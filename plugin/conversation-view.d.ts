import type { ConversationRegistration } from './conversations.js'
export interface ConversationViewScope {
  botId: string; conversationId: string; conversationKey: string; sessionId: string
  visibility: 'user-private' | 'group' | 'peer'; accessHash: string
}
export interface ConversationViewPolicy {
  schemaVersion: 1; botId: string; conversationId: string; conversationKey: string; role: string
  protocol: string; soul: string; memory: string[]; references: string[]
}
export interface ConversationDocumentIdentity { path: string; blob: string; contentHash: string }
export interface ConversationKnowledge {
  schemaVersion: 2; scope: ConversationViewScope; role: string; policy: ConversationDocumentIdentity
  documents: (ConversationDocumentIdentity & { kind: 'protocol' | 'soul' | 'memory' | 'reference' })[]; version: string
}
export interface ConversationViewInspection {
  schemaVersion: 1; head: string; knowledge: ConversationKnowledge
  documents: (ConversationKnowledge['documents'][number] & { bytes: number })[]
}
export interface ConversationView extends Omit<ConversationViewInspection, 'documents'> {
  policy: ConversationViewPolicy
  documents: (ConversationViewInspection['documents'][number] & { text: string })[]
}
export declare const conversationViewLimits: Readonly<{ policyBytes: number; documentBytes: number; totalBytes: number; documents: number }>
export declare function conversationViewScope(registration: ConversationRegistration): ConversationViewScope
export declare function conversationViewPath(registration: ConversationRegistration): string
export declare function conversationViewPolicy(input: ConversationViewPolicy, registration: ConversationRegistration, role: string): ConversationViewPolicy
export declare function readConversationView(workspace: string, commit: string | undefined, registration: ConversationRegistration, role: string): ConversationView
export declare function conversationViewDocument(view: ConversationView, path: string): string
export declare function inspectConversationView(view: ConversationView): ConversationViewInspection
