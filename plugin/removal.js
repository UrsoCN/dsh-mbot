import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { isDeepStrictEqual } from 'node:util'
import { BotRegistry, emptyRegistry, findBot, revise } from './instances.js'

/** Registry retirement also works when the data directory has gone missing. */
async function withDataLock(host, bot, operation) {
  let usable = false
  try {
    const parent = await lstat(join(bot.workspacePath, '.mbot'))
    const lock = await lstat(join(bot.workspacePath, '.mbot/lock'))
    usable = parent.isDirectory() && !parent.isSymbolicLink() && lock.isFile() && !lock.isSymbolicLink()
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
  if (!usable) return operation()
  const child = host.ctx.subprocess.spawn({ argv: ['flock', '-n', join(bot.workspacePath, '.mbot/lock'), 'sh', '-c', 'printf "ready\\n"; cat >/dev/null'],
    cwd: bot.workspacePath, graceMs: 5000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8000 } } })
  host.active.add(child)
  child.stdin.on('error', () => {})
  const reader = createInterface({ input: child.stdout })
  try {
    const first = await reader[Symbol.asyncIterator]().next()
    if (first.done || first.value !== 'ready') throw new Error('Bot data writer is busy; wait for its turn before removal')
    return await operation()
  } finally {
    child.stdin.end()
    child.terminate()
    await child.waitForExit()
    reader.close()
    host.active.delete(child)
  }
}

export async function removeBot(host, identity, options) {
  const { editor, entry } = host.configurationEntry()
  let bot, existing
  const check = () => { options.signal?.throwIfAborted(); if (host.closed) throw new Error('MBot plugin is disposed') }
  await editor.edit(entry, current => {
    check()
    const registry = BotRegistry(current.registry ?? emptyRegistry)
    existing = registry.retiredBots.find(item => item.bot.botId === identity)
    if (!existing) {
      if (options.revision !== undefined && options.revision !== registry.revision) throw new Error('Bot registry changed; reload before removal')
      bot = structuredClone(findBot(registry, identity))
    }
    return current
  })
  if (existing) return { ...structuredClone(existing), alreadyRemoved: true }
  return withDataLock(host, bot, async () => {
    check()
    if ([...host.leases].some(lease => lease.identity.botId === bot.botId && !lease.transportEnded)) throw new Error('Bot turn is busy; stop and settle it before removal')
    const ids = [bot.mainSessionId, bot.binding?.pendingSessionId].filter(Boolean)
    const runtime = host.ctx.get('mbotRuntime')
    if (ids.length) {
      const controller = host.ctx.get('sessionController')
      if (!controller || !runtime) throw new Error('Bound Bot removal requires the native Session Controller and MBot Runtime')
      for (const id of ids) {
        const result = await controller.resolveAgent(id)
        if ('error' in result) { if (result.error.code === 'session/not-found') continue; throw result.error }
        if (result.agent.id !== id || result.agent.session.header.cwd !== bot.workspacePath) throw new Error('Main Session ownership does not match the Bot; inspect its binding before removal')
        await runtime.attach(result.agent, { botId: bot.botId })
      }
    }
    check()
    const hold = runtime?.prepareRemoval(bot.botId)
    const retired = { bot: structuredClone(bot), sessionIds: [...new Set([...ids, ...(hold?.sessionIds ?? [])])], retiredAt: new Date().toISOString() }
    try {
      await editor.edit(entry, current => {
        check()
        const registry = BotRegistry(current.registry ?? emptyRegistry)
        if (options.revision !== undefined && options.revision !== registry.revision) throw new Error('Bot registry changed; reload before removal')
        const latest = findBot(registry, bot.botId)
        if (!isDeepStrictEqual(latest, bot)) throw new Error('Bot binding changed; reload before removal')
        const selected = registry.selectedBotId === bot.botId ? null : registry.selectedBotId
        return { ...current, workspace: registry.selectedBotId === bot.botId || current.workspace === bot.workspacePath ? '' : current.workspace,
          registry: revise(registry, { bots: registry.bots.filter(item => item.botId !== bot.botId), retiredBots: [...registry.retiredBots, retired], selectedBotId: selected }) }
      })
      // Durable retirement wins over a caller disconnect after ConfigEditor saved.
      hold?.commit(retired)
      return { ...structuredClone(retired), alreadyRemoved: false }
    } finally { hold?.release() }
  })
}
