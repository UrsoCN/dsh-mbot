import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export const contextSnapshotType = 'plugin:mbot/context-snapshot'

// Stable across JSON serialization, persistence and provider object key order.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonical(item)).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const contextHash = value => createHash('sha256').update(canonical(value)).digest('hex')
export const contentHash = value => createHash('sha256').update(value).digest('hex')
export function freezeContext(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeContext(item)
    Object.freeze(value)
  }
  return value
}
const hash = /^[a-f0-9]{64}$/u
const gitHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u

export function knowledgeFiles(role) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(role) || role === 'human') throw new Error('Invalid context role')
  return ['AGENTS.md', `bots/${role}/SOUL.md`, 'MEMORY.md', `bots/${role}/MEMORY.md`]
}

export function validateKnowledge(knowledge, role) {
  const paths = knowledgeFiles(role)
  if (knowledge?.schemaVersion !== 1 || knowledge.role !== role || !Array.isArray(knowledge.documents)
    || knowledge.documents.length !== paths.length || !hash.test(knowledge.version ?? '')
    || knowledge.documents.some((document, index) => document.path !== paths[index]
      || !gitHash.test(document.blob ?? '') || !hash.test(document.contentHash ?? ''))
    || knowledge.version !== contextHash({ role, documents: knowledge.documents })) throw new Error('Invalid context knowledge identity')
  return knowledge
}

/** Persona and operational system context are supplied afresh, outside dialogue. */
export function recentContextEvent(event) {
  return !['system/message', 'developer/message'].includes(event.type)
    && !(event.type === 'user/message' && event.data.source?.kind === 'runtime-context')
}

export function contextReferences(events) {
  return events.filter(recentContextEvent).map(event => ({ seq: event.seq, type: event.type, hash: contextHash(event) }))
}

export function validateContextSnapshot(data, seq) {
  if (data?.schemaVersion !== 1 || data.kind !== 'turn-input' || data.visibility !== 'owner-private'
    || typeof data.botId !== 'string' || !data.botId || typeof data.sessionId !== 'string' || !data.sessionId
    || data.conversationId !== data.sessionId || !Number.isSafeInteger(data.turn) || data.turn < 1
    || data.compactionPolicyVersion !== undefined && data.compactionPolicyVersion !== 1
    || !/^\d{8}T\d{6}Z-turn-[a-f0-9]{16}$/u.test(data.runId ?? '') || !gitHash.test(data.memoryCommit ?? '')
    || !Number.isSafeInteger(data.contextEpoch) || data.contextEpoch < 1
    || !Number.isSafeInteger(data.sourceCut?.throughSeq) || data.sourceCut.throughSeq < -1 || data.sourceCut.throughSeq >= seq
    || !Array.isArray(data.sourceCut.events) || !Array.isArray(data.input)
    || data.input.some(item => typeof item.messageId !== 'string' || !hash.test(item.hash ?? ''))) throw new Error('Invalid context snapshot')
  validateKnowledge(data.knowledge, data.role)
  const seen = new Set()
  for (const item of data.sourceCut.events) {
    if (!Number.isSafeInteger(item.seq) || item.seq < 0 || item.seq > data.sourceCut.throughSeq || seen.has(item.seq)
      || typeof item.type !== 'string' || !hash.test(item.hash ?? '')) throw new Error('Invalid context source cut')
    seen.add(item.seq)
  }
  if (new Set(data.input.map(item => item.messageId)).size !== data.input.length) throw new Error('Duplicate context input identity')
  if (data.previous !== null && (data.previous?.schemaVersion !== 1 || !hash.test(data.previous.snapshotHash ?? '')
    || !hash.test(data.previous.knowledgeVersion ?? '') || !gitHash.test(data.previous.commit ?? '')
    || !Number.isSafeInteger(data.previous.contextEpoch) || data.previous.contextEpoch < 1)) throw new Error('Invalid previous context checkpoint')
  const epoch = data.previous === null ? 1 : data.previous.contextEpoch + (data.previous.knowledgeVersion === data.knowledge.version ? 0 : 1)
  if (data.contextEpoch !== epoch) throw new Error('Context epoch does not match its knowledge version')
  return data
}

/** The caller supplies the native SDK's fold of this exact raw-log prefix. */
export function verifyContextCut(snapshot, events, nodes) {
  const history = events.filter(event => event.seq <= snapshot.sourceCut.throughSeq)
  const prefix = new Map(history.map(event => [event.seq, event]))
  const surface = nodes.map(seq => {
    const event = prefix.get(seq)
    if (!event) throw new Error('Context source event is missing')
    return event
  })
  if (!isDeepStrictEqual(contextReferences(surface), snapshot.sourceCut.events)) throw new Error('Context source cut contradicts the native surface')
  const input = new Map()
  for (const event of history) {
    if (event.type === 'agent/inbox/spliced') for (const message of event.data.inserted) input.set(message.id, message)
  }
  for (const item of snapshot.input) {
    if (!input.has(item.messageId) || contextHash(input.get(item.messageId)) !== item.hash) throw new Error('Context input does not match its accepted native Inbox bytes')
  }
}

export function contextAuditEvent(event) {
  return !event.ignorable || [contextSnapshotType, 'plugin:mbot/compact-input', 'plugin:mbot/compact-output'].includes(event.type)
}
