// Local-only adapter in the disposable installed Web profile.
import { appendFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
export const inject = ['llm', 'mbotRuntime', 'commands', 'sessionQuery']
export function apply(ctx) {
  const root = process.env.MBOT_GUI_COMPACTION_ROOT
  void setup(ctx, root).catch(error => writeFile(join(root, 'fixture-error'), error.stack ?? String(error)))
}
async function setup(ctx, root) {
  const fromPackage = createRequire(process.env.MBOT_GUI_PACKAGE)
  const { LlmAdapter } = await import(fromPackage.resolve('@deepseek-ai/dsh-llm'))
  const { runtimeCells } = await import(pathToFileURL(join(dirname(fromPackage.resolve('dsh-mbot/package.json')), 'plugin/runtime-cells.js')).href)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (...args) => {
    const input = args[0], url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/u.test(url)) throw new Error('GUI compaction fixture refuses external requests')
    return originalFetch(...args)
  }
  ctx.effect(() => () => { globalThis.fetch = originalFetch })
  ctx.on('agent/pre-step', async (input, next) => {
    if (input.messages.some(message => message.content.some(block => block.text === 'compaction now'))) {
      const surface = await ctx.sessionQuery.readSurface(input.agent.id)
      const first = surface.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
      const last = surface.events.findLast(event => event.type === 'assistant/message')
      const backend = runtimeCells.get(input.agent).compactionFiber.ctx.get('compaction')
      await backend.compactRegion(first.seq, last.seq, input.agent, input.signal)
    }
    return next()
  })
  class Local extends LlmAdapter {
    async listModels() { return [{ id: 'scripted', name: 'Compaction fixture' }] }
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 32768 } } }
    async *stream(request) {
      let text
      if (request.purpose === 'mbot-compaction') {
        const sources = JSON.parse(request.messages.at(-1).content[0].text)
        text = JSON.stringify({ items: [{ text: 'User requested local conversation maintenance.', sourceEventSeqs: sources[0].sourceEventSeqs }] })
        await appendFile(join(root, 'summaries.jsonl'), JSON.stringify({ sessionId: request.sessionId }) + '\n')
      } else if (request.purpose) text = 'Compaction Bot'
      else {
        const seed = request.messages.some(message => message.role === 'user' && message.content.some(block => block.text === 'compaction seed'))
          && !(request.messages.some(message => message.role === 'assistant'))
        text = seed ? 'model report '.repeat(15000) : 'GUI conversation continues'
        await appendFile(join(root, 'requests.jsonl'), JSON.stringify({ sessionId: request.sessionId }) + '\n')
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mbot-compaction-fixture'], new Local())
  ctx.commands.register({ name: 'mbot_fixture_checkpoint', recordInput: false, description: 'Inspect this disposable Bot checkpoint.',
    async handler(invocation) { return { kind: 'success', text: JSON.stringify(await ctx.mbotRuntime.checkpoint(invocation.agent)) } } })
  let logging = Promise.resolve()
  ctx.on('session/event', (session, event) => {
    const line = JSON.stringify({ sessionId: session.id, event }) + '\n'
    logging = logging.then(() => appendFile(join(root, 'events.jsonl'), line))
  })
  ctx.effect(() => async () => { await logging })
  await writeFile(join(root, 'fixture-ready'), '')
}
