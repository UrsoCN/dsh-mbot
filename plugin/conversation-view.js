// Registry-aware Host helpers. Pure Git readers live in domain-view.js.
import { validateConversation } from './conversations.js'
import { contextHash } from './context-hash.js'
import { policyAtScope, readDomainView } from './domain-view.js'
export { conversationViewLimits, readDomainView, conversationViewDocument, inspectConversationView } from './domain-view.js'

export function conversationViewScope(registration) {
  const record = validateConversation(registration)
  return { botId: record.botId, conversationId: record.conversationId, conversationKey: record.conversationKey,
    sessionId: record.sessionId, visibility: record.source.visibility,
    accessHash: contextHash({ source: record.source, allowedSenders: record.allowedSenders, replyRoute: record.replyRoute }) }
}

export function conversationViewPath(registration) {
  return `memory/conversations/${validateConversation(registration).conversationId}/VIEW.json`
}

/** Human-published policy, bound to the durable reservation rather than a display name. */
export function conversationViewPolicy(input, registration, role) {
  return policyAtScope(input, conversationViewScope(registration), role)
}

export function readConversationView(workspace, commit, registration, role) {
  return readDomainView(workspace, commit, conversationViewScope(registration), role)
}
