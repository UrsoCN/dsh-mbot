import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { BotRegistration, BotRegistrySnapshot, BotRegistryInput, RetiredBot } from './instances.js'
import type { TurnLease, BeginTurnOptions } from './turn.js'
export type { BotRegistration, BotRegistrySnapshot, BotRegistryInput, RetiredBot } from './instances.js'
export type { TurnLease, BeginTurnOptions, ContextSnapshot, ContextKnowledge, TurnResult, ManagedOutcome, FailureCountEffect } from './turn.js'

export declare const name: 'mbot'
export declare const inject: string[]
export interface Config { workspace: Volatile<string>; registry: Volatile<BotRegistryInput> }
export declare const Config: z<{ workspace?: string | null; registry?: BotRegistryInput | null }, Config>
export declare const packageRoot: string
export interface BotSelection { botId?: string; sessionId?: string }
export interface ExecuteOptions extends BotSelection { signal?: AbortSignal; input?: string; /** Trusted Host override; not exposed to the model tool. */ workspace?: string; /** Host-held active transaction identity. */ permit?: { runId: string; token: string }; /** Host asserts its owned data calls have settled. */ recoveryOwner?: { pid: number; start: string; runtimeProof?: string } }
export interface ManagementOptions { signal?: AbortSignal; revision?: number }
export interface ImportOptions extends ManagementOptions { name?: string; defaultRole?: string }
export type RemoveBotResult = RetiredBot & { alreadyRemoved: boolean }
export interface ExecuteResult { exitCode: number; stdout: string; stderr: string; truncated: boolean; workspace?: string }
export type RecoverTurnResult = { kind: 'recovered'; needed: false; receiptRepaired?: true } | {
  kind: 'recovered'; needed: true; alreadyCommitted: boolean; runId: string; head: string; meta: string; transcript?: string; success: boolean
  outcome: import('./turn.js').ManagedOutcome; failureCountEffect: import('./turn.js').FailureCountEffect
}
export declare class MBotService extends Service {
  static inject: string[]
  constructor(ctx: Context, config: Config)
  registry(): BotRegistrySnapshot
  bot(options?: BotSelection): BotRegistration | undefined
  workspace(options?: BotSelection & { workspace?: string }): string
  importBot(directory: string, options?: ImportOptions): Promise<BotRegistration>
  selectBot(identity: string, options?: ManagementOptions): Promise<BotRegistration>
  removeBot(identity: string, options?: ManagementOptions): Promise<RemoveBotResult>
  describeRemovedBots(): Promise<string>
  /** Create/verify the official workspace and stable managed main Session. */
  ensureBinding(identity: string, options?: ManagementOptions): Promise<BotRegistration>
  /** Open a healthy main without excluding its active data turn. */
  resolveMainSession(identity: string, options?: ManagementOptions): Promise<BotRegistration>
  describeBots(): Promise<string>
  beginTurn(options: BeginTurnOptions): Promise<TurnLease>
  recoverTurn(options?: BotSelection & { signal?: AbortSignal }): Promise<RecoverTurnResult>
  initialize(directory?: string, options?: ExecuteOptions): Promise<ExecuteResult>
  execute(program: 'mbot' | 'botctl', args: string[], options?: ExecuteOptions): Promise<ExecuteResult>
}
export declare function apply(ctx: Context, config: Config): void
declare module '@deepseek-ai/cordis' { interface Context { mbot: MBotService } }
