import { Service } from '@deepseek-ai/cordis'
import * as nativeBash from '@deepseek-ai/dsh-tool-bash'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { botSections, reconcileContext, turnContext } from './context.js'
import { redact } from './redact.js'
import { MessageIndex, ownerBinding, ownerMessage, requestIdentity, validateSource, deliveryReceipt, operationalSource } from './messages.js'
import { messageReceipt } from './receipts.js'
import { recoverRuntime, repairNativeReceipt } from './runtime-recovery.js'

export const name = 'mbot-runtime'
export const inject = ['mbot', 'agents', 'sessions', 'sessionQuery', 'tools', 'systemPrompt']
export const runtimeRecordType = 'plugin:mbot/runtime-turn'
const receiptPhases = ['active', 'auditing', 'committed', 'rejected', 'failed', 'cancelled']

function validReceipt(event) {
  const data = event.data
  return event.type === runtimeRecordType && event.ignorable === true && data?.schemaVersion === 1
    && typeof data.botId === 'string' && typeof data.sessionId === 'string' && Number.isSafeInteger(data.turn) && data.turn > 0
    && receiptPhases.includes(data.phase)
    && ['runId', 'memoryCommit', 'head', 'meta', 'reason', 'error'].every(key => data[key] === undefined || typeof data[key] === 'string')
    && (data.outcome === undefined || ['completed', 'cancelled', 'failed'].includes(data.outcome))
    && (data.failureCountEffect === undefined || ['reset', 'preserve', 'increment'].includes(data.failureCountEffect))
    && (data.success === undefined || typeof data.success === 'boolean')
}

// Agent-owned gates outlive a Runtime reload. An unavailable owner fails closed;
// a replacement Runtime adopts the same cell rather than stacking old guards.
const cells = new WeakMap()
const foregroundTools = ['botctl', 'bash', 'read', 'read_image', 'write', 'edit', 'apply_patch', 'glob', 'grep',
  'web_search', 'web_fetch', 'ask_user_question', 'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read']

function requireState(cell) {
  if (cell.retired) throw new Error('This Bot was removed; its old managed Session is retired')
  if (!cell.state || cell.state.closing || cell.state.runtime.closed) throw new Error('MBot Runtime is unavailable for this managed Session')
  if (cell.state.retiring) throw new Error('Bot removal is in progress; this managed Session is blocked')
  if (cell.state.runtime.recoveries.has(cell.state.botId)) throw new Error('Bot recovery is in progress; accepted input stays in the native Inbox')
  if (cell.state.runtime.ctx.mbot.registry().retiredBots.some(entry => entry.bot.botId === cell.state.botId)) throw new Error('This Bot was removed; its old managed Session is retired')
  return cell.state
}

