import z from '@deepseek-ai/schemastery'
import { registerBotctl } from './tools.js'
import { WorkerManager, WorkerSession } from './workers.js'
import { Service } from '@deepseek-ai/cordis'
import * as nativeBash from '@deepseek-ai/dsh-tool-bash'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { workerRecoveryPrefix } from './worker-recovery-proof.js'
import { redact } from './redact.js'
import { recoverRuntime, repairNativeReceipt } from './runtime-recovery.js'
import { runtimeCells as cells } from './runtime-cells.js'
import { restoreContext } from './context-checkpoint.js'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import * as CompactCommand from '@deepseek-ai/dsh-command-compact'
import { foregroundTools, installGates, createGateCell } from './gate-driver.js'
import { ConversationSession, runtimeRecordType, validReceipt } from './conversation-session.js'
import { BotCoordinator } from './bot-coordinator.js'
import { createOwnerMailbox } from './mailbox-facade.js'
import { runManualCompaction, recoverMaintenanceCompaction } from './compaction.js'
import { sleepBot, wakeBot, recoverSleepMaintenance, botOverview } from './sleep.js'
import { readMaintenanceJournal } from './maintenance-journal.js'
import { botSessionIds, conversationForSession } from './conversations.js'

export const name = 'mbot-runtime'
export const inject = ['mbot', 'agents', 'sessions', 'sessionQuery', 'tools', 'systemPrompt', 'subprocess', 'llm']
export const Config = z.object({ workers: z.boolean().default(true).description('Allow Chief Sessions to delegate task data operations to fresh Workers.'),
  compactMaxBytes: z.number().step(1).min(4096).max(4194304).default(262144).description('Maximum UTF-8 source bytes in a managed compaction request.') })
export { runtimeRecordType }

/** Agent-scoped transaction owner. Native DSH remains the conversation driver. */
export class MBotRuntime extends Service {
  static inject = inject
  static Config = Config

  constructor(ctx, config = {}) {
    super(ctx, 'mbotRuntime')
    this.workersEnabled = config.workers !== false
    this.compactMaxBytes = config.compactMaxBytes ?? 262144
    this.states = new Map()
    this.foreground = new Set(foregroundTools)
    this.foregroundOwners = new Map()
    this.attachments = new Map()
    this.recoveries = new Map()
    this.removals = new Set()
    this.coordinator = new BotCoordinator(this)
    this.closed = false
    this.ready = false
    ctx.inject(['subagents'], child => {
      const manager = new WorkerManager(this, child)
      this.workerManager = manager
      child.effect(() => async () => { await manager.close(); if (this.workerManager === manager) this.workerManager = undefined })
    })
    ctx.on('agent/created', async ({ agent }) => {
      const member = this.workerManager?.members.get(agent.id)
      if (member) { await this.attachWorker(agent, member); return }
      if (agent.session.header.origin === 'subagent') {
        const registry = ctx.mbot.registry()
        const parent = agent.session.header.parentSession
        if (registry.bots.some(bot => botSessionIds(registry, bot).includes(parent))
          || registry.retiredBots.some(entry => entry.sessionIds.includes(parent))
          || this.managed(ctx.agents.get(parent))) throw new Error('Old or unbound managed Worker cannot resume its data assignment')
      }
      const retired = ctx.mbot.registry().retiredBots.find(entry => entry.sessionIds.includes(agent.id))
      if (retired) { await this.attachRetired(agent, retired); return }
      const registry = ctx.mbot.registry()
      const bot = registry.bots.find(bot => botSessionIds(registry, bot).includes(agent.id))
      if (bot) await this.attach(agent, { botId: bot.botId })
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const state = this.states.get(agent)
      void state?.close().then(() => {
        if (this.states.get(agent) === state) {
          this.states.delete(agent)
          this.coordinator.unregisterConversation(state.botId, agent.id)
        }
      }).catch(error => { state.error ??= error })
    })
    ctx.inject(['shellEnv'], child => {
      child.shellEnv.register({ name: 'mbot-turn', variables: {
        DSH_MBOT_WS: { description: 'Managed Bot data directory.' },
        DSH_MBOT_RUN_ID: { description: 'Managed Bot turn identity.' },
        DSH_MBOT_PERMIT_TOKEN: { description: 'Private data transaction permission; never include in output.' },
        DSH_MBOT_BOTCTL: { description: 'Bundled botctl executable for managed shell calls.' },
      }, resolve: exec => this.states.get(exec.agent)?.current?.lease?.shellEnvironment() ?? {} })
    })
    ctx.effect(() => () => this.close())
  }

