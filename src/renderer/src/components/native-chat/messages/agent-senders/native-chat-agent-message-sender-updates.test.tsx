// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { agentSenderIndexWorkForTest } from '@/runtime/native-chat/agent-senders/agent-sender-associations'
import { agentSenderPublicationPatch } from '@/runtime/native-chat/agent-senders/agent-sender-publication-patch'
import type { AgentSenderPublication } from '../../../../../../shared/orchestration/mailbox/agent-sender-associations'
import type { AgentMessageSender } from '../../../../../../shared/agent-session/agent-session-message-source'
import { parseOrcaSessionAddress } from '../../../../../../shared/agent-session/identity/orca-session-address'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useAgentMessageSenderLabel } from './native-chat-agent-message-sender-label'
import { useAgentMessageSenderOpens } from './native-chat-agent-message-sender-view'
import { initialStore, LEAF, resetSenderStore } from './native-chat-agent-sender.test-fixture'

afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.restoreAllMocks()
})

let revision = 0
const chat = (id: string, worktreeId: string) => ({
  identity: `orca_session_id:${id}`,
  sessionId: id,
  paneKey: `tab-${id}:${LEAF}`,
  worktreeId
})
const publication = (associations: AgentSenderPublication['associations']) => ({
  associations,
  principals: [],
  attachments: [],
  revision: { epoch: 'scale', revision: ++revision }
})
function publishScope(host: string, scope: string, associations: AgentSenderPublication['associations']) {
  useAppStore.setState((state) =>
    agentSenderPublicationPatch(state, host, scope, publication(associations))
  )
}

it('a remote scope update rejoins only its peer and notifies only the senders it moved', () => {
  resetSenderStore()
  useAppStore.getState().setAgentSenderPublication('local', {
    ...publication(Array.from({ length: 9261 }, (_, i) => chat(`session_local_${i}`, 'workspace'))),
    principals: [
      { peerFingerprint: 'peer-a', homePeerFingerprint: 'home' },
      { peerFingerprint: 'peer-b', homePeerFingerprint: 'home' }
    ]
  })
  for (const [peer, scopes] of [['a', 120], ['b', 210]] as const) {
    publishScope(`runtime:${peer}`, '*', [])
    for (let i = 0; i < scopes; i++) {
      const id = `session_${peer}_${i}`
      publishScope(`runtime:${peer}`, `workspace_${peer}_${i}`, [chat(id, `workspace_${peer}_${i}`)])
    }
  }
  const projection = useAppStore.getState().agentStatusByPaneKey.projection
  const subscribe = projection.subscribe.bind(projection)
  const notified: string[] = []
  vi.spyOn(projection, 'subscribe').mockImplementation((channel, listener) =>
    subscribe(channel, () => {
      notified.push(channel)
      listener()
    })
  )
  const renders = new Map<string, number>()
  const mount = (id: string, target: RuntimeClientTarget) => {
    const sender: AgentMessageSender = {
      name: id,
      party: {
        address: `orca_session_id:${id}`,
        terminalHandle: null,
        orcaSessionId: parseOrcaSessionAddress(`orca_session_id:${id}`)
      }
    }
    renderHook(() => {
      renders.set(id, (renders.get(id) ?? 0) + 1)
      useAgentMessageSenderLabel(sender, 'workspace', target)
      useAgentMessageSenderOpens(sender, 'workspace', target)
    })
  }
  for (let i = 0; i < 40; i++) {
    mount(`session_local_${i}`, { kind: 'local' })
    mount(`session_a_${i}`, { kind: 'environment', environmentId: 'a' })
    mount(`session_b_${i}`, { kind: 'environment', environmentId: 'b' })
  }
  const before = new Map(renders)
  const work = agentSenderIndexWorkForTest()
  notified.length = 0

  // The sender of peer b's fifth scope closes its chat.
  act(() => publishScope('runtime:b', 'workspace_b_5', []))

  // Peer b's 209 remaining rows; none of the local publication's 9,261.
  expect(agentSenderIndexWorkForTest() - work).toBe(209)
  // Its label and link, and no other card.
  expect(notified).toEqual([
    'sender\0["runtime:b","orca_session_id:session_b_5"]',
    'sender\0["runtime:b","orca_session_id:session_b_5"]'
  ])
  const rerendered = [...renders].filter(([id, count]) => count !== before.get(id))
  expect(rerendered).toEqual([['session_b_5', before.get('session_b_5')! + 1]])
})
