import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import Query from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import Bash from '@deepseek-ai/dsh-bash-local'
import Fs from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as nativeBash from '@deepseek-ai/dsh-tool-bash'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import * as executor from '@deepseek-ai/dsh-tool-executor-native'
import * as mbot from '../plugin/index.js'
import * as botTools from '../plugin/tools.js'
import * as runtime from '../plugin/runtime.js'

const root = await mkdtemp('/tmp/mbot-runtime-tests.')
process.env.DSH_HOME = join(root, 'dsh')
process.env.XDG_CONFIG_HOME = join(root, 'config')
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'MBot Runtime tests'
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'mbot-tests@example.invalid'
delete process.env.MBOT_RUN_ID
delete process.env.MBOT_WS
let sequence = 0
const git = (workspace, ...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim()
const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

function* response(text, tool) {
  const block = tool ? { type: 'tool-call', id: `runtime-tool-${++sequence}`, name: tool.name, arguments: JSON.stringify(tool.args) }
    : { type: 'text', text }
  yield { type: 'block-start', index: 0, blockType: block.type }
  yield { type: 'block-end', index: 0, block }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
  yield { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } }
}

async function app(t, script, options = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  await ctx.plugin(Agents)
  await ctx.plugin(Llm)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(executor)
  await ctx.plugin(LocalSubprocess)
  if (options.bash) {
    await ctx.plugin(Fs)
    await ctx.plugin(WorkingDirectory)
    await ctx.plugin(ShellEnv, { dshHome: process.env.DSH_HOME })
    await ctx.plugin(Bash)
    await ctx.plugin(nativeBash)
  }
  class Policy extends Service {
    constructor(ctx) { super(ctx, 'sandboxPolicy') }
    resolve() { return { mode: 'danger-full-access', workspaceRoot: root } }
  }
  await ctx.plugin(Policy)
  class Reads extends Query {}
  await ctx.plugin(Reads)
  class MemoryLoader extends Loader { commit() {} }
  await ctx.plugin(MemoryLoader)
  ctx.loader.builtins.mbot = mbot
  const ws = join(root, `Bot ${++sequence}`)
  const id = await ctx.loader.create({ name: 'cordis:mbot', config: { workspace: ws } })
  await ctx.loader.await()
  const entry = ctx.loader.resolve(id)
  let config = { workspace: ws }
  class Editor extends Service {
    constructor(ctx) { super(ctx, 'configEditor') }
    entries() { return [entry] }
    async edit(target, update) {
      assert.equal(target.fiber.uid, entry.fiber.uid)
      config = update(config, {})
      await ctx.loader.update(id, { config })
    }
  }
  await ctx.plugin(Editor)
  assert.equal((await ctx.mbot.execute('mbot', ['init'])).exitCode, 0)
  const bot = await ctx.mbot.importBot(ws)
  await ctx.plugin(botTools)
  await ctx.plugin(AgentLoop, { agents: [] })
  await options.beforeRuntime?.(ctx)
  const owner = ctx.plugin(runtime)
  await owner
  const requests = []
  const errors = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  class Scripted extends LlmAdapter {
    async *stream(options) {
      requests.push({ sessionId: options.sessionId, messages: structuredClone(options.messages), tools: structuredClone(options.tools) })
      yield* await script(options, requests.length, ctx)
    }
  }
  ctx.llm.registerAdapter(['runtime-test'], new Scripted())
  const handle = await ctx.agents.create({ sessionId: `runtime-session-${++sequence}`, meta: { cwd: ws },
    agentOptions: { provider: 'runtime-test', model: 'scripted' }, setup: (_ctx, agent) => ctx.mbotRuntime.attach(agent, { botId: bot.botId }) })
  return { ctx, ws, bot, agent: handle.agent, handle, requests, owner, errors }
}

async function settle(ctx, agent) { await agent.whenIdle(); await ctx.mbotRuntime.settled(agent) }

test('real Agent uses managed context and native botctl, then creates one turn audit', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, requests, errors } = await app(t, (_options, count) => count === 1
    ? response('', { name: 'botctl', args: { action: 'board_add', text: 'runtime task', owner: 'coder' } }) : response('task created'))
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('create a task'))
  await settle(ctx, agent)
  assert.equal(requests.length, 2, errors.map(error => error.stack).join('\n'))
  assert.ok(requests[0].messages[0].content[0].text.includes('# MBot role: chief'))
  assert.ok(requests[0].messages[0].content[0].text.includes(await readFile(join(ws, 'MEMORY.md'), 'utf8')))
  assert.ok(requests[0].tools.some(tool => tool.name === 'botctl'))
  assert.match(await readFile(join(ws, 'BOARD.md'), 'utf8'), /runtime task/u)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal(git(ws, 'status', '--porcelain'), '')
  const surface = await ctx.sessionQuery.readSurface(agent.id)
  assert.ok(surface.events.some(event => event.type === 'tool/result'))
  const audit = JSON.parse(git(ws, 'show', 'HEAD:' + git(ws, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').find(path => path.endsWith('.meta.json'))))
  assert.equal(audit.runtime.bot_id, bot.botId)
  assert.equal(audit.runtime.session_id, agent.id)
  assert.equal(audit.usage.total_tokens, 30)
})

test('two native followups stay FIFO and the second turn sees the first audit commit', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { ctx, ws, agent, requests, errors } = await app(t, async (_options, count) => {
    if (count === 1) { entered.resolve(); await release.promise }
    return response(`reply ${count}`)
  })
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('window one'))
  await entered.promise
  agent.followup(message('window two'))
  assert.equal(requests.length, 1)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  release.resolve()
  await settle(ctx, agent)
  assert.equal(requests.length, 2, errors.map(error => error.stack).join('\n'))
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '2')
  const second = JSON.stringify(requests[1].messages)
  assert.ok(second.includes('window one') && second.includes('window two'))
  assert.ok(second.includes(git(ws, 'rev-parse', 'HEAD^')))
  assert.equal(git(ws, 'status', '--porcelain'), '')
})

