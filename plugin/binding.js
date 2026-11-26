import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { BotRegistry, emptyRegistry, findBot, revise } from './instances.js'
import { redact } from './redact.js'

export function nativeBindingAvailable(host) {
  return ['workspaceController', 'workspaceRegistry', 'sessionController', 'sessions', 'mbotRuntime']
    .every(name => host.ctx.get(name))
}

/** Opening an existing healthy main is observational, even during its turn. */
export async function resolveBinding(host, identity, options = {}) {
  options.signal?.throwIfAborted()
  if (!nativeBindingAvailable(host)) throw new Error('Native main Session requires the DSH workspace/session controllers and MBot Runtime')
  const bot = host.bot({ botId: identity })
  if (bot.binding?.state !== 'ready') return host.ensureBinding(bot.botId, options)
  if (options.revision !== undefined && host.registry().revision !== options.revision) throw new Error('Bot registry changed; reload before opening')
  const registry = host.ctx.get('workspaceRegistry')
  const workspace = registry.get(bot.workspaceId)
  if (!workspace || workspace.path !== bot.workspacePath || !workspace.sessionIds.includes(bot.mainSessionId)) throw new Error(`Main Session workspace needs /mbot repair ${bot.botId}`)
  if (registry.archivedSessionIds.includes(bot.mainSessionId)) throw new Error('Main Session is archived; restore it in DSH before opening')
  const resolved = await host.ctx.get('sessionController').resolveAgent(bot.mainSessionId)
  if ('error' in resolved) throw resolved.error
  if (resolved.agent.id !== bot.mainSessionId || resolved.agent.session.header.cwd !== bot.workspacePath
    || resolved.agent.session.header.origin === 'subagent') throw new Error('Main Session identity, directory or ownership does not match the Bot')
  options.signal?.throwIfAborted()
  if (host.closed || !isDeepStrictEqual(host.bot({ botId: bot.botId }), bot)) throw new Error('Bot binding changed or Host closed; reload before opening')
  await host.ctx.get('mbotRuntime').attach(resolved.agent, { botId: bot.botId })
  return structuredClone(bot)
}

/** Serialize native entity changes with every Bot data writer, across Hosts. */
async function withLock(host, bot, operation) {
  const checked = await host.execute('botctl', ['lint'], { workspace: bot.workspacePath })
  if (checked.exitCode) throw new Error(checked.stderr || checked.stdout)
  const child = host.ctx.subprocess.spawn({
    argv: ['flock', '-n', join(bot.workspacePath, '.mbot', 'lock'), 'sh', '-c', 'printf "ready\\n"; cat >/dev/null'],
    cwd: bot.workspacePath, graceMs: 5000,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8000 } },
  })
  host.active.add(child)
  child.stdin.on('error', () => {})
  const reader = createInterface({ input: child.stdout })
  try {
    const first = await reader[Symbol.asyncIterator]().next()
    if (first.done || first.value !== 'ready') throw new Error('Bot is busy; retry binding after its current operation settles')
    return await operation()
  } finally {
    child.stdin.end()
    child.terminate()
    await child.waitForExit()
    reader.close()
    host.active.delete(child)
  }
}