  close() {
    if (this.shutdown) return this.shutdown
    this.closed = true
    const states = [...this.states.values()]
    const completion = Promise.withResolvers()
    this.shutdown = completion.promise
    for (const state of states) {
      const cell = cells.get(state.agent)
      if (cell?.state === state) cell.quiescence = this.shutdown
    }
    void (async () => {
      await this.coordinator.drainAll()
      await Promise.allSettled([...this.recoveries.values()].map(item => item.promise))
      await Promise.allSettled([...this.attachments.values()].map(item => item.promise))
      // A rejected writer drain cannot become a successful handoff.
      const draining = new Set([...states, ...this.states.values()])
      for (const state of draining) {
        const cell = cells.get(state.agent)
        if (cell?.state === state) cell.quiescence = this.shutdown
      }
      await Promise.all([...draining].map(state => state.close()))
      for (const state of draining) {
        const cell = cells.get(state.agent)
        if (cell?.state !== state) continue
        if (this.ready || !cell.handoff) cell.handoff = { botId: state.botId, lastReceipt: state.lastReceipt,
          error: state.error, failedAuditRunId: state.failedAuditRunId, failedAuditRecord: state.failedAuditRecord }
        cell.state = undefined
      }
      this.states.clear()
    })().then(completion.resolve, completion.reject)
    return this.shutdown
  }

