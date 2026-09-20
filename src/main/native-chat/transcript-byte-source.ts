import {
  closeTranscriptHandle,
  wslGatedOpen,
  wslGatedRead,
  wslGatedStat
} from './wsl-transcript-fs-access'

/** Positional bytes owned by one filesystem, including SSH. */
export type TranscriptByteSource = {
  size: number
  read: (position: number, length: number) => Promise<Buffer>
  close: () => Promise<void>
}

export async function openLocalTranscriptByteSource(
  filePath: string,
  signal?: AbortSignal
): Promise<TranscriptByteSource> {
  const { size } = await wslGatedStat(filePath, 'exact', signal)
  const handle = await wslGatedOpen(filePath, 'exact', signal)
  return {
    size,
    read: async (position, length) => {
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await wslGatedRead(
        handle,
        filePath,
        buffer,
        0,
        length,
        position,
        'exact',
        signal
      )
      return buffer.subarray(0, bytesRead)
    },
    close: () => closeTranscriptHandle(handle, filePath)
  }
}
