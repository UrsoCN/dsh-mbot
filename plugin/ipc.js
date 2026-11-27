import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createServer } from 'node:net'
import { constants } from 'node:fs'
import { open, mkdir, lstat, chmod, unlink, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { ipcLocation, ipcVersion, maxFrameBytes, hostActions, privatePath } from './ipc-protocol.js'
import { redact, redactValue } from './redact.js'
import { processStart, currentBootId, validBootId } from './recovery.js'

export const name = 'mbot-ipc'
export const inject = ['mbot', 'mbotRuntime', 'agents', 'subprocess']
export const Config = z.object({
  enabled: z.boolean().default(true).description('Private local botctl Host entry; disable to retain only Web/Host APIs.'),
  directory: z.string().pattern(/^(?:|\/[^\0\r\n]*)$/u).default('').description('Private short IPC directory. Empty derives a /tmp location from the DSH profile.'),
})

function validateRequest(input, profileId) {
  const common = ['schemaVersion', 'transportId', 'profileId', 'action']
  const fields = input?.action === 'talk' ? ['botId', 'requestId', 'text', 'correlationId']
    : input?.action === 'receipt' ? ['botId', 'requestId']
    : ['bots', 'removed', 'overview'].includes(input?.action) ? []
    : input?.action === 'remove' ? ['botId', 'revision']
    : input?.action === 'sleep' ? ['botId', 'skipDream', 'compact']
    : ['botId']
  if (!input || Array.isArray(input) || input.schemaVersion !== ipcVersion || input.profileId !== profileId
    || !hostActions.includes(input.action) || typeof input.transportId !== 'string' || !/^[0-9a-f-]{36}$/u.test(input.transportId)
    || Object.keys(input).some(key => ![...common, ...fields].includes(key))) throw new Error('Invalid IPC request version, profile, action or fields')
  if (!['bots', 'removed', 'overview'].includes(input.action) && (typeof input.botId !== 'string' || !input.botId || input.botId.length > 1024 || /[\0\r\n]/u.test(input.botId))) throw new Error('IPC operation requires a Bot identity')
  if (input.action === 'sleep' && ((input.skipDream !== undefined && typeof input.skipDream !== 'boolean') || (input.compact !== undefined && typeof input.compact !== 'boolean'))) throw new Error('Invalid sleep options')
  if (['remove', 'recover'].includes(input.action) && (!/^bot-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(input.botId)
    || input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 0))) throw new Error('IPC removal/recovery requires a stable Bot ID and valid optional revision')
  return input
}

/** Owner-local transport adapter. Session/Inbox/Runtime remain the authority. */
export class MBotIpc extends Service {
  static inject = inject

  constructor(ctx, config) {
    super(ctx, 'mbotIpc')
    this.config = config
    this.instanceId = randomUUID()
    this.state = 'starting'
    this.clients = new Set()
    this.operations = new Set()
    this.closed = false
    ctx.effect(() => () => this.close())
  }

  async [Service.init]() {
    this.startup = this.start()
    return this.startup
  }

