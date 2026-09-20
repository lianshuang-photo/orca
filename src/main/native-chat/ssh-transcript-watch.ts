import type { AgentType } from '../../shared/native-chat-types'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import type { IFilesystemProvider, FileStat } from '../providers/filesystem-provider-contract'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTailFile
} from './transcript-tail-reader'
import { nativeChatTurnLifecycleDecoderForAgent } from './transcript-turn-lifecycle'
import {
  createIncrementalTranscriptState,
  readIncrementalTranscriptMessages,
  resetIncrementalTranscriptState
} from './transcript-incremental-reader'
import { openSshTranscriptSource, requireSshTranscriptPath } from './ssh-transcript-source'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import type { TranscriptByteSource } from './transcript-byte-source'

export async function readSshNativeChatTranscript(
  args: {
    sshConnectionId: string
    agent: AgentType
    sessionId: string
    transcriptPath?: string
    limit: number
    beforeOffset?: number
  },
  signal?: AbortSignal
) {
  try {
    signal?.throwIfAborted()
    const path = requireSshTranscriptPath(args.transcriptPath)
    const provider = requireSshFilesystemProvider(args.sshConnectionId)
    const decode = nativeChatLineDecoderForAgent(args.agent)
    if (!decode) {
      return { error: 'Unsupported SSH transcript agent' }
    }
    const result = await readNativeChatTranscriptTailFile(
      path,
      args.limit,
      decode,
      true,
      args.beforeOffset,
      nativeChatTurnLifecycleDecoderForAgent(args.agent),
      signal,
      () => openSshTranscriptSource(provider, path, signal)
    )
    signal?.throwIfAborted()
    return {
      messages: result.messages,
      hasMore: result.hasMore,
      beforeOffset: result.beforeOffset,
      ...(args.beforeOffset === undefined && result.lifecycle
        ? { lifecycle: result.lifecycle }
        : {})
    }
  } catch (error) {
    signal?.throwIfAborted()
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function boundary(source: TranscriptByteSource, offset: number): Promise<string> {
  const start = Math.max(0, offset - 64)
  return offset > 0 ? (await source.read(start, offset - start)).toString('base64') : ''
}

function versionKey(stat: FileStat): string {
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs ?? stat.mtime])
}

/** Poll metadata through the existing relay; only changed files transfer bytes. */
export function subscribeSshNativeChatTranscript(
  connectionId: string,
  args: SubscribeNativeChatTranscriptArgs,
  setupSignal?: AbortSignal
): NativeChatTranscriptSubscription {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let previous: FileStat | undefined
  let previousProvider: IFilesystemProvider | undefined
  let fingerprint = ''
  let needsSnapshot = true
  let lastError: string | undefined
  const state = createIncrementalTranscriptState()
  const signal = controller.signal
  const decode = nativeChatLineDecoderForAgent(args.agent)
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent(args.agent)

  function unsubscribe(): void {
    controller.abort()
    clearTimeout(timer)
    setupSignal?.removeEventListener('abort', unsubscribe)
  }

  async function poll(): Promise<void> {
    try {
      signal.throwIfAborted()
      const path = requireSshTranscriptPath(args.transcriptPath)
      const provider = requireSshFilesystemProvider(connectionId)
      const current = await provider.stat(path)
      signal.throwIfAborted()
      if (!decode) {
        throw new Error('Unsupported SSH transcript agent')
      }
      if (
        !needsSnapshot &&
        provider === previousProvider &&
        previous &&
        versionKey(current) === versionKey(previous)
      ) {
        return
      }
      const source = await openSshTranscriptSource(provider, path, signal, current)
      try {
        const replaced =
          needsSnapshot ||
          provider !== previousProvider ||
          !previous ||
          current.ino !== previous.ino ||
          current.dev !== previous.dev ||
          current.size <= previous.size ||
          current.size < state.offset ||
          (await boundary(source, state.offset)) !== fingerprint
        if (replaced) {
          resetIncrementalTranscriptState(state)
          const snapshot = await readNativeChatTranscriptTailFile(
            path,
            args.initialLimit ?? 300,
            decode,
            false,
            undefined,
            decodeLifecycle,
            signal,
            async () => source
          )
          signal.throwIfAborted()
          state.offset = snapshot.consumedTo
          state.pendingStart = state.offset
          args.onInitialSnapshot?.(
            snapshot.messages,
            snapshot.hasMore,
            snapshot.beforeOffset,
            undefined,
            snapshot.lifecycle
          )
          needsSnapshot = false
        }
        let lifecycle: ReturnType<NonNullable<typeof decodeLifecycle>> = null
        const messages = await readIncrementalTranscriptMessages(
          path,
          state,
          decode,
          undefined,
          decodeLifecycle ?? undefined,
          (value) => {
            lifecycle = value
          },
          signal,
          source
        )
        signal.throwIfAborted()
        if (messages.length || lifecycle) {
          args.onAppend(messages, lifecycle ?? undefined)
        }
        fingerprint = await boundary(source, state.offset)
        previous = current
        previousProvider = provider
        lastError = undefined
      } finally {
        await source.close()
      }
    } catch (error) {
      needsSnapshot = true
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        if (message !== lastError) {
          args.onInitialSnapshot?.([], false, 0, message)
          lastError = message
        }
      }
    } finally {
      if (!signal.aborted) {
        timer = setTimeout(() => void poll(), args.reconciliationIntervalMs ?? 1000)
        timer.unref?.()
      }
    }
  }
  setupSignal?.addEventListener('abort', unsubscribe, { once: true })
  if (setupSignal?.aborted) {
    unsubscribe()
  } else {
    void poll()
  }
  return { watching: true, unsubscribe }
}
