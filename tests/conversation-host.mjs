// Real process boundary for persisted conversation ownership and native Inbox.
// The parent kills this Host only after a native flush; no dispose/queue rewrite.
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
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
await ctx.plugin(host, config)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(runtime, { workers: false })
let requests = 0
class ForbiddenModel extends LlmAdapter {
  async *stream() { requests++; throw new Error('Reserved domain reached a model') }
}
ctx.llm.registerAdapter(['reserved-fixture'], new ForbiddenModel())
const record = ctx.mbot.registry().conversations[0]
const options = { agentOptions: { provider: 'reserved-fixture', model: 'scripted' } }
const handle = mode === 'create'
  ? await ctx.agents.create({ ...options, sessionId: record.sessionId, meta: { cwd: config.workspace } })
  : await ctx.agents.resume({ ...options, resumeSessionId: record.sessionId })
const before = handle.agent.inbox.nextTurn.map(message => message.id)
handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: `input-${mode}` }], source: { kind: 'user' } }))
await handle.agent.whenIdle()
await ctx.mbotRuntime.settled(handle.agent)
await ctx.sessions.flush(handle.agent.session)
const log = await ctx.sessionQuery.readSession(handle.agent.id)
process.stdout.write('CONVERSATION_READY ' + JSON.stringify({ sessionId: handle.agent.id, record,
  descriptor: ctx.mbotRuntime.states.get(handle.agent).conversation,
  before, pending: handle.agent.inbox.nextTurn.map(message => ({ id: message.id, text: message.content[0].text })),
  requests, modelEvents: log.events.filter(event => ['assistant/message', 'plugin:mbot/context-snapshot'].includes(event.type)).length,
  leases: ctx.mbot.leases.size }) + '\n')
setInterval(() => {}, 1000)
