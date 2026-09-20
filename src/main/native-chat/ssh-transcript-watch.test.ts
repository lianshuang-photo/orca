import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readSshNativeChatTranscript,
  subscribeSshNativeChatTranscript
} from './ssh-transcript-watch'

const registry = vi.hoisted(() => ({ require: vi.fn() }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: registry.require
}))

function message(id: string, text = id): string {
  return `${JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'session',
      turn_id: 'turn',
      item: {
        type: 'AgentMessage',
        id,
        content: [{ type: 'Text', text }],
        phase: 'final_answer'
      },
      completed_at_ms: 1
    }
  })}\n`
}

const args = {
  sshConnectionId: 'ssh-one',
  agent: 'codex',
  sessionId: 'session',
  transcriptPath: '/remote/only/session.jsonl',
  limit: 2
} as const
let bytes: Buffer
let mtime: number
let ino: number
const provider = {
  stat: vi.fn(async () => ({ size: bytes.length, type: 'file', mtime, ino, dev: 1 })),
  supportsFileRangeRead: vi.fn(async () => true),
  readFileRange: vi.fn(async (_path: string, position: number, length: number) => {
    const result = bytes.subarray(position, position + length)
    return { bytes: result, bytesRead: result.length }
  }),
  readFile: vi.fn(async () => ({ content: bytes.toString('utf8'), isBinary: false }))
}
let stop: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  bytes = Buffer.from(message('one') + message('two') + message('three', '你好 🌊'))
  mtime = 1
  ino = 1
  provider.supportsFileRangeRead.mockResolvedValue(true)
  registry.require.mockReturnValue(provider)
})
afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
})

async function start() {
  const snapshot = vi.fn()
  const append = vi.fn()
  stop = subscribeSshNativeChatTranscript(args.sshConnectionId, {
    ...args,
    initialLimit: 2,
    onInitialSnapshot: snapshot,
    onAppend: append,
    reconciliationIntervalMs: 10
  }).unsubscribe
  await vi.advanceTimersByTimeAsync(0)
  return { snapshot, append }
}

describe('SSH native chat transcripts', () => {
  it('reads older byte pages without replaying the tail or its live lifecycle', async () => {
    const tail = await readSshNativeChatTranscript(args)
    if (!('messages' in tail)) {
      throw new Error('Missing tail')
    }
    const older = await readSshNativeChatTranscript({ ...args, beforeOffset: tail.beforeOffset })
    expect(older).toMatchObject({ messages: [{ id: 'one' }], hasMore: false })
    expect(older).not.toHaveProperty('lifecycle')
  })

  it('honors cancellation before contacting the SSH provider', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(readSshNativeChatTranscript(args, controller.signal)).rejects.toThrow()
    expect(registry.require).not.toHaveBeenCalled()
  })
  it('reads the owning host with bounded pagination and Unicode', async () => {
    const result = await readSshNativeChatTranscript(args)
    expect(result).toMatchObject({
      hasMore: true,
      messages: [{ id: 'two' }, { id: 'three', blocks: [{ type: 'text', text: '你好 🌊' }] }]
    })
    expect(registry.require).toHaveBeenCalledWith('ssh-one')
    expect(provider.readFile).not.toHaveBeenCalled()
    expect(await readSshNativeChatTranscript({ ...args, limit: 10 })).toMatchObject({
      hasMore: false,
      messages: [{ id: 'one' }, { id: 'two' }, { id: 'three' }]
    })
  })

  it('uses one bounded whole-file snapshot on older relays', async () => {
    provider.supportsFileRangeRead.mockResolvedValue(false)
    expect(await readSshNativeChatTranscript(args)).toHaveProperty('messages')
    expect(provider.readFile).toHaveBeenCalledTimes(1)
    expect(provider.readFileRange).not.toHaveBeenCalled()
  })

  it('never substitutes local disk when the SSH connection or hook path is absent', async () => {
    registry.require.mockImplementation(() => {
      throw new Error('Remote connection dropped')
    })
    expect(await readSshNativeChatTranscript(args)).toEqual({ error: 'Remote connection dropped' })
    expect(await readSshNativeChatTranscript({ ...args, transcriptPath: undefined })).toMatchObject(
      { error: expect.stringContaining('absolute transcript path') }
    )
    expect(provider.stat).not.toHaveBeenCalled()
  })

  it('does not transfer an unchanged file and only appends complete new records', async () => {
    const { snapshot, append } = await start()
    expect(snapshot).toHaveBeenCalledTimes(1)
    const readCount = provider.readFileRange.mock.calls.length
    await vi.advanceTimersByTimeAsync(30)
    expect(provider.readFileRange).toHaveBeenCalledTimes(readCount)
    bytes = Buffer.concat([bytes, Buffer.from(message('four').slice(0, -1))])
    mtime++
    await vi.advanceTimersByTimeAsync(10)
    expect(append).not.toHaveBeenCalled()
    bytes = Buffer.concat([bytes, Buffer.from('\n')])
    mtime++
    await vi.advanceTimersByTimeAsync(10)
    expect(append).toHaveBeenCalledWith([expect.objectContaining({ id: 'four' })], undefined)
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  it('replaces history after rotation and recovers after disconnect', async () => {
    const { snapshot } = await start()
    bytes = Buffer.from(message('replacement'))
    ino++
    mtime++
    await vi.advanceTimersByTimeAsync(10)
    expect(snapshot.mock.lastCall?.[0]).toEqual([expect.objectContaining({ id: 'replacement' })])
    registry.require.mockImplementation(() => {
      throw new Error('Disconnected')
    })
    await vi.advanceTimersByTimeAsync(20)
    expect(snapshot.mock.lastCall?.[3]).toBe('Disconnected')
    expect(snapshot).toHaveBeenCalledTimes(3)
    registry.require.mockReturnValue(provider)
    await vi.advanceTimersByTimeAsync(10)
    expect(snapshot.mock.lastCall?.[0]).toEqual([expect.objectContaining({ id: 'replacement' })])
    expect(snapshot.mock.lastCall?.[3]).toBeUndefined()
  })

  it('stops polling and publishing after unsubscribe', async () => {
    const { snapshot, append } = await start()
    stop?.()
    const statCount = provider.stat.mock.calls.length
    bytes = Buffer.concat([bytes, Buffer.from(message('late'))])
    mtime++
    await vi.advanceTimersByTimeAsync(100)
    expect(provider.stat).toHaveBeenCalledTimes(statCount)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalled()
  })
})
