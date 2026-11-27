import { randomUUID, createHash } from 'node:crypto'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { registerBotctl } from './tools.js'
import { MessageIndex, operationalSource } from './messages.js'
import { workerAssignmentType } from './worker-proof.js'

export const workerTools = Object.freeze(['botctl'])
function startupAborted(error, signals) {
  const seen = new Set()
  for (let cause = error; cause !== undefined && !seen.has(cause); cause = cause?.cause) {
    // Preserve SDK/operation failures even when a concurrent user stop occurs.
    if (cause?.code !== undefined && !['ABORTED', 'ABORTED_BEFORE_DISPATCH'].includes(cause.code)) return false
    if (signals.some(signal => signal.aborted && cause === signal.reason)) return true
    seen.add(cause)
  }
  return false
}
function awaited(operation, signal) {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers()
  const cancel = () => aborted.reject(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  return Promise.race([operation, aborted.promise]).finally(() => signal.removeEventListener('abort', cancel))
}

/** One fresh child owns execution; its Actor owns only scoped data calls. */
export class WorkerSession {
  constructor(runtime, agent, member) {
    this.runtime = runtime
    this.agent = agent
    this.member = member
    this.botId = member.parent.botId
    this.worker = true
    this.initializing = true
    this.closing = false
    this.pending = Promise.resolve()
    this.messageOperations = Promise.resolve()
    this.messageIndex = new MessageIndex()
    this.events = []
    this.writes = Promise.resolve()
  }
  async initialize() {
    const actor = this.member.actor
    appendPluginRecord(this.agent.session, workerAssignmentType, { schemaVersion: 1, ...actor.identity,
      memoryCommit: actor.snapshot.head, snapshotHash: createHash('sha256').update(JSON.stringify(actor.snapshot)).digest('hex') })
    const log = await this.runtime.ctx.sessionQuery.readSession(this.agent.id)
    if (log.inheritedEventCount !== 0) throw new Error('Managed Worker must start with no inherited context')
    this.events = [...new Map([...log.events, ...this.events].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq)
    for (const event of this.events) { this.messageIndex.apply(event, 0); this.record(event) }
    await this.writes
    this.logging = true
    this.initializing = false
    this.agent.ctx.inject(['tools', 'mbot', 'sandboxPolicy'], child => registerBotctl(child, { role: actor.identity.role }))
    this.agent.ctx.tools.restrict({ allow: workerTools })
  }
  record(event) {
    const frozen = structuredClone(event)
    this.writes = this.writes.then(() => this.member.actor.record(frozen))
    void this.writes.catch(error => { this.error = error; this.agent.cancel({ kind: 'hook', reason: 'Worker audit transport failed' }, { keepInbox: true }) })
  }
  observe(event) {
    this.events.push(event)
    if (this.logging) {
      try { this.messageIndex.apply(event, 0) } catch (error) { this.error = error }
      this.record(event)
    }
    if (event.type === 'turn/start') this.current = { worker: true, turn: event.data.turn, step: 1, messages: [], calls: new Set(), ended: false,
      admitted: new Set(), dispatched: new Set(), end: Promise.withResolvers() }
    const current = this.current
    if (!current) return
    if (event.type === 'tool/call' && event.data.name === 'botctl') {
      // Invalid model JSON is handled by the native tool pipeline and audited
      // as a tool failure; it must not throw from a Session event observer.
      let args
      try { args = JSON.parse(event.data.arguments) } catch { /* Not a boot. */ }
      if (args?.action === 'boot' && args.bot === this.member.actor.identity.role && args.task_id === this.member.actor.identity.taskId) this.bootCall = event.data.callId
    }
    if (event.type === 'tool/result' && event.data.message.toolCallId === this.bootCall && event.data.message.isError !== true) this.booted = true
    if (event.type === 'user/message') current.dispatched.add(event.data.id)
    if (event.type === 'turn/end') { current.ended = true; current.settled = true; current.end.resolve() }
  }
  async admit(signal) {
    const record = this.current
    if (!record || record.ended) throw new Error('Worker admission requires an active turn')
    await awaited(this.member.ready.promise, signal)
    if (this.closing || this.member.done || this.runtime.closed || this.error) throw this.error ?? new Error('Worker assignment is unavailable')
    for (const message of record.messages.filter(message => !record.admitted.has(message.id))) {
      if (!operationalSource(message) && !(message.source.kind === 'user' && message.id === this.member.initialMessageId)
        && !(message.source.kind === 'agent-message' && message.source.senderSessionId === this.member.parent.agent.id)) {
        this.parkInput(record, signal)
        throw new Error('Worker input is outside its creator/task binding')
      }
      this.messageIndex.match(message)
    }
    await awaited(this.runtime.ctx.sessions.flush(this.agent.session), signal)
    signal.throwIfAborted()
    for (const message of record.messages) record.admitted.add(message.id)
    record.lease = this.member.actor
    return record
  }
  guard(exec) {
    if (!workerTools.includes(exec.name)) return 'Worker tool has no captured lifetime contract'
    const args = exec.arguments ?? {}
    if (!this.booted && !(args.action === 'boot' && args.bot === this.member.actor.identity.role && args.task_id === this.member.actor.identity.taskId)) return 'Worker must boot its assigned role/task before other operations'
    if (['worker_spawn', 'worker_wait', 'worker_message', 'worker_stop'].includes(args.action)) return 'Workers cannot delegate or control other Agents'
  }
  parkInput(record) {
    const queued = new Set([...this.agent.inbox.nextTurn, ...this.agent.inbox.nextStep].map(message => message.id))
    const fresh = record.messages.filter(message => !record.dispatched.has(message.id) && !queued.has(message.id))
    if (fresh.length) this.agent.inbox.splice('next-turn', 0, 0, fresh)
  }
  async close() {
    if (this.shutdown) return this.shutdown
    this.closing = true
    this.agent.cancel({ kind: 'hook', reason: 'Worker lifetime closed' }, { keepInbox: true })
    return this.shutdown = (async () => {
      await this.agent.whenIdle()
      await Promise.allSettled([...this.current?.calls ?? []])
      await this.writes
    })()
  }
}

/** A turn owns exact SDK activations; no second Inbox or detached writer. */
export class WorkerManager {
  constructor(runtime, ctx) { this.runtime = runtime; this.ctx = ctx; this.members = new Map(); this.closed = false }
  provider() {
    const provider = this.ctx.subagents.getProvider('spawn')
    if (!provider || provider.inheritsParentContext || typeof provider.prepareContinuable !== 'function') throw new Error('Managed Workers require the native fresh spawn provider')
    return provider
  }
  async start(parent, record, args, signal) {
    if (this.closed || this.runtime.closed || record.ended || record.lease?.runtimeOwnership?.schemaVersion !== 2) throw new Error('Worker admission is unavailable')
    const provider = this.provider()
    signal.throwIfAborted()
    record.signal.throwIfAborted()
    const member = { id: `mbot-worker-${randomUUID()}`, parent, record, ready: Promise.withResolvers(), controller: new AbortController(), done: false }
    void member.ready.promise.catch(() => {})
    const cancel = () => this.cancel(member)
    record.signal.addEventListener('abort', cancel, { once: true })
    ;(record.workers ??= new Set()).add(member)
    this.members.set(member.id, member)
    member.starting = (async () => {
      try {
        member.actor = await record.lease.delegate({ sessionId: member.id, role: args.bot, taskId: args.task_id, native: true })
        member.controller.signal.throwIfAborted()
        signal.throwIfAborted()
        if (this.ctx.subagents.getProvider('spawn') !== provider) throw new Error('Worker provider changed during admission')
        const started = await this.ctx.subagents.startActivation({ provider: 'spawn', parent: parent.agent, childId: member.id,
          maxDepth: 1, cwd: member.actor.snapshot.workspace, delivery: 'caller', label: `Task ${args.task_id}: ${args.bot}`,
          prompt: [{ type: 'text', text: `Work only on task ${args.task_id} as ${args.bot}. First call botctl boot with this role and task_id.\n${args.text ?? 'Complete the assigned task and append its result using botctl.'}` }],
          signal: AbortSignal.any([signal, member.controller.signal]) })
        member.activation = started
        member.name = started.name
        if (typeof started.messageId !== 'string') throw new Error('Worker startup did not return a native input receipt')
        member.initialMessageId = started.messageId
        member.ready.resolve()
        if (member.controller.signal.aborted) await started.dispose()
        return { worker_id: member.id, name: member.name, role: args.bot, task_id: args.task_id }
      } catch (error) {
        const cancelled = startupAborted(error, [signal, member.controller.signal, record.signal])
        const failure = cancelled ? Object.assign(new Error('Worker startup cancelled', { cause: error }), { name: 'AbortError' }) : error
        member.startupError = failure
        member.ready.reject(failure)
        await member.activation?.dispose()
        member.startupFailed = true
        member.startupResult = { stopReason: cancelled ? 'aborted' : 'error', output: [] }
        throw failure
      }
    })()
    member.completion = (async () => {
      try { await member.starting } catch { /* SDK startup has completed its rollback. */ }
      try {
        if (!member.actor) { member.done = true; return }
        const result = member.startupResult ?? await member.activation.result
        await member.activation?.dispose()
        await member.state?.close()
        const input = { result, quiescent: true, startupFailed: member.startupFailed === true, initialMessageId: member.initialMessageId,
          ...(member.state ? { session: structuredClone(member.state.agent.session.header), inheritedEventCount: 0 } : {}) }
        member.native = (await member.actor.sealNative(input)).native
        await member.actor.close()
        member.result = await member.actor.redactResult(result)
        member.done = true
        return member.result
      } finally {
        record.signal.removeEventListener('abort', cancel)
        this.members.delete(member.id)
      }
    })()
    void member.completion.catch(error => { member.error = error })
    return member.starting
  }
  cancel(member) {
    member.controller.abort(new Error('Worker cancelled by its owning turn'))
    const operation = member.activation?.dispose()
    if (operation) void operation.catch(error => { member.error = error })
  }
  find(record, id) {
    const member = [...record.workers ?? []].find(member => member.id === id || member.name === id)
    if (!member) throw new Error('Worker does not belong to this turn')
    return member
  }
  async action(parent, record, action, args, signal) {
    if (action === 'worker_spawn') return this.start(parent, record, args, signal)
    const member = this.find(record, args.worker_id)
    if (action === 'worker_wait') return { worker_id: member.id, ...await awaited(member.completion, signal), native: member.native }
    if (action === 'worker_stop') { this.cancel(member); return { worker_id: member.id, ...await awaited(member.completion, signal) } }
    if (action === 'worker_message') {
      if (member.done || member.controller.signal.aborted || !member.activation) throw new Error('Worker activation already ended; start a fresh Worker')
      return this.ctx.subagents.sendMessage(parent.agent, member.id, [{ type: 'text', text: args.text }], { signal })
    }
    throw new Error('Unknown Worker action')
  }
  async close() {
    this.closed = true
    for (const member of this.members.values()) this.cancel(member)
    const results = await Promise.allSettled([...this.members.values()].map(member => member.completion))
    const failure = results.find(item => item.status === 'rejected')
    if (failure) throw failure.reason
  }
}
