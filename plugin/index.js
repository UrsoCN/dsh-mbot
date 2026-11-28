import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redact } from './redact.js'
import { BotRegistry, BotRegistrySchema, emptyRegistry, findBot, registration, revise, uniqueName, registryTransition } from './instances.js'
import { openTurn } from './turn.js'
import { nativeBindingAvailable, provisionBinding, resolveBinding, sessionResult } from './binding.js'
import { removeBot } from './removal.js'
import { recoverSelected } from './runtime-recovery.js'
import { conversationAccess, conversationKey, reserveConversationRecord, authorizeConversationSource, conversationForSession, botSessionIds } from './conversations.js'
import { isDeepStrictEqual } from 'node:util'

export const name = 'mbot'
export const inject = ['subprocess']
export const Config = z.object({
  workspace: z.string().pattern(/^(?:|~|\/[^\0\r\n]*|~\/[^\0\r\n]*)$/u).default('').description('Bot data repository; absolute path or ~/. Empty uses MBOT_WS and the mbot user configuration.').volatile(),
  registry: BotRegistrySchema.default(emptyRegistry).description('Profile-owned Bot identities and DSH references. Use /mbot import/list/select to manage.').hidden().volatile(),
})

export const packageRoot = fileURLToPath(new URL('../', import.meta.url))

/** One host-owned bridge to the bundled, transactional Bash implementation. */
export class MBotService extends Service {
  static inject = ['subprocess']

  constructor(ctx, config) {
    super(ctx, 'mbot')
    this.config = config
    this.ownerContext = ctx
    this.initializing = Promise.resolve()
    this.active = new Set()
    this.leases = new Set()
    this.closed = false
    ctx.effect(() => async () => {
      this.closed = true
      await Promise.allSettled([...this.leases].map(lease => lease.cancel('MBot plugin disposed')))
      await this.initializing
      for (const child of this.active) child.terminate()
      await Promise.allSettled([...this.active].map(child => child.waitForExit()))
    })
  }

  /** Capture live configuration once so an edit cannot redirect an in-flight operation. */
  registry() {
    return structuredClone(BotRegistry(this.config.registry.get()))
  }

  /** Bound sessions stay on their Bot even when another client changes the default. */
  bot(options = {}) {
    const registry = this.registry()
    if (options.botId !== undefined) return findBot(registry, options.botId)
    if (options.sessionId && registry.retiredBots.some(entry => entry.sessionIds.includes(options.sessionId))) throw new Error('Bot was removed; choose an active Bot explicitly')
    const bound = options.sessionId === undefined ? undefined : registry.bots.find(bot => botSessionIds(registry, bot).includes(options.sessionId))
    return bound ?? (registry.selectedBotId === null ? undefined : findBot(registry, registry.selectedBotId))
  }

