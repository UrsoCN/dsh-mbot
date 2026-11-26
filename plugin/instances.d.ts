import type z from '@deepseek-ai/schemastery'
export interface BotRegistration {
  schemaVersion: 1
  botId: string
  name: string
  workspacePath: string
  workspaceId: string | null
  mainSessionId: string | null
  defaultRole: string
  createdAt: string
}
export interface BotRegistrySnapshot {
  schemaVersion: 1
  revision: number
  selectedBotId: string | null
  bots: BotRegistration[]
}
export declare const BotRegistration: z<BotRegistration, BotRegistration>
export declare const BotRegistrySchema: z<BotRegistrySnapshot, BotRegistrySnapshot>
export declare function BotRegistry(input: BotRegistrySnapshot): BotRegistrySnapshot
export declare const emptyRegistry: BotRegistrySnapshot
export declare function registration(workspacePath: string, options?: { name?: string; defaultRole?: string }): BotRegistration
export declare function uniqueName(registry: BotRegistrySnapshot, candidate: BotRegistration, explicit?: boolean): BotRegistration
export declare function findBot(registry: BotRegistrySnapshot, identity: string): BotRegistration
export declare function revise(registry: BotRegistrySnapshot, change: Partial<BotRegistrySnapshot>): BotRegistrySnapshot
