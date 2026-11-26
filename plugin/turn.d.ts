import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { MBotService, ExecuteResult } from './index.js'
export interface ContextSnapshot {
  readonly head: string
  readonly role: string
  readonly workspace: string
  readonly protocol: string
  readonly soul: string
  readonly memory: string
  readonly roleMemory: string
  readonly board: string
}
export interface TurnIdentity { readonly botId: string; readonly sessionId: string; readonly turn: number; readonly runId: string }
export interface TurnOutcome { reason: { kind: string; [key: string]: unknown }; text: string }
export interface TurnResult { readonly kind: 'finished'; readonly runId: string; readonly head: string; readonly meta: string; readonly transcript: string; readonly success: boolean }
export interface BeginTurnOptions { botId?: string; sessionId: string; turn: number; request: string; requestIds?: string[]; /** Admission cancellation; published work uses cancel(). */ signal?: AbortSignal; finalizationTimeoutMs?: number; writerScope?: 'data-subprocesses' | 'agent-runtime'; /** Required for agent-runtime: cancel and join the model/tools before settlement. */ onExpiry?: () => Promise<void>; onCancel?: (message: string) => Promise<void> }
export declare class TurnLease {
  readonly identity: TurnIdentity
  readonly snapshot: ContextSnapshot
  readonly transportEnded: boolean
  readonly expiresAt: number
  /** Host-only environment; private token must be redacted from tool results. */
  shellEnvironment(): Record<string, string>
  redactResult<T>(value: T): Promise<T>
  record(event: SessionEvent): Promise<void>
  execute(program: 'mbot' | 'botctl', args: string[], options?: { signal?: AbortSignal; input?: string }): Promise<ExecuteResult>
  finish(outcome: TurnOutcome): Promise<TurnResult>
  cancel(message?: string): Promise<TurnResult>
}
export declare function openTurn(mbot: MBotService, root: string, bot: import('./instances.js').BotRegistration, options: BeginTurnOptions): Promise<TurnLease>
