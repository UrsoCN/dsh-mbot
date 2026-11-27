import { access, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

export function defaultSessionRoot(env = process.env) {
  let home = env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), '.dsh')
  if (home === '~') home = homedir()
  else if (home.startsWith('~/') || home.startsWith('~\\')) home = join(homedir(), home.slice(2))
  return join(resolve(home), 'sessions')
}

/** Resolve the installed Harness, without evaluating shell text or profile code. */
export async function nativeSdk(command = process.env.MBOT_DSH || 'dsh') {
  if (typeof command !== 'string' || !command || /[\0\r\n]/u.test(command)) throw new Error('Invalid Harness executable')
  const choices = command.includes('/') ? [resolve(command)] : (process.env.PATH || '/usr/bin:/bin').split(':').map(path => join(path || '.', command))
  let executable
  for (const path of choices) {
    try { await access(path, constants.X_OK); executable = await realpath(path); break }
    catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error }
  }
  if (!executable) throw new Error('Harness executable is unavailable; specify --dsh with the installed dsh path')
  let directory = dirname(executable)
  for (let level = 0; level < 8; level++) {
    const file = join(directory, 'package.json')
    try {
      const pkg = JSON.parse(await readFile(file, 'utf8'))
      if (pkg.name === '@deepseek-ai/dsh') {
        if (pkg.version !== '0.2.2-rc.5') throw new Error('Readonly migration currently requires the verified Harness 0.2.2-rc.5 SDK')
        return createRequire(file)
      }
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error('Cannot resolve the native Harness SDK from its executable')
}

/** Native read handles never acquire a Session writer, append, flush or resume. */
export async function openNativeRead(sessionId, options = {}) {
  const root = options.sessionRoot ?? defaultSessionRoot()
  if (typeof root !== 'string' || !isAbsolute(root) || /[\0\r\n]/u.test(root)) throw new Error('Native session root must be an absolute single-line directory')
  const require = await nativeSdk(options.dsh)
  const [{ Context }, Sessions, Persistence] = await Promise.all([
    import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href),
    import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href),
  ])
  const ctx = new Context()
  let handle
  try {
    await ctx.plugin(Sessions.default ?? Sessions)
    await ctx.plugin(Persistence, { root, compression: 'zstd' })
    handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal: options.signal })
    const read = await handle.read(0, undefined, { signal: options.signal })
    return { log: { session: handle.header, inheritedEventCount: handle.inheritedEventCount, events: read.events },
      close: async () => { await handle.close(); await ctx.fiber.dispose() } }
  } catch (error) {
    await handle?.close().catch(() => {})
    await ctx.fiber.dispose()
    throw error
  }
}
