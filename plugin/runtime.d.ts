import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TurnLease } from './turn.js'
export declare const name: 'mbot-runtime'
export declare const inject: string[]
export declare const runtimeRecordType: 'plugin:mbot/runtime-turn'
export interface RuntimeTurnReceipt {
  schemaVersion: 1; botId: string; sessionId: string; turn: number
  phase: 'active' | 'auditing' | 'committed' | 'rejected' | 'failed' | 'cancelled'
  runId?: string; memoryCommit?: string; head?: string; meta?: string; success?: boolean; reason?: string; error?: string
}
export interface RuntimeStatus {
  botId: string; sessionId: string
  state: 'idle' | 'active' | 'admitting' | 'auditing' | 'failed' | 'unavailable'
  queued: { nextTurn: number; nextStep: number }
  lastReceipt?: RuntimeTurnReceipt & { seq: number }; error?: string
}
export interface RuntimeStopResult extends RuntimeStatus {
  /** Captured turn; status may already describe work accepted afterward. */
  targetTurn?: number; receipt?: RuntimeTurnReceipt & { seq: number }
}
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
  status(agent: Agent): Promise<RuntimeStatus>
  stop(agent: Agent, options?: { signal?: AbortSignal }): Promise<RuntimeStopResult>
}
export declare function apply(ctx: Context): void
declare module '@deepseek-ai/cordis' { interface Context { mbotRuntime: MBotRuntime } }
declare module '@deepseek-ai/dsh-session/types' { interface PluginRecordMap { 'plugin:mbot/runtime-turn': RuntimeTurnReceipt } }