  async [Service.init]() {
    try {
      for (const agent of this.ctx.agents.list()) {
        const prior = cells.get(agent)
        if (prior?.state && this.states.get(agent) !== prior.state && !prior.state.runtime.closed) throw new Error('Managed Session already has a Runtime owner')
        if (prior?.quiescence) await prior.quiescence
        const retired = this.ctx.mbot.registry().retiredBots.find(entry => entry.sessionIds.includes(agent.id))
        if (retired) {
          if (agent.status !== 'idle') {
            agent.cancel({ kind: 'hook', reason: 'Retiring removed MBot Session' }, { keepInbox: true })
            await agent.whenIdle()
          }
          await this.attachRetired(agent, retired)
          continue
        }
        const registry = this.ctx.mbot.registry()
        const bot = registry.bots.find(bot => botSessionIds(registry, bot).includes(agent.id))
        if (!bot) continue
        if (agent.status !== 'idle') {
          agent.cancel({ kind: 'hook', reason: 'Preparing managed MBot Session' }, { keepInbox: true })
          await agent.whenIdle()
        }
        await this.attach(agent, { botId: bot.botId })
      }
      if (this.closed) throw new Error('MBot Runtime closed during initialization')
      this.ready = true
      for (const agent of this.states.keys()) { const cell = cells.get(agent); if (cell?.state && this.states.get(agent) === cell.state) cell.handoff = undefined }
    } catch (error) {
      await this.close()
      throw error
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
    if (this.removals.has(botId)) throw new Error('Bot removal is in progress; its Session cannot activate')
    if (this.ctx.mbot.registry().retiredBots.some(entry => entry.sessionIds.includes(agent.id)) || cells.get(agent)?.retired) throw new Error('Removed Bot Session cannot be redirected to another Bot')
    if (this.states.has(agent)) {
      if (this.states.get(agent).botId !== botId) throw new Error('Managed Session cannot be redirected to another Bot')
      return
    }
    const bot = this.ctx.mbot.bot({ botId })
    const conversation = conversationForSession(this.ctx.mbot.registry(), agent.id)
    if (conversation && conversation.botId !== botId) throw new Error('Conversation Session cannot be redirected to another Bot')
    if (!bot || agent.session.header.cwd !== bot.workspacePath) throw new Error('Managed Session must belong to the Bot data directory')
    if (agent.session.header.origin === 'subagent') throw new Error('Managed Worker routing is not yet connected')
    let cell = cells.get(agent)
    if (cell?.state && !cell.state.runtime.closed) throw new Error('Managed Session already has a Runtime owner')
    if (cell?.quiescence) await cell.quiescence
    if (agent.status !== 'idle') throw new Error('Attach MBot Runtime before Agent work starts')
    if (this.closed) throw new Error('MBot Runtime closed while waiting for prior writers')
    if (!cell) {
      cell = createGateCell()
      cells.set(agent, cell)
    } else if (cell.state && !cell.state.runtime.closed) throw new Error('Managed Session already has a Runtime owner')
    if (cell.handoff && cell.handoff.botId !== botId) throw new Error('Managed Session handoff cannot redirect its Bot identity')
    const driver = installGates(agent, cell)
    const state = new ConversationSession(this, agent, botId, conversation ?? { conversationKey: 'main', visibility: 'owner-private' })
    cell.state = state
    this.states.set(agent, state)
    this.coordinator.registerConversation(botId, state.conversation.conversationKey, agent.id)
    try {
      await state.initialize()
      // Restore persisted sleeping state across Host restart / Runtime reload.
      try {
        const maint = await readMaintenanceJournal(bot.workspacePath)
        if (maint?.record.kind === 'sleep' && maint.record.phase === 'sleeping') {
          this.coordinator.setSleeping(botId, maint.record)
        }
      } catch {}
      if (cell.handoff) for (const key of ['lastReceipt', 'error', 'failedAuditRunId', 'failedAuditRecord']) state[key] = cell.handoff[key]
      if (!cell.bashInstalled && this.ctx.tools.get('bash', agent)) {
        // The official foreground-only composition kills and joins commands
        // at timeout; a returned job receipt is not writer-quiescence proof.
        for (const name of ['shell', 'shellEnv', 'workingDirectory']) {
          if (!agent.ctx.get(name)) throw new Error(`Managed Bash requires ${name}`)
        }
        cell.bashFiber = await agent.ctx.plugin(nativeBash, { enableRunInBackground: false, promoteOnTimeout: false })
        cell.bashInstalled = true
      }
      if (!cell.compactionFiber && !agent.ctx.get('compaction') && agent.ctx.get('tokenMeter')) {
        // Web may disable the root backend. The official engine is scoped to
        // this managed Agent, whose LLM gate owns and audits its summaries.
        const composition = agent.ctx.isolate('compaction')
        cell.compactionFiber = await composition.plugin(BasicCompaction)
        if (agent.ctx.get('commands')) cell.compactionCommandFiber = await composition.plugin(CompactCommand)
      }
      if (!cell.compactCommandGate && agent.ctx.get('commands')) {
        // Route native `/compact` on managed main Sessions through MBot's
        // audited maintenance barrier/lock/journal lifecycle instead of raw compactNow.
        cell.compactCommandGate = agent.ctx.inject(['commands'], child => {
          child.commands.register({
            name: 'compact',
            description: 'Compact older conversation history through the MBot maintenance lifecycle.',
            handler: async invocation => {
              if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: 'Usage: /compact (no arguments)' }
              try {
                const res = await this.compact(agent, { signal: invocation.signal, sourceCommandId: invocation.commandId })
                if (!res.compacted) return { kind: 'success', text: 'No compactable history yet.' }
                return { kind: 'success', text: `Compacted ${res.shadowedCount} history items (~${res.shadowedTokenCount} tokens).`, sourceEventSeq: res.summarySeq }
              } catch (error) {
                return { kind: 'error', text: await redact(invocation.signal?.aborted ? 'Compaction cancelled.' : error.message ?? String(error), bot.workspacePath) }
              }
            },
          })
        })
      }
      if (this.closed) throw new Error('MBot Runtime disposed during attachment')
      const workerControls = this.workersEnabled && this.workerManager && this.ctx.mbot.bot({ botId: state.botId }).defaultRole === 'chief'
      if (workerControls && !cell.controlTool) cell.controlTool = agent.ctx.inject(['tools', 'mbot', 'sandboxPolicy'], child => registerBotctl(child, { workers: true }))
      if (!workerControls && cell.controlTool) { cell.controlTool(); cell.controlTool = undefined }
      cell.driver = driver
      state.initializing = false
      if (this.ready) cell.handoff = undefined
    } catch (error) {
      // Keep the gates closed while any event/message operations from this
      // failed attachment finish; a failed drain remains a failed handoff.
      await state.abortAttachment()
      this.states.delete(agent)
      this.coordinator.unregisterConversation(botId, agent.id)
      if (cell.state === state) cell.state = undefined
      throw error
    }
  }

