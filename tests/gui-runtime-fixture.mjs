// Loaded only by gui-runtime.mjs inside a disposable installed Web profile.
import { appendFile, writeFile, mkdir, chmod, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay, setImmediate } from 'node:timers/promises'

export const inject = ['llm', 'mbot', 'mbotRuntime', 'tools', 'subprocess', 'agents', 'commands', 'workspaceController']
if (process.env.MBOT_GUI_RUNTIME_ROOT) await writeFile(join(process.env.MBOT_GUI_RUNTIME_ROOT, 'fixture-imported'), '')
export function apply(ctx) {
  void writeFile(join(process.env.MBOT_GUI_RUNTIME_ROOT, 'fixture-applied'), '')
  void setImmediate().then(() => setup(ctx)).catch(error => writeFile(join(process.env.MBOT_GUI_RUNTIME_ROOT, 'fixture-error.txt'), error.stack ?? String(error)))
}
async function setup(ctx) {
  const root = process.env.MBOT_GUI_RUNTIME_ROOT
  const fromPackage = createRequire(process.env.MBOT_GUI_PACKAGE)
  const { LlmAdapter } = await import(fromPackage.resolve('@deepseek-ai/dsh-llm'))
  const { defineTool } = await import(fromPackage.resolve('@deepseek-ai/dsh-tools'))
  const marker = name => join(root, name)
  ctx.commands.register({ name: 'mbot_fixture_delete', description: 'Delete a native workspace inside the disposable GUI fixture.', recordInput: false,
    async handler(invocation) {
      const bot = ctx.mbot.bot({ sessionId: invocation.agent.id })
      await ctx.workspaceController.delete({ workspaceId: bot.workspaceId })
      return { kind: 'success', text: `Native workspace deleted: ${bot.workspaceId}` }
    } })
  const wait = async name => {
    const deadline = Date.now() + 15000
    while (!existsSync(marker(name))) {
      if (Date.now() > deadline) throw new Error(`fixture timed out waiting for ${name}`)
      await delay(20)
    }
  }
  const shim = marker('git-shim')
  await mkdir(shim, { recursive: true })
  await writeFile(join(shim, 'git'), '#!/bin/sh\nfor arg do\n  if [ "$arg" = commit ]; then exit 1; fi\ndone\nexec /usr/bin/git "$@"\n')
  await chmod(join(shim, 'git'), 0o700)
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = spec => {
    if (spec.argv[0].endsWith('/bin/mbot-turn') && existsSync(marker('fail-next-commit'))) {
      void unlink(marker('fail-next-commit'))
      return spawn({ ...spec, env: { ...spec.env, PATH: `${shim}:${spec.env.PATH}` } })
    }
    return spawn(spec)
  }
  // Auxiliary or misrouted requests cannot reach the real provider in this fixture.
  const fetch = globalThis.fetch
  globalThis.fetch = (...args) => {
    const input = args[0]
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/u.test(url)) throw new Error('GUI fixture refuses external network requests')
    return fetch(...args)
  }
  ctx.effect(() => () => { globalThis.fetch = fetch; ctx.subprocess.spawn = spawn })
  ctx.tools.register(defineTool({ name: 'mbot_gui_writer', description: 'Deterministic foreground cleanup writer.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute(_args, exec) {
      await writeFile(marker('writer-started'), '')
      await new Promise(resolve => {
        if (exec.signal.aborted) resolve()
        else exec.signal.addEventListener('abort', resolve, { once: true })
      })
      await writeFile(marker('writer-cancelled'), '')
      await wait('release-writer')
      const lease = ctx.mbotRuntime.dataLease(exec.agent)
      if (existsSync(marker('violate-next-stop'))) {
        await unlink(marker('violate-next-stop'))
        await writeFile(join(lease.snapshot.workspace, 'MEMORY.md'), 'forbidden cancelled memory edit\n')
      }
      await lease.execute('botctl', ['remember', 'GUI writer cleanup joined'])
      return 'GUI writer cleanup joined'
    },
  }))
  ctx.effect(() => ctx.mbotRuntime.foregroundTool('mbot_gui_writer'))
  let toolSequence = 0
  class Scripted extends LlmAdapter {
    listModels() { return Promise.resolve([{ id: 'scripted', name: 'Scripted UI fixture' }]) }
    async *stream(request) {
      if (!request.purpose) {
        const user = request.messages.filter(message => message.role === 'user' && message.content.some(block => block.type === 'text'
          && /^(hold audit|slow writer|queued after writer|wake|fail audit)$/u.test(block.text))).at(-1)
        const text = user?.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
        await appendFile(marker('requests.jsonl'), JSON.stringify({ sessionId: request.sessionId, text }) + '\n')
        const agent = ctx.agents.get(request.sessionId)
        if (text.includes('hold audit')) {
          const lease = ctx.mbotRuntime.dataLease(agent)
          const finish = lease.finish.bind(lease)
          lease.finish = async outcome => { await writeFile(marker('audit-waiting'), ''); await wait('release-audit'); return finish(outcome) }
        }
        if (text.includes('slow writer')) {
          const block = { type: 'tool-call', id: `gui-cleanup-writer-${++toolSequence}`, name: 'mbot_gui_writer', arguments: '{}' }
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `GUI reply: ${text}` } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'GUI Bot' } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mbot-ui-fixture'], new Scripted())
  ctx.on('session/event', (session, event) => {
    void appendFile(marker('events.jsonl'), JSON.stringify({ sessionId: session.id, event }) + '\n')
  })
  await writeFile(marker('fixture-ready'), '')
}
