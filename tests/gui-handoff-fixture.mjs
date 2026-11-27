// Real DSH HMR fixture; all state and providers remain inside a disposable profile.
import { appendFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

export const inject = ['llm', 'tools', 'agents', 'commands', 'mbot', 'sessionQuery', 'hmr']
export async function apply(ctx) {
  const root = process.env.MBOT_GUI_HANDOFF_ROOT
  const fromPackage = createRequire(process.env.MBOT_GUI_PACKAGE)
  const { LlmAdapter, createUserMessage } = await import(fromPackage.resolve('@deepseek-ai/dsh-llm'))
  const { defineTool } = await import(fromPackage.resolve('@deepseek-ai/dsh-tools'))
  const marker = name => join(root, name)
  const record = (file, value) => appendFile(marker(file), JSON.stringify(value) + '\n')
  const wait = async name => {
    const deadline = Date.now() + 20000
    while (!existsSync(marker(name))) { if (Date.now() > deadline) throw new Error(`HMR fixture timeout: ${name}`); await delay(20) }
  }
  const fetch = globalThis.fetch
  globalThis.fetch = (...args) => {
    const input = args[0]
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/u.test(url)) throw new Error('HMR fixture refuses external requests')
    return fetch(...args)
  }
  ctx.effect(() => () => { globalThis.fetch = fetch })
  class Scripted extends LlmAdapter {
    listModels() { return Promise.resolve([{ id: 'scripted', name: 'HMR fixture' }]) }
    async *stream(request) {
      const text = request.messages.filter(message => message.role === 'user').flatMap(message => message.content)
        .filter(block => block.type === 'text' && /^hmr /u.test(block.text)).at(-1)?.text ?? ''
      if (!request.purpose) await record('requests.jsonl', { sessionId: request.sessionId, text, messages: request.messages })
      const block = !request.purpose && text === 'hmr slow writer'
        ? { type: 'tool-call', id: 'hmr-writer-call', name: 'mbot_hmr_writer', arguments: '{}' }
        : { type: 'text', text: request.purpose ? 'HMR Bot' : `HMR reply: ${text}` }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mbot-hmr-fixture'], new Scripted())
  let unrelated
  ctx.commands.register({ name: 'hmr_recompose', description: 'Exercise official profile module reconciliation', recordInput: false,
    async handler() {
      try {
        const result = await ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile())
        return { kind: 'success', text: `Profile reconciliation: ${JSON.stringify(result)}` }
      } catch (error) { return { kind: 'error', text: `Profile reconciliation failed: ${error.message}` } }
    } })
  ctx.commands.register({ name: 'hmr_unrelated', description: 'Verify an unrelated native Session survives plugin HMR', recordInput: false,
    async handler() {
      unrelated ??= await ctx.agents.create({ sessionId: 'hmr-unrelated-session', meta: { cwd: root },
        agentOptions: { provider: 'mbot-hmr-fixture', model: 'scripted' } })
      unrelated.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hmr unrelated request' }], source: { kind: 'user' } }))
      await unrelated.agent.whenIdle()
      return { kind: 'success', text: `Unrelated Agent alive: ${unrelated.agent.id}` }
    } })
  ctx.on('session/event', (session, event) => { void record('events.jsonl', { sessionId: session.id, event }) })
  let previous, generation = 0
  ctx.inject(['mbotRuntime'], child => {
    const runtime = child.mbotRuntime
    const constructor = runtime.constructor
    if (previous === constructor) throw new Error('HMR reused the old Runtime class')
    previous = constructor
    const current = ++generation
    child.tools.register(defineTool({ name: 'mbot_hmr_writer', description: 'Late cancellation writer for HMR', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) {
        const lease = runtime.dataLease(exec.agent)
        await writeFile(marker('writer-started'), '')
        await new Promise(resolve => exec.signal.aborted ? resolve() : exec.signal.addEventListener('abort', resolve, { once: true }))
        await writeFile(marker('writer-cancelled'), '')
        await wait('release-writer')
        await lease.execute('botctl', ['remember', 'HMR old writer cleanup joined'])
        return 'joined'
      } }))
    child.effect(() => runtime.foregroundTool('mbot_hmr_writer'))
    child.effect(() => () => record('lifecycle.jsonl', { phase: 'detached', generation: current }))
    void record('lifecycle.jsonl', { phase: 'attached', generation: current, build: runtime.buildMarker ?? 'original' })
  })
  await writeFile(marker('fixture-ready'), '')
}
