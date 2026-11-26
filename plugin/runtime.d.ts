import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TurnLease } from './turn.js'
export declare const name: 'mbot-runtime'
export declare const inject: string[]
export declare class MBotRuntime extends Service {
  static inject: string[]
  constructor(ctx: Context)
  /** Trusted Host attachment; use before the Agent starts work. */
  attach(agent: Agent, options: { botId: string }): Promise<void>
  managed(agent: Agent): boolean
  /** Trusted Host contract: the tool joins all writers before returning. */
  foregroundTool(name: string): () => void
  dataLease(agent: Agent): TurnLease
  settled(agent: Agent): Promise<void>
}
export declare function apply(ctx: Context): void
declare module '@deepseek-ai/cordis' { interface Context { mbotRuntime: MBotRuntime } }
