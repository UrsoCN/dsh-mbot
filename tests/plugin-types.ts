import { Context } from '@deepseek-ai/cordis'
import * as plugin from 'dsh-mbot'
import * as tools from 'dsh-mbot/tools'
import * as commands from 'dsh-mbot/commands'
import * as runtime from 'dsh-mbot/runtime'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
const managedSummaryPurpose: GenerateOptions['purpose'] = 'mbot-compaction'
void managedSummaryPurpose
import * as ipc from 'dsh-mbot/ipc'

const ctx = new Context()
ctx.plugin(plugin, { workspace: '/tmp/mbot-types' })
ctx.plugin(tools)
ctx.plugin(commands)
const result: Promise<plugin.ExecuteResult> = ctx.mbot.execute('botctl', ['lint'], { signal: new AbortController().signal })
void result
tools.toolCommand({ action: 'board_add', text: 'typed command' })
commands.commandArgs('status')
const registry: plugin.BotRegistrySnapshot = ctx.mbot.registry()
const bot: Promise<plugin.BotRegistration> = ctx.mbot.importBot('/tmp/mbot-types', { name: 'example', revision: registry.revision })
void bot
ctx.mbot.workspace({ sessionId: 'main-session' })
ctx.mbot.selectBot('example', { revision: registry.revision })
const binding: Promise<plugin.BotRegistration> = ctx.mbot.ensureBinding('example', { revision: registry.revision })
void binding
ctx.mbot.resolveMainSession('example', { revision: registry.revision })
const turn: Promise<plugin.TurnLease> = ctx.mbot.beginTurn({ botId: 'example', sessionId: 'session', turn: 1, request: 'hello' })
void turn
const recovery: Promise<plugin.RecoverTurnResult> = ctx.mbot.recoverTurn({ botId: 'example' })
void recovery
declare const managedResult: plugin.TurnResult
const outcome: plugin.ManagedOutcome = managedResult.outcome
const failureEffect: plugin.FailureCountEffect = managedResult.failureCountEffect
void outcome
void failureEffect
ctx.plugin(runtime)
ctx.plugin(runtime, { workers: true })
declare const managedAgent: import('@deepseek-ai/dsh-agent').Agent
ctx.mbotRuntime.attach(managedAgent, { botId: 'example' })
ctx.mbotRuntime.settled(managedAgent)
const retirement = ctx.mbotRuntime.prepareRemoval('example')
const removalVerification: Promise<void> = retirement.verifySessions(new AbortController().signal)
const removalRelease: Promise<void> = retirement.release()
void removalVerification
void removalRelease
const contextCheckpoint: Promise<runtime.ContextCheckpoint | null> = ctx.mbotRuntime.checkpoint(managedAgent)
void contextCheckpoint
const compactedResult = ctx.mbotRuntime.compact(managedAgent)
void compactedResult
const workerResult: Promise<runtime.WorkerReceipt | string> = ctx.mbotRuntime.workerAction(managedAgent, 'worker_spawn', { bot: 'coder', task_id: '001' }, new AbortController().signal)
void workerResult
const runtimeStatus: Promise<runtime.RuntimeStatus> = ctx.mbotRuntime.status(managedAgent)
const stopped: Promise<runtime.RuntimeStopResult> = ctx.mbotRuntime.stop(managedAgent, { signal: new AbortController().signal })
void runtimeStatus
void stopped
const mailbox: runtime.OwnerMailbox = ctx.mbotRuntime.ownerMailbox(managedAgent, {
  visibility: 'owner-private', adapterId: 'tg', ownerId: 'verified-owner', conversationKey: 'private-chat', replyRoute: 'private-chat',
})
const delivery: Promise<runtime.MessageDeliveryReceipt> = mailbox.send({ requestId: 'platform-event-id', text: 'hello' })
const receipt: Promise<runtime.MessageReceipt | undefined> = mailbox.receipt('platform-event-id')
void receipt
mailbox.dispose()
void delivery
ctx.plugin(ipc, { directory: '/tmp/mbot-ipc-types' })
const ipcStatus: ipc.IpcStatus = ctx.mbotIpc.status()
void ipcStatus
