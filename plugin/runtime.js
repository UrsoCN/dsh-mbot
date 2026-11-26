import { Service } from '@deepseek-ai/cordis'
import * as nativeBash from '@deepseek-ai/dsh-tool-bash'
import { botSections, reconcileContext, turnContext } from './context.js'
import { redact } from './redact.js'

export const name = 'mbot-runtime'
export const inject = ['mbot', 'agents', 'sessions', 'sessionQuery', 'tools', 'systemPrompt']

// Agent-owned gates outlive a Runtime reload. An unavailable owner fails closed;
// a replacement Runtime adopts the same cell rather than stacking old guards.
const cells = new WeakMap()
const foregroundTools = ['botctl', 'bash', 'run_code', 'read', 'read_image', 'write', 'edit', 'apply_patch', 'glob', 'grep',
  'web_search', 'web_fetch', 'ask_user_question', 'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read']

function requireState(cell) {
  if (!cell.state || cell.state.closing || cell.state.runtime.closed) throw new Error('MBot Runtime is unavailable for this managed Session')
  return cell.state
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
  }

  observe(event) {
    if (event.type === 'turn/start') {
      this.current = { turn: event.data.turn, step: 1, messages: [], events: [], calls: new Set(), ended: false,
        end: Promise.withResolvers() }
    }
    const record = this.current
    if (!record || record.ended) return
    if (event.type === 'assistant/message') record.text = event.data.message.content
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (record.lease) this.record(record, event)
    else record.events.push(event)
    if (event.type !== 'turn/end') return
    record.ended = true
    record.reason = event.data.reason
    record.end.resolve()
    if (record.lease || record.admission) {
      this.pending = this.settle(record)
      void this.pending.catch(error => { this.error = error; void this.runtime.report(error, this.botId).catch(() => {}) })
    }
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
      record.admission = (async () => {
        await this.pending
        signal.throwIfAborted()
        if (this.closing || this.runtime.closed) throw new Error('MBot Runtime is unavailable')
        if (this.error) throw this.error
        const request = record.messages.map(message => JSON.stringify({ id: message.id, source: message.source, content: message.content })).join('\n')
        record.lease = await this.runtime.ctx.mbot.beginTurn({ botId: this.botId, sessionId: this.agent.id, turn: record.turn, request,
          requestIds: record.messages.map(message => message.source.requestId).filter(value => typeof value === 'string'),
          signal, writerScope: 'agent-runtime', onExpiry: () => this.expire(record), onCancel: message => this.stop(record, message) })
        for (const event of record.events) this.record(record, event)
        record.events = []
        return record
      })()
      void record.admission.catch(() => {
        // A failed admission must not silently consume already-claimed input.
        // Cancellation ends the attempted request; other failures park it in
        // the one authoritative DSH Inbox for inspection and a later wake.
        if (!signal.aborted) this.agent.inbox.splice('next-turn', 0, 0, record.messages)
      })
    }
    return record.admission
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
    try { await record.admission } catch { return }
    if (!record.lease) return
    await Promise.allSettled([...record.calls])
    return record.lease.finish({ reason: record.reason, text: record.text ?? '' })
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
    this.closed = false
    ctx.on('agent/created', async ({ agent }) => {
      const bot = ctx.mbot.registry().bots.find(bot => bot.mainSessionId === agent.id)
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
      const bot = this.ctx.mbot.registry().bots.find(bot => bot.mainSessionId === agent.id)
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

  /** Trusted Host declaration: the tool must join every writer before returning. */
  foregroundTool(name) {
    if (this.closed || typeof name !== 'string' || !name || !this.ctx.tools.get(name)) throw new Error('Register a known foreground tool')
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

  async report(error, botId) {
    const bot = this.ctx.mbot.bot({ botId })
    this.ctx.logger.warn(await redact(error.message ?? String(error), bot?.workspacePath))
  }
}

export function apply(ctx) { ctx.plugin(MBotRuntime) }