  async attachWorker(agent, member) {
    if (member.done || member.state || !member.actor || agent.session.header.parentSession !== member.parent.agent.id || agent.session.header.origin !== 'subagent'
      || agent.session.header.delegationDepth !== 1 || agent.session.header.isSeeded === true) throw new Error('Worker publication does not match its reserved native identity')
    const cell = createGateCell()
    if (cells.has(agent)) throw new Error('Worker already has a gate owner')
    cells.set(agent, cell)
    const driver = installGates(agent, cell)
    const state = new WorkerSession(this, agent, member)
    cell.state = state
    this.states.set(agent, state)
    member.state = state
    await state.initialize()
    cell.driver = driver
  }

  worker(agent) { return this.states.get(agent)?.worker === true }

  /** Restore only native closers, with no Actor permit or business execution. */
  async acquireRecoveryWorker(journal, actor, signal) {
    if (this.closed || !this.recoveries.has(journal.botId)
      || this.ctx.agents.get(actor.sessionId)) throw new Error('Worker recovery writer is already owned or unavailable')
    const persistence = this.ctx.get('sessionPersistence')
    if (!persistence) throw new Error('Worker recovery requires native Session persistence')
    const handle = await persistence.open(actor.sessionId, 'write', { signal })
    try {
      const header = handle.header
      if (header.origin !== 'subagent' || header.parentSession !== journal.sessionId || header.cwd !== journal.workspace
        || header.delegationDepth !== 1 || header.isSeeded === true || handle.inheritedEventCount !== 0) throw new Error('Worker recovery Session assignment changed')
      const loaded = await handle.read(0, undefined, { signal })
      await workerRecoveryPrefix(journal, actor, { session: header, events: loaded.events })
      // This is the same public native repair function used by Agent.resume.
      // Hold the exclusive writer throughout Git settlement, without creating
      // an executable Agent or reactivating the old assignment/Inbox.
      const closers = interruptedTurnClosers(loaded.events)
      if (closers.length) await handle.append(closers)
      const read = await handle.read(0, undefined, { signal })
      return { log: { session: structuredClone(header), inheritedEventCount: handle.inheritedEventCount, events: read.events },
        dispose: () => handle.close() }
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  async workerLogs(events) {
    const ids = [...new Set(events.filter(event => event.type === 'subagent/catalog').map(event => event.data.childId))]
    const logs = []
    for (const id of ids) {
      try { logs.push(await this.ctx.sessionQuery.readSession(id)) }
      catch { /* A missing native log remains unverified by the audit reader. */ }
    }
    return logs
  }

  async workerAction(agent, action, args, signal) {
    const state = this.states.get(agent)
    if (!state || state.worker || !state.current?.lease || state.current.ended || state.current.lease.snapshot.role !== 'chief') throw new Error('Only an active Chief turn can control its Workers')
    if (!this.workersEnabled || !this.workerManager) throw new Error('Native Worker execution is not enabled or its provider is unavailable')
    return this.workerManager.action(state, state.current, action, structuredClone(args), signal)
  }

  managed(agent) { return this.states.has(agent) }

  /** Enter through the service method so Cordis retains Runtime dependency scope. */
  async coordinateRecovery(bot, journal, options = {}) {
    if (this.closed || !this.ready) throw new Error('MBot Runtime is not ready for recovery')
    if (journal) return recoverRuntime(this, bot, journal, options)
    const repaired = await repairNativeReceipt(this, bot, options)
    if (repaired) return repaired
    const compactRecovered = await recoverMaintenanceCompaction(this, bot, options)
    if (compactRecovered) return compactRecovered
    return recoverSleepMaintenance(this, bot, options)
  }

  /** Managed manual compaction through BotCoordinator barrier, lock & maintenance journal. */
  async compact(agent, options = {}) {
    if (conversationForSession(this.ctx.mbot.registry(), agent.id)) throw new Error('Reserved conversation cannot compact before visibility filtering is available')
    const cell = cells.get(agent)
    if (!cell) throw new Error('Session is not managed by the active MBot Runtime')
    return runManualCompaction(this, agent, cell, options)
  }

  /** Staged sleep: barrier -> cutoff -> Dreaming -> optional compact -> durable sleeping state. */
  async sleep(botId, options = {}) {
    if (this.closed || !this.ready) throw new Error('MBot Runtime is not ready for sleep')
    return sleepBot(this, botId, options)
  }

  /** Wake a sleeping Bot, retaining its original main Session ID and refreshing context. */
  async wake(botId, options = {}) {
    if (this.closed || !this.ready) throw new Error('MBot Runtime is not ready for wake')
    return wakeBot(this, botId, options)
  }

  /** Read-only overview of all registered Bots for CLI/commands/management panel. */
  async overview() {
    const registry = this.ctx.mbot.registry()
    const bots = await Promise.all(registry.bots.map(bot => botOverview(this, bot)))
    return {
      schemaVersion: 1,
      revision: registry.revision,
      selectedBotId: registry.selectedBotId,
      bots,
      retiredBots: registry.retiredBots,
    }
  }

  async attachRetired(agent, retired) {
    let cell = cells.get(agent)
    if (cell?.state && this.states.get(agent) !== cell.state && !cell.state.runtime.closed) throw new Error('Managed Session already has a Runtime owner')
    if (cell?.quiescence) await cell.quiescence
    if (this.closed) throw new Error('MBot Runtime closed while adopting a retired Session')
    if (!cell) { cell = createGateCell(); cells.set(agent, cell) }
    const driver = installGates(agent, cell)
    const state = this.states.get(agent)
    const onlyHeldAdmission = state?.retiring && !state.current?.lease && !state.current?.admission
    if (state && !onlyHeldAdmission && (agent.status !== 'idle' || state.current && !state.current.settled)) throw new Error('Bot is busy; wait for its managed turn/audit before removal')
    if (onlyHeldAdmission) {
      const pending = new Set([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(message => message.id))
      const messages = state.current?.messages.filter(message => !pending.has(message.id)) ?? []
      if (messages.length) agent.inbox.splice('next-turn', 0, 0, messages)
    }
    if (state) {
      state.closing = true
      await state.contextOperations?.catch(() => {})
    }
    cell.state = undefined
    cell.retired = structuredClone(retired)
    cell.driver = driver
    this.states.delete(agent)
    if (state) this.coordinator.unregisterConversation(state.botId, agent.id)
  }

  /** Reversible pre-save gate. No active turn/tool/audit is cancelled by removal. */
  prepareRemoval(botId) {
    return this.coordinator.prepareRemoval(botId)
  }

  /** Host capability: the caller verifies owner identity and binds the route. */
  ownerMailbox(agent, options) {
    return createOwnerMailbox(this, agent, options)
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

  /** Only the flushed native snapshot sealed by a reachable Git audit is returned. */
  async checkpoint(agent) {
    const state = this.states.get(agent)
    if (!state || state.initializing || state.closing || this.closed || !this.ready) throw new Error('Session is not managed by the active MBot Runtime')
    if (state.worker) throw new Error('Context checkpoints require a managed main Session')
    if (state.retiring || this.recoveries.has(state.botId) || this.coordinator.isBlocked(state.botId)) throw new Error('Context checkpoint query is unavailable during Bot management')
    await state.pending
    if (state.error) throw state.error
    const checkpoint = await restoreContext(state, { update: false })
    return checkpoint ? structuredClone(checkpoint) : null
  }

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
    const maintenance = this.coordinator.maintenanceState(state.botId)
    return structuredClone({ botId: state.botId, sessionId: agent.id,
      state: this.closed || !this.ready || state.closing || state.initializing ? 'unavailable' : this.recoveries.has(state.botId) ? 'recovering' : state.retiring ? 'removing' : maintenance === 'sleeping' ? 'sleeping' : maintenance ? 'maintaining' : error ? 'failed'
        : state.conversation.state === 'reserved' ? 'reserved' : record && !record.ended ? record.lease ? 'active' : 'admitting' : record && !record.settled ? 'auditing' : 'idle',
      queued: { nextTurn: agent.inbox.nextTurn.length, nextStep: agent.inbox.nextStep.length },
      ...(lastReceipt ? { lastReceipt } : {}), ...(error ? { error } : {}) })
  }

  /** Cancel the captured turn; later accepted inputs remain in the native Inbox. */
  async stop(agent, options = {}) {
    options = { ...options }
    options.signal?.throwIfAborted()
    const state = this.states.get(agent)
    if (!state || this.closed || !this.ready || state.closing || state.initializing) throw new Error('Session is not managed by the active MBot Runtime')
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

export async function apply(ctx, config) { await ctx.plugin(MBotRuntime, config) }
