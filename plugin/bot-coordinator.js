// Bot-level coordinator: maintenance barriers, conversation mapping, and removal coordination.
// Single Bot maintenance operations (manual compact, sleep/wake, removal, recovery)
// serialize through this layer without creating a second model queue.
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { botSessionIds } from './conversations.js'

export class BotCoordinator {
  constructor(runtime) {
    this.runtime = runtime
    this.maintenance = new Map() // botId -> { kind, promise, resolve }
    this.sleeping = new Map() // botId -> sleep metadata
    this.conversations = new Map() // botId -> Map(conversationKey -> sessionId)
  }

  setSleeping(botId, info) {
    this.sleeping.set(botId, Object.freeze({ ...info }))
  }

  clearSleeping(botId) {
    this.sleeping.delete(botId)
  }

  isSleeping(botId) {
    return this.sleeping.has(botId)
  }

  sleepInfo(botId) {
    return this.sleeping.get(botId)
  }

  registerConversation(botId, conversationKey, sessionId) {
    let map = this.conversations.get(botId)
    if (!map) { map = new Map(); this.conversations.set(botId, map) }
    map.set(conversationKey, sessionId)
  }

  unregisterConversation(botId, sessionId) {
    const map = this.conversations.get(botId)
    if (!map) return
    for (const [key, id] of map.entries()) {
      if (id === sessionId) map.delete(key)
    }
    if (!map.size) this.conversations.delete(botId)
  }

  conversationSessions(botId) {
    const map = this.conversations.get(botId)
    return map ? Object.fromEntries(map.entries()) : {}
  }

  isBlocked(botId) {
    return this.maintenance.has(botId) || this.sleeping.has(botId)
  }

  maintenanceState(botId) {
    return this.maintenance.get(botId)?.kind ?? (this.sleeping.has(botId) ? 'sleeping' : undefined)
  }

  statesForBot(botId) {
    return [...this.runtime.states.values()].filter(state => state.botId === botId)
  }

  /**
   * Acquire an exclusive Bot-level maintenance barrier (e.g. compact / sleep).
   * Waits for no active turn/audit/attachment/recovery, blocks new business turns
   * while still allowing native Inbox to accept messages.
   */
  async acquireBarrier(botId, kind, options = {}) {
    const runtime = this.runtime
    if (runtime.closed || !runtime.ready) throw new Error('MBot Runtime is not ready for maintenance')
    if (this.maintenance.has(botId) || runtime.removals.has(botId) || runtime.recoveries.has(botId)
      || [...runtime.attachments.values()].some(item => item.botId === botId)) {
      throw new Error(`Bot maintenance (${kind}) is blocked by an active lifecycle operation`)
    }
    const states = this.statesForBot(botId)
    if (states.some(state => state.closing || state.retiring || state.agent.status !== 'idle' || state.current && !state.current.settled)) {
      throw new Error(`Bot is busy; settle active turns before ${kind}`)
    }
    const completion = Promise.withResolvers()
    const entry = { kind, promise: completion.promise, resolve: completion.resolve }
    this.maintenance.set(botId, entry)
    try {
      options.signal?.throwIfAborted()
      await Promise.allSettled(states.map(state => state.drainOperations()))
      if (states.some(state => state.agent.status !== 'idle' || state.current?.lease && !state.current.settled)) {
        throw new Error(`Bot writers became active before ${kind} barrier settled`)
      }
      return {
        kind,
        botId,
        states,
        release: () => {
          if (this.maintenance.get(botId) === entry) {
            this.maintenance.delete(botId)
            completion.resolve()
          }
        },
      }
    } catch (error) {
      if (this.maintenance.get(botId) === entry) {
        this.maintenance.delete(botId)
        completion.resolve()
      }
      throw error
    }
  }

  async drainAll() {
    await Promise.allSettled([...this.maintenance.values()].map(item => item.promise))
  }

  /** Reversible pre-save gate. No active turn/tool/audit is cancelled by removal. */
  prepareRemoval(botId) {
    const runtime = this.runtime
    if (runtime.closed || !runtime.ready || runtime.removals.has(botId) || runtime.recoveries.has(botId)
      || this.maintenance.has(botId)
      || [...runtime.attachments.values()].some(item => item.botId === botId)) throw new Error('Bot Runtime attachment/recovery is busy')
    const bot = runtime.ctx.mbot.bot({ botId })
    const states = this.statesForBot(botId)
    if (states.some(state => state.closing || state.retiring || state.agent.status !== 'idle' || state.current && !state.current.settled)) throw new Error('Bot is busy; stop and settle its current turn before removal')
    for (const state of states) state.retiring = true
    runtime.removals.add(botId)
    const sessionIds = [...new Set([...botSessionIds(runtime.ctx.mbot.registry(), bot), ...states.map(state => state.agent.id)])]
    const handles = []
    let committed = false, verified = false
    return {
      sessionIds,
      verifySessions: async signal => {
        if (verified) return
        for (const id of sessionIds) {
          signal?.throwIfAborted()
          if (runtime.closed) throw new Error('MBot Runtime closed during removal')
          let header
          const live = runtime.ctx.agents.get(id)
          if (live) {
            const controller = runtime.ctx.get('sessionController')
            if (!controller) throw new Error('Bound Bot removal requires the native Session Controller')
            const result = await controller.resolveAgent(id)
            if ('error' in result) throw result.error
            if (result.agent !== live || !states.some(state => state.agent === live)) throw new Error('Live main Session has no verified Runtime ownership for removal')
            header = result.agent.session.header
          } else {
            const persistence = runtime.ctx.get('sessionPersistence')
            if (!persistence) throw new Error('Cold Bot removal requires native Session persistence')
            let handle
            try { handle = await persistence.open(id, 'write', { signal }) }
            catch (error) {
              if (error instanceof SessionPersistenceNotFoundError && error.sessionId === id) continue
              throw error
            }
            handles.push(handle)
            header = handle.header
          }
          if (header.id !== id || header.cwd !== bot.workspacePath || header.origin === 'subagent') throw new Error('Main Session ownership does not match the Bot; inspect its binding before removal')
        }
        verified = true
      },
      commit: async retired => {
        if (sessionIds.length && !verified) throw new Error('Bot removal Session ownership was not verified')
        committed = true
        await Promise.all(states.map(state => runtime.attachRetired(state.agent, retired)))
      },
      release: async () => {
        await Promise.all(handles.map(handle => handle.close()))
        runtime.removals.delete(botId)
        if (!committed) for (const state of states) state.retiring = false
      },
    }
  }
}
