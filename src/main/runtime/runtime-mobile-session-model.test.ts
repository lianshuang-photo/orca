import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusIpcPayload
} from '../../shared/agent-status-types'
import { selectRuntimeHookAgentRowForPane } from './runtime-mobile-agent-status-projection'

function sessionRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: 'tab:leaf',
    tabId: 'tab',
    worktreeId: 'folder:workspace',
    connectionId: 'ssh-host',
    state: 'working',
    prompt: 'Old activity',
    agentType: 'codex',
    model: 'gpt-6-astra',
    providerSession: { key: 'session_id', id: 'session-1' },
    receivedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1000,
    stateStartedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1000,
    ...overrides
  }
}

describe('mobile session model metadata', () => {
  it('keeps the model after activity expires without reviving working', () => {
    expect(selectRuntimeHookAgentRowForPane([sessionRow()])).toMatchObject({
      providerSessionModel: 'gpt-6-astra',
      agentIsLive: false,
      live: null
    })
  })

  it('does not carry a previous session model into a resumed session', () => {
    const previous = sessionRow()
    const resumed = sessionRow({
      providerSession: { key: 'session_id', id: 'session-2' },
      receivedAt: previous.receivedAt + 1,
      model: undefined
    })
    expect(selectRuntimeHookAgentRowForPane([resumed, previous])).not.toHaveProperty(
      'providerSessionModel'
    )
  })
})
