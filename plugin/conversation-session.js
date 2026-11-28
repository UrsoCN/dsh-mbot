// Per-conversation session turn state machine.
// Reserves explicit conversationKey/visibility/sessionId identity boundaries
// while preserving current single owner-private main conversation admission.
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { workerTools } from './workers.js'
import { redact } from './redact.js'
import { MessageIndex, requestIdentity, validateSource } from './messages.js'
import { captureContext, restoreContext } from './context-checkpoint.js'
import { verifyManagedCompactions } from './compaction.js'
import { conversationViewScope } from './conversation-view.js'
import { freezeContext } from './context-hash.js'
import { conversationForSession } from './conversations.js'
import { validateConversationMessage } from './conversation-messages.js'

export const runtimeRecordType = 'plugin:mbot/runtime-turn'
const receiptPhases = ['active', 'auditing', 'committed', 'rejected', 'failed', 'cancelled']

export function validReceipt(event) {
  const data = event.data
  return event.type === runtimeRecordType && event.ignorable === true && data?.schemaVersion === 1
    && typeof data.botId === 'string' && typeof data.sessionId === 'string' && Number.isSafeInteger(data.turn) && data.turn > 0
    && receiptPhases.includes(data.phase)
    && ['runId', 'memoryCommit', 'head', 'meta', 'reason', 'error'].every(key => data[key] === undefined || typeof data[key] === 'string')
    && (data.outcome === undefined || ['completed', 'cancelled', 'failed'].includes(data.outcome))
    && (data.failureCountEffect === undefined || ['reset', 'preserve', 'increment'].includes(data.failureCountEffect))
    && (data.success === undefined || typeof data.success === 'boolean')
}

