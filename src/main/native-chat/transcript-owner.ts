import { agentHookServer } from '../agent-hooks/server'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'

/** Older phones send only session identity; the hook store already knows its host. */
export function resolveNativeChatTranscriptOwner(args: {
  agent: string
  sessionId: string
  transcriptPath?: string
}): { sshConnectionId: string | null; transcriptPath?: string } {
  const rows = agentHookServer
    .getStatusSnapshot()
    .filter((row) => row.agentType === args.agent && row.providerSession?.id === args.sessionId)
  const matching = args.transcriptPath
    ? rows.filter(
        (row) =>
          !row.providerSession?.transcriptPath ||
          row.providerSession.transcriptPath === args.transcriptPath
      )
    : rows
  if (rows.length && !matching.length) {
    throw new Error('Transcript path does not match the reported agent session')
  }
  const owners = new Map<string, { sshConnectionId: string | null; transcriptPath?: string }>()
  for (const row of matching) {
    const sshConnectionId = isWslHookRelayConnectionId(row.connectionId) ? null : row.connectionId
    const transcriptPath = args.transcriptPath ?? row.providerSession?.transcriptPath
    owners.set(JSON.stringify([sshConnectionId, transcriptPath]), {
      sshConnectionId,
      transcriptPath
    })
  }
  if (owners.size > 1) {
    throw new Error(
      'Transcript session belongs to multiple hosts or paths; reopen the target session'
    )
  }
  return (
    owners.values().next().value ?? { sshConnectionId: null, transcriptPath: args.transcriptPath }
  )
}