test('changed SOUL and MEMORY replace old system snapshots without editing the raw Session log', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests, errors } = await app(t, () => response('done'))
  await writeFile(join(ws, 'MEMORY.md'), '# 共享记忆\n\nold-memory-rule-112233\n')
  await writeFile(join(ws, 'bots/chief/SOUL.md'), '# chief\n\nold-persona-rule-112233\n')
  git(ws, 'add', 'MEMORY.md', 'bots/chief/SOUL.md')
  git(ws, 'commit', '-m', 'fixture: initial persona')
  agent.followup(message('first turn'))
  await settle(ctx, agent)
  const initial = await ctx.sessionQuery.readSession(agent.id)
  assert.ok(JSON.stringify(requests[0].messages).includes('old-memory-rule-112233'))
  await writeFile(join(ws, 'MEMORY.md'), '# 共享记忆\n\nnew-memory-rule-445566\n')
  await writeFile(join(ws, 'bots/chief/SOUL.md'), '# chief\n\nnew-persona-rule-445566\n')
  git(ws, 'add', 'MEMORY.md', 'bots/chief/SOUL.md')
  git(ws, 'commit', '-m', 'fixture: updated persona')
  agent.followup(message('second turn'))
  await settle(ctx, agent)
  assert.equal(requests.length, 2, errors.map(error => error.stack).join('\n'))
  const second = JSON.stringify(requests[1].messages)
  assert.ok(second.includes('new-memory-rule-445566') && second.includes('new-persona-rule-445566'))
  assert.ok(!second.includes('old-memory-rule-112233') && !second.includes('old-persona-rule-112233'))
  const log = await ctx.sessionQuery.readSession(agent.id)
  assert.deepEqual(log.events.slice(0, initial.events.length), initial.events)
  assert.ok(log.events.some(event => event.surfaceOp?.op === 'replace'))
})

test('native Bash receives a fixed permit, CLI changes join the turn and token bytes never enter Session history', { timeout: 30000 }, async t => {
  let token
  const { ctx, ws, agent, requests } = await app(t, (_options, count, ctx) => {
    if (count !== 1) return response('candidate saved')
    token = ctx.mbotRuntime.dataLease(ctx.agents.list()[0]).shellEnvironment().DSH_MBOT_PERMIT_TOKEN
    return response('', { name: 'bash', args: { description: 'Append a managed memory candidate', command: 'printf "%s\\n" "$DSH_MBOT_PERMIT_TOKEN"\n"$DSH_MBOT_BOTCTL" remember "native bash candidate"\nif "$DSH_MBOT_BOTCTL" remember "forged human candidate" --as human; then exit 17; fi' } })
  }, { bash: true })
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('save a candidate through Bash'))
  await settle(ctx, agent)
  assert.equal(requests.length, 2)
  assert.ok(JSON.stringify(requests[1].messages).includes('[REDACTED]'),
    JSON.stringify(requests[1].messages.filter(message => message.role === 'tool')).replaceAll(token, '[private]'))
  assert.ok(!JSON.stringify(requests).includes(token))
  const log = await ctx.sessionQuery.readSession(agent.id)
  assert.ok(!JSON.stringify(log.events).includes(token))
  const candidate = git(ws, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').find(path => /^inbox\/.*\.md$/u.test(path))
  assert.match(git(ws, 'show', `HEAD:${candidate}`), /native bash candidate/u)
  assert.match(git(ws, 'show', `HEAD:${candidate}`), /by: chief/u)
  assert.doesNotMatch(git(ws, 'show', `HEAD:${candidate}`), /forged human candidate/u)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal(git(ws, 'status', '--porcelain'), '')
  const call = await ctx.tools.execute({ agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: 'inactive-write', name: 'botctl', arguments: JSON.stringify({ action: 'board_add', text: 'outside managed turn' }) }] })
  assert.equal(call.results[0].result.isError, true)
  assert.doesNotMatch(await readFile(join(ws, 'BOARD.md'), 'utf8'), /outside managed turn/u)
})

