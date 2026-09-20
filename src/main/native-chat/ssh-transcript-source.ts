import { posix, win32 } from 'node:path'
import type { IFilesystemProvider, FileStat } from '../providers/filesystem-provider-contract'
import type { TranscriptByteSource } from './transcript-byte-source'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'

const LEGACY_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024

export function requireSshTranscriptPath(transcriptPath?: string): string {
  const path = transcriptPath?.trim()
  if (!path || (!posix.isAbsolute(path) && !win32.isAbsolute(path)) || !path.endsWith('.jsonl')) {
    throw new Error(
      'The SSH agent has not reported an absolute transcript path. Resume the session in Terminal first.'
    )
  }
  return path
}

export async function openSshTranscriptSource(
  provider: IFilesystemProvider,
  path: string,
  signal?: AbortSignal,
  stat?: FileStat
): Promise<TranscriptByteSource> {
  signal?.throwIfAborted()
  const version = stat ?? (await provider.stat(path))
  const readRange = provider.readFileRange?.bind(provider)
  const ranged = readRange && (await provider.supportsFileRangeRead?.({ signal }))
  signal?.throwIfAborted()
  if (!ranged || !readRange) {
    // Older relays get one bounded snapshot, never one whole-file transfer per range.
    if (version.size > LEGACY_SNAPSHOT_MAX_BYTES) {
      throw new Error('Update the SSH relay to read chat transcripts larger than 32 MiB.')
    }
    const result = await provider.readFile(path, { maxTextBytes: LEGACY_SNAPSHOT_MAX_BYTES })
    signal?.throwIfAborted()
    if (result.isBinary) {
      throw new Error('The SSH transcript is not a text file.')
    }
    const bytes = Buffer.from(result.content, 'utf8')
    return {
      size: bytes.length,
      read: async (start, length) => bytes.subarray(start, start + length),
      close: async () => {}
    }
  }
  return {
    size: version.size,
    read: async (position, length) => {
      signal?.throwIfAborted()
      const result = await readRange(path, position, Math.min(length, MAX_FILE_RANGE_READ_BYTES), {
        signal
      })
      signal?.throwIfAborted()
      return result.bytes
    },
    close: async () => {}
  }
}
