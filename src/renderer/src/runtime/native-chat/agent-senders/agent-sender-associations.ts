import type { AppState } from '@/store/types'
import type {
  AgentSenderAssociation,
  AgentSenderPublication
} from '../../../../../shared/orchestration/mailbox/agent-sender-associations'
import type { AgentMessageSender } from '../../../../../shared/agent-session/agent-session-message-source'
import { structuredAgentSessionOwnerInputs } from '../session-ownership/structured-agent-session-owner'
import type { Tab } from '../../../../../shared/tab-types'
import { agentSenderAliasParts, assembleAgentSenderAliases } from './agent-sender-alias-projection'

/** `paneKey` is this window's name for the pane; `hostPaneKey` is the name its host gave it. */
export type LocatedAgentSender = AgentSenderAssociation & {
  host: string
  hostPaneKey: string
  tab?: Tab
}
const key = (host: string, address: string) => JSON.stringify([host, address])
type Aliases = ReturnType<typeof assembleAgentSenderAliases>
type Located = LocatedAgentSender | null
/** One host's publication on this window's panes: null where its rows disagree, and reverse
 *  pane maps so a pane's rival claims are found without walking every row. */
type HostPart = {
  identities: Map<string, Located>
  principals: Set<string>
  /** The rows it runs for each home principal that attached them, by identity. */
  attachments: Map<string, Map<string, Located>>
  panes: Map<string, string[]>
  attachedPanes: Map<string, [principal: string, identity: string][]>
}
type SenderIndex = {
  parts: ReadonlyMap<string, HostPart>
  results: Map<string, Located | undefined>
}
type LocatedRows = {
  aliases: Aliases
  host: string
  associations: LocatedAgentSender[]
  attachments: [principal: string, row: LocatedAgentSender][]
}

const EMPTY: AppState['agentSenderPublicationsByHost'] = Object.freeze({})
let aliasCache: { inputs: unknown[]; parts: readonly unknown[]; aliases: Aliases } | undefined
const locatedRows = new WeakMap<AgentSenderPublication, LocatedRows>()
const hostParts = new WeakMap<object, { aliases: Aliases; host: string; part: HostPart }>()
const indexes = new WeakMap<object, { aliases: Aliases; index: SenderIndex }>()
let joins = 0
/** Rows joined to panes: each publication's once per alias change, each host's once per update. */
export const agentSenderIndexWorkForTest = () => joins

function senderAliases(state: AppState): Aliases {
  const inputs = [
    state.unifiedTabsByWorktree,
    state.tabsByWorktree,
    ...structuredAgentSessionOwnerInputs(state)
  ]
  if (aliasCache?.inputs.every((input, i) => input === inputs[i])) {
    return aliasCache.aliases
  }
  const parts = agentSenderAliasParts(state)
  if (
    aliasCache?.parts.length === parts.length &&
    aliasCache.parts.every((part, i) => part === parts[i])
  ) {
    aliasCache.inputs = inputs
    return aliasCache.aliases
  }
  aliasCache = { inputs, parts, aliases: assembleAgentSenderAliases(parts) }
  return aliasCache.aliases
}

/** Equal claims keep the first; a disagreement, or an ambiguous claim, is ambiguous. */
function merge(current: Located | undefined, next: Located | undefined): Located | undefined {
  if (next === undefined || current === null) {
    return current
  }
  if (current === undefined || next === null) {
    return next
  }
  return JSON.stringify(current) === JSON.stringify(next) ? current : null
}

function locate(publication: AgentSenderPublication, host: string, aliases: Aliases): LocatedRows {
  const cached = locatedRows.get(publication)
  if (cached?.aliases === aliases && cached.host === host) {
    return cached
  }
  const place = (row: AgentSenderAssociation): LocatedAgentSender[] => {
    joins++
    const actual = aliases.windowPane(host, row.paneKey)
    const paneKey = actual ?? row.paneKey
    const tab = aliases.chatTabs.get(key(host, paneKey))
    return actual === null ? [] : [{ ...row, host, paneKey, hostPaneKey: row.paneKey, tab }]
  }
  const peer = publication.peerFingerprint
  const rows: LocatedRows = {
    aliases,
    host,
    associations: publication.associations.flatMap(place),
    attachments: peer
      ? publication.attachments.flatMap((row) =>
          place(row).map((location) => [key(peer, row.homePeerFingerprint), location] as const)
        )
      : []
  }
  locatedRows.set(publication, rows)
  return rows
}

