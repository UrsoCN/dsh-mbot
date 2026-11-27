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
export type ManagedOutcome = 'completed' | 'cancelled' | 'failed'
export type FailureCountEffect = 'reset' | 'preserve' | 'increment'
export interface TurnResult { readonly kind: 'finished'; readonly runId: string; readonly head: string; readonly meta: string; readonly transcript: string; readonly success: boolean; readonly outcome: ManagedOutcome; readonly failureCountEffect: FailureCountEffect }
export type RuntimeOwnership = { schemaVersion: 1; mode: 'foreground-only'; workerDepth: 0; tools: readonly string[] }
  | { schemaVersion: 2; mode: 'foreground-workers'; workerDepth: 1; maxWorkers: 2; tools: readonly string[]; workerTools: readonly string[] }
export interface ActorIdentity { readonly botId: string; readonly runId: string; readonly parentSessionId: string; readonly parentTurn: number; readonly sessionId: string; readonly role: string; readonly taskId: string; readonly actorId: string }
export interface ActorSnapshot extends ContextSnapshot { readonly taskId: string; readonly task: string }
export declare class ActorLease {
  private constructor()
  readonly identity: Readonly<ActorIdentity>
  readonly snapshot: Readonly<ActorSnapshot>
  /** Admission flag; await close() for data quiescence and revocation. */
  readonly closed: boolean
  shellEnvironment(): Record<string, string>
  redactResult<T>(value: T): Promise<T>
  execute(program: 'botctl', args: string[], options?: { signal?: AbortSignal; input?: string }): Promise<ExecuteResult>
  /** Data calls drain here; the caller must also join its native Agent/tools. */
  close(): Promise<void>
}
export interface BeginTurnOptions { runtimeOwnership?: RuntimeOwnership; botId?: string; sessionId: string; turn: number; request: string; requestIds?: string[]; /** Native claimed input, required to seal agent-runtime replies. */ messages?: readonly import('@deepseek-ai/dsh-llm').UserMessage[]; /** Admission cancellation; published work uses cancel(). */ signal?: AbortSignal; finalizationTimeoutMs?: number; writerScope?: 'data-subprocesses' | 'agent-runtime'; /** Required for agent-runtime: cancel and join the model/tools before settlement. */ onExpiry?: () => Promise<void>; onCancel?: (message: string) => Promise<void> }
export declare class TurnLease {
  readonly identity: TurnIdentity
  readonly snapshot: ContextSnapshot
  readonly runtimeOwnership?: Readonly<RuntimeOwnership>
  readonly transportEnded: boolean
  readonly expiresAt: number
  /** Host-only environment; private token must be redacted from tool results. */
  shellEnvironment(): Record<string, string>
  redactResult<T>(value: T): Promise<T>
  record(event: SessionEvent): Promise<void>
  execute(program: 'mbot' | 'botctl', args: string[], options?: { signal?: AbortSignal; input?: string }): Promise<ExecuteResult>
  /** Trusted Host only; publish the native child after this reservation. */
  delegate(options: { sessionId: string; role: string; taskId: string }): Promise<ActorLease>
  finish(outcome: TurnOutcome): Promise<TurnResult>
  cancel(message?: string): Promise<TurnResult>
}
export declare function openTurn(mbot: MBotService, root: string, bot: import('./instances.js').BotRegistration, options: BeginTurnOptions): Promise<TurnLease>