async function flushInput(ctx, session, signal) {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers()
  const cancel = () => aborted.reject(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  try { await Promise.race([ctx.sessions.flush(session), aborted.promise]) }
  finally { signal.removeEventListener('abort', cancel) }
}

function installGates(agent, cell) {
  const ctx = agent.ctx
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (!cell.state && event.type === 'turn/start') cell.parked = []
    cell.state?.observe(event)
  })
  ctx.on('agent/inbox/claimed', ({ message, turn }) => {
    const state = cell.state
    if (state?.current?.turn === turn) state.current.messages.push(message)
    else (cell.parked ??= []).push(message)
  })
  for (const [order, section] of botSections({ role: 'chief', soul: '', protocol: '', memory: '', roleMemory: '' }).entries()) {
    ctx.systemPrompt.section({ ...section, order: order * 10,
      text: () => cell.state?.current?.lease ? botSections(cell.state.current.lease.snapshot)[order].text : '' })
  }
  ctx.systemPrompt.context({ name: 'mbot:turn', order: 130, required: true, interpolate: false,
    text: () => turnContext(cell.state?.current) })
  ctx.on('system-prompt/assemble', async (presentation, input, next) => {
    let state
    try { state = requireState(cell) }
    catch (error) {
      const messages = cell.state?.current?.messages ?? cell.parked ?? []
      if (input.signal && !input.signal.aborted && messages.length) {
        agent.inbox.splice('next-turn', 0, 0, messages)
        if (cell.state?.current) cell.state.current.messages = []
        cell.parked = []
      }
      throw error
    }
    if (input.agent !== agent) throw new Error('MBot prompt scope mismatch')
    // Diagnostics never acquire a transaction or retain their cancellation.
    if (!input.signal) return next()
    const record = await state.admit(input.signal)
    const assembled = await next()
    const owned = new Map(botSections(record.lease.snapshot).map(section => [section.name, section]))
    return { ...assembled, sections: assembled.sections.map(section => owned.get(section.name) ?? section),
      contexts: assembled.contexts.map(context => context.name === 'mbot:turn' ? { ...context, text: turnContext(record) } : context) }
  }, { prepend: true })
  ctx.on('agent/pre-step', async (input, next) => {
    const state = requireState(cell)
    const record = await state.admit(input.signal)
    record.step = input.step
    // Reassembly verifies the final public result (including complete sections)
    // and refreshes the head before native automatic compaction sees history.
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal: input.signal, modelSelection: input.modelSelection })
    const changed = await reconcileContext(state.runtime.ctx, agent, assembly, record, input.signal)
    const decision = await next()
    if (decision.kind === 'enter') {
      const claimed = new Map(record.messages.map(message => [message.id, message]))
      for (const message of decision.messages) {
        const original = claimed.get(message.id)
        if (operationalSource(message)) continue
        if (!original || JSON.stringify(original.source) !== JSON.stringify(message.source)) {
          state.parkInput(record, input.signal)
          throw new Error('Pre-step producer bypassed MBot message admission')
        }
      }
    }
    return changed && decision.kind === 'enter' ? { ...decision, startsRequestSeries: true } : decision
  }, { prepend: true })
  ctx.tools.guard(exec => {
    try {
      const state = requireState(cell)
      if (exec.agent !== agent || !state.current?.lease || state.current.ended) return 'No active MBot turn owns this tool call'
      // Workers need role snapshots and a shared lease before their activation
      // can be enabled; lifecycle tools cannot create unowned detached writers.
      if (['spawn_agent', 'send_message'].includes(exec.name)) return 'Managed Worker routing is not yet connected'
      if (!state.runtime.foreground.has(exec.name)) return 'This tool has no managed foreground lifetime contract'
      if (state.current.lease.runtimeOwnership && !state.current.lease.runtimeOwnership.tools.includes(exec.name)) return 'This tool was not in the captured turn ownership contract'
      if (exec.name === 'bash' && (cell.bashFiber?.state !== 2
        || ctx.tools.get('bash', agent, exec.toolSet) !== ctx.tools.get('bash', agent))) {
        // Cordis const enum FiberState.ACTIVE is 2. Reject a tool admission
        // captured before the official scoped foreground composition was ready.
        return 'Managed Bash admission predates its foreground setup; retry'
      }
    } catch (error) { return error.message }
  })
  ctx.on('tools/execute', async (exec, next) => {
    const state = requireState(cell)
    const record = state.current
    if (!record?.lease || record.ended) throw new Error('No active MBot turn owns this tool call')
    const operation = next()
    record.calls.add(operation)
    try { return record.lease.redactResult(await operation) }
    finally { record.calls.delete(operation) }
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const lease = cell.state?.current?.lease
    return lease ? lease.redactResult(decision) : decision
  })
  ctx.effect(() => () => { cell.state = undefined })
}

class ManagedSession {
  constructor(runtime, agent, botId) {
    this.runtime = runtime
    this.agent = agent
    this.botId = botId
    this.pending = Promise.resolve()
    this.closing = false
    this.error = undefined
    this.messageIndex = new MessageIndex()
    this.messageOperations = Promise.resolve()
    this.earlyEvents = []
  }

