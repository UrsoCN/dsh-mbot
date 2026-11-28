// A real Host process killed by the parent after its helper sealed a plan.
// Resume uses the same native persistent Session, with no reconstructed logs.
import { readFile } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import Query from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as executor from '@deepseek-ai/dsh-tool-executor-native'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import * as host from '../plugin/index.js'
import * as runtime from '../plugin/runtime.js'
import { readMaintenanceJournal } from '../plugin/maintenance-journal.js'

const [mode, configFile, storage] = process.argv.slice(2)
const config = JSON.parse(await readFile(configFile, 'utf8'))
const ctx = new Context()
await ctx.plugin(Sessions)
await ctx.plugin(Persistence, { root: storage, compression: 'none' })
await ctx.plugin(Projections)
await ctx.plugin(Agents)
await ctx.plugin(Llm)
await ctx.plugin(SystemPrompt)
await ctx.plugin(Tools)
await ctx.plugin(executor)
await ctx.plugin(LocalSubprocess)
await ctx.plugin(Query)
await ctx.plugin(host, { workspace: config.workspace, registry: config.registry })
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(runtime, { workers: false })
const record = config.registry.conversations[0]
let requests = 0
class Model extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 16384 } } }
  async *stream(request) {
    requests++
    if (mode !== 'create' || request.purpose !== 'mbot-domain-dream') throw new Error('Recovery must never call a model')
    const input = JSON.parse(request.messages[1].content[0].text)
    const document = input.documents.find(item => item.kind === 'memory' && item.writable)
    const proposal = { decisions: input.sources.map(source => ({ sourceId: source.id, action: 'merge', reason: 'Retain source attribution' })),
      changes: [{ path: document.path, baseHash: document.textHash, edits: [{ startLine: 1, deleteCount: 0,
        lines: ['Cold Host candidate (unconfirmed).'], sourceIds: input.sources.map(source => source.id), reason: 'Keep original memory' }] }], report: 'Cold Host maintenance.' }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(proposal) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['cold-dream', 'runtime-test'], new Model())
const agentOptions = { provider: 'cold-dream', model: 'scripted' }
if (mode === 'create') {
  const { agent } = await ctx.agents.create({ agentOptions, sessionId: record.sessionId,
    meta: { cwd: config.workspace, isSeeded: false }, seed: config.seed })
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = spec => {
    const child = spawn(spec)
    if (spec.argv[0].endsWith('/bin/mbot-maintenance')) {
      const write = child.stdin.write.bind(child.stdin)
      child.stdin.write = (data, callback) => {
        if (JSON.parse(data).kind !== 'commit') return write(data, callback)
        void (async () => {
          const late = createUserMessage({ content: [{ type: 'text', text: 'Persisted late Inbox during Dreaming' }], source: { kind: 'user' } })
          agent.inbox.splice('next-turn', 0, 0, [late]); await ctx.sessions.flush(agent.session)
          const journal = await readMaintenanceJournal(config.workspace)
          process.stdout.write('DREAM_READY ' + JSON.stringify({ record: journal.record, requests, pendingId: late.id }) + '\n')
        })().catch(error => { process.stderr.write(String(error)); process.exit(1) })
        return true // Keep the real Host and helper alive until the parent's SIGKILL.
      }
    }
    return child
  }
  await ctx.mbotRuntime.dream(agent)
  throw new Error('Expected parent to kill this Host at the commit boundary')
} else {
  class Controller extends Service {
    constructor(ctx) { super(ctx, 'sessionController') }
    async resolveAgent(id) {
      if (id !== record.sessionId) throw new Error('Recovery changed its native Session identity')
      return ctx.agents.resume({ agentOptions, resumeSessionId: id })
    }
  }
  await ctx.plugin(Controller)
  const result = await ctx.mbot.recoverTurn({ botId: record.botId })
  const agent = ctx.agents.get(record.sessionId)
  process.stdout.write('DREAM_READY ' + JSON.stringify({ result, requests, sessionId: agent.id,
    pendingIds: agent.inbox.nextTurn.map(message => message.id), state: (await ctx.mbotRuntime.status(agent)).state }) + '\n')
  setInterval(() => {}, 1000)
}
