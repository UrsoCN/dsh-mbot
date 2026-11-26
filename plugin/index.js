import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redact } from './redact.js'

export const name = 'mbot'
export const inject = ['subprocess']
export const Config = z.object({
  workspace: z.string().pattern(/^(?:|~|\/[^\0\r\n]*|~\/[^\0\r\n]*)$/u).default('').description('Bot data repository; absolute path or ~/. Empty uses MBOT_WS and the mbot user configuration.').volatile(),
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
    this.closed = false
    ctx.effect(() => async () => {
      this.closed = true
      for (const child of this.active) child.terminate()
      await Promise.allSettled([...this.active].map(child => child.waitForExit()))
    })
  }

  /** Capture live configuration once so an edit cannot redirect an in-flight operation. */
  workspace() {
    let path = this.config.workspace.get()
    if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(2))
    if (path && (!isAbsolute(path) || /[\0\r\n]/u.test(path))) {
      throw new Error('mbot workspace must be an absolute single-line path or ~/path')
    }
    return path
  }

  /** Initialize and persist selection in the owning profile, serialized across clients. */
  initialize(directory, options = {}) {
    const run = async () => {
      if (this.closed) throw new Error('mbot plugin is disposed')
      options.signal?.throwIfAborted()
      const editor = this.ownerContext.get('configEditor')
      let entry
      for (let fiber = this.ownerContext.fiber; fiber && !entry; fiber = fiber.parent?.fiber) {
        entry = editor?.entries().find(candidate => candidate.fiber?.uid === fiber.uid)
        if (fiber.uid === fiber.parent?.fiber?.uid) break
      }
      if (!entry) throw new Error('Persistent workspace selection requires a profile-owned MBot configuration entry')
      const before = this.config.workspace.get()
      const result = await this.execute('mbot', ['init', ...(directory === undefined ? [] : [directory])], options)
      if (result.exitCode) return result
      try {
        options.signal?.throwIfAborted()
        if (this.closed) throw new Error('mbot plugin is disposed')
        if (!result.workspace) throw new Error('Initialization did not report its data directory')
        await editor.edit(entry, current => {
          if ((current.workspace ?? '') !== before) throw new Error('Workspace selection changed during initialization; newer selection retained')
          return { ...current, workspace: result.workspace }
        })
      } catch (error) {
        return { ...result, exitCode: 1, stderr: `${result.stderr}Repository initialized, but selection was not saved: ${error.message}\nSet the MBot workspace in the plugin configuration to use this repository.\n` }
      }
      return { ...result, stdout: `${result.stdout}Selected for subsequent /mbot and native botctl operations.\nNext: /mbot status\n` }
    }
    const pending = this.initializing.then(run)
    this.initializing = pending.catch(() => {})
    return pending
  }

  async execute(program, args, options = {}) {
    if (this.closed) throw new Error('mbot plugin is disposed')
    if (!['mbot', 'botctl'].includes(program)) throw new Error('unknown mbot executable')
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('invalid mbot arguments')
    options.signal?.throwIfAborted()
    const workspace = this.workspace()
    const argv = [join(packageRoot, 'bin', program), ...(workspace ? ['-C', workspace] : []), ...args]
    // The provider scrubs ambient credentials/DSH identity. Forward only facts these scripts need.
    const env = { DSH_HOME: process.env.DSH_HOME, DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE,
      PATH: `${join(packageRoot, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}` }
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
}

export function apply(ctx, config) {
  ctx.plugin(MBotService, config)
}
