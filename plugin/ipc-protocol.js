import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createConnection } from 'node:net'

export const ipcVersion = 1
export const maxFrameBytes = 1600000
export const hostActions = ['talk', 'receipt', 'runtime', 'stop', 'compact', 'bots', 'remove', 'removed', 'recover']
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24)

export async function ipcLocation(options) {
  if (typeof process.getuid !== 'function') throw new Error('MBot local IPC requires Linux/WSL')
  if (options.directory) {
    if (!isAbsolute(options.directory) || /[\0\r\n]/u.test(options.directory)) throw new Error('IPC directory must be an absolute single-line path')
    const directory = resolve(options.directory)
    const socketPath = join(directory, 'owner.sock')
    if (Buffer.byteLength(socketPath) > 100) throw new Error('IPC socket path is too long; choose a short directory under /tmp')
    return { directory, socketPath, profileId: `explicit:${digest(directory)}` }
  }
  const profileDirectory = await realpath(options.profileDirectory)
  const profileId = `profile:${digest(profileDirectory)}`
  const directory = `/tmp/dsh-mbot-${process.getuid()}-${digest(profileDirectory)}`
  return { directory, socketPath: join(directory, 'owner.sock'), profileId }
}

export async function profileLocation(profile, env = process.env) {
  if (typeof profile !== 'string' || !profile || /[\0\r\n/\\]/u.test(profile) || ['.', '..', 'node_modules'].includes(profile)) throw new Error('Invalid DSH profile name')
  // Matches DSH 0.2.2-rc.5 resolveDshHome: blank overrides are unset and
  // supported tilde prefixes expand before resolving the absolute path.
  let home = env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), '.dsh')
  if (home === '~') home = homedir()
  else if (home.startsWith('~/') || home.startsWith('~\\')) home = join(homedir(), home.slice(2))
  return ipcLocation({ profileDirectory: join(resolve(home), 'profiles', profile) })
}

export async function privatePath(path, kind) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)
    || (kind === 'directory' ? !stat.isDirectory() : kind === 'socket' ? !stat.isSocket() : !stat.isFile())) throw new Error('MBot IPC path must be private, owned by this user, and have the expected file type')
  return stat
}

/** One request, no automatic reconnect/replay and no cancellation of Agent work. */
export async function requestHost(location, input, options = {}) {
  const request = structuredClone(input)
  const transportId = randomUUID()
  const frame = Buffer.from(JSON.stringify({ ...request, schemaVersion: ipcVersion, transportId, profileId: location.profileId }) + '\n')
  if (frame.length > maxFrameBytes) throw new Error('IPC request exceeds frame limit')
  options.signal?.throwIfAborted()
  try {
    await privatePath(location.directory, 'directory')
    await privatePath(location.socketPath, 'socket')
  } catch (error) {
    const failure = new Error(error.code === 'ENOENT' ? 'MBot Host IPC is unavailable; start the matching DSH profile' : error.message)
    failure.code = 'IPC_UNAVAILABLE'
    failure.uncertain = false
    throw failure
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(location.socketPath)
    let sent = false, done = false, bytes = 0
    const chunks = []
    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
      socket.destroy()
      if (error) {
        const uncertain = sent && ['talk', 'stop', 'remove', 'recover'].includes(request.action)
        const failure = new Error(uncertain ? request.action === 'remove'
          ? 'Host acknowledgement is unconfirmed; inspect removed Bots before retrying with the same stable Bot ID'
          : request.action === 'recover' ? 'Host acknowledgement is unconfirmed; inspect Bot status and retry recovery with the same stable Bot ID'
          : 'Host acknowledgement is unconfirmed; query status or retry talk with the same request ID'
          : 'MBot Host IPC is unavailable; start the matching DSH profile')
        failure.code = uncertain ? 'IPC_UNCONFIRMED' : 'IPC_UNAVAILABLE'
        failure.uncertain = uncertain
        reject(failure)
      } else resolve(value)
    }
    const cancel = () => finish(new Error('Caller stopped waiting'))
    const timer = setTimeout(() => finish(new Error('IPC timeout')), options.timeoutMs ?? 15000)
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) { cancel(); return }
    socket.once('connect', () => { sent = true; socket.write(frame) })
    socket.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxFrameBytes) { finish(new Error('IPC response exceeds frame limit')); return }
      chunks.push(chunk)
      if (!chunk.includes(10)) return
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim())
        if (value.schemaVersion !== ipcVersion || value.transportId !== transportId || value.profileId !== location.profileId
          || typeof value.ok !== 'boolean' || typeof value.instanceId !== 'string') throw new Error('IPC response identity mismatch')
        finish(undefined, value)
      } catch (error) { finish(error) }
    })
    socket.once('error', finish)
    socket.once('end', () => finish(new Error('Host disconnected before acknowledgement')))
    socket.once('close', () => finish(new Error('IPC connection closed')))
  })
}
