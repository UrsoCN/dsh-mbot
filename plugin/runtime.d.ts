import { Context, Service } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ActorIdentity, ActorLease, TurnLease } from './turn.js'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
export declare const name: 'mbot-runtime'
export declare const inject: string[]
export interface Config { /** Task-scoped native Workers; default true. False keeps foreground-only turns. */ workers?: boolean }
export declare const Config: z<Config>
export type WorkerAction = 'worker_spawn' | 'worker_wait' | 'worker_message' | 'worker_stop'
export interface WorkerRequest { bot?: string; task_id?: string; text?: string; worker_id?: string }
export interface WorkerReceipt { worker_id: string; name?: string; role?: string; task_id?: string; stopReason?: SubagentResult['stopReason']; output?: SubagentResult['output']; native?: import('./turn.js').NativeWorkerProof }
export interface WorkerAssignment extends ActorIdentity { schemaVersion: 1; memoryCommit: string; snapshotHash: string }
export interface WorkerNativeLog { session: Agent['session']['header']; inheritedEventCount: number; events: readonly SessionEvent[] }
export declare const runtimeRecordType: 'plugin:mbot/runtime-turn'
export interface RuntimeTurnReceipt {
  schemaVersion: 1; botId: string; sessionId: string; turn: number
  phase: 'active' | 'auditing' | 'committed' | 'rejected' | 'failed' | 'cancelled'
  runId?: string; memoryCommit?: string; head?: string; meta?: string; success?: boolean; reason?: string; error?: string
  outcome?: import('./turn.js').ManagedOutcome; failureCountEffect?: import('./turn.js').FailureCountEffect
}
export interface RuntimeStatus {
  botId: string; sessionId: string
  state: 'idle' | 'active' | 'admitting' | 'auditing' | 'failed' | 'unavailable' | 'retired' | 'removing' | 'recovering'
  queued: { nextTurn: number; nextStep: number }
  lastReceipt?: RuntimeTurnReceipt & { seq: number }; error?: string
}
export interface RuntimeStopResult extends RuntimeStatus {
  /** Captured turn; status may already describe work accepted afterward. */
  targetTurn?: number; receipt?: RuntimeTurnReceipt & { seq: number }
}
export interface OwnerMailboxBinding {
  visibility: 'owner-private'; adapterId: string; ownerId: string
  conversationKey: string; replyRoute: string
}
export interface OwnerMessageInput { requestId: string; text: string; correlationId?: string }
export interface MessageDeliveryReceipt {
  /** Persisted native request, independent of model completion or Git audit. */
  confirmation: 'confirmed' | 'unconfirmed'
  rpcId: string; messageId: string; requestId: string; botId: string
  conversationKey: string; replyRoute: string
  delivery: 'queued' | 'claimed' | 'ended' | 'cancelled'; turn?: number; reason?: string
}
export interface VerifiedReply {
  schemaVersion: 1; replyId: string; botId: string; sessionId: string; requestId: string; rpcId: string; messageId: string
  conversationKey: string; replyRoute: string; adapterId: string; ownerId: string; correlationId?: string
  turn: number; outcome: import('./turn.js').ManagedOutcome; commit: string; endEventSeq: number; assistantEventSeq: number | null; text: string
}
export interface MessageResult {
  schemaVersion: 1; status: 'queued' | 'running' | 'auditing' | 'recovering' | 'unverified' | import('./turn.js').ManagedOutcome
  final: boolean; observedThroughSeq: number; error?: string; reply?: VerifiedReply
  audit?: { commit: string; observedHead: string; runId: string; meta: string; memoryCommit: string;
    outcome: import('./turn.js').ManagedOutcome; failureCountEffect: import('./turn.js').FailureCountEffect; success: boolean }
}
export interface MessageReceipt extends MessageDeliveryReceipt { result: MessageResult }
export interface OwnerMailbox {
  readonly binding: Readonly<OwnerMailboxBinding & { schemaVersion: 1; botId: string }>
  /** Returns after admission flush, never waits for a model response. */
  send(input: OwnerMessageInput): Promise<MessageDeliveryReceipt>
  receipt(requestId: string): Promise<MessageReceipt | undefined>
  dispose(): void
}
export declare class MBotRuntime extends Service {
  static inject: string[]
  static Config: typeof Config
  constructor(ctx: Context, config?: Config)
  /** Trusted Host attachment; use before the Agent starts work. */
  attach(agent: Agent, options: { botId: string }): Promise<void>
  managed(agent: Agent): boolean
  worker(agent: Agent): boolean
  /** Recovery-only native write handle; never activates an Agent or an Actor permit. */
  acquireRecoveryWorker(journal: Record<string, unknown>, actor: Record<string, unknown>, signal?: AbortSignal): Promise<{ log: WorkerNativeLog; dispose(): Promise<void> }>
  /** Read native child logs referenced by this parent's captured catalog. */
  workerLogs(events: readonly SessionEvent[]): Promise<WorkerNativeLog[]>
  /** Scoped to this active Chief turn; a wait signal cancels observation only. */
  workerAction(agent: Agent, action: WorkerAction, args: WorkerRequest, signal: AbortSignal): Promise<WorkerReceipt | string>
  /** Trusted Host coordinator; retains the Runtime's Cordis dependency scope. */
  coordinateRecovery(bot: import('./instances.js').BotRegistration, journal: Record<string, unknown> | undefined, options?: import('./index.js').ManagementOptions & { retiredSessionIds?: string[] }): Promise<import('./index.js').RecoverTurnResult | undefined>
  /** Trusted removal coordinator: hold before ConfigEditor save, commit only its saved retirement. */
  prepareRemoval(botId: string): { sessionIds: string[]; commit(retired: import('./instances.js').RetiredBot): Promise<void>; release(): void }
  /** Trusted Host capability: caller verifies the owner and binds a private main route. */
  ownerMailbox(agent: Agent, binding: OwnerMailboxBinding): OwnerMailbox
  /** Trusted Host contract: the tool joins all writers before returning. */
  foregroundTool(name: string): () => void
  dataLease(agent: Agent): TurnLease | ActorLease
  settled(agent: Agent): Promise<void>
  status(agent: Agent): Promise<RuntimeStatus>
  stop(agent: Agent, options?: { signal?: AbortSignal }): Promise<RuntimeStopResult>
}
export declare function apply(ctx: Context, config?: Config): Promise<void>
declare module '@deepseek-ai/cordis' { interface Context { mbotRuntime: MBotRuntime } }
declare module '@deepseek-ai/dsh-session/types' { interface PluginRecordMap {
  'plugin:mbot/runtime-turn': RuntimeTurnReceipt
  'plugin:mbot/worker-assignment': WorkerAssignment
} }
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mbot-owner-rpc': { kind: 'user'; rpcId: string; mbot: OwnerMailboxBinding & {
      schemaVersion: 1; botId: string; requestId: string; fingerprint: string; correlationId?: string
    } }
  }
}
