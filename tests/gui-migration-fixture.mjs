// A local-only model inside a disposable old/current installed Harness profile.
import { appendFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { setImmediate } from 'node:timers/promises'
export const inject = ['llm', 'mbot', 'mbotRuntime', 'subprocess', 'commands']
export function apply(ctx) {
  void setImmediate().then(() => setup(ctx)).catch(error => writeFile(join(process.env.MBOT_MIGRATION_ROOT, 'fixture-error'), error.stack ?? String(error)))
}
async function setup(ctx) {
  const root = process.env.MBOT_MIGRATION_ROOT
  const fromPackage = createRequire(process.env.MBOT_MIGRATION_PACKAGE)
  const { LlmAdapter } = await import(fromPackage.resolve('@deepseek-ai/dsh-llm'))
  const shim = join(root, 'node-shim')
  await mkdir(shim, { recursive: true })
  await writeFile(join(shim, 'node'), `#!/bin/sh\ncase "$1" in */bin/turn-reply.mjs) exit 1 ;; esac\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`)
  await chmod(join(shim, 'node'), 0o700)
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  let protectedChild
  ctx.commands.register({ name: 'mbot_fixture_protected', description: 'Create a protected child only inside this test Host.', recordInput: false,
    async handler() {
      protectedChild = spawn({ argv: ['python3', '-u', '-c', 'import ctypes,os,time; ctypes.CDLL(None).prctl(4,0); print(os.getpid(),flush=True); time.sleep(120)'],
        cwd: root, graceMs: 5000, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 8000 } } })
      await Promise.race([new Promise(resolve => protectedChild.stdout.once('data', resolve)), protectedChild.done.then(() => {
        throw new Error('Protected fixture child exited before readiness')
      })]).catch(async error => { await writeFile(join(root, 'protected-fixture-error'), error.stack ?? String(error)); throw error })
      await writeFile(join(root, 'protected-host-child'), '')
      return { kind: 'success', text: 'Protected test child ready' }
    } })
  ctx.commands.register({ name: 'mbot_fixture_unprotect', description: 'Join the protected child created by this test Host.', recordInput: false,
    async handler() {
      protectedChild.terminate(); await protectedChild.waitForExit()
      await writeFile(join(root, 'protected-host-child-ended'), '')
      return { kind: 'success', text: 'Protected test child ended' }
    } })
  ctx.effect(() => async () => { if (protectedChild) { protectedChild.terminate(); await protectedChild.waitForExit() } })
  ctx.subprocess.spawn = spec => spec.argv[0].endsWith('/bin/mbot-turn') && existsSync(join(root, 'legacy-mode'))
    ? spawn({ ...spec, env: { ...spec.env, PATH: `${shim}:${spec.env.PATH}` } }) : spawn(spec)
  const fetch = globalThis.fetch
  globalThis.fetch = (...args) => {
    const input = args[0], url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/u.test(url)) throw new Error('Migration fixture refuses external network requests')
    return fetch(...args)
  }
  ctx.effect(() => () => { ctx.subprocess.spawn = spawn; globalThis.fetch = fetch })
  const counts = new Map()
  class Scripted extends LlmAdapter {
    listModels() { return Promise.resolve([{ id: 'scripted', name: 'Scripted legacy migration' }]) }
    async *stream(request) {
      let block = { type: 'text', text: 'Legacy answer retained' }
      if (!request.purpose) {
        const text = request.messages.filter(message => message.role === 'user').flatMap(message => message.content)
          .filter(block => block.type === 'text' && /^(inspect readonly|write legacy|unknown legacy|resume after legacy migration)$/u.test(block.text)).at(-1)?.text
        const n = (counts.get(request.sessionId) ?? 0) + 1
        counts.set(request.sessionId, n)
        await appendFile(join(root, 'requests.jsonl'), JSON.stringify({ sessionId: request.sessionId, n, text })+'\n')
        let tool
        if (text !== 'resume after legacy migration' && n === 1) tool = { name: 'botctl', args: { action: 'boot', bot: 'chief' } }
        if (text !== 'resume after legacy migration' && n === 2) tool = text === 'write legacy'
          ? { name: 'botctl', args: { action: 'remember', text: 'legacy writer must not use readonly migration' } }
          : text === 'unknown legacy' ? { name: 'bash', args: { command: 'printf readonly', description: 'A shell call remains outside readonly migration.' } }
            : { name: 'botctl', args: { action: 'board_show' } }
        if (tool) block = { type: 'tool-call', id: `migration-call-${n}`, name: tool.name, arguments: JSON.stringify(tool.args) }
      }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mbot-legacy-fixture'], new Scripted())
  await writeFile(join(root, 'fixture-ready'), '')
}