/** The whole-host publication is the baseline; each newer scope replaces its worktree's rows. */
function hostPart(
  host: string,
  scopes: Record<string, AgentSenderPublication>,
  aliases: Aliases
): HostPart {
  const cached = hostParts.get(scopes)
  if (cached?.aliases === aliases && cached.host === host) {
    return cached.part
  }
  const part: HostPart = {
    identities: new Map(),
    principals: new Set(),
    attachments: new Map(),
    panes: new Map(),
    attachedPanes: new Map()
  }
  const onPane = <T>(map: Map<string, T[]>, row: LocatedAgentSender, value: T) => {
    const pane = key(row.worktreeId, row.paneKey)
    const values = map.get(pane) ?? []
    values.push(value)
    map.set(pane, values)
  }
  const whole = scopes['*']
  const scoped = Object.entries(scopes).flatMap(([id, value]) => (id === '*' ? [] : [value]))
  for (const publication of whole ? [whole, ...scoped] : scoped) {
    const kept = (row: LocatedAgentSender) =>
      publication !== whole || scoped.length === 0 || !Object.hasOwn(scopes, row.worktreeId)
    const rows = locate(publication, host, aliases)
    for (const row of rows.associations) {
      if (kept(row)) {
        joins++
        part.identities.set(row.identity, merge(part.identities.get(row.identity), row))
        onPane(part.panes, row, row.identity)
      }
    }
    for (const [principal, row] of rows.attachments) {
      if (kept(row)) {
        joins++
        const bucket = part.attachments.get(principal) ?? new Map<string, Located>()
        part.attachments.set(principal, bucket)
        bucket.set(row.identity, merge(bucket.get(row.identity), row))
        onPane(part.attachedPanes, row, [principal, row.identity])
      }
    }
    // Principals repeat in every scope of a host; each joins once.
    for (const { peerFingerprint, homePeerFingerprint } of publication.principals) {
      part.principals.add(key(peerFingerprint, homePeerFingerprint))
    }
  }
  hostParts.set(scopes, { aliases, host, part })
  return part
}

function senderIndex(state: AppState): SenderIndex {
  const aliases = senderAliases(state)
  const source = state.agentSenderPublicationsByHost ?? EMPTY
  const cached = indexes.get(source)
  if (cached?.aliases === aliases) {
    return cached.index
  }
  const parts = new Map(
    Object.entries(source).map(([host, scopes]) => [host, hostPart(host, scopes, aliases)])
  )
  const index: SenderIndex = { parts, results: new Map() }
  indexes.set(source, { aliases, index })
  return index
}

/** A host's claim for an identity: its own rows, then every row a peer runs for its principals. */
function claim(index: SenderIndex, host: string, identity: string): Located | undefined {
  const part = index.parts.get(host)
  let value = part?.identities.get(identity)
  for (const principal of part?.principals ?? []) {
    for (const executing of index.parts.values()) {
      value = merge(value, executing.attachments.get(principal)?.get(identity))
    }
  }
  return value
}

/** Two hosts claiming one pane of this window make every claim on it ambiguous. */
function contested(index: SenderIndex, location: LocatedAgentSender): boolean {
  const pane = key(location.worktreeId, location.paneKey)
  const rival = (host: string, identity: string) => {
    const other = claim(index, host, identity)
    return Boolean(other && other.host !== location.host)
  }
  for (const [host, part] of index.parts) {
    if (part.panes.get(pane)?.some((identity) => rival(host, identity))) {
      return true
    }
    for (const [principal, identity] of part.attachedPanes.get(pane) ?? []) {
      for (const [home, homePart] of index.parts) {
        if (homePart.principals.has(principal) && rival(home, identity)) {
          return true
        }
      }
    }
  }
  return false
}

function lookup(index: SenderIndex, host: string, identity: string): Located | undefined {
  const id = key(host, identity)
  if (!index.results.has(id)) {
    const value = claim(index, host, identity)
    index.results.set(id, value && contested(index, value) ? null : value)
  }
  return index.results.get(id)
}

const SENDER_CHANNEL = 'sender\0'
let reads: Set<string> | undefined
/** Runs `read`, returning the sender channels its resolutions read: what to subscribe to. */
export function readingAgentSenders<T>(read: () => T): [T, ReadonlySet<string>] {
  const outer = reads
  reads = new Set()
  try {
    return [read(), reads]
  } finally {
    reads = outer
  }
}

function sameLocation(a: Located | undefined, b: Located | undefined): boolean {
  return (
    a === b ||
    Boolean(
      a &&
      b &&
      a.identity === b.identity &&
      a.host === b.host &&
      a.paneKey === b.paneKey &&
      a.hostPaneKey === b.hostPaneKey &&
      a.worktreeId === b.worktreeId &&
      a.sessionId === b.sessionId &&
      a.dispatchActor === b.dispatchActor &&
      a.tab === b.tab
    )
  )
}

