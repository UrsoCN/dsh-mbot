// Agent-owned gate driver & ABI migration layer.
// Gates outlive Runtime module reloads via the shared Agent-keyed cell registry.
import { botSections, reconcileContext, turnContext } from './context.js'
import { operationalSource } from './messages.js'
import { managedCompaction } from './compaction.js'
import { runtimeCells as cells, gateSchemaVersion } from './runtime-cells.js'

export const foregroundTools = ['botctl', 'bash', 'read', 'read_image', 'write', 'edit', 'apply_patch', 'glob', 'grep',
  'web_search', 'web_fetch', 'ask_user_question', 'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read']

export function createGateCell() {
  return { schemaVersion: gateSchemaVersion }
}

export function requireState(cell, { allowMaintenance = false } = {}) {
  if (cell.retired) throw new Error('This Bot was removed; its old managed Session is retired')
  if (!cell.state || cell.state.closing || cell.state.runtime.closed) throw new Error('MBot Runtime is unavailable for this managed Session')
  if (!cell.state.runtime.ready || cell.state.initializing) throw new Error('MBot Runtime attachment is initializing; accepted input stays in the native Inbox')
  if (cell.state.retiring) throw new Error('Bot removal is in progress; this managed Session is blocked')
  if (cell.state.runtime.recoveries.has(cell.state.botId)) throw new Error('Bot recovery is in progress; accepted input stays in the native Inbox')
  if (!allowMaintenance && cell.state.runtime.coordinator?.isSleeping(cell.state.botId)) throw new Error('Bot is sleeping; accepted input stays in the native Inbox until /mbot wake')
  if (!allowMaintenance && cell.state.runtime.coordinator?.isBlocked(cell.state.botId)) throw new Error('Bot maintenance is in progress; accepted input stays in the native Inbox')
  if (cell.state.runtime.ctx.mbot.registry().retiredBots.some(entry => entry.bot.botId === cell.state.botId)) throw new Error('This Bot was removed; its old managed Session is retired')
  return cell.state
}

export function installGates(agent, cell) {
  const ctx = agent.ctx
  const upgrade = cell.schemaVersion === 1 && cell.installed === true && cell.driver?.schemaVersion === 1
    && (!cell.state || cell.state.runtime.closed)
  if ((cell.schemaVersion !== gateSchemaVersion && !upgrade) || cell.disposed
    || cell.schemaVersion === 2 && cell.installed && !cell.hasLlmGate) throw new Error('Managed Agent gate ABI is incompatible or disposed')
  const installed = cell.installed === true
  const driver = { schemaVersion: gateSchemaVersion }
  const registrations = []
  const on = (name, callback, options) => {
    driver[name] = callback
    if (!installed || upgrade && name === 'llm/stream') registrations.push(() => ctx.on(name, (...args) => cell.driver[name](...args), options))
  }
  const guard = callback => {
    driver.guard = callback
    if (!installed) registrations.push(() => ctx.tools.guard((...args) => cell.driver.guard(...args)))
  }
  on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (!cell.state && event.type === 'turn/start') cell.parked = []
    cell.state?.observe(event)
  })
  on('agent/inbox/claimed', ({ message, turn }) => {
    const state = cell.state
    if (state?.current?.turn === turn) state.current.messages.push(message)
    else (cell.parked ??= []).push(message)
  })
  on('llm/stream', (options, next) => {
    if (options.sessionId !== agent.id) return next()
    const state = cell.state
    if (options.purpose === 'compaction' || options.purpose === 'mbot-compaction') {
      const allowMaintenance = Boolean(cell.activeMaintenanceCompaction)
      return managedCompaction(requireState(cell, { allowMaintenance }), cell, options, next)
    }
    return state ? managedCompaction(state, cell, options, next) : next()
  }, { prepend: true })
  const layout = botSections({ role: 'chief', soul: '', protocol: '', memory: '', roleMemory: '' })
  const signature = JSON.stringify(layout.map(({ name, required, interpolate }) => ({ name, required, interpolate })))
  if (installed && cell.sectionSignature !== signature) throw new Error('Managed Agent prompt layout changed without a gate ABI migration')
  driver.sectionText = order => cell.state?.current?.lease ? botSections(cell.state.current.lease.snapshot, { worker: cell.state.worker === true })[order].text : ''
  driver.turnText = () => turnContext(cell.state?.current)
  if (!installed) {
    for (const [order, section] of layout.entries()) registrations.push(() => ctx.systemPrompt.section({ ...section, order: order * 10, text: () => cell.driver.sectionText(order) }))
    registrations.push(() => ctx.systemPrompt.context({ name: 'mbot:turn', order: 130, required: true, interpolate: false, text: () => cell.driver.turnText() }))
  }
  on('system-prompt/assemble', async (presentation, input, next) => {
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
    const owned = new Map(botSections(record.lease.snapshot, { worker: state.worker === true }).map(section => [section.name, section]))
    return { ...assembled, sections: assembled.sections.map(section => owned.get(section.name) ?? section),
      contexts: assembled.contexts.map(context => context.name === 'mbot:turn' ? { ...context, text: turnContext(record) } : context) }
  }, { prepend: true })
  on('agent/pre-step', async (input, next) => {
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
  guard(exec => {
    try {
      const state = requireState(cell)
      if (exec.agent !== agent || !state.current?.lease || state.current.ended) return 'No active MBot turn owns this tool call'
      if (state.worker) return state.guard(exec)
      if (['spawn_agent', 'send_message'].includes(exec.name)) return 'Use botctl Worker operations bound to this audited turn'
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
  on('tools/execute', async (exec, next) => {
    const state = requireState(cell)
    const record = state.current
    if (!record?.lease || record.ended) throw new Error('No active MBot turn owns this tool call')
    const operation = next()
    record.calls.add(operation)
    try { return record.lease.redactResult(await operation) }
    finally { record.calls.delete(operation) }
  })
  on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const lease = cell.state?.current?.lease
    return lease ? lease.redactResult(decision) : decision
  })
  if (!installed || upgrade) {
    const disposers = []
    const oldDriver = cell.driver
    cell.driver = driver
    try {
      for (const register of registrations) disposers.push(register())
      if (!installed) ctx.effect(() => () => { cell.state = undefined; cell.disposed = true })
      cell.sectionSignature = signature
      cell.installed = true
      cell.hasLlmGate = true
      cell.schemaVersion = gateSchemaVersion
    } catch (cause) {
      for (const dispose of disposers.reverse()) dispose()
      cell.driver = upgrade ? oldDriver : undefined
      if (!upgrade) cells.delete(agent)
      throw new Error('Cannot register MBot Agent gates; legacy or conflicting providers require a supported reload before adoption', { cause })
    }
  }
  return driver
}
