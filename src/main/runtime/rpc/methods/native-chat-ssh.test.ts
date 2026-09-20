import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { RpcContext } from '../core'

const mocks = vi.hoisted(() => {
  const rows: AgentStatusIpcPayload[] = []
  return { rows, localRead: vi.fn(), localSubscribe: vi.fn(), provider: vi.fn() }
})
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { getStatusSnapshot: () => mocks.rows }
}))
vi.mock('../../../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: mocks.localRead,
  subscribeNativeChatTranscript: mocks.localSubscribe
}))
vi.mock('../../../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: mocks.provider
}))
import { NATIVE_CHAT_METHODS } from './native-chat'
import { resolveNativeChatTranscriptOwner } from '../../../native-chat/transcript-owner'

const params = { agent: 'codex', sessionId: 'session', limit: 2 }
const path = '/remote/.codex/session.jsonl'
const read = NATIVE_CHAT_METHODS.find((method) => method.name === 'nativeChat.readSession')!
const subscribe = NATIVE_CHAT_METHODS.find((method) => method.name === 'nativeChat.subscribe')!
let bytes: Buffer
let cleanup: (() => void) | undefined
function line(id: string, text = id): string {
  return `${JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      completed_at_ms: 1,
      item: { type: 'AgentMessage', id, content: [{ type: 'Text', text }], phase: 'final_answer' }
    }
  })}\n`
}
function row(connectionId: string | null = 'ssh-one'): AgentStatusIpcPayload {
  return {
    paneKey: 'pane',
    connectionId,
    agentType: 'codex',
    state: 'done',
    prompt: '',
    receivedAt: 1,
    stateStartedAt: 1,
    providerSession: { key: 'session_id', id: 'session', transcriptPath: path }
  }
}
function context(signal?: AbortSignal): RpcContext {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These handlers only use subscription cleanup on the runtime.
    runtime: {
      registerSubscriptionCleanup: (_id: string, fn: () => void) => {
        cleanup = fn
      },
      cleanupSubscription: () => cleanup?.()
    } as unknown as RpcContext['runtime'],
    connectionId: 'phone',
    clientKind: 'mobile',
    signal
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.rows = [row()]
  bytes = Buffer.from(line('one') + line('two') + line('three', 'x'.repeat(100000)))
  mocks.provider.mockReturnValue({
    stat: async () => ({ size: bytes.length, mtime: bytes.length, ino: 1, dev: 1 }),
    supportsFileRangeRead: async () => true,
    readFileRange: async (_path: string, offset: number, length: number) => {
      const part = bytes.subarray(offset, offset + length)
      return { bytes: part, bytesRead: part.length }
    }
  })
})
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
})

describe('existing mobile native-chat requests for SSH sessions', () => {
  it('routes without new phone fields and retains mobile clipping and older-page cursors', async () => {
    const tail = await read.handler(params, context())
    expect(tail).toMatchObject({ messages: [{ id: 'two' }, { id: 'three' }], hasMore: true })
    expect(mocks.provider).toHaveBeenCalledWith('ssh-one')
    expect(mocks.localRead).not.toHaveBeenCalled()
    if (!('messages' in tail)) {
      throw new Error('Missing tail')
    }
    expect(JSON.stringify(tail.messages).length).toBeLessThan(65000)
    const older = await read.handler({ ...params, beforeOffset: tail.beforeOffset }, context())
    expect(older).toMatchObject({ messages: [{ id: 'one' }], hasMore: false })
    expect(older).not.toHaveProperty('lifecycle')
  })

  it('streams the SSH snapshot and appended records, then stops on phone disconnect', async () => {
    const emit = vi.fn()
    const controller = new AbortController()
    await subscribe.handler(params, context(controller.signal), emit)
    await vi.advanceTimersByTimeAsync(0)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'snapshot',
        hasMore: true,
        messages: [expect.objectContaining({ id: 'two' }), expect.objectContaining({ id: 'three' })]
      })
    )
    bytes = Buffer.concat([bytes, Buffer.from(line('four'))])
    await vi.advanceTimersByTimeAsync(1000)
    expect(emit).toHaveBeenLastCalledWith({
      type: 'appended',
      messages: [expect.objectContaining({ id: 'four' })]
    })
    controller.abort()
    const calls = emit.mock.calls.length
    bytes = Buffer.concat([bytes, Buffer.from(line('five'))])
    await vi.advanceTimersByTimeAsync(2000)
    expect(emit).toHaveBeenCalledTimes(calls)
    expect(emit).toHaveBeenLastCalledWith({ type: 'end' })
    expect(mocks.localSubscribe).not.toHaveBeenCalled()
  })

  it('reports a disconnected SSH owner without reading local disk', async () => {
    mocks.provider.mockImplementation(() => {
      throw new Error('Remote connection dropped')
    })
    expect(await read.handler(params, context())).toEqual({ error: 'Remote connection dropped' })
    const emit = vi.fn()
    await subscribe.handler(params, context(), emit)
    await vi.advanceTimersByTimeAsync(0)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Remote connection dropped' })
    )
    expect(mocks.localRead).not.toHaveBeenCalled()
    expect(mocks.localSubscribe).not.toHaveBeenCalled()
  })

  it('retains local and WSL routing and ignores another agent with the same session id', () => {
    for (const connection of [null, 'wsl:Ubuntu']) {
      mocks.rows = [row(connection)]
      expect(resolveNativeChatTranscriptOwner(params)).toEqual({
        sshConnectionId: null,
        transcriptPath: path
      })
    }
    mocks.rows = [{ ...row(), agentType: 'claude' }]
    expect(resolveNativeChatTranscriptOwner(params).sshConnectionId).toBeNull()
  })

  it('rejects ambiguous hosts and mismatched paths instead of selecting another machine', () => {
    mocks.rows = [row(), row('ssh-two')]
    expect(() => resolveNativeChatTranscriptOwner(params)).toThrow('multiple hosts')
    mocks.rows = [row()]
    expect(() =>
      resolveNativeChatTranscriptOwner({ ...params, transcriptPath: '/wrong.jsonl' })
    ).toThrow('does not match')
  })
})
