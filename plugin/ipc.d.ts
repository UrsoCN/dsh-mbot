import { Context, Service } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
export declare const name: 'mbot-ipc'
export declare const inject: string[]
export interface Config { enabled: boolean; directory: string }
export declare const Config: z<{ enabled?: boolean; directory?: string }, Config>
export interface IpcStatus {
  state: 'starting' | 'ready' | 'disabled' | 'unavailable' | 'busy' | 'failed'
  directory?: string; socketPath?: string; profileId?: string; instanceId?: string; error?: string
}
export declare class MBotIpc extends Service {
  static inject: string[]
  constructor(ctx: Context, config: Config)
  status(): IpcStatus
  close(): Promise<void>
}
export declare function apply(ctx: Context, config: Config): Promise<void>
declare module '@deepseek-ai/cordis' { interface Context { mbotIpc: MBotIpc } }
