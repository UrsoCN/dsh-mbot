import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { authorizeConversationSource } from './conversations.js'
import { conversationViewScope } from './conversation-view.js'
import { domainMessageBinding, domainEnvelope, validateDomainMessage } from './domain-message.js'

export function conversationMessageBinding(registration, attestation) {
  const record = authorizeConversationSource(registration, attestation)
  return domainMessageBinding(conversationViewScope(record), { adapterId: record.source.adapterId,
    senderId: attestation.senderId, replyRoute: record.replyRoute })
}

export function conversationMessage(binding, input) {
  return createUserMessage(domainEnvelope(binding, input))
}

/** Recheck the immutable native envelope against current persistent permission. */
export function validateConversationMessage(message, registration) {
  const binding = validateDomainMessage(message, conversationViewScope(registration))
  conversationMessageBinding(registration, { ...registration.source, adapterId: binding.adapterId,
    senderId: binding.senderId, replyRoute: binding.replyRoute })
}
