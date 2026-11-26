import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { BotRegistration, BotRegistrySnapshot } from './instances.js'
export type { BotRegistration, BotRegistrySnapshot } from './instances.js'

export declare const name: 'mbot'
export declare const inject: string[]
export interface Config { workspace: Volatile<string>; registry: Volatile<BotRegistrySnapshot> }
export declare const Config: z<{ workspace?: string | null; registry?: BotRegistrySnapshot | null }, Config>
export declare const packageRoot: string
export interface BotSelection { botId?: string; sessionId?: string }
export interface ExecuteOptions extends BotSelection { signal?: AbortSignal; input?: string; /** Trusted Host override; not exposed to the model tool. */ workspace?: string }
export interface ManagementOptions { signal?: AbortSignal; revision?: number }
export interface ImportOptions extends ManagementOptions { name?: string; defaultRole?: string }
export interface ExecuteResult { exitCode: number; stdout: string; stderr: string; truncated: boolean; workspace?: string }
export declare class MBotService extends Service {
  static inject: string[]
  constructor(ctx: Context, config: Config)
  registry(): BotRegistrySnapshot
  bot(options?: BotSelection): BotRegistration | undefined
  workspace(options?: BotSelection & { workspace?: string }): string
  importBot(directory: string, options?: ImportOptions): Promise<BotRegistration>
  selectBot(identity: string, options?: ManagementOptions): Promise<BotRegistration>
  describeBots(): Promise<string>
  initialize(directory?: string, options?: ExecuteOptions): Promise<ExecuteResult>
  execute(program: 'mbot' | 'botctl', args: string[], options?: ExecuteOptions): Promise<ExecuteResult>
}
export declare function apply(ctx: Context, config: Config): void
declare module '@deepseek-ai/cordis' { interface Context { mbot: MBotService } }
