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
const domain: plugin.ConversationAccess = { source: { adapterId: 'fixture', platform: 'telegram', accountId: 'bot',
  spaceId: 'chat', threadId: null, visibility: 'user-private', principalId: 'alice' }, allowedSenders: ['alice'], replyRoute: 'chat' }
const conversation: Promise<plugin.ConversationRegistration> = ctx.mbot.reserveConversation('example', domain, { revision: registry.revision })
void conversation
ctx.mbot.conversation('example', domain.source)
ctx.mbot.authorizeConversation('example', { ...domain.source, senderId: 'alice', replyRoute: 'chat' })
const conversationView: Promise<plugin.ConversationViewInspection> = ctx.mbot.inspectConversationView('example', domain.source)
void conversationView
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
declare const contextSnapshot: runtime.ContextCheckpoint['snapshot']
if (contextSnapshot.schemaVersion === 2) {
  const domainKnowledge: plugin.ConversationKnowledge = contextSnapshot.knowledge
  const domainId: string = domainKnowledge.scope.conversationId
  void domainId
} else {
  const privateKnowledgeVersion: 1 = contextSnapshot.knowledge.schemaVersion
  void privateKnowledgeVersion
}
const compactedResult = ctx.mbotRuntime.compact(managedAgent)
void compactedResult
const sleptResult = ctx.mbotRuntime.sleep('example', { skipDream: true, compact: false })
const wokenResult = ctx.mbotRuntime.wake('example')
const overviewResult = ctx.mbotRuntime.overview()
void sleptResult
void wokenResult
void overviewResult
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
const domainMailbox: runtime.ConversationMailbox = ctx.mbotRuntime.conversationMailbox(managedAgent, {
  ...domain.source, senderId: 'alice', replyRoute: 'chat',
})
const domainDelivery: Promise<runtime.ConversationDeliveryReceipt> = domainMailbox.send({ requestId: 'event', text: 'hello domain' })
const boundDomainId: string = domainMailbox.binding.conversationId
void boundDomainId
void domainDelivery
domainMailbox.receipt('event').then(value => { const sender: string | undefined = value?.result.reply?.senderId; void sender })
domainMailbox.dispose()
ctx.plugin(ipc, { directory: '/tmp/mbot-ipc-types' })
const ipcStatus: ipc.IpcStatus = ctx.mbotIpc.status()
void ipcStatus
