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
      return { exitCode: outcome.exitCode ?? 1, stdout: await redact(stdout.text, workspace),
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
