import type z from '@deepseek-ai/schemastery'
import type { ConversationRegistration } from './conversations.js'
export interface BotRegistration {
  schemaVersion: 1
  botId: string
  name: string
  workspacePath: string
  workspaceId: string | null
  mainSessionId: string | null
  /** Null for legacy/unbound registrations; reservations survive partial setup. */
  binding: { state: 'provisioning' | 'ready' | 'failed'; pendingSessionId: string | null; error: string | null } | null
  defaultRole: string
  createdAt: string
}
export interface BotRegistrySnapshot {
  schemaVersion: 3
  revision: number
  selectedBotId: string | null
  bots: BotRegistration[]
  retiredBots: RetiredBot[]
  conversations: ConversationRegistration[]
}
export interface RetiredBot { bot: BotRegistration; sessionIds: string[]; retiredAt: string }
export type BotRegistryInput = BotRegistrySnapshot
  | { schemaVersion: 1; revision: number; selectedBotId: string | null; bots: BotRegistration[]; retiredBots?: never; conversations?: never }
  | { schemaVersion: 2; revision: number; selectedBotId: string | null; bots: BotRegistration[]; retiredBots: RetiredBot[]; conversations?: never }
export declare const BotRegistration: z<BotRegistration, BotRegistration>
export declare const BotRegistrySchema: z<BotRegistryInput, BotRegistryInput>
export declare const RetiredBot: z<RetiredBot, RetiredBot>
export declare function BotRegistry(input: BotRegistryInput): BotRegistrySnapshot
export declare function registryTransition(previous: BotRegistryInput, next: BotRegistryInput): BotRegistrySnapshot
export declare const emptyRegistry: BotRegistrySnapshot
export declare function registration(workspacePath: string, options?: { name?: string; defaultRole?: string }): BotRegistration
export declare function uniqueName(registry: BotRegistrySnapshot, candidate: BotRegistration, explicit?: boolean): BotRegistration
export declare function findBot(registry: BotRegistrySnapshot, identity: string): BotRegistration
export declare function revise(registry: BotRegistrySnapshot, change: Partial<BotRegistrySnapshot>): BotRegistrySnapshot