  async initialize() {
    const log = await this.runtime.ctx.sessionQuery.readSession(this.agent.id)
    this.inheritedEventCount = log.inheritedEventCount
    for (const event of [...log.events, ...this.earlyEvents]) this.messageIndex.apply(event, this.inheritedEventCount)
    this.earlyEvents = undefined
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
        end: Promise.withResolvers(), admitted: new Set(), dispatched: new Set() }
    }
    const record = this.current
    if (!record || record.ended) return
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
        if (this.error) throw this.error
        const bot = this.runtime.ctx.mbot.bot({ botId: this.botId })
        if (bot.binding && bot.binding.state !== 'ready') throw new Error('MBot main Session binding needs /mbot repair before business turns')
        await this.confirmInput(record, signal)
        const request = record.messages.map(message => JSON.stringify({ id: message.id, source: message.source, content: message.content })).join('\n')
        record.lease = await this.runtime.ctx.mbot.beginTurn({ botId: this.botId, sessionId: this.agent.id, turn: record.turn, request,
          messages: record.messages,
          requestIds: record.messages.map(requestIdentity).filter(value => typeof value === 'string'),
          signal, writerScope: 'agent-runtime', runtimeOwnership: { schemaVersion: 1, mode: 'foreground-only', workerDepth: 0, tools: [...this.runtime.foreground].sort() },
          onExpiry: () => this.expire(record), onCancel: message => this.stop(record, message) })
        await this.publish(record, 'active').catch(error => { record.feedbackError = error })
        for (const event of record.events) this.record(record, event)
        record.events = []
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
      validateSource(message, this.botId)
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
    record.reason = { kind: 'aborted', message }
    if (this.current === record && !record.ended) {
      this.agent.cancel({ kind: 'hook', reason: message }, { keepInbox: true })
    }
    await record.end.promise
    await Promise.allSettled([...record.calls])
  }

  async settle(record) {
    try {
      try { await record.admission }
      catch (error) {
        await this.publish(record, record.signal?.aborted ? 'cancelled' : 'failed', { error: error.message ?? String(error) })
        await this.runtime.ctx.sessions.flush(this.agent.session)
        return
      }
      if (!record.lease) return
      await Promise.allSettled([...record.calls])
      await this.publish(record, 'auditing').catch(error => { record.feedbackError = error })
      record.result = await record.lease.finish({ reason: record.reason, text: record.text ?? '' })
      await this.publish(record, record.result.success ? 'committed' : 'rejected')
      await this.runtime.ctx.sessions.flush(this.agent.session)
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

  async close() {
    this.closing = true
    this.agent.cancel({ kind: 'hook', reason: 'MBot Runtime disposed' }, { keepInbox: true })
    await this.agent.whenIdle()
    await this.pending.catch(() => {})
  }
}

/** Agent-scoped transaction owner. Native DSH remains the conversation driver. */
export class MBotRuntime extends Service {
  static inject = inject

  constructor(ctx) {
    super(ctx, 'mbotRuntime')
    this.states = new Map()
    this.foreground = new Set(foregroundTools)
    this.foregroundOwners = new Map()
    this.attachments = new Map()
    this.recoveries = new Map()
    this.closed = false
    ctx.on('agent/created', async ({ agent }) => {
      const retired = ctx.mbot.registry().retiredBots.find(entry => entry.sessionIds.includes(agent.id))
      if (retired) { this.attachRetired(agent, retired); return }
      const bot = ctx.mbot.registry().bots.find(bot => bot.mainSessionId === agent.id || bot.binding?.pendingSessionId === agent.id)
      if (bot) await this.attach(agent, { botId: bot.botId })
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const state = this.states.get(agent)
      void state?.pending.finally(() => {
        if (this.states.get(agent) === state) this.states.delete(agent)
      }).catch(() => {})
    })
    ctx.inject(['shellEnv'], child => {
      child.shellEnv.register({ name: 'mbot-turn', variables: {
        DSH_MBOT_WS: { description: 'Managed Bot data directory.' },
        DSH_MBOT_RUN_ID: { description: 'Managed Bot turn identity.' },
        DSH_MBOT_PERMIT_TOKEN: { description: 'Private data transaction permission; never include in output.' },
        DSH_MBOT_BOTCTL: { description: 'Bundled botctl executable for managed shell calls.' },
      }, resolve: exec => this.states.get(exec.agent)?.current?.lease?.shellEnvironment() ?? {} })
    })
    ctx.effect(() => async () => {
      this.closed = true
      await Promise.allSettled([...this.recoveries.values()].map(item => item.promise))
      await Promise.allSettled([...this.attachments.values()].map(item => item.promise))
      await Promise.allSettled([...this.states.values()].map(state => state.close()))
      for (const [agent, state] of this.states) {
        const cell = cells.get(agent)
        if (cell?.state === state) cell.state = undefined
      }
      this.states.clear()
    })
  }

  async [Service.init]() {
    for (const agent of this.ctx.agents.list()) {
      const retired = this.ctx.mbot.registry().retiredBots.find(entry => entry.sessionIds.includes(agent.id))
      if (retired) {
        if (agent.status !== 'idle') {
          agent.cancel({ kind: 'hook', reason: 'Retiring removed MBot Session' }, { keepInbox: true })
          await agent.whenIdle()
        }
        this.attachRetired(agent, retired)
        continue
      }
      const bot = this.ctx.mbot.registry().bots.find(bot => bot.mainSessionId === agent.id || bot.binding?.pendingSessionId === agent.id)
      if (!bot) continue
      if (agent.status !== 'idle') {
        agent.cancel({ kind: 'hook', reason: 'Preparing managed MBot Session' }, { keepInbox: true })
        await agent.whenIdle()
      }
      await this.attach(agent, { botId: bot.botId })
    }
  }

  attach(agent, { botId }) {
    if (this.attachments.has(agent)) {
      const existing = this.attachments.get(agent)
      return existing.botId === botId ? existing.promise : Promise.reject(new Error('Managed Session cannot be redirected to another Bot'))
    }
    const pending = this.attachNew(agent, botId)
    this.attachments.set(agent, { botId, promise: pending })
    void pending.finally(() => this.attachments.delete(agent)).catch(() => {})
    return pending
  }

  async attachNew(agent, botId) {
    if (this.closed) throw new Error('MBot Runtime is disposed')
    if (this.ctx.mbot.registry().retiredBots.some(entry => entry.sessionIds.includes(agent.id)) || cells.get(agent)?.retired) throw new Error('Removed Bot Session cannot be redirected to another Bot')
    if (this.states.has(agent)) {
      if (this.states.get(agent).botId !== botId) throw new Error('Managed Session cannot be redirected to another Bot')
      return
    }
    const bot = this.ctx.mbot.bot({ botId })
    if (!bot || agent.session.header.cwd !== bot.workspacePath) throw new Error('Managed Session must belong to the Bot data directory')
    if (agent.session.header.origin === 'subagent') throw new Error('Managed Worker routing is not yet connected')
    if (agent.status !== 'idle') throw new Error('Attach MBot Runtime before Agent work starts')
    let cell = cells.get(agent)
    if (!cell) {
      cell = {}
      cells.set(agent, cell)
      installGates(agent, cell)
    } else if (cell.state && !cell.state.runtime.closed) throw new Error('Managed Session already has a Runtime owner')
    const state = new ManagedSession(this, agent, botId)
    cell.state = state
    this.states.set(agent, state)
    try {
      await state.initialize()
      if (!cell.bashInstalled && this.ctx.tools.get('bash', agent)) {
        // The official foreground-only composition kills and joins commands
        // at timeout; a returned job receipt is not writer-quiescence proof.
        for (const name of ['shell', 'shellEnv', 'workingDirectory']) {
          if (!agent.ctx.get(name)) throw new Error(`Managed Bash requires ${name}`)
        }
        cell.bashFiber = await agent.ctx.plugin(nativeBash, { enableRunInBackground: false, promoteOnTimeout: false })
        cell.bashInstalled = true
      }
      if (this.closed) throw new Error('MBot Runtime disposed during attachment')
    } catch (error) {
      this.states.delete(agent)
      if (cell.state === state) cell.state = undefined
      throw error
    }
  }

  managed(agent) { return this.states.has(agent) }

  /** Enter through the service method so Cordis retains Runtime dependency scope. */
  coordinateRecovery(bot, journal, options = {}) {
    return journal ? recoverRuntime(this, bot, journal, options) : repairNativeReceipt(this, bot, options)
  }

  attachRetired(agent, retired) {
    let cell = cells.get(agent)
    if (!cell) { cell = {}; cells.set(agent, cell); installGates(agent, cell) }
    const state = this.states.get(agent)
    const onlyHeldAdmission = state?.retiring && !state.current?.lease && !state.current?.admission
    if (state && !onlyHeldAdmission && (agent.status !== 'idle' || state.current && !state.current.settled)) throw new Error('Bot is busy; wait for its managed turn/audit before removal')
    if (onlyHeldAdmission) {
      const pending = new Set([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(message => message.id))
      const messages = state.current?.messages.filter(message => !pending.has(message.id)) ?? []
      if (messages.length) agent.inbox.splice('next-turn', 0, 0, messages)
    }
    if (state) state.closing = true
    cell.state = undefined
    cell.retired = structuredClone(retired)
    this.states.delete(agent)
  }

  /** Reversible pre-save gate. No active turn/tool/audit is cancelled by removal. */
  prepareRemoval(botId) {
    if (this.closed || this.recoveries.has(botId) || [...this.attachments.values()].some(item => item.botId === botId)) throw new Error('Bot Runtime attachment/recovery is busy')
    const states = [...this.states.values()].filter(state => state.botId === botId)
    if (states.some(state => state.closing || state.retiring || state.agent.status !== 'idle' || state.current && !state.current.settled)) throw new Error('Bot is busy; stop and settle its current turn before removal')
    for (const state of states) state.retiring = true
    let committed = false
    return {
      sessionIds: states.map(state => state.agent.id),
      commit: retired => {
        committed = true
        for (const state of states) this.attachRetired(state.agent, retired)
      },
      release: () => { if (!committed) for (const state of states) state.retiring = false },
    }
  }

  /** Host capability: the caller verifies owner identity and binds the route. */
  ownerMailbox(agent, options) {
    const state = this.states.get(agent)
    if (!state || this.closed || state.closing) throw new Error('Session is not managed by the active MBot Runtime')
    if (state.earlyEvents) throw new Error('Managed Session attachment is still initializing')
    const bot = this.ctx.mbot.bot({ botId: state.botId })
    if (bot.mainSessionId !== agent.id || bot.binding?.state !== 'ready') throw new Error('Owner mailbox requires a ready Bot main Session')
    const binding = ownerBinding(options, state.botId)
    let revoked = false
    const check = () => {
      if (revoked || this.closed || state.closing || state.retiring || this.states.get(agent) !== state || this.ctx.mbot.closed) throw new Error('MBot owner mailbox is unavailable')
      const current = this.ctx.mbot.bot({ botId: state.botId })
      if (current.mainSessionId !== agent.id || current.binding?.state !== 'ready') throw new Error('Bot main Session binding changed; reopen the mailbox')
    }
    const operation = run => {
      const pending = state.messageOperations.then(() => { check(); return run() })
      state.messageOperations = pending.catch(() => {})
      return pending
    }
    return Object.freeze({
      binding,
      send: input => {
        // Own caller bytes before the first await, including duplicate retries.
        let message
        try { check(); message = ownerMessage(binding, input) }
        catch (error) { return Promise.reject(error) }
        return operation(async () => {
          let record = state.messageIndex.requests.get(requestIdentity(message))
          if (record) {
            if (record.conflict || record.message.source.mbot?.fingerprint !== message.source.mbot.fingerprint) throw new Error('Request identity was reused with changed content or reply route')
          } else {
            agent.followup(message)
            record = state.messageIndex.requests.get(requestIdentity(message))
          }
          try {
            await this.ctx.sessions.flush(agent.session)
            check()
            return deliveryReceipt(record, 'confirmed')
          } catch {
            // Append may already be durable, claimed, or executing. Same-ID
            // retry inspects native history; it never inserts a replacement.
            return deliveryReceipt(record, 'unconfirmed')
          }
        })
      },
      receipt: async requestId => {
        check()
        const probe = ownerMessage(binding, { requestId, text: 'receipt lookup' })
        const record = state.messageIndex.requests.get(requestIdentity(probe))
        if (!record) return undefined
        if (record.conflict) throw new Error('Request identity was reused with changed content or duplicate native input')
        const source = record.message.source.mbot
        if (!source || Object.keys(binding).some(key => source[key] !== binding[key])) throw new Error('Request belongs to a different owner route')
        let confirmation = 'confirmed'
        try { await this.ctx.sessions.flush(agent.session); check() }
        catch { confirmation = 'unconfirmed' }
        const receipt = await messageReceipt(this, agent, state.botId, record.rpcId, binding, confirmation)
        check()
        return receipt
      },
      dispose: () => { revoked = true },
    })
  }

  /** Trusted Host declaration: the tool must join every writer before returning. */
  foregroundTool(name) {
    if (this.closed || typeof name !== 'string' || !name || !this.ctx.tools.get(name) || ['run_code', 'spawn_agent', 'send_message'].includes(name)) throw new Error('Register a known foreground tool; lifecycle tools require managed ownership')
    this.foregroundOwners.set(name, (this.foregroundOwners.get(name) ?? 0) + 1)
    this.foreground.add(name)
    let active = true
    return () => {
      if (!active) return
      active = false
      const count = this.foregroundOwners.get(name) - 1
      if (count) this.foregroundOwners.set(name, count)
      else {
        this.foregroundOwners.delete(name)
        if (!foregroundTools.includes(name)) this.foreground.delete(name)
      }
    }
  }

  dataLease(agent) {
    const state = this.states.get(agent)
    if (!state || state.closing || !state.current?.lease || state.current.ended) throw new Error('No active MBot turn owns this data operation')
    return state.current.lease
  }

  async settled(agent) { await this.states.get(agent)?.pending }

  async status(agent) {
    const state = this.states.get(agent)
    if (!state) {
      const retired = cells.get(agent)?.retired
      if (retired) return { botId: retired.bot.botId, sessionId: agent.id, state: 'retired',
        queued: { nextTurn: agent.inbox.nextTurn.length, nextStep: agent.inbox.nextStep.length }, error: 'Bot was removed; old Session will not execute business turns' }
      throw new Error('Session is not managed by the active MBot Runtime')
    }
    const record = state.current
    let lastReceipt = state.lastReceipt
    if (!lastReceipt) {
      const log = await this.ctx.sessionQuery.readSession(agent.id)
      const event = log.events.findLast(event => validReceipt(event) && event.data.botId === state.botId && event.data.sessionId === agent.id)
      if (event) lastReceipt = { ...event.data, seq: event.seq }
    }
    const error = state.error ? record?.lease ? await record.lease.redactResult(state.error.message ?? String(state.error))
      : await redact(state.error.message ?? String(state.error), this.ctx.mbot.bot({ botId: state.botId }).workspacePath) : undefined
    return structuredClone({ botId: state.botId, sessionId: agent.id,
      state: this.closed || state.closing ? 'unavailable' : this.recoveries.has(state.botId) ? 'recovering' : state.retiring ? 'removing' : error ? 'failed'
        : record && !record.ended ? record.lease ? 'active' : 'admitting' : record && !record.settled ? 'auditing' : 'idle',
      queued: { nextTurn: agent.inbox.nextTurn.length, nextStep: agent.inbox.nextStep.length },
      ...(lastReceipt ? { lastReceipt } : {}), ...(error ? { error } : {}) })
  }

  /** Cancel the captured turn; later accepted inputs remain in the native Inbox. */
  async stop(agent, options = {}) {
    options = { ...options }
    options.signal?.throwIfAborted()
    const state = this.states.get(agent)
    if (!state || this.closed || state.closing) throw new Error('Session is not managed by the active MBot Runtime')
    const record = state.current
    if (record && !record.ended) {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      await record.end.promise
      await record.settlement
    } else await state.pending
    options.signal?.throwIfAborted()
    return { ...await this.status(agent), ...(record ? { targetTurn: record.turn, ...(record.receipt ? { receipt: structuredClone(record.receipt) } : {}) } : {}) }
  }

  async report(error, botId, lease) {
    const bot = this.ctx.mbot.bot({ botId })
    this.ctx.logger.warn(lease ? await lease.redactResult(error.message ?? String(error)) : await redact(error.message ?? String(error), bot?.workspacePath))
  }
}

export function apply(ctx) { ctx.plugin(MBotRuntime) }