  async start() {
    if (!this.config.enabled) { this.state = 'disabled'; return }
    const profile = this.ctx.get('profileContext')
    if (!this.config.directory && !profile?.dir) { this.state = 'unavailable'; this.error = 'No DSH profile location; configure an explicit IPC directory'; return }
    try {
      this.endpoint = await ipcLocation({ directory: this.config.directory, profileDirectory: profile?.dir })
      await mkdir(this.endpoint.directory, { recursive: true, mode: 0o700 })
      await privatePath(this.endpoint.directory, 'directory')
      const lockPath = join(this.endpoint.directory, 'owner.lock')
      const lock = await open(lockPath, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try { await privatePath(lockPath, 'file') } finally { await lock.close() }
      if (this.closed) throw new Error('IPC disposed during initialization')
      this.lock = this.ctx.subprocess.spawn({ argv: ['flock', '-n', lockPath, 'sh', '-c', 'printf "ready\\n"; cat >/dev/null'],
        cwd: this.endpoint.directory, graceMs: 5000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8000 } } })
      this.lock.stdin.on('error', () => {})
      const reader = createInterface({ input: this.lock.stdout })
      const first = await reader[Symbol.asyncIterator]().next()
      reader.close()
      if (first.done || first.value !== 'ready') { await this.releaseLock(); this.state = 'busy'; return }
      if (this.closed) throw new Error('IPC disposed during initialization')
      this.ownerPath = join(this.endpoint.directory, 'owner.json')
      const bootId = await currentBootId()
      const previous = await this.readOwner()
      if (previous) {
        let birth
        const sameBoot = previous.bootId === undefined || previous.bootId === bootId
        if (sameBoot) {
          try { birth = await processStart(previous.pid) } catch (error) { if (error.code !== 'ENOENT') throw error }
        }
        // A dead flock helper does not prove its live Host has drained already
        // transferred operations. The PID birth record survives that failure.
        if (sameBoot && birth === previous.ownerStart) { await this.releaseLock(); this.state = 'busy'; return }
        await unlink(this.ownerPath)
      }
      const temporary = join(this.endpoint.directory, `owner.${this.instanceId}.tmp`)
      const owner = await open(temporary, 'wx', 0o600)
      try {
        await owner.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, ownerStart: await processStart(), bootId,
          instanceId: this.instanceId, profileId: this.endpoint.profileId }))
        await owner.sync()
        if (this.closed) throw new Error('IPC disposed during initialization')
        await rename(temporary, this.ownerPath)
        this.ownsDescriptor = true
      } finally {
        await owner.close()
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
      const lostLock = () => {
        if (this.closed || this.state === 'failed' || this.state === 'busy') return
        this.state = 'failed'
        this.error = 'IPC owner lock was lost'
        void this.close().catch(() => { this.ctx.logger.warn('MBot IPC could not settle its lost owner lock') })
      }
      void this.lock.done.then(lostLock, lostLock)
      // Reclaim only after flock proves no other endpoint owner remains.
      try { await privatePath(this.endpoint.socketPath, 'socket'); await unlink(this.endpoint.socketPath) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      this.server = createServer(socket => this.accept(socket))
      this.server.maxConnections = 128
      await new Promise((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(this.endpoint.socketPath, resolve)
      })
      this.server.on('error', error => { this.error = 'IPC listener failed'; this.state = 'failed'; void this.ctx.logger.warn('MBot IPC listener failed') })
      await chmod(this.endpoint.socketPath, 0o600)
      this.socketIdentity = await privatePath(this.endpoint.socketPath, 'socket')
      if (this.closed) throw new Error('IPC disposed during initialization')
      this.state = 'ready'
    } catch (error) {
      this.error = await redact(error.message ?? String(error))
      this.state = 'failed'
      await this.shutdown()
      throw new Error(this.error)
    }
  }

  status() { return structuredClone({ state: this.closed && this.state === 'ready' ? 'unavailable' : this.state,
    ...(this.endpoint ? { ...this.endpoint, instanceId: this.instanceId } : {}), ...(this.error ? { error: this.error } : {}) }) }

  async readOwner() {
    try {
      const stat = await privatePath(this.ownerPath, 'file')
      if (stat.size > 4096) throw new Error('Invalid IPC owner descriptor')
      const owner = JSON.parse(await readFile(this.ownerPath, 'utf8'))
      if (owner.schemaVersion !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.ownerStart !== 'string'
        || !/^\d+$/u.test(owner.ownerStart) || (owner.bootId !== undefined && !validBootId(owner.bootId))
        || typeof owner.instanceId !== 'string' || owner.profileId !== this.endpoint.profileId) throw new Error('Invalid IPC owner descriptor')
      return owner
    } catch (error) { if (error.code === 'ENOENT') return; throw error }
  }

  accept(socket) {
    if (this.closed || this.state !== 'ready') { socket.destroy(); return }
    this.clients.add(socket)
    socket.once('close', () => this.clients.delete(socket))
    socket.on('error', () => {})
    socket.setTimeout(15000, () => socket.destroy())
    const chunks = []
    let bytes = 0, handled = false
    socket.on('data', chunk => {
      if (handled) return
      bytes += chunk.length
      if (bytes > maxFrameBytes) { handled = true; socket.destroy(); return }
      chunks.push(chunk)
      if (!chunk.includes(10)) return
      handled = true
      socket.pause()
      const operation = this.handle(socket, Buffer.concat(chunks))
      this.operations.add(operation)
      void operation.finally(() => this.operations.delete(operation)).catch(() => {})
    })
  }

  async handle(socket, line) {
    let input, workspace = ''
    const response = { schemaVersion: ipcVersion, transportId: '', profileId: this.endpoint.profileId, instanceId: this.instanceId }
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
      if (typeof input?.transportId === 'string') response.transportId = input.transportId
      validateRequest(input, this.endpoint.profileId)
      if (this.closed || this.ctx.mbotRuntime.closed) throw new Error('MBot Host is unavailable')
      if (input.action === 'bots') {
        const { retiredBots, ...active } = this.ctx.mbot.registry()
        response.value = active
      } else if (input.action === 'removed') {
        const registry = this.ctx.mbot.registry()
        response.value = { schemaVersion: registry.schemaVersion, revision: registry.revision, retiredBots: registry.retiredBots }
      } else if (input.action === 'overview') {
        response.value = await this.ctx.mbotRuntime.overview()
      } else if (input.action === 'sleep') {
        const bot = this.ctx.mbot.bot({ botId: input.botId })
        workspace = bot.workspacePath
        response.value = await this.ctx.mbotRuntime.sleep(bot.botId, { skipDream: input.skipDream === true, compact: input.compact === true })
      } else if (input.action === 'wake') {
        const bot = this.ctx.mbot.bot({ botId: input.botId })
        workspace = bot.workspacePath
        response.value = await this.ctx.mbotRuntime.wake(bot.botId)
      } else if (input.action === 'recover') response.value = await this.ctx.mbot.recoverTurn({ botId: input.botId })
      else if (input.action === 'remove') response.value = await this.ctx.mbot.removeBot(input.botId, { revision: input.revision })
      else {
        // Capture the stable Bot identity before any asynchronous resolution.
        const bot = this.ctx.mbot.bot({ botId: input.botId })
        workspace = bot.workspacePath
        if (bot.binding?.state !== 'ready') throw new Error('Bot main Session is not ready; use /mbot repair')
        const resolved = await this.ctx.mbot.resolveMainSession(bot.botId)
        if (this.closed) throw new Error('MBot Host is unavailable')
        const agent = this.ctx.agents.get(resolved.mainSessionId)
        if (!agent) throw new Error('Bot main Agent is unavailable')
        if (input.action === 'runtime') response.value = await this.ctx.mbotRuntime.status(agent)
        else if (input.action === 'stop') response.value = await this.ctx.mbotRuntime.stop(agent)
        else if (input.action === 'compact') response.value = await this.ctx.mbotRuntime.compact(agent)
        else {
          const mailbox = this.ctx.mbotRuntime.ownerMailbox(agent, { visibility: 'owner-private', adapterId: 'botctl-local-v1',
            ownerId: `local-uid:${process.getuid()}`, conversationKey: 'main', replyRoute: 'botctl-local' })
          try {
            response.value = input.action === 'talk' ? await mailbox.send({ requestId: input.requestId, text: input.text,
              ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }) }) : await mailbox.receipt(input.requestId)
            response.value ??= null
          } finally { mailbox.dispose() }
        }
      }
      response.ok = true
    } catch (error) {
      if (typeof input?.transportId === 'string') response.transportId = input.transportId
      response.ok = false
      response.error = { code: this.closed ? 'IPC_UNAVAILABLE' : 'IPC_REJECTED', message: await redact(error.message ?? String(error), workspace) }
    }
    // A disconnected observer never cancels a transferred request or releases
    // its operation ownership. Teardown joins this promise even without reply.
    const safe = await redactValue(response, workspace)
    if (!socket.destroyed) socket.end(JSON.stringify(safe) + '\n')
  }

  async releaseLock() {
    if (!this.lock) return
    this.lock.stdin.end()
    this.lock.terminate()
    await this.lock.waitForExit()
    this.lock = undefined
  }

  close() {
    if (this.closure) return this.closure
    this.closed = true
    this.closure = (async () => {
      await this.startup?.catch(() => {})
      await this.shutdown()
    })()
    return this.closure
  }

  async shutdown() {
    const serverClosed = this.server?.listening ? new Promise(resolve => this.server.close(resolve)) : Promise.resolve()
    for (const socket of this.clients) socket.destroy()
    await Promise.allSettled([...this.operations])
    await serverClosed
    if (this.socketIdentity) {
      try {
        const current = await lstat(this.endpoint.socketPath)
        if (current.dev === this.socketIdentity.dev && current.ino === this.socketIdentity.ino) await unlink(this.endpoint.socketPath)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (this.ownsDescriptor) {
      const owner = await this.readOwner()
      if (owner?.instanceId !== this.instanceId) throw new Error('IPC owner descriptor changed; preserving ownership evidence')
      await unlink(this.ownerPath)
      this.ownsDescriptor = false
    }
    // Never unlink owner.lock: retaining its inode prevents split flock owners.
    await this.releaseLock()
  }
}

export async function apply(ctx, config) { await ctx.plugin(MBotIpc, config) }