/** Reservations are durable before publication; selection edits remain independent. */
export async function provisionBinding(host, identity, options = {}) {
  if (!nativeBindingAvailable(host)) throw new Error('Native main Session requires the DSH workspace/session controllers and MBot Runtime')
  const { editor, entry } = host.configurationEntry()
  let bot = host.bot({ botId: identity })
  return withLock(host, bot, async () => {
    const check = () => {
      options.signal?.throwIfAborted()
      if (host.closed) throw new Error('MBot plugin is disposed')
    }
    // Read the latest profile under ConfigEditor's lock, including other Hosts.
    await editor.edit(entry, current => {
      check()
      const registry = BotRegistry(current.registry ?? emptyRegistry)
      if (options.revision !== undefined && registry.revision !== options.revision) throw new Error('Bot registry changed; reload before saving')
      bot = structuredClone(findBot(registry, identity))
      return current
    })
    const update = async change => {
      const expected = structuredClone(bot)
      let saved
      await editor.edit(entry, current => {
        const registry = BotRegistry(current.registry ?? emptyRegistry)
        const latest = findBot(registry, expected.botId)
        if (!isDeepStrictEqual(latest, expected)) throw new Error('Bot binding changed; reload before repairing')
        saved = { ...latest, ...change }
        return { ...current, registry: revise(registry, { bots: registry.bots.map(item => item.botId === saved.botId ? saved : item) }) }
      })
      bot = structuredClone(saved)
    }
    try {
      check()
      const registry = host.ctx.get('workspaceRegistry')
      const previousWorkspace = bot.workspaceId && registry.get(bot.workspaceId)
      if (previousWorkspace && previousWorkspace.path !== bot.workspacePath) throw new Error('Bound DSH workspace belongs to a different directory')
      const sessionId = bot.mainSessionId ?? bot.binding?.pendingSessionId ?? `session-${randomUUID()}`
      if (registry.archivedSessionIds.includes(sessionId)) throw new Error('Main Session is archived; restore it in DSH before /mbot repair')
      if (bot.binding?.state !== 'ready') {
        await update({ binding: { state: 'provisioning', pendingSessionId: bot.mainSessionId ? null : sessionId, error: null } })
      }
      check()
      const { workspace: created } = await host.ctx.get('workspaceController').create({ path: bot.workspacePath })
      const workspace = registry.get(created.workspaceId)
      if (!workspace || workspace.path !== bot.workspacePath) throw new Error('DSH workspace creation did not verify the Bot directory')
      if (bot.workspaceId !== workspace.id) await update({ workspaceId: workspace.id })
      check()
      // Resolve first: create's blank-only reuse can otherwise mint duplicates.
      let resolved = await host.ctx.get('sessionController').resolveAgent(sessionId)
      let newlyCreated = false
      if ('error' in resolved) {
        if (resolved.error.code !== 'session/not-found') throw resolved.error
        const result = await host.ctx.get('sessionController').create({ workspaceId: workspace.id, sessionId })
        if (result.sessionId !== sessionId) throw new Error(`DSH created unexpected Session ${result.sessionId}; reserved ${sessionId} retained for repair`)
        newlyCreated = true
        resolved = await host.ctx.get('sessionController').resolveAgent(sessionId)
        if ('error' in resolved) throw resolved.error
      }
      check()
      const { agent } = resolved
      if (agent.id !== sessionId || agent.session.header.cwd !== bot.workspacePath || agent.session.header.origin === 'subagent') {
        throw new Error('Main Session identity, directory or ownership does not match the Bot')
      }
      if (!workspace.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId)
      await host.ctx.get('mbotRuntime').attach(agent, { botId: bot.botId })
      if (!host.ctx.get('mbotRuntime').managed(agent) || !workspace.sessionIds.includes(sessionId)) throw new Error('Main Session Runtime or membership verification failed')
      if (newlyCreated || !bot.mainSessionId) await host.ctx.get('sessionController').rename({ sessionId, title: `${bot.name} · ${bot.defaultRole}` })
      await host.ctx.get('sessions').flush(agent.session)
      check()
      if (bot.binding?.state !== 'ready' || bot.mainSessionId !== sessionId) {
        await update({ mainSessionId: sessionId, binding: { state: 'ready', pendingSessionId: null, error: null } })
      }
      return structuredClone(bot)
    } catch (error) {
      // Never delete an entity or discard its reservation on a partial failure.
      const message = await redact(error.message ?? String(error), bot.workspacePath)
      try { await update({ binding: { state: 'failed', pendingSessionId: bot.binding?.pendingSessionId ?? null, error: message } }) }
      catch (saveError) { throw new Error(`${message}; repair state was not saved: ${await redact(saveError.message, bot.workspacePath)}`, { cause: error }) }
      throw new Error(`${message}\nRetry: /mbot repair ${bot.botId}`, { cause: error })
    }
  })
}

export function sessionResult(bot, open = false) {
  return `DSH workspace: ${bot.workspaceId}\nMain Session: ${bot.mainSessionId}\nMain Session link: #mbot-session=${encodeURIComponent(bot.mainSessionId)}\n${open ? `Open main Session: ${bot.mainSessionId}\n` : ''}`
}
