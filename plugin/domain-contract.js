// Pure domain identity and writer contract shared by Host and standalone helpers.
import { isDeepStrictEqual } from 'node:util'
import { contextHash } from './context-hash.js'

const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const digest = /^[a-f0-9]{64}$/u
const gitHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
export const domainOwnership = Object.freeze({ schemaVersion: 3, mode: 'domain-foreground', workerDepth: 0, tools: Object.freeze(['botctl']) })
export const domainCandidateOwnership = Object.freeze({ schemaVersion: 4, mode: 'domain-candidates', workerDepth: 0, tools: Object.freeze(['botctl']), candidateVersion: 1 })

export const domainJournalVersion = ownership => validateDomainOwnership(ownership).schemaVersion === 4 ? 5 : 4

export function validateDomainScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).sort().join() !== ['accessHash', 'botId', 'conversationId', 'conversationKey', 'sessionId', 'visibility'].join()
    || !new RegExp(`^bot-${uuid}$`, 'u').test(scope.botId ?? '')
    || !new RegExp(`^conversation-${uuid}$`, 'u').test(scope.conversationId ?? '')
    || !new RegExp(`^session-${uuid}$`, 'u').test(scope.sessionId ?? '')
    || !/^domain:[a-f0-9]{64}$/u.test(scope.conversationKey ?? '') || !digest.test(scope.accessHash ?? '')
    || !['user-private', 'group', 'peer'].includes(scope.visibility)) throw new Error('Invalid conversation scope')
  return scope
}

export function validateDomainOwnership(value) {
  if (!isDeepStrictEqual(value, domainOwnership) && !isDeepStrictEqual(value, domainCandidateOwnership)) throw new Error('Unsupported domain writer ownership contract')
  return value
}

export function validateDomainHeader(header) {
  const scope = validateDomainScope(header.conversation)
  validateDomainOwnership(header.runtimeOwnership)
  if (header.botId !== scope.botId || header.sessionId !== scope.sessionId || header.writerScope !== 'agent-runtime'
    || header.compactionPolicyVersion !== undefined) throw new Error('Domain turn identity or maintenance contract is unsupported')
  return scope
}

export function validateDomainJournal(journal) {
  validateDomainHeader(journal)
  if (journal.schemaVersion !== domainJournalVersion(journal.runtimeOwnership) || journal.actors !== undefined || !digest.test(journal.contextHash ?? '')) throw new Error('Domain turn requires its versioned journal without Worker permits and with its context hash')
  return journal
}

export function domainPath(path, scope) {
  validateDomainScope(scope)
  if (typeof path !== 'string' || path.length > 1024 || !path.endsWith('.md') || /[\x00-\x1f\x7f\\]/u.test(path)
    || path.split('/').some(part => !part || part.startsWith('.') || part.trim() !== part)
    || !(path.startsWith('memory/shared/') || path.startsWith(`memory/conversations/${scope.conversationId}/`))) {
    throw new Error('Conversation document must be a Markdown file in shared memory or its own domain')
  }
  return path
}

export function validateDomainKnowledge(knowledge, role) {
  const scope = validateDomainScope(knowledge?.scope)
  const policy = knowledge.policy
  if (knowledge.schemaVersion !== 2 || knowledge.role !== role || !/^[a-z][a-z0-9_-]{0,31}$/u.test(role) || role === 'human'
    || !policy || policy.path !== `memory/conversations/${scope.conversationId}/VIEW.json`
    || !gitHash.test(policy.blob ?? '') || !digest.test(policy.contentHash ?? '')
    || !Array.isArray(knowledge.documents) || knowledge.documents.length < 2 || knowledge.documents.length > 64
    || knowledge.documents[0]?.kind !== 'protocol' || knowledge.documents[1]?.kind !== 'soul') throw new Error('Invalid domain knowledge identity')
  let references = false
  for (const [index, document] of knowledge.documents.entries()) {
    domainPath(document.path, scope)
    if (!gitHash.test(document.blob ?? '') || !digest.test(document.contentHash ?? '')) throw new Error('Invalid domain document identity')
    if (index < 2) continue
    if (document.kind === 'reference') references = true
    else if (document.kind !== 'memory' || references) throw new Error('Invalid domain knowledge order')
  }
  if (new Set(knowledge.documents.map(item => item.path)).size !== knowledge.documents.length
    || knowledge.version !== contextHash({ scope, role, policy, documents: knowledge.documents })) throw new Error('Invalid domain knowledge version')
  return knowledge
}