/** Hosts starting or stopping publication move every sender on them; that is not keyed. */
export function samePublishingHosts(a: AppState, b: AppState): boolean {
  const before = a.agentSenderPublicationsByHost ?? EMPTY
  const after = b.agentSenderPublicationsByHost ?? EMPTY
  const hosts = Object.keys(before)
  return (
    hosts.length === Object.keys(after).length && hosts.every((host) => Object.hasOwn(after, host))
  )
}

/** The subscribed sender channels whose answer differs between two states that share tabs and
 *  owners: a publication update notifies only the cards it moves. */
export function movedAgentSenderChannels(
  previous: AppState,
  state: AppState,
  channels: Iterable<string>
): string[] {
  let pair: [SenderIndex, SenderIndex] | undefined
  const moved: string[] = []
  for (const channel of channels) {
    if (channel.startsWith(SENDER_CHANNEL)) {
      const [before, after] = (pair ??= [senderIndex(previous), senderIndex(state)])
      const [host, identity]: [string, string] = JSON.parse(channel.slice(SENDER_CHANNEL.length))
      if (!sameLocation(lookup(before, host, identity), lookup(after, host, identity))) {
        moved.push(channel)
      }
    }
  }
  return moved
}

/** Where a card's sender runs on its host now, before the saved-kind check the card layer adds. */
export type AgentSenderResolution =
  | { kind: 'located'; location: LocatedAgentSender }
  /** Two hosts or rows claim it: no live link, and never a guess between them. */
  | { kind: 'ambiguous' }
  /** The host runs nothing under the identities the card saved: a closed chat, a terminal that
   *  exited or was respawned, or a sender with no identity this host can name. */
  | { kind: 'gone'; sender: 'chat' | 'terminal' | 'other' }
  /** The host publishes nothing: an older Orca, read through its own lookup. */
  | { kind: 'legacy' }

const AMBIGUOUS: AgentSenderResolution = Object.freeze({ kind: 'ambiguous' })
const LEGACY: AgentSenderResolution = Object.freeze({ kind: 'legacy' })

/** The identities a card names its sender by, most specific first: the Dispatch a Started-worker
 *  card records, the chat session, the terminal handle it sent from, a federated Dispatch. */
function senderIdentities(sender: AgentMessageSender, dispatchId: string | undefined): string[] {
  const { address, orcaSessionId, terminalHandle } = sender.party
  return [
    dispatchId ? `dispatch:${dispatchId}` : undefined,
    orcaSessionId ? `orca_session_id:${orcaSessionId}` : undefined,
    terminalHandle && !terminalHandle.startsWith('dispatch:') ? terminalHandle : undefined,
    address.startsWith('dispatch:') ? address : undefined
  ].filter((identity): identity is string => Boolean(identity))
}

/** Undefined publication is old-host compatibility; the first identity the host proves selects
 *  the one target, and an ambiguous one never falls through to another. */
export function resolveAgentMessageSender(
  state: AppState,
  host: string,
  sender: AgentMessageSender,
  dispatchId?: string
): AgentSenderResolution {
  if (
    sender.party.address.startsWith('run:') &&
    !sender.party.orcaSessionId &&
    !sender.party.terminalHandle
  ) {
    return { kind: 'gone', sender: 'other' }
  }
  if (!state.agentSenderPublicationsByHost?.[host]) {
    return LEGACY
  }
  const index = senderIndex(state)
  for (const identity of senderIdentities(sender, dispatchId)) {
    reads?.add(SENDER_CHANNEL + key(host, identity))
    const location = lookup(index, host, identity)
    if (location === null) {
      return AMBIGUOUS
    }
    if (location) {
      const role = sender.party.address.startsWith('dispatch:') || dispatchId !== undefined
      const stableSession = identity.startsWith('orca_session_id:')
      if (
        (identity.startsWith('dispatch:') || (role && !stableSession)) &&
        location.dispatchActor !== true
      ) {
        continue
      }
      return { kind: 'located', location }
    }
  }
  const { orcaSessionId, terminalHandle } = sender.party
  return {
    kind: 'gone',
    sender: orcaSessionId
      ? 'chat'
      : terminalHandle && !terminalHandle.startsWith('dispatch:')
        ? 'terminal'
        : 'other'
  }
}

/** Undefined publication is old-host compatibility; an authoritative miss never falls back. */
export function hasAgentSenderPublication(state: AppState, host: string): boolean {
  return Boolean(state.agentSenderPublicationsByHost?.[host])
}
export function selectAgentSenderAssociation(
  state: AppState,
  host: string,
  sender: AgentMessageSender,
  dispatchId?: string
): LocatedAgentSender | undefined {
  const resolution = resolveAgentMessageSender(state, host, sender, dispatchId)
  return resolution.kind === 'located' ? resolution.location : undefined
}