test('Agent cancellation joins a late tool writer before auditing and preserves queued followup work', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers()
  const { ctx, ws, agent, requests, errors } = await app(t, (_options, count) => count === 1
    ? response('', { name: 'slow_writer', args: {} }) : response('followup done'))
  const base = git(ws, 'rev-parse', 'HEAD')
  let headWhileWriting
  ctx.tools.register(defineTool({ name: 'slow_writer', description: 'A writer that joins its cancellation cleanup.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      entered.resolve()
      await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
      await new Promise(resolve => setTimeout(resolve, 30))
      headWhileWriting = git(ws, 'rev-parse', 'HEAD')
      await writeFile(join(ws, 'inbox/late-writer.md'), 'late tool cleanup\n')
      return 'settled'
    },
  }))
  ctx.mbotRuntime.foregroundTool('slow_writer')
  agent.followup(message('start slow writer'))
  await Promise.race([entered.promise, agent.whenIdle().then(() => { throw new Error(errors.map(error => error.stack).join('\n') || JSON.stringify(requests)) })])
  agent.followup(message('queued followup'))
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  agent.followup(message('wake after cancellation'))
  await settle(ctx, agent)
  assert.equal(headWhileWriting, base)
  assert.equal(requests.length, 3)
  assert.ok(JSON.stringify(requests[1].messages).includes('queued followup'))
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '3')
  assert.equal(git(ws, 'status', '--porcelain'), '')
  assert.match(git(ws, 'show', 'HEAD^^:inbox/late-writer.md'), /late tool cleanup/u)
})

test('Runtime unload blocks model execution, parks native input, and reload adopts one existing Session', { timeout: 30000 }, async t => {
  const { ctx, bot, agent, requests, owner } = await app(t, () => response('done'))
  agent.followup(message('before reload'))
  await settle(ctx, agent)
  await owner.dispose()
  const parked = message('while Runtime is unavailable')
  agent.followup(parked)
  await agent.whenIdle()
  assert.equal(requests.length, 1)
  assert.equal(agent.inbox.nextTurn[0].id, parked.id)
  await ctx.plugin(runtime)
  const attachment = ctx.mbotRuntime.attach(agent, { botId: bot.botId })
  assert.equal(ctx.mbotRuntime.attach(agent, { botId: bot.botId }), attachment)
  await attachment
  agent.followup(message('after reload'))
  await settle(ctx, agent)
  assert.equal(requests.length, 3)
  assert.ok(JSON.stringify(requests[1].messages).includes('while Runtime is unavailable'))
  assert.equal(ctx.agents.list().length, 1)
})

test('owned runtime facts retire before older pre-step consumers while operational context survives', { timeout: 30000 }, async t => {
  let checked = false
  const { ctx, agent, requests } = await app(t, () => response('done'), { beforeRuntime(ctx) {
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      assert.ok(!JSON.stringify(agent.session.deriveMessages()).includes('obsolete-mbot-memory-998877'))
      checked = true
      return next()
    })
  } })
  agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'obsolete-mbot-memory-998877\nkeep-operational-context-554433' }],
    source: { kind: 'runtime-context', form: 'snapshot', sections: [
      { name: 'mbot:memory', text: 'obsolete-mbot-memory-998877' },
      { name: 'harness:fixture', text: 'keep-operational-context-554433' },
    ] } }), { surfaceOp: 'append' })
  agent.followup(message('refresh context'))
  await settle(ctx, agent)
  assert.equal(checked, true)
  assert.ok(!JSON.stringify(requests[0].messages).includes('obsolete-mbot-memory-998877'))
  assert.ok(JSON.stringify(requests[0].messages).includes('keep-operational-context-554433'))
})

test('the managed deadline cancels the actual model before the aborted turn audit', { timeout: 30000 }, async t => {
  let aborted = false
  const { ctx, ws, agent, requests } = await app(t, async options => {
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
    aborted = true
    return response('interrupted')
  })
  const config = join(ws, '.mbot/config')
  await writeFile(config, (await readFile(config, 'utf8')).replace(/^MBOT_TIMEOUT=.*$/mu, 'MBOT_TIMEOUT=1'))
  git(ws, 'add', '.mbot/config')
  git(ws, 'commit', '-m', 'fixture: one second deadline')
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('wait until timeout'))
  await settle(ctx, agent)
  assert.equal(aborted, true)
  assert.equal(requests.length, 1)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal(git(ws, 'status', '--porcelain'), '')
  const log = await ctx.sessionQuery.readSession(agent.id)
  assert.equal(log.events.find(event => event.type === 'turn/end').data.reason.kind, 'aborted')
})

test('a custom tool cannot launch a writer without a managed lifetime contract', { timeout: 30000 }, async t => {
  let started = false
  const { ctx, agent, requests } = await app(t, (_options, count) => count === 1
    ? response('', { name: 'unowned_writer', args: {} }) : response('writer refused'))
  ctx.tools.register(defineTool({ name: 'unowned_writer', description: 'A tool whose lifetime has not been admitted.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() { started = true; return 'started' },
  }))
  agent.followup(message('try the unowned writer'))
  await settle(ctx, agent)
  assert.equal(started, false)
  assert.equal(requests.length, 2)
  assert.ok(JSON.stringify(requests[1].messages).includes('managed foreground lifetime contract'))
})
