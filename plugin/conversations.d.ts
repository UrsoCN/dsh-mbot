import type z from '@deepseek-ai/schemastery'
import type { BotRegistrySnapshot, BotRegistration } from './instances.js'

export interface ConversationSource {
  adapterId: string; platform: string; accountId: string; spaceId: string; threadId: string | null
  visibility: 'user-private' | 'group' | 'peer'; principalId: string | null
}
export interface ConversationAccess { source: ConversationSource; allowedSenders: string[]; replyRoute: string }
export interface ConversationRegistration extends ConversationAccess {
  schemaVersion: 1; conversationId: string; botId: string; conversationKey: string; sessionId: string
  /** Ownership reservation only: no model, tools or private context may run yet. */
  state: 'reserved'; createdAt: string
}
export type ConversationAttestation = ConversationSource & { senderId: string; replyRoute: string }
export declare const ConversationSource: z<ConversationSource, ConversationSource>
export declare const ConversationRegistration: z<ConversationRegistration, ConversationRegistration>
export declare function conversationSource(input: ConversationSource): ConversationSource
export declare function conversationKey(input: ConversationSource): string
export declare function conversationAccess(input: ConversationAccess): ConversationAccess
export declare function validateConversation(input: ConversationRegistration): ConversationRegistration
export declare function reserveConversationRecord(botId: string, input: ConversationAccess): ConversationRegistration
export declare function authorizeConversationSource(record: ConversationRegistration, source: ConversationAttestation): ConversationRegistration
export declare function conversationForSession(registry: BotRegistrySnapshot, sessionId: string): ConversationRegistration | undefined
export declare function botSessionIds(registry: BotRegistrySnapshot, bot: BotRegistration): string[]