async function flushInput(ctx, session, signal) {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers()
  const cancel = () => aborted.reject(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  try { await Promise.race([ctx.sessions.flush(session), aborted.promise]) }
  finally { signal.removeEventListener('abort', cancel) }
}

export class ConversationSession {
  constructor(runtime, agent, botId, options = {}) {
    this.runtime = runtime
    this.agent = agent
    this.botId = botId
    this.domainScope = options.conversationId ? freezeContext(conversationViewScope(options)) : undefined
    // Versioned identity descriptor separating Host Bot, conversation, and native Session.
    this.conversation = Object.freeze({
      schemaVersion: 1,
      botId,
      conversationKey: options.conversationKey ?? 'main',
      visibility: options.source?.visibility ?? options.visibility ?? 'owner-private',
      sessionId: agent.id,
      ...(options.conversationId ? { conversationId: options.conversationId, state: options.state } : {}),
    })
    this.pending = Promise.resolve()
    this.closing = false
    this.initializing = true
    this.error = undefined
    this.messageIndex = new MessageIndex()
    this.messageOperations = Promise.resolve()
    this.contextOperations = Promise.resolve()
    this.compactionCatalog = new Map()
    this.earlyEvents = []
  }

  async initialize() {
    const log = await this.runtime.ctx.sessionQuery.readSession(this.agent.id)
    this.inheritedEventCount = log.inheritedEventCount
    for (const event of [...log.events, ...this.earlyEvents]) this.messageIndex.apply(event, this.inheritedEventCount)
    this.earlyEvents = undefined
    await restoreContext(this)
  }

  observe(event) {
    if (this.earlyEvents) this.earlyEvents.push(event)
    else {
      try { this.messageIndex.apply(event, this.inheritedEventCount) }
      catch (error) { this.error = error }
    }
    if (event.type === runtimeRecordType) return
    if (event.type === 'turn/start') {
      this.current = { turn: event.data.turn, step: 1, messages: [], events: [], calls: new Set(), ended: false,
        end: Promise.withResolvers(), admitted: new Set(), dispatched: new Set(), ...(this.domainScope ? { domainEvents: new Set() } : {}) }
    }
    const record = this.current
    if (!record || record.ended) return
    record.domainEvents?.add(event.seq)
    if (event.type.startsWith('compaction/') || ['plugin:mbot/compact-input', 'plugin:mbot/compact-output'].includes(event.type)) record.compactionSeen = true
    if (event.type === 'user/message') record.dispatched.add(event.data.id)
    if (event.type === 'assistant/message') record.text = event.data.message.content
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (record.lease) this.record(record, event)
    else record.events.push(event)
    if (event.type !== 'turn/end') return
    record.ended = true
    record.reason = event.data.reason
    record.end.resolve()
    if (record.lease || record.admission) {
      this.pending = record.settlement = this.settle(record)
      void this.pending.catch(error => { this.error = error; void this.runtime.report(error, this.botId, record.lease).catch(() => {}) })
    } else record.settled = true
  }

  record(record, event) {
    void record.lease.record(event).catch(error => {
      this.error = error
      queueMicrotask(() => this.agent.cancel({ kind: 'hook', reason: 'MBot audit transport failed' }, { keepInbox: true }))
    })
  }

  async admit(signal) {
    const record = this.current
    if (!record || record.ended) throw new Error('MBot admission requires an open Agent turn')
    if (!record.admission) {
      record.signal = signal
      record.admission = (async () => {
        await this.pending
        signal.throwIfAborted()
        if (this.closing || this.retiring || this.runtime.closed) throw new Error('MBot Runtime is unavailable')
        if (this.runtime.coordinator?.isSleeping(this.botId)) throw new Error('Bot is sleeping; accepted input stays in the native Inbox until /mbot wake')
        if (this.runtime.coordinator?.isBlocked(this.botId)) throw new Error('Bot maintenance is in progress; accepted input stays in the native Inbox')
        if (this.error) throw this.error
        const bot = this.runtime.ctx.mbot.bot({ botId: this.botId })
        if (bot.binding && bot.binding.state !== 'ready') throw new Error('MBot main Session binding needs /mbot repair before business turns')
        await this.confirmInput(record, signal)
        const request = record.messages.map(message => JSON.stringify({ id: message.id, source: message.source, content: message.content })).join('\n')
        record.lease = await this.runtime.ctx.mbot.beginTurn({ botId: this.botId, sessionId: this.agent.id, turn: record.turn, request,
          messages: record.messages,
          requestIds: record.messages.map(requestIdentity).filter(value => typeof value === 'string'),
          signal, writerScope: 'agent-runtime', compactionPolicyVersion: 1, runtimeOwnership: this.runtime.workersEnabled && this.runtime.workerManager && bot.defaultRole === 'chief' ? { schemaVersion: 2, mode: 'foreground-workers', workerDepth: 1, maxWorkers: 2, tools: [...this.runtime.foreground].sort(), workerTools }
            : { schemaVersion: 1, mode: 'foreground-only', workerDepth: 0, tools: [...this.runtime.foreground].sort() },
          onExpiry: () => this.expire(record), onCancel: message => this.stop(record, message) })
        for (const event of record.events) this.record(record, event)
        record.events = []
        await captureContext(this, record)
        await this.publish(record, 'active').catch(error => { record.feedbackError = error })
        return record
      })()
      void record.admission.catch(() => {
        // A failed admission must not silently consume already-claimed input.
        // Cancellation ends the attempted request; other failures park it in
        // the one authoritative DSH Inbox for inspection and a later wake.
        this.parkInput(record, signal)
      })
    }
    await record.admission
    // Explicit steer/inject can be claimed after the first step. They pass
    // the same source and persistence gate before any later model dispatch.
    try { await this.confirmInput(record, signal) }
    catch (error) { this.parkInput(record, signal); throw error }
    return record
  }

  async confirmInput(record, signal) {
    const fresh = record.messages.filter(message => !record.admitted.has(message.id))
    if (!fresh.length) return
    for (const message of fresh) {
      if (this.domainScope) {
        const registration = conversationForSession(this.runtime.ctx.mbot.registry(), this.agent.id)
        if (!registration || registration.botId !== this.botId) throw new Error('Conversation permission is unavailable')
        validateConversationMessage(message, registration)
      } else validateSource(message, this.botId)
      this.messageIndex.match(message)
    }
    // Native append/followup does not itself guarantee a storage flush. This
    // awaited gate covers native Web and adapters before lease/model dispatch.
    await flushInput(this.runtime.ctx, this.agent.session, signal)
    signal.throwIfAborted()
    if (this.closing || this.retiring || this.runtime.closed || this.error) throw this.error ?? new Error('MBot Runtime is unavailable')
    for (const message of fresh) record.admitted.add(message.id)
  }

  parkInput(record, signal) {
    // Teardown preserves unexecuted claims. A user stop cancels its captured
    // input, while model-visible input is never requeued.
    if (signal.aborted && !this.closing && !this.runtime.closed) return
    const pending = new Set([...this.agent.inbox.nextTurn, ...this.agent.inbox.nextStep].map(message => message.id))
    const fresh = record.messages.filter(message => !record.dispatched.has(message.id) && !pending.has(message.id))
    if (fresh.length) this.agent.inbox.splice('next-turn', 0, 0, fresh)
  }

  async expire(record) {
    return this.stop(record, 'Managed turn timeout')
  }

  async stop(record, message) {
    // Only the native turn/end defines the audit outcome. A late expiry or
    // teardown callback must not overwrite an already recorded completion.
    if (this.current === record && !record.ended) {
      this.agent.cancel({ kind: 'hook', reason: message }, { keepInbox: true })
    }
    await record.end.promise
    await Promise.allSettled([...record.calls])
    const workers = await Promise.allSettled([...record.workers ?? []].map(member => member.completion))
    const failure = workers.find(item => item.status === 'rejected')
    if (failure) throw failure.reason
  }

  async settle(record) {
    try {
      try { await record.admission }
      catch (error) {
        if (!record.lease) {
          await this.publish(record, record.signal?.aborted ? 'cancelled' : 'failed', { error: error.message ?? String(error) })
          await this.runtime.ctx.sessions.flush(this.agent.session)
          return
        }
        // Capture can fail after the data lease was acquired. Close that lease
        // using the real blocked/cancelled native outcome, retaining its audit.
      }
      if (!record.lease) return
      await Promise.allSettled([...record.calls])
      const workers = await Promise.allSettled([...record.workers ?? []].map(member => member.completion))
      const failed = workers.find(item => item.status === 'rejected')
      if (failed) throw failed.reason
      if (record.lease.snapshot.knowledge) await verifyManagedCompactions(this, record)
      await this.publish(record, 'auditing').catch(error => { record.feedbackError = error })
      record.result = await record.lease.finish({ reason: record.reason, text: record.text ?? '' })
      await this.publish(record, record.result.success ? 'committed' : 'rejected')
      await this.runtime.ctx.sessions.flush(this.agent.session)
      if (this.domainScope) await restoreContext(this)
      if (record.context) this.checkpoint = { ...record.context, commit: record.result.head, meta: record.result.meta, turn: record.turn }
      for (const proof of record.compactions ?? []) this.compactionCatalog.set(proof.compactionId, proof)
      if (record.compactions?.length && this.checkpoint) this.checkpoint.compactions = record.compactions
      return record.result
    } catch (error) {
      const message = record.lease ? await record.lease.redactResult(error.message ?? String(error))
        : await redact(error.message ?? String(error), this.runtime.ctx.mbot.bot({ botId: this.botId }).workspacePath)
      const failure = new Error(message)
      this.error = record.failure = failure
      if (record.lease) { this.failedAuditRunId = record.lease.identity.runId; this.failedAuditRecord = record }
      await this.publish(record, 'failed', { error: message }).catch(() => {})
      await this.runtime.ctx.sessions.flush(this.agent.session).catch(() => {})
      throw failure
    } finally { record.settled = true }
  }

  async publish(record, phase, details = {}) {
    const data = { schemaVersion: 1, botId: this.botId, sessionId: this.agent.id, turn: record.turn, phase,
      ...(record.lease ? { runId: record.lease.identity.runId, memoryCommit: record.lease.snapshot.head } : {}),
      ...(record.result ? { head: record.result.head, meta: record.result.meta, success: record.result.success } : {}),
      ...(record.result?.outcome ? { outcome: record.result.outcome, failureCountEffect: record.result.failureCountEffect } : {}),
      ...(record.reason ? { reason: record.reason.kind } : {}), ...details }
    if (data.error !== undefined) data.error = record.lease
      ? await record.lease.redactResult(data.error)
      : await redact(data.error, this.runtime.ctx.mbot.bot({ botId: this.botId }).workspacePath)
    const seq = appendPluginRecord(this.agent.session, runtimeRecordType, data)
    record.receipt = this.lastReceipt = Object.freeze({ ...data, seq })
    return seq
  }

  async drainOperations() {
    await this.pending.catch(() => {})
    await this.messageOperations.catch(() => {})
    await this.contextOperations.catch(() => {})
  }

  async abortAttachment() {
    if (!this.initializing || this.current?.lease || this.current?.calls.size) throw new Error('Cannot discard an attachment with managed writers')
    this.closing = true
    // Native setup and agent/created run inside publication maintenance.
    // whenIdle() would wait for the callback that is awaiting this rollback.
    // The initialization gate prevents managed turns; join only our owned
    // operations here and let the native factory drain its failed publication.
    // Its disposed cause must also own cancellation, suppressing queued wakes.
    await this.drainOperations()
    if (this.current?.lease || this.current?.calls.size) throw new Error('Managed writers appeared during attachment rollback')
  }

  async close() {
    this.closing = true
    this.agent.cancel({ kind: 'hook', reason: 'MBot Runtime disposed' }, { keepInbox: true })
    await this.agent.whenIdle()
    await this.drainOperations()
    if (this.agent.status !== 'idle' || this.current?.calls.size || this.current?.lease && !this.current.lease.transportEnded) throw new Error('Managed Session writers have not drained for Runtime handoff')
  }
}