  workspace(options = {}) {
    const registry = this.registry()
    if (options.workspace === undefined && options.botId === undefined && !options.sessionId && registry.retiredBots.length && registry.selectedBotId === null && !this.config.workspace.get()) throw new Error('No active Bot selected. Use /mbot select or an explicit init/import directory.')
    let path = options.workspace ?? this.bot(options)?.workspacePath ?? this.config.workspace.get()
    if (typeof path !== 'string') throw new Error('mbot workspace must be an absolute single-line path or ~/path')
    if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(2))
    if (path && (!isAbsolute(path) || /[\0\r\n]/u.test(path))) {
      throw new Error('mbot workspace must be an absolute single-line path or ~/path')
    }
    return path
  }

  /** ConfigEditor has its own cross-process lock; never write profile YAML here. */
  configurationEntry() {
    const editor = this.ownerContext.get('configEditor')
    for (let fiber = this.ownerContext.fiber; editor && fiber; fiber = fiber.parent?.fiber) {
      const entry = editor.entries().find(candidate => candidate.fiber?.uid === fiber.uid)
      if (entry) return { editor, entry }
      if (fiber.uid === fiber.parent?.fiber?.uid) break
    }
    throw new Error('Persistent workspace selection requires a profile-owned MBot configuration entry')
  }

  manage(operation) {
    const pending = this.initializing.then(() => {
      if (this.closed) throw new Error('mbot plugin is disposed')
      return operation()
    })
    this.initializing = pending.catch(() => {})
    return pending
  }

  /** Reserve durable ownership only; visibility-aware execution is a separate stage. */
  async reserveConversation(identity, input, options = {}) {
    const access = conversationAccess(input)
    options = { ...options }
    return this.manage(async () => {
      const { editor, entry } = this.configurationEntry()
      let saved
      await editor.edit(entry, current => {
        options.signal?.throwIfAborted()
        if (this.closed) throw new Error('mbot plugin is disposed')
        const registry = BotRegistry(current.registry ?? emptyRegistry)
        if (options.revision !== undefined && registry.revision !== options.revision) throw new Error('Bot registry changed; reload before saving')
        const bot = findBot(registry, identity)
        const key = conversationKey(access.source)
        saved = registry.conversations.find(item => item.botId === bot.botId && item.conversationKey === key)
        if (saved) {
          if (!isDeepStrictEqual({ source: saved.source, allowedSenders: saved.allowedSenders, replyRoute: saved.replyRoute }, access)) throw new Error('Conversation permission or reply route changed; existing ownership retained')
          return current
        }
        saved = reserveConversationRecord(bot.botId, access)
        return { ...current, registry: revise(registry, { conversations: [...registry.conversations, saved] }) }
      })
      return structuredClone(saved)
    })
  }

  conversation(identity, source) {
    const registry = this.registry(), bot = findBot(registry, identity)
    const key = conversationKey(source)
    return structuredClone(registry.conversations.find(item => item.botId === bot.botId && item.conversationKey === key))
  }

  authorizeConversation(identity, attestation) {
    const { senderId, replyRoute, ...source } = attestation
    const record = this.conversation(identity, source)
    if (!record) throw new Error('Conversation source has no persistent permission')
    return authorizeConversationSource(record, { ...source, senderId, replyRoute })
  }

  async importBot(directory, options = {}) {
    options = { ...options }
    return this.manage(async () => {
      options.signal?.throwIfAborted()
      if (typeof directory !== 'string' || !directory) throw new Error('import requires a data directory')
      const { editor, entry } = this.configurationEntry()
      const path = await realpath(this.workspace({ workspace: directory }))
      const candidate = registration(path, options)
      const checked = await this.execute('botctl', ['lint'], { signal: options.signal, workspace: path })
      if (checked.exitCode) throw new Error(checked.stderr || checked.stdout)
      const role = await this.execute('botctl', ['boot', candidate.defaultRole], { signal: options.signal, workspace: path })
      if (role.exitCode) throw new Error(role.stderr || role.stdout)
      options.signal?.throwIfAborted()
      if (this.closed) throw new Error('mbot plugin is disposed')
      let imported
      await editor.edit(entry, current => {
        options.signal?.throwIfAborted()
        if (this.closed) throw new Error('mbot plugin is disposed')
        const registry = BotRegistry(current.registry ?? emptyRegistry)
        if (options.revision !== undefined && registry.revision !== options.revision) throw new Error('Bot registry changed; reload before saving')
        imported = registry.bots.find(bot => bot.workspacePath === path)
        if (imported && ((options.name !== undefined && imported.name !== options.name) || (options.defaultRole !== undefined && imported.defaultRole !== options.defaultRole))) {
          throw new Error('Repository is already registered with different Bot settings')
        }
        if (imported) return current
        imported = uniqueName(registry, candidate, options.name !== undefined)
        return { ...current, registry: revise(registry, { bots: [...registry.bots, imported] }) }
      })
      return structuredClone(imported)
    })
  }

  selectBot(identity, options = {}) {
    options = { ...options }
    return this.manage(async () => {
      options.signal?.throwIfAborted()
      const { editor, entry } = this.configurationEntry()
      let selected
      await editor.edit(entry, current => {
        options.signal?.throwIfAborted()
        if (this.closed) throw new Error('mbot plugin is disposed')
        const registry = BotRegistry(current.registry ?? emptyRegistry)
        if (options.revision !== undefined && registry.revision !== options.revision) throw new Error('Bot registry changed; reload before saving')
        selected = findBot(registry, identity)
        return { ...current, registry: revise(registry, { selectedBotId: selected.botId }) }
      })
      return structuredClone(selected)
    })
  }

  removeBot(identity, options = {}) {
    if (typeof identity !== 'string' || !identity.trim() || /[\0\r\n]/u.test(identity)) return Promise.reject(new Error('remove requires an explicit Bot ID or name'))
    return this.manage(() => removeBot(this, identity, { ...options }))
  }

  async describeRemovedBots() {
    const entries = this.registry().retiredBots
    if (!entries.length) return 'No removed Bots.\n'
    return (await Promise.all(entries.map(entry => redact(`Removed Bot: ${entry.bot.name} (${entry.bot.botId})\n  Data: ${entry.bot.workspacePath}\n  Retired: ${entry.retiredAt}\n  Retired Sessions: ${entry.sessionIds.join(', ') || 'none'}\n`, entry.bot.workspacePath)))).join('')
  }

  ensureBinding(identity, options = {}) {
    options = { ...options }
    return this.manage(() => provisionBinding(this, identity, options))
  }

  resolveMainSession(identity, options = {}) {
    if (this.closed) return Promise.reject(new Error('MBot plugin is disposed'))
    return resolveBinding(this, identity, { ...options })
  }

  async describeBots() {
    const registry = this.registry()
    if (!registry.bots.length) return 'No registered Bots. Use /mbot init <directory> or /mbot import <directory>.\n'
    const rows = await Promise.all(registry.bots.map(bot => redact(
      `${bot.botId === registry.selectedBotId ? '* ' : '  '}Bot: ${bot.name} (${bot.botId})\n  Workspace: ${bot.workspacePath}\n  Role: ${bot.defaultRole}\n  DSH workspace: ${bot.workspaceId ?? 'not bound'}\n  Main Session: ${bot.mainSessionId ?? 'not bound'}\n  Binding: ${bot.binding?.state ?? 'unbound'}${bot.binding?.error ? ` (${bot.binding.error})` : ''}\n`, bot.workspacePath)))
    return `Bot registry revision: ${registry.revision}\n${rows.join('')}`
  }

  /** Initialize and persist selection in the owning profile, serialized across clients. */
  initialize(directory, options = {}) {
    options = { ...options }
    return this.manage(async () => {
      if (this.closed) throw new Error('mbot plugin is disposed')
      options.signal?.throwIfAborted()
      const { editor, entry } = this.configurationEntry()
      const before = this.config.workspace.get()
      const selection = this.registry().selectedBotId
      const result = await this.execute('mbot', ['init', ...(directory === undefined ? [] : [directory])], directory === undefined ? options : { ...options, workspace: directory })
      if (result.exitCode) return result
      let created
      try {
        options.signal?.throwIfAborted()
        if (this.closed) throw new Error('mbot plugin is disposed')
        if (!result.workspace) throw new Error('Initialization did not report its data directory')
        const candidate = registration(result.workspace)
        await editor.edit(entry, current => {
          options.signal?.throwIfAborted()
          if (this.closed) throw new Error('mbot plugin is disposed')
          const registry = BotRegistry(current.registry ?? emptyRegistry)
          if ((current.workspace ?? '') !== before || registry.selectedBotId !== selection) throw new Error('Workspace selection changed during initialization; newer selection retained')
          if (registry.bots.some(bot => bot.workspacePath === result.workspace)) throw new Error('Initialized directory is already registered; inspect its Bot binding')
          const bot = uniqueName(registry, candidate)
          created = bot
          return { ...current, workspace: result.workspace, registry: revise(registry, { bots: [...registry.bots, bot], selectedBotId: bot.botId }) }
        })
      } catch (error) {
        return { ...result, exitCode: 1, stderr: `${result.stderr}Repository initialized, but selection was not saved: ${error.message}\nSet the MBot workspace in the plugin configuration to use this repository.\n` }
      }
      let binding = 'Native main Session is unavailable in this Host. Use /mbot repair in a full DSH profile.\n'
      if (nativeBindingAvailable(this)) {
        try {
          created = await provisionBinding(this, created.botId, options)
          binding = sessionResult(created, true)
        } catch (error) {
          return { ...result, exitCode: 1, stderr: await redact(`${result.stderr}Bot data and identity saved, but main Session setup failed: ${error.message}\n`, result.workspace) }
        }
      }
      return { ...result, stdout: await redact(`${result.stdout}Bot: ${created.name} (${created.botId})\nSelected for subsequent /mbot and native botctl operations.\n${binding}Next: /mbot status\n`, result.workspace) }
    })
  }

  async execute(program, args, options = {}) {
    if (this.closed) throw new Error('mbot plugin is disposed')
    if (conversationForSession(this.registry(), options.sessionId)) throw new Error('Reserved conversation has no data tool or management permission')
    if (!['mbot', 'botctl'].includes(program)) throw new Error('unknown mbot executable')
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('invalid mbot arguments')
    args = [...args]
    options = { ...options }
    options.signal?.throwIfAborted()
    const workspace = this.workspace(options)
    const argv = [join(packageRoot, 'bin', program), ...(workspace ? ['-C', workspace] : []), ...args]
    // The provider scrubs ambient credentials/DSH identity. Forward only facts these scripts need.
    const env = { DSH_HOME: process.env.DSH_HOME, DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME, MBOT_STATE_DIR: process.env.MBOT_STATE_DIR,
      PATH: `${join(packageRoot, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}` }
    if (options.permit) {
      if (!(program === 'botctl' || (program === 'mbot' && args[0] === 'status'))
        || typeof options.permit.runId !== 'string' || !/^[0-9A-Za-z-]+$/u.test(options.permit.runId)
        || !/^[a-f0-9]{64}$/u.test(options.permit.token) || !workspace) throw new Error('Invalid managed data permit')
      env.MBOT_RUN_ID = options.permit.runId
      env.MBOT_PERMIT_TOKEN = options.permit.token
      env.MBOT_WS = workspace
    }
    if (options.recoveryOwner) {
      if (program !== 'mbot' || args[0] !== 'recover' || options.recoveryOwner.pid !== process.pid) throw new Error('Invalid recovery owner')
      env.MBOT_RECOVERY_OWNER = String(options.recoveryOwner.pid)
      env.MBOT_RECOVERY_START = options.recoveryOwner.start
      if (options.recoveryOwner.runtimeProof) env.MBOT_RUNTIME_RECOVERY_PROOF = options.recoveryOwner.runtimeProof
    }
    if (program === 'mbot' && ['run', 'tick', 'dream'].includes(args[0])) {
      env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
    }
    const child = this.ctx.subprocess.spawn({ argv, cwd: packageRoot, env, signal: options.signal,
      graceMs: 5000, stdio: { stdin: options.input === undefined ? 'ignore' : { data: options.input },
        stdout: { maxBytes: 128000 }, stderr: { maxBytes: 128000 } } })
    this.active.add(child)
    try {
      const outcome = await child.done
      options.signal?.throwIfAborted()
      const stdout = child.collected.stdout.readFrom(0)
      const stderr = child.collected.stderr.readFrom(0)
      // Bundled init has a single stable success line; capture it before text redaction.
      const initialized = program === 'mbot' && args[0] === 'init' && outcome.exitCode === 0
        ? /^Initialized (.+)\n$/u.exec(stdout.text)?.[1] : undefined
      return { exitCode: outcome.exitCode ?? 1, ...(initialized === undefined ? {} : { workspace: initialized }), stdout: await redact(stdout.text, workspace),
        stderr: await redact(stderr.text, workspace), truncated: stdout.lossy || stderr.lossy }
    } finally {
      child.terminate()
      await child.waitForExit()
      this.active.delete(child)
    }
  }

  beginTurn(options) {
    if (this.closed) return Promise.reject(new Error('mbot plugin is disposed'))
    if (conversationForSession(this.registry(), options.sessionId)) return Promise.reject(new Error('Reserved conversation requires memory and tool visibility filtering before execution'))
    const bot = this.bot(options)
    if (!bot) return Promise.reject(new Error('Managed turn requires a registered Bot'))
    return openTurn(this, packageRoot, bot, { ...options })
  }

  recoverTurn(options = {}) {
    options = { ...options }
    return this.manage(() => recoverSelected(this, options))
  }
}

export function apply(ctx, config) {
  BotRegistry(config.registry.get())
  const owner = ctx.fiber.uid
  // Keep the public schema projectable; native cross-record rules also run on edits.
  ctx.on('internal/config', (fiber, next) => {
    const input = next()
    if (fiber.uid === owner) registryTransition(config.registry.get(), input.registry ?? emptyRegistry)
    return input
  })
  ctx.plugin(MBotService, config)
}
