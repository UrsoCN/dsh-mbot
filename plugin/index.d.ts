import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'

export declare const name: 'mbot'
export declare const inject: string[]
export interface Config { workspace: Volatile<string> }
export declare const Config: z<{ workspace?: string | null }, Config>
export declare const packageRoot: string
export interface ExecuteOptions { signal?: AbortSignal; input?: string }
export interface ExecuteResult { exitCode: number; stdout: string; stderr: string; truncated: boolean; workspace?: string }
export declare class MBotService extends Service {
  static inject: string[]
  constructor(ctx: Context, config: Config)
  workspace(): string
  initialize(directory?: string, options?: ExecuteOptions): Promise<ExecuteResult>
  execute(program: 'mbot' | 'botctl', args: string[], options?: ExecuteOptions): Promise<ExecuteResult>
}
export declare function apply(ctx: Context, config: Config): void
declare module '@deepseek-ai/cordis' { interface Context { mbot: MBotService } }
