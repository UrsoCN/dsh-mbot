import { test } from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, chmod, lstat, symlink, unlink, rename } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Sessions from '@deepseek-ai/dsh-session'
import * as SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as SpawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import Query from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import Bash from '@deepseek-ai/dsh-bash-local'
import Fs from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as nativeBash from '@deepseek-ai/dsh-tool-bash'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import * as executor from '@deepseek-ai/dsh-tool-executor-native'
import * as mbot from '../plugin/index.js'
import * as botTools from '../plugin/tools.js'
import * as runtime from '../plugin/runtime.js'
import Commands from '@deepseek-ai/dsh-commands'
import * as botCommands from '../plugin/commands.js'
import { MessageIndex } from '../plugin/messages.js'
import { runtimeCells } from '../plugin/runtime-cells.js'
import { appendPluginRecord, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { workerProof, workerCompletion } from '../plugin/worker-proof.js'
import * as ipc from '../plugin/ipc.js'
import { ipcLocation, profileLocation, requestHost, maxFrameBytes } from '../plugin/ipc-protocol.js'
import { readonlyLegacy } from '../plugin/readonly-migration.js'
import { recoveryInput } from '../plugin/recovery-proof.js'
import { contextSnapshotType, contextHash, contextAuditEvent } from '../plugin/context-state.js'
import { compactInputType, compactOutputType, summaryPurpose } from '../plugin/compaction-data.js'

const root = await mkdtemp('/tmp/mbot-runtime-tests.')
process.env.DSH_HOME = join(root, 'dsh')
process.env.XDG_CONFIG_HOME = join(root, 'config')
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'MBot Runtime tests'
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'mbot-tests@example.invalid'
delete process.env.MBOT_RUN_ID
delete process.env.MBOT_WS
let sequence = 0
const git = (workspace, ...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim()
// The production /proc proof deliberately refuses disappearing, uninspectable
// PIDs. Retry the PUBLIC operation only after that PID exited and the refusal
// demonstrably left Git/data/journal unchanged. Live/unknown writers still fail.
async function recoverNativeTurn(ctx, options) {
  const registry = ctx.mbot.registry()
  const retired = registry.retiredBots.find(entry => entry.bot.botId === options.botId)
  const workspace = (retired?.bot ?? ctx.mbot.bot(options)).workspacePath
  const ledger = async () => readFile(join(workspace, '.mbot/runs/active-turn.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  const before = { head: git(workspace, 'rev-parse', 'HEAD'), status: git(workspace, 'status', '--porcelain'), journal: await ledger() }
  for (let attempt = 0; ; attempt++) {
    try { return await ctx.mbot.recoverTurn(options) }
    catch (error) {
      const match = /Cannot inspect possible writer pid (\d+)/u.exec(error.message)
      if (!match || attempt >= 3) throw error
      let gone = false
      const deadline = Date.now() + 500
      while (Date.now() < deadline) {
        try {
          const value = await readFile(`/proc/${match[1]}/stat`, 'utf8')
          if (value.slice(value.lastIndexOf(')') + 2).split(/\s+/u)[0] === 'Z') { gone = true; break }
        }
        catch (inspection) { if (inspection.code === 'ENOENT') { gone = true; break }; throw error }
        await delay(20)
      }
      if (!gone) throw error
      assert.equal(git(workspace, 'rev-parse', 'HEAD'), before.head)
      assert.equal(git(workspace, 'status', '--porcelain'), before.status)
      assert.equal(contextHash(await ledger()), contextHash(before.journal))
    }
  }
}
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
  if (options.persistence) await ctx.plugin(SessionPersistence, { root: join(root, `native-sessions-${++sequence}`), compression: 'none' })
  await ctx.plugin(Projections)
  await ctx.plugin(Agents)
  await ctx.plugin(Llm)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(executor)
  await ctx.plugin(LocalSubprocess)
  if (options.bash || options.workers) { await ctx.plugin(Fs); await ctx.plugin(WorkingDirectory) }
  if (options.bash) {
    await ctx.plugin(ShellEnv, { dshHome: process.env.DSH_HOME })
    await ctx.plugin(Bash)
    await ctx.plugin(nativeBash)
  }
  class Policy extends Service {
    constructor(ctx) { super(ctx, 'sandboxPolicy') }
    resolve() { return { mode: 'danger-full-access', workspaceRoot: root } }
  }
  if (options.workers) await ctx.plugin(SandboxPolicy, { mode: options.policy ?? 'danger-full-access', workspaceRoot: root })
  else await ctx.plugin(Policy)
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
  const bot = await ctx.mbot.importBot(ws, { defaultRole: options.role ?? 'chief' })
  await ctx.plugin(botTools)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.compaction) {
    await ctx.plugin(TokenMeter)
    if (options.compaction !== 'scoped') await ctx.plugin(BasicCompaction, { auto: options.compaction === 'automatic', headroomTokens: 0, retainTokens: 0, maxTokens: 1024 })
    if (!['automatic', 'scoped'].includes(options.compaction)) ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      if (messages.some(message => message.content.some(block => block.type === 'text' && block.text.startsWith('compact:')))) {
        const surface = await ctx.sessionQuery.readSurface(agent.id)
        const first = surface.events.find(event => event.type === 'user/message' && ['user', 'compact-checkpoint'].includes(event.data.source.kind))
        const last = surface.events.findLast(event => event.type === 'assistant/message')
        if (first && last) await ctx.compaction.compactRegion(first.seq, last.seq, agent, signal)
      }
      return next()
    })
  }
  await options.beforeRuntime?.(ctx)
  let workerProvider
  if (options.workers) { await ctx.plugin(Subagents); workerProvider = ctx.plugin(SpawnProvider); await workerProvider }
  const owner = ctx.plugin(runtime, { ...(options.defaultWorkers ? {} : { workers: options.workers === true }),
    ...(options.compactMaxBytes ? { compactMaxBytes: options.compactMaxBytes } : {}) })
  await owner
  const requests = []
  const errors = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  class Scripted extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 16384 } } }
    async *stream(options) {
      requests.push({ sessionId: options.sessionId, purpose: options.purpose, messages: structuredClone(options.messages), tools: structuredClone(options.tools) })
      yield* await script(options, requests.length, ctx)
    }
  }
  ctx.llm.registerAdapter(['runtime-test'], new Scripted())
  const handle = await ctx.agents.create({ sessionId: `runtime-session-${++sequence}`, meta: { cwd: ws },
    agentOptions: { provider: 'runtime-test', model: 'scripted' }, setup: (_ctx, agent) => ctx.mbotRuntime.attach(agent, { botId: bot.botId }) })
  if (options.main) await ctx.configEditor.edit(entry, current => ({ ...current, registry: { ...current.registry,
    revision: current.registry.revision + 1, bots: current.registry.bots.map(item => item.botId !== bot.botId ? item : {
      ...item, workspaceId: `workspace-${sequence}`, mainSessionId: handle.agent.id,
      binding: { state: 'ready', pendingSessionId: null, error: null },
    }) } }))
  return { ctx, ws, bot, agent: handle.agent, handle, requests, owner, errors, workerProvider }
}

async function settle(ctx, agent) { await agent.whenIdle(); await ctx.mbotRuntime.settled(agent) }

test('failed native creation drains attachment work without waiting on its own publication', { timeout: 15000 }, async t => {
  let failedId, failedAgent
  const { ctx, ws, bot, requests } = await app(t, () => response('must not run during failed publication'), {
    persistence: true,
    beforeRuntime(ctx) {
      ctx.on('agent/created', ({ agent }) => {
        if (agent.id !== failedId) return
        failedAgent = agent
        agent.followup(message('retain this input when attachment fails'))
      })
    },
  })
  failedId = `failed-publication-${++sequence}`
  await ctx.configEditor.edit(ctx.configEditor.entries()[0], current => ({ ...current, registry: {
    ...current.registry, revision: current.registry.revision + 1,
    bots: current.registry.bots.map(item => item.botId !== bot.botId ? item : { ...item,
      binding: { state: 'provisioning', pendingSessionId: failedId, error: null } }),
  } }))
  const registry = ctx.mbot.registry(), head = git(ws, 'rev-parse', 'HEAD')
  const offline = `${ws}.offline`
  await rename(ws, offline)
  try {
    await assert.rejects(ctx.agents.create({ sessionId: failedId, meta: { cwd: ws },
      agentOptions: { provider: 'runtime-test', model: 'scripted' } }), /Context checkpoint does not match/u)
    assert.equal(ctx.agents.get(failedId), undefined, 'The native factory must finish rollback')
    assert.equal(ctx.mbotRuntime.attachments.size, 0)
    assert.equal(ctx.mbotRuntime.states.has(failedAgent), false)
    assert.equal(runtimeCells.get(failedAgent).state, undefined, 'Failed attachment keeps no usable Runtime owner')
    assert.equal(ctx.mbot.active.size, 0, 'Owned checkpoint subprocesses must drain')
    assert.equal(requests.length, 0, 'Queued input must not start a model during failed publication')
    const log = await ctx.sessionQuery.readSession(failedId)
    assert.ok(!log.events.some(event => event.type === 'turn/start'))
    assert.equal(failedAgent.inbox.nextTurn.length, 1)
    assert.deepEqual(ctx.mbot.registry(), registry, 'Failure must preserve the reservation and old identity')
    assert.equal(git(offline, 'rev-parse', 'HEAD'), head)
    const next = await ctx.mbot.initialize(join(root, `after failed publication ${++sequence}`))
    assert.equal(next.exitCode, 0, next.stderr)
  } finally { await rename(offline, ws) }
  failedId = undefined
  const retry = await ctx.agents.resume({ resumeSessionId: registry.bots[0].binding.pendingSessionId,
    agentOptions: { provider: 'runtime-test', model: 'scripted' } })
  assert.equal(ctx.mbotRuntime.managed(retry.agent), true, 'Restored data must permit the same reserved Session to resume')
  assert.equal(requests.length, 0)
})

test('missing native backends are isolated per Bot Agent and survive Runtime handoff', { timeout: 30000 }, async t => {
  const { ctx, agent, bot, owner } = await app(t, () => response('scoped backend reply'), {
    compaction: 'scoped', beforeRuntime: async ctx => { await ctx.plugin(Commands) } })
  const first = runtimeCells.get(agent).compactionFiber
  assert.ok(first.ctx.get('compaction'))
  assert.equal(ctx.get('compaction'), undefined)
  const otherWs = join(root, `Scoped Bot ${++sequence}`)
  assert.equal((await ctx.mbot.execute('mbot', ['init'], { workspace: otherWs })).exitCode, 0)
  const other = await ctx.mbot.importBot(otherWs)
  const second = await ctx.agents.create({ sessionId: `scoped-compaction-${++sequence}`, meta: { cwd: otherWs },
    agentOptions: { provider: 'runtime-test', model: 'scripted' }, setup: (_scope, current) => ctx.mbotRuntime.attach(current, { botId: other.botId }) })
  const secondFiber = runtimeCells.get(second.agent).compactionFiber
  assert.notEqual(first.ctx.get('compaction'), secondFiber.ctx.get('compaction'))
  assert.equal(ctx.get('compaction'), undefined)
  assert.ok(ctx.commands.find(agent, 'compact'))
  assert.ok(ctx.commands.find(second.agent, 'compact'))
  assert.equal(ctx.commands.find({}, 'compact'), undefined)
  agent.followup(message('Bot A context')); await settle(ctx, agent)
  second.agent.followup(message('Bot B context')); await settle(ctx, second.agent)
  await owner.dispose(); await ctx.plugin(runtime)
  await ctx.mbotRuntime.attach(agent, { botId: bot.botId })
  await ctx.mbotRuntime.attach(second.agent, { botId: other.botId })
  assert.equal(runtimeCells.get(agent).compactionFiber, first)
  assert.equal(runtimeCells.get(second.agent).compactionFiber, secondFiber)
})

test('managed native compaction binds attributed sources, replacement and Git checkpoint without copying persona', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests } = await app(t, options => {
    if (options.purpose === summaryPurpose) {
      const sources = JSON.parse(options.messages.at(-1).content[0].text)
      assert.equal(options.tools, undefined)
      assert.equal(options.messages.length, 2)
      assert.ok(!JSON.stringify(options.messages).includes('unique-persona-compact-992211'))
      return response(JSON.stringify({ items: [{ text: 'The user requested a task; completion remains a model report.', sourceEventSeqs: sources[0].sourceEventSeqs }] }))
    }
    return response('model report: ' + 'completed reference work '.repeat(1000))
  }, { main: true, persistence: true, compaction: true })
  const soul = join(ws, 'bots/chief/SOUL.md')
  await writeFile(soul, (await readFile(soul, 'utf8')) + '\nunique-persona-compact-992211\n')
  git(ws, 'add', 'bots/chief/SOUL.md'); git(ws, 'commit', '-m', 'fixture: compaction persona')
  agent.followup(message('original request ' + 'reference data '.repeat(1000)))
  await settle(ctx, agent)
  agent.followup(message('compact: summarize completed history'))
  await settle(ctx, agent)
  const checkpoint = await ctx.mbotRuntime.checkpoint(agent)
  assert.equal(checkpoint.compactions.length, 1)
  const proof = checkpoint.compactions[0]
  assert.equal(proof.status, 'completed')
  assert.equal(proof.input.policyHash.length, 64)
  assert.ok(proof.input.sourceRefs.length)
  const log = await ctx.sessionQuery.readSession(agent.id)
  const summary = log.events.find(event => event.type === 'compaction/summary')
  const replacement = log.events.find(event => event.seq === proof.native.replacementSeq)
  assert.equal(summary.data.compactionId, proof.compactionId)
  assert.deepEqual(summary.data.shadowedSeqs, proof.native.shadowedSeqs)
  assert.equal(replacement.data.source.compactionId, proof.compactionId)
  const meta = JSON.parse(git(ws, 'show', `${checkpoint.commit}:${checkpoint.meta}`))
  assert.deepEqual(meta.runtime.compactions, checkpoint.compactions)
  assert.equal(meta.runtime.compaction_policy_version, 1)
  assert.equal(meta.usage.total_tokens, 30)
  const after = requests.at(-1)
  assert.ok(JSON.stringify(after.messages).includes('MBot conversation summary'))
  assert.ok(JSON.stringify(after.messages).includes('unique-persona-compact-992211'))
  assert.equal(requests.filter(request => request.purpose === summaryPurpose).length, 1)
  assert.equal(requests.filter(request => request.purpose === 'compaction').length, 0)
})

test('repeated managed compaction reuses audited sources and expands them after knowledge changes', { timeout: 30000 }, async t => {
  let summaryCount = 0
  const { ctx, ws, agent, handle, bot } = await app(t, options => {
    if (options.purpose === summaryPurpose) {
      summaryCount++
      const sources = JSON.parse(options.messages.at(-1).content[0].text)
      assert.equal(sources.some(source => source.derivedFrom), summaryCount === 2)
      if (summaryCount === 3) assert.ok(sources.some(source => source.text.startsWith('original raw request')))
      return response(JSON.stringify({ items: [{ text: 'User requested reference work.', sourceEventSeqs: sources[0].sourceEventSeqs }] }))
    }
    return response('model report '.repeat(1500))
  }, { main: true, persistence: true, compaction: true })
  agent.followup(message('original raw request ' + 'data '.repeat(3000)))
  await settle(ctx, agent)
  agent.followup(message('compact: first'))
  await settle(ctx, agent)
  const first = (await ctx.mbotRuntime.checkpoint(agent)).compactions[0]
  agent.followup(message('compact: second'))
  await settle(ctx, agent)
  const second = (await ctx.mbotRuntime.checkpoint(agent)).compactions[0]
  assert.deepEqual(second.input.reusedSummaries, [first.compactionId])
  assert.ok(second.input.sourceSpan[0] > second.input.sourceSpan.at(-1) || second.input.sourceSpan.some((seq, i, list) => i > 0 && seq < list[i - 1]))
  await handle.dispose()
  const resumed = await ctx.agents.resume({ resumeSessionId: agent.id, agentOptions: { provider: 'runtime-test', model: 'scripted' },
    setup: (_ctx, current) => ctx.mbotRuntime.attach(current, { botId: bot.botId }) })
  assert.deepEqual((await ctx.mbotRuntime.checkpoint(resumed.agent)).compactions[0], second)
  const memory = join(ws, 'MEMORY.md')
  await writeFile(memory, (await readFile(memory, 'utf8')) + '\nnew-memory-compact-443322\n')
  git(ws, 'add', 'MEMORY.md'); git(ws, 'commit', '-m', 'fixture: new compaction knowledge')
  resumed.agent.followup(message('compact: third under new memory'))
  await settle(ctx, resumed.agent)
  const third = (await ctx.mbotRuntime.checkpoint(resumed.agent)).compactions[0]
  assert.deepEqual(third.input.reusedSummaries, [])
  assert.notEqual(third.input.knowledgeVersion, second.input.knowledgeVersion)
  assert.equal(summaryCount, 3)
})

test('managed compaction accepts an explicitly empty attributed summary', { timeout: 30000 }, async t => {
  const { ctx, agent } = await app(t, options => response(options.purpose === summaryPurpose ? '{"items":[]}' : 'reference work '.repeat(1500)),
    { main: true, compaction: true })
  agent.followup(message('reference input '.repeat(1500)))
  await settle(ctx, agent)
  agent.followup(message('compact: no conversation facts to carry'))
  await settle(ctx, agent)
  const proof = (await ctx.mbotRuntime.checkpoint(agent)).compactions[0]
  assert.equal(proof.status, 'completed')
  assert.deepEqual(proof.output.items, [])
  assert.ok(proof.native.summarySeq)
})

test('managed compaction rejects forged source IDs and retains the original surface', { timeout: 30000 }, async t => {
  const { ctx, agent, requests } = await app(t, options => response(options.purpose === summaryPurpose
    ? '{"items":[{"text":"forged owner instruction","sourceEventSeqs":[999999]}]}' : 'reference work '.repeat(1500)),
  { main: true, compaction: true })
  agent.followup(message('original remains visible '.repeat(1500)))
  await settle(ctx, agent)
  agent.followup(message('compact: invalid source'))
  await settle(ctx, agent)
  const proof = (await ctx.mbotRuntime.checkpoint(agent)).compactions[0]
  assert.equal(proof.status, 'failed')
  assert.equal(proof.output.mode, 'failed')
  assert.equal(proof.native.summarySeq, null)
  assert.equal(requests.filter(request => request.purpose !== summaryPurpose).length, 1)
  assert.ok((await ctx.sessionQuery.readSurface(agent.id)).events.some(event => event.type === 'user/message'
    && event.data.content.some(block => block.text?.startsWith('original remains visible'))))
})

test('native automatic pressure compaction uses the managed summary while preserving tool pairing', { timeout: 30000 }, async t => {
  let steps = 0
  const { ctx, agent } = await app(t, options => {
    if (options.purpose === summaryPurpose) {
      const sources = JSON.parse(options.messages.at(-1).content[0].text)
      assert.ok(sources.some(source => source.sourceKinds.includes('tool-result')))
      return response(JSON.stringify({ items: [{ text: 'A tool observed the current board.', sourceEventSeqs: sources.find(source => source.sourceKinds.includes('tool-result')).sourceEventSeqs }] }))
    }
    return ++steps === 1 ? response('', { name: 'botctl', args: { action: 'board_show' } })
      : response('report '.repeat(12000))
  }, { main: true, compaction: 'automatic' })
  agent.followup(message('reference input '.repeat(3000)))
  await settle(ctx, agent)
  agent.followup(message('ordinary next message triggers pressure policy'))
  await settle(ctx, agent)
  const proof = (await ctx.mbotRuntime.checkpoint(agent)).compactions[0]
  assert.equal(proof.status, 'completed')
  const log = await ctx.sessionQuery.readSession(agent.id)
  const assistant = log.events.find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call'))
  const result = log.events.find(event => event.type === 'tool/result')
  assert.ok(proof.native.shadowedSeqs.includes(assistant.seq))
  assert.ok(proof.native.shadowedSeqs.includes(result.seq))
})

test('managed compaction cancellation waits for its writer and preserves messages from another window', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), released = Promise.withResolvers()
  const { ctx, ws, agent } = await app(t, async options => {
    if (options.purpose === summaryPurpose) {
      entered.resolve()
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
      await delay(50)
      released.resolve()
      throw options.signal.reason
    }
    return response('reference report '.repeat(1500))
  }, { main: true, compaction: true })
  agent.followup(message('reference input '.repeat(1500)))
  await settle(ctx, agent)
  const before = await ctx.mbotRuntime.checkpoint(agent)
  agent.followup(message('compact: cancel summary'))
  await entered.promise
  agent.followup(message('another window queued this input'))
  const record = ctx.mbotRuntime.states.get(agent).current
  const stopping = ctx.mbotRuntime.stop(agent)
  await released.promise
  await stopping
  assert.equal(record.calls.size, 0)
  assert.equal(record.result.outcome, 'cancelled')
  assert.equal(record.result.failureCountEffect, 'preserve')
  assert.ok(agent.inbox.nextTurn.some(input => input.content[0].text === 'another window queued this input'))
  assert.equal(git(ws, 'rev-list', '--count', `${before.commit}..HEAD`), '1')
  const meta = JSON.parse(git(ws, 'show', `HEAD:${record.result.meta}`))
  assert.equal(meta.runtime.compactions[0].status, 'failed')
  assert.equal(meta.runtime.compactions[0].native.replacementSeq, null)
})

test('managed compaction source budget rejects before calling the summary model', { timeout: 30000 }, async t => {
  const { ctx, agent, requests } = await app(t, () => response('reference report '.repeat(1500)),
    { main: true, compaction: true, compactMaxBytes: 4096 })
  agent.followup(message('oversize source '.repeat(1500)))
  await settle(ctx, agent)
  agent.followup(message('compact: source byte budget'))
  await settle(ctx, agent)
  const proof = (await ctx.mbotRuntime.checkpoint(agent)).compactions[0]
  assert.equal(proof.input.mode, 'rejected')
  assert.equal(proof.status, 'failed')
  assert.equal(requests.filter(request => request.purpose === summaryPurpose).length, 0)
})

test('standalone native compact is held behind the unimplemented MBot maintenance gate', { timeout: 30000 }, async t => {
  const { ctx, agent, requests } = await app(t, () => response('reference report '.repeat(1500)), { main: true, compaction: true })
  agent.followup(message('reference input '.repeat(1500)))
  await settle(ctx, agent)
  const count = requests.length
  await assert.rejects(ctx.compaction.compactNow(agent, new AbortController().signal), /summary/u)
  assert.equal(requests.length, count)
  assert.equal((await ctx.sessionQuery.readSession(agent.id)).events.filter(event => event.type === 'compaction/summary').length, 0)
  agent.followup(message('normal conversation still works'))
  await settle(ctx, agent)
})

for (const crash of [undefined, 'commit', 'settlement']) {
  test(`managed compaction recovery retains native replacement and settles once after ${crash ?? 'failed commit'}`, { timeout: 30000 }, async t => {
    const { ctx, ws, bot, agent, journal, requests, mailbox } = await failedRuntime(t, { crash,
      fixture: { compaction: true, persistence: true }, script: options => {
        if (options.purpose === summaryPurpose) {
          const sources = JSON.parse(options.messages.at(-1).content[0].text)
          return response(JSON.stringify({ items: [{ text: 'Audited work report.', sourceEventSeqs: sources[0].sourceEventSeqs }] }))
        }
        return response('recoverable reference report '.repeat(1500))
      }, prepare: async fixture => {
        fixture.agent.followup(message('reference input '.repeat(1500)))
        await settle(fixture.ctx, fixture.agent)
        // Exercise the public native compactor inside the helper's failed turn.
        fixture.ctx.on('agent/pre-step', async (input, next) => {
          if (input.messages.some(message => message.content.some(block => block.text === 'audit interrupted'))) {
            const surface = await fixture.ctx.sessionQuery.readSurface(input.agent.id)
            const first = surface.events.find(event => event.type === 'user/message' && ['user', 'compact-checkpoint'].includes(event.data.source.kind))
            const last = surface.events.findLast(event => event.type === 'assistant/message')
            await fixture.ctx.compaction.compactRegion(first.seq, last.seq, input.agent, input.signal)
          }
          return next()
        })
      } })
    const native = await ctx.sessionQuery.readSession(agent.id)
    const summary = native.events.find(event => event.type === 'compaction/summary')
    assert.ok(summary)
    const count = requests.length, head = git(ws, 'rev-parse', 'HEAD')
    assert.equal(journal.compactionPolicyVersion, 1)
    await recoverNativeTurn(ctx, { botId: bot.botId })
    const checkpoint = await ctx.mbotRuntime.checkpoint(agent)
    assert.equal(checkpoint.compactions[0].compactionId, summary.data.compactionId)
    assert.equal(requests.length, count)
    assert.equal((await ctx.sessionQuery.readSession(agent.id)).events.filter(event => event.type === 'compaction/summary').length, 1)
    assert.equal(crash ? git(ws, 'rev-parse', 'HEAD') : git(ws, 'rev-list', '--count', `${head}..HEAD`), crash ? head : '1')
    assert.equal((await mailbox.receipt('runtime-recover-request')).result.final, true)
    assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).needed, false)
  })
}

test('managed summary flush recovery publishes its existing proof without another model call', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, requests } = await app(t, options => {
    if (options.purpose === summaryPurpose) {
      const sources = JSON.parse(options.messages.at(-1).content[0].text)
      return response(JSON.stringify({ items: [{ text: 'The user requested reference work.', sourceEventSeqs: sources[0].sourceEventSeqs }] }))
    }
    return response('reference report '.repeat(1500))
  }, { main: true, persistence: true, compaction: true })
  await removalController(ctx, agent)
  agent.followup(message('reference input '.repeat(1500)))
  await settle(ctx, agent)
  const previous = await ctx.mbotRuntime.checkpoint(agent)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let fail = true
  ctx.sessions.flush = async session => {
    if (fail && ctx.mbotRuntime.states.get(agent).current?.result?.head) { fail = false; throw new Error('summary receipt flush failure') }
    return flush(session)
  }
  agent.followup(message('compact: summary committed before flush failure'))
  await agent.whenIdle()
  await assert.rejects(ctx.mbotRuntime.settled(agent), /flush/u)
  assert.equal(ctx.mbotRuntime.states.get(agent).checkpoint.commit, previous.commit)
  const head = git(ws, 'rev-parse', 'HEAD'), count = requests.length
  ctx.sessions.flush = flush
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).receiptRepaired, true)
  assert.equal((await ctx.mbotRuntime.checkpoint(agent)).compactions[0].status, 'completed')
  assert.equal(git(ws, 'rev-parse', 'HEAD'), head)
  assert.equal(requests.length, count)
})

test('retired Bot compaction recovery rebuilds reused summary ancestry from Git without reopening business', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, requests } = await failedRuntime(t, { fixture: { compaction: true, persistence: true },
    script: options => {
      if (options.purpose === summaryPurpose) {
        const sources = JSON.parse(options.messages.at(-1).content[0].text)
        return response(JSON.stringify({ items: [{ text: 'User requested work.', sourceEventSeqs: sources[0].sourceEventSeqs }] }))
      }
      return response('reference report '.repeat(1500))
    }, prepare: async fixture => {
      fixture.agent.followup(message('raw input '.repeat(1500))); await settle(fixture.ctx, fixture.agent)
      fixture.agent.followup(message('compact: audited first summary')); await settle(fixture.ctx, fixture.agent)
      fixture.ctx.on('agent/pre-step', async (input, next) => {
        if (input.messages.some(message => message.content.some(block => block.text === 'audit interrupted'))) {
          const surface = await fixture.ctx.sessionQuery.readSurface(input.agent.id)
          const first = surface.events.find(event => event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint')
          const last = surface.events.findLast(event => event.type === 'assistant/message')
          await fixture.ctx.compaction.compactRegion(first.seq, last.seq, input.agent, input.signal)
        }
        return next()
      })
    } })
  const count = requests.length
  await ctx.mbot.removeBot(bot.botId)
  assert.equal(ctx.mbotRuntime.states.has(agent), false)
  const recovered = await recoverNativeTurn(ctx, { botId: bot.botId })
  assert.equal(recovered.success, true)
  assert.equal(requests.length, count)
  const meta = JSON.parse(git(ws, 'show', `HEAD:${recovered.meta}`))
  assert.equal(meta.runtime.compactions[0].status, 'completed')
  assert.equal(meta.runtime.compactions[0].input.reusedSummaries.length, 1)
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'retired')
})

test('managed compaction restoration refuses missing owned output even when its native replacement exists', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests } = await app(t, options => response(options.purpose === summaryPurpose
    ? '{"items":[]}' : 'reference report '.repeat(1500)), { main: true, compaction: true })
  agent.followup(message('reference input '.repeat(1500)))
  await settle(ctx, agent)
  agent.followup(message('compact: preserve evidence'))
  await settle(ctx, agent)
  const head = git(ws, 'rev-parse', 'HEAD'), count = requests.length
  const read = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
  t.after(() => { if (ctx.sessionQuery) ctx.sessionQuery.readSession = read })
  ctx.sessionQuery.readSession = async id => {
    const log = structuredClone(await read(id))
    if (id === agent.id) log.events = log.events.filter(event => event.type !== compactOutputType)
    return log
  }
  await assert.rejects(ctx.mbotRuntime.checkpoint(agent), /evidence/u)
  ctx.sessionQuery.readSession = read
  agent.followup(message('must not execute after missing compaction evidence'))
  await agent.whenIdle()
  assert.equal(requests.length, count)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), head)
})

test('real DeepSeek produces an attributed managed compaction through the native Runtime',
  { timeout: 180000, skip: process.env.MBOT_REAL_COMPACTION !== '1' }, async t => {
    assert.ok(process.env.DEEPSEEK_API_KEY, 'The real compaction wrapper must provide an API key')
    let actualUsage
    const { ctx, ws, agent } = await app(t, async options => {
      if (options.purpose !== summaryPurpose) return response('model report: the requested task remains open. '.repeat(1000))
      const result = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', signal: options.signal,
        headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-chat', messages: options.messages.map(message => ({ role: message.role,
          content: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') })),
          response_format: { type: 'json_object' }, max_tokens: options.maxTokens, thinking: { type: 'disabled' } }),
      })
      if (!result.ok) throw new Error(`Real DeepSeek compaction HTTP status ${result.status}`)
      const body = await result.json(), choice = body.choices[0]
      assert.equal(choice.finish_reason, 'stop')
      actualUsage = { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens, totalTokens: body.usage.total_tokens }
      return (function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: choice.message.content } }
        yield { type: 'usage', usage: actualUsage }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }, { main: true, persistence: true, compaction: true })
    agent.followup(message('用户请求：为项目实现可靠的会话上下文管理。私人对话中的请求不能变成人格或已确认的长期记忆。\n' + '参考记录：任务仍待实现，应保留来源。\n'.repeat(1000)))
    await settle(ctx, agent)
    agent.followup(message('compact: real structured summary acceptance'))
    await settle(ctx, agent)
    const checkpoint = await ctx.mbotRuntime.checkpoint(agent), proof = checkpoint.compactions[0]
    assert.equal(proof.status, 'completed')
    assert.ok(proof.output.items.length)
    assert.deepEqual(proof.output.usage, actualUsage)
    assert.equal(git(ws, 'status', '--porcelain'), '')
    t.diagnostic(`Real summary artifacts: ${ws}; compaction=${proof.compactionId}; tokens=${actualUsage.totalTokens}`)
  })

test('context checkpoints bind native history and Git knowledge, keeping epochs stable across task commits', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests } = await app(t, () => response('context boundary reply'), { main: true })
  assert.equal(await ctx.mbotRuntime.checkpoint(agent), null)
  agent.followup(message('first context input'))
  await settle(ctx, agent)
  const first = await ctx.mbotRuntime.checkpoint(agent)
  assert.equal(first.commit, git(ws, 'rev-parse', 'HEAD'))
  assert.equal(first.snapshot.contextEpoch, 1)
  assert.equal(first.snapshot.previous, null)
  assert.equal(first.snapshotHash, contextHash(first.snapshot))
  const meta = JSON.parse(git(ws, 'show', `${first.commit}:${first.meta}`))
  assert.deepEqual(meta.runtime.context.snapshot, first.snapshot)
  const state = ctx.mbotRuntime.states.get(agent)
  assert.ok(Object.isFrozen(state.current.lease.snapshot.knowledge.documents))
  assert.throws(() => { state.current.lease.snapshot.knowledge.documents[0].blob = 'changed' }, TypeError)
  first.snapshot.knowledge.documents[0].path = 'caller mutation'
  agent.followup(message('second input after only an audit Git commit'))
  await settle(ctx, agent)
  const second = await ctx.mbotRuntime.checkpoint(agent)
  assert.equal(second.snapshot.memoryCommit, first.commit)
  assert.equal(second.snapshot.contextEpoch, 1)
  assert.equal(second.snapshot.knowledge.version, first.snapshot.knowledge.version)
  assert.equal(second.snapshot.knowledge.documents[0].path, 'AGENTS.md')
  assert.ok(second.snapshot.sourceCut.events.length > 0)
  const history = await ctx.sessionQuery.readSession(agent.id)
  const user = history.events.find(event => event.type === 'user/message' && event.data.content.some(block => block.text === 'first context input'))
  assert.equal(second.snapshot.sourceCut.events.find(item => item.seq === user.seq).hash, contextHash(user))
  assert.ok(requests[1].messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('"contextEpoch":1'))))
  const soul = join(ws, 'bots/chief/SOUL.md')
  await writeFile(soul, (await readFile(soul, 'utf8')) + '\nnew-persona-context-version-882211\n')
  git(ws, 'add', 'bots/chief/SOUL.md'); git(ws, 'commit', '-m', 'fixture: new knowledge version')
  agent.followup(message('third input with new personality'))
  await settle(ctx, agent)
  const third = await ctx.mbotRuntime.checkpoint(agent)
  assert.equal(third.snapshot.contextEpoch, 2)
  assert.notEqual(third.snapshot.knowledge.version, second.snapshot.knowledge.version)
  assert.equal(third.snapshot.previous.commit, second.commit)
  assert.ok(JSON.stringify(requests[2].messages).includes('new-persona-context-version-882211'))
})

test('a checkpoint remains unpublished until native flush and receipt recovery does not repeat its Git commit', { timeout: 30000 }, async t => {
  let emitted = false, failed = false
  const { ctx, ws, bot, agent } = await app(t, () => { emitted = true; return response('checkpoint flush reply') }, { main: true })
  await removalController(ctx, agent)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush = async session => {
    if (emitted && !failed) { failed = true; throw new Error('checkpoint persistence failure') }
    return flush(session)
  }
  agent.followup(message('commit but do not confirm the checkpoint'))
  await agent.whenIdle()
  await assert.rejects(ctx.mbotRuntime.settled(agent), /persistence/u)
  assert.equal(ctx.mbotRuntime.states.get(agent).checkpoint, null)
  await assert.rejects(ctx.mbotRuntime.checkpoint(agent), /persistence/u)
  const head = git(ws, 'rev-parse', 'HEAD')
  ctx.sessions.flush = flush
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).receiptRepaired, true)
  const restored = await ctx.mbotRuntime.checkpoint(agent)
  assert.equal(restored.commit, head)
  assert.equal(restored.snapshot.contextEpoch, 1)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), head)
})

test('native persistence resumes the same Session with its verified context checkpoint and epoch', { timeout: 30000 }, async t => {
  const { ctx, agent, handle, bot } = await app(t, () => response('persisted context reply'), { main: true, persistence: true })
  agent.followup(message('context survives native writer release'))
  await settle(ctx, agent)
  const before = await ctx.mbotRuntime.checkpoint(agent)
  await handle.dispose()
  const resumed = await ctx.agents.resume({ resumeSessionId: agent.id, agentOptions: { provider: 'runtime-test', model: 'scripted' },
    setup: (_ctx, current) => ctx.mbotRuntime.attach(current, { botId: bot.botId }) })
  assert.notEqual(resumed.agent, agent)
  assert.equal(resumed.agent.id, agent.id)
  assert.deepEqual(await ctx.mbotRuntime.checkpoint(resumed.agent), before)
  resumed.agent.followup(message('continue the same memory version'))
  await settle(ctx, resumed.agent)
  assert.equal((await ctx.mbotRuntime.checkpoint(resumed.agent)).snapshot.contextEpoch, before.snapshot.contextEpoch)
})

test('context sources preserve surface order after a native replacement introduces nonmonotonic seqs', { timeout: 30000 }, async t => {
  const { ctx, agent } = await app(t, () => response('surface order reply'), { main: true })
  agent.followup(message('first historical turn'))
  await settle(ctx, agent)
  const first = await ctx.sessionQuery.readSurface(agent.id)
  const beginning = first.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
  const end = first.events.findLast(event => event.type === 'assistant/message')
  agent.followup(message('second historical turn stays visible'))
  await settle(ctx, agent)
  const currentSurface = await ctx.sessionQuery.readSurface(agent.id)
  const replaced = currentSurface.events.slice(currentSurface.events.findIndex(event => event.seq === beginning.seq),
    currentSurface.events.findIndex(event => event.seq === end.seq) + 1).map(event => event.seq)
  const replacementSeq = agent.session.append('user/message', message('trusted replacement of the first historical span'),
    { surfaceOp: { op: 'replace', startSeq: beginning.seq, endSeq: end.seq }, sourceEventSeqs: replaced }).seq
  agent.followup(message('capture the reordered native history'))
  await settle(ctx, agent)
  const checkpoint = await ctx.mbotRuntime.checkpoint(agent)
  const refs = checkpoint.snapshot.sourceCut.events
  const replacementIndex = refs.findIndex(item => item.seq === replacementSeq)
  assert.ok(replacementIndex >= 0)
  assert.ok(refs.slice(replacementIndex + 1).some(item => item.seq < replacementSeq))
})

test('checkpoint restoration rejects changed historical source bytes and holds subsequent model admission', { timeout: 30000 }, async t => {
  const { ctx, agent, requests } = await app(t, () => response('source proof reply'), { main: true })
  agent.followup(message('first source bytes'))
  await settle(ctx, agent)
  agent.followup(message('second source bytes'))
  await settle(ctx, agent)
  const read = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
  t.after(() => { if (ctx.sessionQuery) ctx.sessionQuery.readSession = read })
  ctx.sessionQuery.readSession = async id => {
    const log = structuredClone(await read(id))
    if (id === agent.id) {
      const user = log.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
      user.data.content = [{ type: 'text', text: 'changed historical source' }]
    }
    return log
  }
  await assert.rejects(ctx.mbotRuntime.checkpoint(agent), /source cut/u)
  ctx.sessionQuery.readSession = read
  agent.followup(message('must remain pending after evidence conflict'))
  await agent.whenIdle()
  assert.equal(requests.length, 2)
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'failed')
})

test('native context snapshot tampering is refused even when a command card claims success', { timeout: 30000 }, async t => {
  const { ctx, ws, agent } = await app(t, () => response('sealed snapshot reply'), { main: true })
  appendPluginRecord(agent.session, 'plugin:mbot/context-checkpoint', { contextEpoch: 999, committed: true })
  assert.equal(await ctx.mbotRuntime.checkpoint(agent), null, 'An ignorable presentation event is not checkpoint evidence')
  agent.followup(message('create actual native and Git evidence'))
  await settle(ctx, agent)
  const head = git(ws, 'rev-parse', 'HEAD')
  const read = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
  t.after(() => { if (ctx.sessionQuery) ctx.sessionQuery.readSession = read })
  ctx.sessionQuery.readSession = async id => {
    const log = structuredClone(await read(id))
    if (id === agent.id) log.events.find(event => event.type === contextSnapshotType).data.contextEpoch = 999
    return log
  }
  await assert.rejects(ctx.mbotRuntime.checkpoint(agent), /evidence/u)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), head)
})

test('removing all native context snapshots cannot turn an audited Session into an empty checkpoint baseline', { timeout: 30000 }, async t => {
  const { ctx, agent } = await app(t, () => response('context evidence must survive'), { main: true })
  agent.followup(message('publish a checkpoint that cannot be silently dropped'))
  await settle(ctx, agent)
  const read = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
  ctx.sessionQuery.readSession = async id => {
    const log = await read(id)
    return id === agent.id ? { ...log, events: log.events.filter(event => event.type !== contextSnapshotType) } : log
  }
  await assert.rejects(ctx.mbotRuntime.checkpoint(agent), /evidence/u)
  ctx.sessionQuery.readSession = read
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'failed')
})

test('interrupted native turn recovery publishes its original checkpoint once without running another model', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, journal, requests } = await failedRuntime(t)
  const before = requests.length
  const recovered = await recoverNativeTurn(ctx, { botId: bot.botId })
  const checkpoint = await ctx.mbotRuntime.checkpoint(agent)
  assert.equal(checkpoint.snapshot.runId, journal.runId)
  assert.equal(checkpoint.snapshot.memoryCommit, journal.baseHead)
  assert.equal(checkpoint.commit, recovered.head)
  assert.equal(checkpoint.snapshot.contextEpoch, 1)
  assert.equal(requests.length, before)
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).needed, false)
  assert.equal(git(ws, 'rev-list', '--count', `${journal.baseHead}..HEAD`), '1')
})

test('a checkpoint stays withheld after Git committed until the abandoned journal is settled', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, journal, owner } = await failedRuntime(t, { crash: 'commit' })
  const committed = git(ws, 'rev-parse', 'HEAD')
  assert.notEqual(committed, journal.baseHead)
  await owner.dispose()
  await ctx.plugin(runtime)
  assert.equal(ctx.mbotRuntime.states.get(agent).checkpoint, null)
  const recovered = await recoverNativeTurn(ctx, { botId: bot.botId })
  assert.equal(recovered.alreadyCommitted, true)
  assert.equal((await ctx.mbotRuntime.checkpoint(agent)).commit, committed)
  assert.equal(git(ws, 'rev-list', '--count', `${journal.baseHead}..HEAD`), '1')
})

test('checkpoint capture failure after lease acquisition closes the native blocked audit and parks unexecuted input', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests } = await app(t, () => response('must not dispatch'), { main: true })
  const read = ctx.sessionQuery.readSurface.bind(ctx.sessionQuery)
  ctx.sessionQuery.readSurface = async () => { throw new Error('injected context capture failure') }
  agent.followup(message('park this input if context cannot be captured'))
  await agent.whenIdle()
  await ctx.mbotRuntime.settled(agent)
  ctx.sessionQuery.readSurface = read
  assert.equal(requests.length, 0)
  assert.equal(agent.inbox.nextTurn.length, 1)
  const state = ctx.mbotRuntime.states.get(agent)
  assert.equal(state.current.lease.transportEnded, true)
  await assert.rejects(readFile(join(ws, '.mbot/runs/active-turn.json')), { code: 'ENOENT' })
  assert.equal(state.current.result.outcome, 'failed')
})

test('a checkpoint query overlapping a new commit returns its observation without regressing Runtime context', { timeout: 30000 }, async t => {
  const { ctx, agent } = await app(t, () => response('overlapping checkpoint observation'), { main: true })
  agent.followup(message('first published context'))
  await settle(ctx, agent)
  const first = await ctx.mbotRuntime.checkpoint(agent)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let hold = true
  ctx.sessions.flush = async session => {
    if (hold) { hold = false; entered.resolve(); await release.promise }
    return flush(session)
  }
  const observing = ctx.mbotRuntime.checkpoint(agent)
  await entered.promise
  agent.followup(message('newer context commits while the earlier query waits'))
  await settle(ctx, agent)
  const second = ctx.mbotRuntime.states.get(agent).checkpoint
  assert.ok(second.turn > first.turn)
  release.resolve()
  assert.equal((await observing).commit, first.commit)
  assert.equal(ctx.mbotRuntime.states.get(agent).checkpoint.commit, second.commit)
  assert.equal((await ctx.mbotRuntime.checkpoint(agent)).commit, second.commit)
  ctx.sessions.flush = flush
})

test('Runtime handoff drains an in-flight checkpoint observation and its native flush', { timeout: 30000 }, async t => {
  const { ctx, agent, owner } = await app(t, () => response('checkpoint reader lifetime'), { main: true })
  agent.followup(message('publish context before handoff'))
  await settle(ctx, agent)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush = async session => { entered.resolve(); await release.promise; return flush(session) }
  const observing = ctx.mbotRuntime.checkpoint(agent)
  const rejected = assert.rejects(observing, /unavailable/u)
  await entered.promise
  const old = ctx.mbotRuntime, closing = owner.dispose()
  let closed = false
  const drained = closing.then(() => { closed = true })
  await delay(30)
  assert.equal(closed, false)
  assert.equal(old.states.has(agent), true)
  release.resolve()
  await rejected
  await drained
  assert.equal(old.states.size, 0)
  ctx.sessions.flush = flush
})

test('Bot retirement drains an accepted checkpoint query before dropping its Runtime owner', { timeout: 30000 }, async t => {
  const { ctx, bot, agent } = await app(t, () => response('checkpoint retirement lifetime'), { main: true })
  await removalController(ctx, agent)
  agent.followup(message('publish context before retirement'))
  await settle(ctx, agent)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let hold = true
  ctx.sessions.flush = async session => {
    if (hold) { hold = false; entered.resolve(); await release.promise }
    return flush(session)
  }
  const observing = ctx.mbotRuntime.checkpoint(agent)
  const rejected = assert.rejects(observing, /unavailable/u)
  await entered.promise
  let retired = false
  const retiring = ctx.mbot.removeBot(bot.botId).then(value => { retired = true; return value })
  const state = ctx.mbotRuntime.states.get(agent), deadline = Date.now() + 5000
  while (!state.closing && Date.now() < deadline) await delay(10)
  assert.equal(state.closing, true, 'Retirement must reach its reader-drain boundary')
  assert.equal(retired, false)
  assert.equal(ctx.mbotRuntime.states.has(agent), true)
  release.resolve()
  await rejected
  await retiring
  assert.equal(ctx.mbotRuntime.states.has(agent), false)
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'retired')
  ctx.sessions.flush = flush
})

test('a native/Git checkpoint observation crossing a newer commit retries without failing the Bot', { timeout: 30000 }, async t => {
  const { ctx, agent } = await app(t, () => response('checkpoint observation retry'), { main: true })
  agent.followup(message('first checkpoint observation'))
  await settle(ctx, agent)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const read = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
  let hold = true, reads = 0
  ctx.sessionQuery.readSession = async id => {
    const log = await read(id)
    if (id === agent.id) {
      reads++
      if (hold) { hold = false; entered.resolve(); await release.promise }
    }
    return log
  }
  const observing = ctx.mbotRuntime.checkpoint(agent)
  await entered.promise
  agent.followup(message('commit while the old native log observation is held'))
  await settle(ctx, agent)
  const latest = ctx.mbotRuntime.states.get(agent).checkpoint
  release.resolve()
  assert.equal((await observing).commit, latest.commit)
  assert.equal(reads, 2)
  assert.equal(ctx.mbotRuntime.states.get(agent).error, undefined)
  ctx.sessionQuery.readSession = read
})

test('continuous newer commits bound checkpoint observation retries without pausing normal conversation', { timeout: 30000 }, async t => {
  const { ctx, agent } = await app(t, () => response('bounded checkpoint observation'), { main: true })
  agent.followup(message('initial context before overlapping observations'))
  await settle(ctx, agent)
  const read = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
  let commits = 0
  ctx.sessionQuery.readSession = async id => {
    const log = await read(id)
    if (id === agent.id && commits < 3) {
      agent.followup(message(`new turn crossing observation ${++commits}`))
      await settle(ctx, agent)
    }
    return log
  }
  await assert.rejects(ctx.mbotRuntime.checkpoint(agent), /observations crossed/u)
  assert.equal(commits, 3)
  assert.equal(ctx.mbotRuntime.states.get(agent).error, undefined)
  ctx.sessionQuery.readSession = read
  assert.equal((await ctx.mbotRuntime.checkpoint(agent)).commit, ctx.mbotRuntime.states.get(agent).checkpoint.commit)
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'idle')
})

async function removalController(ctx, agent, resolve = async () => ({ agent })) {
  class Controller extends Service {
    constructor(ctx) { super(ctx, 'sessionController') }
    resolveAgent(id) { assert.equal(id, agent.id); return resolve() }
  }
  await ctx.plugin(Controller)
}

test('real fresh Worker uses its role snapshot and native tools, then joins one parent audit', { timeout: 30000 }, async t => {
  const steps = new Map()
  const { ctx, ws, agent, requests } = await app(t, (request, _n, ctx) => {
    const n = (steps.get(request.sessionId) ?? 0) + 1
    steps.set(request.sessionId, n)
    if (request.sessionId.startsWith('mbot-worker-')) {
      assert.ok(JSON.stringify(request.messages).includes('# MBot role: coder'))
      assert.ok(JSON.stringify(request.messages).includes('coder-private-memory-334411'))
      assert.ok(!JSON.stringify(request.messages).includes('private-parent-history-998877'))
      return n === 1 ? response('', { name: 'botctl', args: { action: 'boot', bot: 'coder', task_id: '001' } })
        : n === 2 ? response('', { name: 'botctl', args: { action: 'task_result', task_id: '001', text: 'native Worker task result' } })
        : n === 3 ? response('', { name: 'botctl', args: { action: 'remember', text: 'native Worker remembered fact' } }) : response('native Worker finished')
    }
    return n === 1 ? response('', { name: 'botctl', args: { action: 'board_add', owner: 'coder', text: 'native Worker task' } })
      : n === 2 ? response('', { name: 'botctl', args: { action: 'board_set', task_id: '001', state: 'doing' } })
      : n === 3 ? response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } })
      : n === 4 ? response('', { name: 'botctl', args: { action: 'worker_wait', worker_id: membersOf(ctx, ctx.agents.get(request.sessionId))[0].id } }) : response('parent audit complete')
  }, { workers: true, main: true })
  const memory = join(ws, 'bots/coder/MEMORY.md')
  await writeFile(memory, (await readFile(memory, 'utf8')) + '\ncoder-private-memory-334411\n')
  git(ws, 'add', 'bots/coder/MEMORY.md'); git(ws, 'commit', '-m', 'fixture: private Worker memory')
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('private-parent-history-998877'))
  await settle(ctx, agent)
  const member = [...ctx.mbotRuntime.states.get(agent).current.workers][0]
  assert.ok(member, JSON.stringify(requests.flatMap(request => request.messages.filter(message => message.role === 'tool')).at(-1)))
  assert.equal(member.done, true, member.error?.stack)
  assert.equal(ctx.mbotRuntime.workerManager.members.size, 0, 'Completed activations must leave the live registry')
  assert.equal(member.result.stopReason, 'completed', member.startupError?.stack ?? member.error?.stack)
  assert.equal(ctx.agents.get(member.id), undefined, 'Native child must be released before parent commits')
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.phase, 'committed')
  assert.match(await readFile(join(ws, 'tasks/001.md'), 'utf8'), /by: coder/u)
  const meta = JSON.parse(git(ws, 'show', 'HEAD:' + git(ws, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').find(path => path.endsWith('.meta.json'))))
  assert.equal(meta.runtime.actors[0].native.kind, 'native-worker')
  assert.equal(meta.runtime.actors[0].native.executionFault, false)
  assert.equal(meta.runtime.actors[0].native.usage.total_tokens, 60)
  const parentLog = await ctx.sessionQuery.readSession(agent.id)
  assert.equal(parentLog.events.some(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled'), false)
  assert.ok(!JSON.stringify(parentLog.events).includes('coder-private-memory-334411'))
})

async function workerTasks(ctx, count = 1) {
  for (let n = 1; n <= count; n++) {
    assert.equal((await ctx.mbot.execute('botctl', ['board', 'add', `Worker task ${n}`, '--owner', 'coder'])).exitCode, 0)
    assert.equal((await ctx.mbot.execute('botctl', ['board', 'set', String(n).padStart(3, '0'), 'doing'])).exitCode, 0)
  }
}
const membersOf = (ctx, agent) => [...ctx.mbotRuntime.states.get(agent).current.workers ?? []]

test('native Workers enforce two concurrent tasks, reject duplicate reservations and join before parent commit', { timeout: 30000 }, async t => {
  const parentEntered = Promise.withResolvers(), childrenEntered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const steps = new Map()
  let childCount = 0
  const { ctx, ws, agent } = await app(t, async (request, _n, ctx) => {
    const n = (steps.get(request.sessionId) ?? 0) + 1
    steps.set(request.sessionId, n)
    if (request.sessionId.startsWith('mbot-worker-')) {
      const member = ctx.mbotRuntime.workerManager.members.get(request.sessionId)
      assert.deepEqual(request.tools.map(tool => tool.name), ['botctl'])
      if (n === 1) return response('', { name: 'botctl', args: { action: 'boot', bot: 'coder', task_id: member.actor.identity.taskId } })
      if (++childCount === 2) childrenEntered.resolve()
      await release.promise
      return response('parallel Worker complete')
    }
    if (n === 1) return response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } })
    parentEntered.resolve()
    await release.promise
    return response('parent waits for both children at the transaction boundary')
  }, { workers: true, main: true })
  await workerTasks(ctx, 3)
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('run the Workers'))
  await parentEntered.promise
  const signal = new AbortController().signal
  await assert.rejects(ctx.mbotRuntime.workerAction(agent, 'worker_spawn', { bot: 'coder', task_id: '001' }, signal), /reserved/u)
  const second = await ctx.mbotRuntime.workerAction(agent, 'worker_spawn', { bot: 'coder', task_id: '002' }, signal)
  await childrenEntered.promise
  await assert.rejects(ctx.mbotRuntime.workerAction(agent, 'worker_spawn', { bot: 'coder', task_id: '003' }, signal), /reserved/u)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  release.resolve()
  await settle(ctx, agent)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal(ctx.agents.get(second.worker_id), undefined)
  assert.equal(ctx.mbotRuntime.workerManager.members.size, 0)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'completed')
  for (const member of membersOf(ctx, agent).filter(member => member.actor)) {
    assert.equal(member.done, true, member.error?.stack)
    await assert.rejects(member.actor.execute('botctl', ['task', 'show', member.actor.identity.taskId]), /closed/u)
  }
})

test('cancelling a Worker wait leaves execution active and creator corrections use only the child Inbox', { timeout: 30000 }, async t => {
  const parentEntered = Promise.withResolvers(), childEntered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const steps = new Map()
  const { ctx, agent, requests } = await app(t, async (request, _n, ctx) => {
    const n = (steps.get(request.sessionId) ?? 0) + 1
    steps.set(request.sessionId, n)
    if (request.sessionId.startsWith('mbot-worker-')) {
      if (n === 1) return response('', { name: 'botctl', args: { action: 'boot', bot: 'coder', task_id: '001' } })
      if (n === 2) { childEntered.resolve(); await release.promise; return response('', { name: 'botctl', args: { action: 'task_show', task_id: '001' } }) }
      assert.match(JSON.stringify(request.messages), /creator-only-correction-445566/u)
      return response('corrected Worker done')
    }
    if (n === 1) return response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } })
    parentEntered.resolve()
    await release.promise
    return response('parent complete')
  }, { workers: true, main: true })
  await workerTasks(ctx)
  agent.followup(message('start a Worker'))
  await Promise.all([parentEntered.promise, childEntered.promise])
  const member = membersOf(ctx, agent)[0], waiting = new AbortController()
  const result = ctx.mbotRuntime.workerAction(agent, 'worker_wait', { worker_id: member.id }, waiting.signal)
  waiting.abort(new Error('observer stopped waiting'))
  await assert.rejects(result, /observer stopped/u)
  assert.equal(member.controller.signal.aborted, false)
  const signal = new AbortController().signal
  const messageId = await ctx.mbotRuntime.workerAction(agent, 'worker_message', { worker_id: member.id, text: 'creator-only-correction-445566' }, signal)
  assert.equal(typeof messageId, 'string')
  await assert.rejects(ctx.mbotRuntime.workerAction(agent, 'worker_message', { worker_id: 'foreign-child', text: 'bad route' }, signal), /this turn/u)
  release.resolve()
  await settle(ctx, agent)
  assert.equal(member.native.executionFault, false)
  assert.ok(!JSON.stringify(requests.filter(request => request.sessionId === agent.id)).includes('creator-only-correction-445566'))
  await assert.rejects(ctx.mbotRuntime.workerAction(agent, 'worker_message', { worker_id: member.id, text: 'too late' }, signal), /active Chief/u)
})

test('parent user stop joins a late native Worker data writer and preserves pending parent input', { timeout: 30000 }, async t => {
  const parentEntered = Promise.withResolvers(), writerEntered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const steps = new Map()
  const { ctx, ws, agent } = await app(t, async (request, _n, ctx) => {
    const n = (steps.get(request.sessionId) ?? 0) + 1
    steps.set(request.sessionId, n)
    if (request.sessionId.startsWith('mbot-worker-')) return n === 1
      ? response('', { name: 'botctl', args: { action: 'boot', bot: 'coder', task_id: '001' } })
      : response('', { name: 'botctl', args: { action: 'task_result', task_id: '001', text: 'late Worker data call' } })
    if (n === 1) return response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } })
    parentEntered.resolve()
    await delay(60000, undefined, { signal: request.signal })
    return response('unreachable')
  }, { workers: true, main: true })
  await workerTasks(ctx)
  await writeFile(join(ws, '.mbot/failures'), '2\n')
  const execute = ctx.mbot.execute.bind(ctx.mbot)
  ctx.mbot.execute = async (program, args, options) => {
    if (args[0] === 'task' && args[1] === 'result' && options?.permit) {
      writerEntered.resolve()
      await release.promise
      // A provider may finish a captured write after cancellation. Its owner
      // still joins this exact operation before closing the data capability.
      return execute(program, args, { ...options, signal: undefined })
    }
    return execute(program, args, options)
  }
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('start and stop the Worker'))
  await Promise.all([parentEntered.promise, writerEntered.promise])
  const member = membersOf(ctx, agent)[0]
  agent.inbox.splice('next-turn', 0, 0, [message('preserved parent followup')])
  let stopped = false
  const stop = ctx.mbotRuntime.stop(agent).then(value => { stopped = true; return value })
  await delay(50)
  assert.equal(stopped, false)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  release.resolve()
  const result = await stop
  assert.equal(result.receipt.outcome, 'cancelled')
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '2\n')
  assert.equal(member.done, true, member.error?.stack)
  assert.equal(member.result.stopReason, 'aborted')
  assert.equal(member.native.executionFault, false)
  assert.equal(ctx.agents.get(member.id), undefined)
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.match(await readFile(join(ws, 'tasks/001.md'), 'utf8'), /late Worker data call/u)
})

test('native Worker tool faults propagate to one failed parent audit without exposing other tasks', { timeout: 30000 }, async t => {
  const steps = new Map()
  const { ctx, ws, agent } = await app(t, (request, _n, ctx) => {
    const n = (steps.get(request.sessionId) ?? 0) + 1
    steps.set(request.sessionId, n)
    if (request.sessionId.startsWith('mbot-worker-')) return n === 1
      ? response('', { name: 'botctl', args: { action: 'boot', bot: 'coder', task_id: '001' } })
      : n === 2 ? response('', { name: 'botctl', args: { action: 'task_result', task_id: '002', text: 'forbidden cross-task data' } }) : response('failed Worker answered')
    return n === 1 ? response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } })
      : n === 2 ? response('', { name: 'botctl', args: { action: 'worker_wait', worker_id: membersOf(ctx, ctx.agents.get(request.sessionId))[0].id } }) : response('parent cannot conceal child failure')
  }, { workers: true, main: true })
  await workerTasks(ctx, 2)
  const task = await readFile(join(ws, 'tasks/002.md'), 'utf8'), base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('test Worker task restrictions'))
  await settle(ctx, agent)
  const member = membersOf(ctx, agent)[0]
  assert.equal(member.native.executionFault, true)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'failed')
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '1\n')
  assert.equal(await readFile(join(ws, 'tasks/002.md'), 'utf8'), task)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
})

test('one-call delegation approval grants only the assigned Worker data capability', { timeout: 30000 }, async t => {
  const approvals = [], steps = new Map()
  const { ctx, agent } = await app(t, (request, _n, ctx) => {
    const n = (steps.get(request.sessionId) ?? 0) + 1
    steps.set(request.sessionId, n)
    if (request.sessionId.startsWith('mbot-worker-')) return n === 1
      ? response('', { name: 'botctl', args: { action: 'boot', bot: 'coder', task_id: '001' } })
      : n === 2 ? response('', { name: 'botctl', args: { action: 'task_result', task_id: '001', text: 'explicitly delegated data' } }) : response('approved Worker complete')
    return n === 1 ? response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } })
      : n === 2 ? response('', { name: 'botctl', args: { action: 'worker_wait', worker_id: membersOf(ctx, ctx.agents.get(request.sessionId))[0].id } }) : response('approved parent complete')
  }, { workers: true, main: true, policy: 'workspace-write', beforeRuntime: async ctx => {
    class Approval extends Service {
      constructor(ctx) { super(ctx, 'approval') }
      async request(input) { approvals.push(input); return 'allowed-once' }
    }
    await ctx.plugin(Approval)
  } })
  await workerTasks(ctx)
  agent.followup(message('delegate with approval'))
  await settle(ctx, agent)
  const member = membersOf(ctx, agent)[0]
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].toolName, 'botctl')
  assert.equal(ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'workspace-write')
  assert.equal(ctx.sandboxPolicy.resolve({ session: member.state.agent.session }).mode, 'workspace-write')
  assert.equal(member.native.executionFault, false)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'completed')
})

test('refused delegation never publishes a native Worker or issues a data permission', { timeout: 30000 }, async t => {
  let n = 0
  const { ctx, ws, agent, requests } = await app(t, () => ++n === 1
    ? response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } }) : response('delegation denied'),
  { workers: true, main: true, policy: 'read-only' })
  await workerTasks(ctx)
  const task = await readFile(join(ws, 'tasks/001.md'), 'utf8')
  agent.followup(message('unapproved delegation'))
  await settle(ctx, agent)
  assert.equal(ctx.mbotRuntime.states.get(agent).current.workers, undefined)
  assert.equal(ctx.mbotRuntime.workerManager.members.size, 0)
  assert.equal(requests.some(request => request.sessionId.startsWith('mbot-worker-')), false)
  assert.equal(await readFile(join(ws, 'tasks/001.md'), 'utf8'), task)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'failed')
})

test('Worker boot refusal is a recorded execution fault and cannot write the assigned task', { timeout: 30000 }, async t => {
  const steps = new Map()
  const { ctx, ws, agent } = await app(t, (request, _n, ctx) => {
    const n = (steps.get(request.sessionId) ?? 0) + 1
    steps.set(request.sessionId, n)
    if (request.sessionId.startsWith('mbot-worker-')) return n === 1
      ? response('', { name: 'botctl', args: { action: 'task_result', task_id: '001', text: 'must boot before writing' } }) : response('no boot')
    return n === 1 ? response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } })
      : n === 2 ? response('', { name: 'botctl', args: { action: 'worker_wait', worker_id: membersOf(ctx, ctx.agents.get(request.sessionId))[0].id } }) : response('parent records the refusal')
  }, { workers: true, main: true })
  await workerTasks(ctx)
  const task = await readFile(join(ws, 'tasks/001.md'), 'utf8')
  agent.followup(message('try to bypass boot'))
  await settle(ctx, agent)
  assert.equal(membersOf(ctx, agent)[0].native.executionFault, true)
  assert.equal(await readFile(join(ws, 'tasks/001.md'), 'utf8'), task)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'failed')
})

test('cancellation during native Worker publication seals rollback and revokes its data reservation', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { ctx, agent, requests } = await app(t, () => response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } }),
    { workers: true, main: true })
  await workerTasks(ctx)
  ctx.on('agent/created', async ({ agent: child }) => {
    if (!child.id.startsWith('mbot-worker-')) return
    entered.resolve()
    await release.promise
  })
  agent.followup(message('cancel during publication'))
  await entered.promise
  let stopped = false
  const stop = ctx.mbotRuntime.stop(agent).then(value => { stopped = true; return value })
  await delay(50)
  assert.equal(stopped, false)
  release.resolve()
  const result = await stop
  const member = membersOf(ctx, agent)[0]
  assert.equal(member.done, true, member.error?.stack)
  assert.equal(member.native.started, false)
  assert.equal(member.native.executionFault, false)
  assert.equal(member.actor.closed, true)
  assert.equal(ctx.agents.get(member.id), undefined)
  assert.equal(requests.some(request => request.sessionId === member.id), false)
  const log = await ctx.sessionQuery.readSession(agent.id)
  assert.equal(result.receipt.outcome, 'cancelled', JSON.stringify({ startup: { name: member.startupError?.name, message: member.startupError?.message },
    tools: log.events.filter(event => event.type === 'tool/result').map(event => ({ error: event.data.error, message: event.data.message.content })) }))
})

test('an unreserved native Worker cannot attach to an active or retired Bot main Session', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent } = await app(t, () => response('unused'), { workers: true, main: true })
  const create = () => ctx.agents.create({ sessionId: `orphan-worker-${++sequence}`, meta: {
    cwd: ws, origin: 'subagent', parentSession: agent.id, delegationDepth: 1,
  }, agentOptions: { provider: 'runtime-test', model: 'scripted' } })
  await assert.rejects(create(), /unbound managed Worker/u)
  await removalController(ctx, agent)
  await ctx.mbot.removeBot(bot.botId)
  await assert.rejects(create(), /unbound managed Worker/u)
})

test('explicit Worker stop closes only its activation and a replacement uses a fresh Session', { timeout: 30000 }, async t => {
  const parentEntered = Promise.withResolvers(), release = Promise.withResolvers(), steps = new Map(), entered = new Set()
  t.after(() => release.resolve())
  const { ctx, agent } = await app(t, async (request, _n, ctx) => {
    const n = (steps.get(request.sessionId) ?? 0) + 1
    steps.set(request.sessionId, n)
    if (request.sessionId.startsWith('mbot-worker-')) {
      if (n === 1) return response('', { name: 'botctl', args: { action: 'boot', bot: 'coder', task_id: '001' } })
      entered.add(request.sessionId)
      await delay(60000, undefined, { signal: request.signal })
      return response('unreachable')
    }
    if (n === 1) return response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } })
    parentEntered.resolve()
    await release.promise
    return response('explicit stops are controlled by the Chief')
  }, { workers: true, main: true })
  await workerTasks(ctx)
  agent.followup(message('start, stop and replace the Worker'))
  await parentEntered.promise
  const first = membersOf(ctx, agent)[0], signal = new AbortController().signal
  while (!entered.has(first.id)) await delay(10)
  const stopped = await ctx.mbotRuntime.workerAction(agent, 'worker_stop', { worker_id: first.id }, signal)
  assert.equal(stopped.stopReason, 'aborted')
  assert.equal(ctx.mbotRuntime.states.get(agent).current.signal.aborted, false)
  assert.equal(first.actor.closed, true)
  await assert.rejects(ctx.mbotRuntime.workerAction(agent, 'worker_message', { worker_id: first.id, text: 'cannot wake the closed assignment' }, signal), /already ended/u)
  const replacement = await ctx.mbotRuntime.workerAction(agent, 'worker_spawn', { bot: 'coder', task_id: '001' }, signal)
  assert.notEqual(replacement.worker_id, first.id)
  while (!entered.has(replacement.worker_id)) await delay(10)
  await ctx.mbotRuntime.workerAction(agent, 'worker_stop', { worker_id: replacement.worker_id }, signal)
  release.resolve()
  await settle(ctx, agent)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'completed')
  assert.equal(ctx.mbotRuntime.workerManager.members.size, 0)
})

test('Worker token exhaustion preserves partial streamed output and fails the parent audit', { timeout: 30000 }, async t => {
  const steps = new Map()
  const { ctx, agent } = await app(t, (request, _n, ctx) => {
    const n = (steps.get(request.sessionId) ?? 0) + 1
    steps.set(request.sessionId, n)
    if (request.sessionId.startsWith('mbot-worker-')) {
      if (n === 1) return response('', { name: 'botctl', args: { action: 'boot', bot: 'coder', task_id: '001' } })
      return (function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'partial Worker output' }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      })()
    }
    return n === 1 ? response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } })
      : n === 2 ? response('', { name: 'botctl', args: { action: 'worker_wait', worker_id: membersOf(ctx, ctx.agents.get(request.sessionId))[0].id } }) : response('partial work is not a successful task')
  }, { workers: true, main: true })
  await workerTasks(ctx)
  agent.followup(message('exhaust the Worker token budget'))
  await settle(ctx, agent)
  const member = membersOf(ctx, agent)[0]
  assert.equal(member.result.stopReason, 'max-tokens')
  assert.deepEqual(member.result.output, [{ type: 'text', text: 'partial Worker output' }])
  assert.equal(member.native.executionFault, true)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'failed')
})

test('malformed Worker tool JSON is audited as a native failure without breaking event observers', { timeout: 30000 }, async t => {
  const steps = new Map()
  const { ctx, agent } = await app(t, (request, _n, ctx) => {
    const n = (steps.get(request.sessionId) ?? 0) + 1
    steps.set(request.sessionId, n)
    if (request.sessionId.startsWith('mbot-worker-')) {
      if (n === 1) return (function* () {
        const block = { type: 'tool-call', id: `malformed-worker-${++sequence}`, name: 'botctl', arguments: '{broken' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      })()
      return response('malformed call refused')
    }
    return n === 1 ? response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } })
      : n === 2 ? response('', { name: 'botctl', args: { action: 'worker_wait', worker_id: membersOf(ctx, ctx.agents.get(request.sessionId))[0].id } }) : response('parent audit includes the native refusal')
  }, { workers: true, main: true })
  await workerTasks(ctx)
  agent.followup(message('send invalid Worker tool JSON'))
  await settle(ctx, agent)
  assert.equal(membersOf(ctx, agent)[0].done, true)
  assert.equal(membersOf(ctx, agent)[0].native.executionFault, true)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'failed')
})

test('a coder main Session retains foreground ownership when native Workers are enabled', { timeout: 30000 }, async t => {
  const { ctx, agent } = await app(t, request => {
    assert.match(JSON.stringify(request.messages), /managed main Session/u)
    assert.ok(!JSON.stringify(request.messages).includes('As a native Worker'))
    assert.ok(!JSON.stringify(request.tools).includes('worker_spawn'))
    return response('coder main Session completed')
  }, { workers: true, main: true, role: 'coder' })
  agent.followup(message('talk to the coder Bot directly'))
  await settle(ctx, agent)
  const record = ctx.mbotRuntime.states.get(agent).current
  assert.equal(ctx.mbotRuntime.worker(agent), false)
  assert.equal(record.lease.runtimeOwnership.mode, 'foreground-only')
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'completed')
})

test('removal rejects a live turn, then revokes the mailbox and preserves native data and pending input', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { ctx, ws, bot, agent, requests, owner } = await app(t, async () => {
    entered.resolve(); await release.promise; return response('settled before retirement')
  }, { main: true })
  await removalController(ctx, agent)
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'retire-active', text: 'complete the current turn' })
  await entered.promise
  await assert.rejects(ctx.mbot.removeBot(bot.botId), /busy/u)
  assert.equal(ctx.mbotRuntime.states.get(agent).current.signal.aborted, false, 'Removal must not cancel active business execution')
  assert.equal(ctx.mbot.registry().retiredBots.length, 0)
  release.resolve()
  await settle(ctx, agent)
  const before = git(ws, 'rev-parse', 'HEAD')
  agent.inbox.splice('next-turn', 0, 0, [message('keep this queued input')])
  const removed = await ctx.mbot.removeBot(bot.botId)
  assert.deepEqual(removed.sessionIds, [agent.id])
  assert.equal(git(ws, 'rev-parse', 'HEAD'), before)
  assert.equal(git(ws, 'status', '--porcelain'), '')
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'retired')
  await assert.rejects(mailbox.send({ requestId: 'retire-after', text: 'must not run' }), /unavailable/u)
  agent.followup(message('old window must remain blocked'))
  await agent.whenIdle()
  assert.equal(requests.length, 1)
  assert.equal(agent.inbox.nextTurn.length, 2)
  assert.throws(() => ctx.mbot.workspace({ sessionId: agent.id }), /removed/u)
  assert.equal((await ctx.mbot.removeBot(bot.botId, { revision: 0 })).alreadyRemoved, true)
  await owner.dispose()
  await ctx.plugin(await replacementRuntime())
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'retired')
  const fresh = await ctx.mbot.importBot(ws)
  assert.notEqual(fresh.botId, bot.botId)
  await assert.rejects(ctx.mbotRuntime.attach(agent, { botId: fresh.botId }), /redirected/u)
  agent.followup(message('blocked after reload and reimport'))
  await agent.whenIdle()
  assert.equal(requests.length, 1)
  assert.equal(agent.inbox.nextTurn.length, 3)
})

test('a failed retirement save releases its temporary gate and the same mailbox remains usable', { timeout: 30000 }, async t => {
  const { ctx, bot, agent, requests } = await app(t, () => response('save failure recovered'), { main: true })
  await removalController(ctx, agent)
  const mailbox = mainMailbox(ctx, agent)
  const edit = ctx.configEditor.edit.bind(ctx.configEditor)
  let calls = 0
  ctx.configEditor.edit = async (...args) => {
    if (++calls === 2) {
      assert.equal((await ctx.mbotRuntime.status(agent)).state, 'removing')
      await assert.rejects(mailbox.send({ requestId: 'held', text: 'temporarily blocked' }), /unavailable/u)
      throw new Error('injected retirement save failure')
    }
    return edit(...args)
  }
  await assert.rejects(ctx.mbot.removeBot(bot.botId), /save failure/u)
  ctx.configEditor.edit = edit
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'idle')
  assert.equal(ctx.mbot.registry().retiredBots.length, 0)
  await mailbox.send({ requestId: 'after-save-failure', text: 'still an active Bot' })
  await settle(ctx, agent)
  assert.equal(requests.length, 1)
})

test('native input arriving during retirement is parked without model dispatch or an audit transaction', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, requests } = await app(t, () => response('must not run'), { main: true })
  await removalController(ctx, agent)
  const edit = ctx.configEditor.edit.bind(ctx.configEditor)
  let calls = 0
  ctx.configEditor.edit = async (...args) => {
    if (++calls === 2) {
      agent.followup(message('arrived from another native window during removal'))
      await agent.whenIdle()
      assert.equal(requests.length, 0)
    }
    return edit(...args)
  }
  const before = git(ws, 'rev-parse', 'HEAD')
  await ctx.mbot.removeBot(bot.botId)
  ctx.configEditor.edit = edit
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'retired')
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), before)
  assert.equal(await lstat(join(ws, '.mbot/runs/active-turn.json')).then(() => true, error => {
    assert.equal(error.code, 'ENOENT'); return false
  }), false)
})

test('bound removal refuses foreign writers or mismatched Session ownership and retires failed reservations', { timeout: 30000 }, async t => {
  const { ctx, bot, agent } = await app(t, () => response('must not run'), { main: true })
  let result = { error: Object.assign(new Error('foreign writer-held'), { code: 'session/writer-held' }) }
  await removalController(ctx, agent, async () => result)
  const before = ctx.mbot.registry()
  await assert.rejects(ctx.mbot.removeBot(bot.botId), /writer-held/u)
  assert.deepEqual(ctx.mbot.registry(), before)
  result = { agent: { id: agent.id, session: { header: { cwd: '/tmp/foreign-directory' } } } }
  await assert.rejects(ctx.mbot.removeBot(bot.botId), /ownership/u)
  assert.deepEqual(ctx.mbot.registry(), before)
  const { editor, entry } = ctx.mbot.configurationEntry()
  // A failed reservation retains its original ID; it never creates a replacement.
  // Convert a ready binding only within this fixture's already trusted initial state.
  const registration = ctx.mbot.bot({ botId: bot.botId })
  await editor.edit(entry, current => ({ ...current, registry: { ...current.registry,
    revision: current.registry.revision + 1, bots: [{ ...registration, mainSessionId: null,
      binding: { state: 'failed', pendingSessionId: agent.id, error: 'injected setup failure' } }] } }))
  result = { agent }
  const retired = await ctx.mbot.removeBot(bot.botId)
  assert.equal(retired.bot.binding.state, 'failed')
  assert.deepEqual(retired.sessionIds, [agent.id])
})

test('cold removal verifies native ownership without restoring missing Bot data and releases failed-save claims', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, handle, owner, requests } = await app(t, () => response('retain the original audit'), { main: true, persistence: true })
  agent.followup(message('one audited conversation'))
  await settle(ctx, agent)
  await handle.dispose()
  await owner.dispose()
  await ctx.plugin(runtime)
  const before = ctx.mbot.registry(), head = git(ws, 'rev-parse', 'HEAD')
  const log = await ctx.sessionQuery.readSession(agent.id)
  const writer = await ctx.sessionPersistence.open(agent.id, 'write')
  try {
    await assert.rejects(ctx.mbot.removeBot(bot.botId), /already owned|writer-held/u)
    assert.deepEqual(ctx.mbot.registry(), before)
  } finally { await writer.close() }
  const offline = `${ws}.offline`
  await rename(ws, offline)
  try {
    const edit = ctx.configEditor.edit.bind(ctx.configEditor)
    let calls = 0
    ctx.configEditor.edit = async (...args) => {
      if (++calls === 2) throw new Error('cold retirement save failed')
      return edit(...args)
    }
    await assert.rejects(ctx.mbot.removeBot(bot.botId), /save failed/u)
    ctx.configEditor.edit = edit
    assert.deepEqual(ctx.mbot.registry(), before)
    const released = await ctx.sessionPersistence.open(agent.id, 'write')
    await released.close()
    const retired = await ctx.mbot.removeBot(bot.name)
    assert.deepEqual(retired.sessionIds, [agent.id])
    assert.equal(ctx.agents.get(agent.id), undefined, 'Retirement must not create or resume an executable Agent')
    assert.deepEqual((await ctx.sessionQuery.readSession(agent.id)).events, log.events, 'Native history and checkpoint evidence must remain unchanged')
    assert.equal(git(offline, 'rev-parse', 'HEAD'), head)
    assert.equal(requests.length, 1)
    const passive = await ctx.agents.resume({ resumeSessionId: agent.id, agentOptions: { provider: 'runtime-test', model: 'scripted' } })
    assert.equal((await ctx.mbotRuntime.status(passive.agent)).state, 'retired')
    passive.agent.followup(message('must stay retired even with missing data'))
    await passive.agent.whenIdle()
    assert.equal(requests.length, 1)
  } finally { await rename(offline, ws) }
})

test('cold retirement refuses a foreign Session header and blocks activation of a missing reservation during save', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests } = await app(t, () => response('must not execute'), { persistence: true })
  const otherPath = join(root, `cold removal identity ${++sequence}`)
  assert.equal((await ctx.mbot.execute('mbot', ['init'], { workspace: otherPath })).exitCode, 0)
  const other = await ctx.mbot.importBot(otherPath)
  const foreignId = `foreign-retirement-${++sequence}`
  const foreign = await ctx.sessionPersistence.create({ ...agent.session.header, id: foreignId, cwd: ws })
  await foreign.flush()
  await foreign.close()
  const entry = ctx.configEditor.entries()[0]
  await ctx.configEditor.edit(entry, current => ({ ...current, registry: { ...current.registry,
    revision: current.registry.revision + 1,
    bots: current.registry.bots.map(bot => bot.botId !== other.botId ? bot : { ...bot,
      binding: { state: 'failed', pendingSessionId: foreignId, error: 'foreign reserved Session' } }),
  } }))
  const before = ctx.mbot.registry()
  await assert.rejects(ctx.mbot.removeBot(other.botId), /ownership/u)
  assert.deepEqual(ctx.mbot.registry(), before)
  const claim = await ctx.sessionPersistence.open(foreignId, 'write')
  await claim.close()

  const absentPath = join(root, `absent removal identity ${++sequence}`)
  assert.equal((await ctx.mbot.execute('mbot', ['init'], { workspace: absentPath })).exitCode, 0)
  const absent = await ctx.mbot.importBot(absentPath), absentId = `absent-retirement-${++sequence}`
  await ctx.configEditor.edit(entry, current => ({ ...current, registry: { ...current.registry,
    revision: current.registry.revision + 1,
    bots: current.registry.bots.map(bot => bot.botId !== absent.botId ? bot : { ...bot,
      binding: { state: 'failed', pendingSessionId: absentId, error: 'missing reserved Session' } }),
  } }))
  const edit = ctx.configEditor.edit.bind(ctx.configEditor)
  let calls = 0
  ctx.configEditor.edit = async (...args) => {
    if (++calls === 2) await assert.rejects(ctx.agents.create({ sessionId: absentId, meta: { cwd: absentPath },
      agentOptions: { provider: 'runtime-test', model: 'scripted' } }), /removal is in progress/u)
    return edit(...args)
  }
  try { assert.deepEqual((await ctx.mbot.removeBot(absent.botId)).sessionIds, [absentId]) }
  finally { ctx.configEditor.edit = edit }
  assert.equal(ctx.agents.get(absentId), undefined)
  assert.equal(requests.length, 0)
})

const privateRoute = { visibility: 'owner-private', adapterId: 'test-tg', ownerId: 'verified-owner', conversationKey: 'private-chat', replyRoute: 'chat:owner' }
const mainMailbox = (ctx, agent, changes = {}) => ctx.mbotRuntime.ownerMailbox(agent, { ...privateRoute, ...changes })

async function failedRuntime(t, options = {}) {
  const fixture = await app(t, options.script ?? (() => response('recover this native answer')), { ...options.fixture, main: true })
  await removalController(fixture.ctx, fixture.agent)
  await options.prepare?.(fixture)
  const spawn = fixture.ctx.subprocess.spawn.bind(fixture.ctx.subprocess)
  const shim = join(root, `runtime-recovery-shim-${++sequence}`)
  await mkdir(shim)
  const executable = options.crash === 'settlement' ? 'rm' : 'git'
  const matches = options.crash === 'settlement'
    ? 'for arg do case "$arg" in */active-turn.json) crash=1 ;; esac; done'
    : 'for arg do [ "$arg" != commit ] || crash=1; done'
  const script = options.crash
    ? '#!/bin/sh\ncrash=0\n'+matches+'\n'+(executable === 'git' ? '/usr/bin/git "$@" || exit $?\n' : '')
      +'if [ "$crash" = 1 ]; then kill -KILL "$PPID"; exit 143; fi\n'+(executable === 'rm' ? 'exec /usr/bin/rm "$@"\n' : '')
    : '#!/bin/sh\nfor arg do\n  if [ "$arg" = commit ]; then exit 1; fi\ndone\nexec /usr/bin/git "$@"\n'
  await writeFile(join(shim, executable), script)
  await chmod(join(shim, executable), 0o700)
  fixture.ctx.subprocess.spawn = spec => spec.argv[0].endsWith('/bin/mbot-turn')
    ? spawn({ ...spec, env: { ...spec.env, PATH: `${shim}:${spec.env.PATH}` } }) : spawn(spec)
  await mainMailbox(fixture.ctx, fixture.agent).send({ requestId: 'runtime-recover-request', text: 'audit interrupted' })
  await fixture.agent.whenIdle()
  await assert.rejects(fixture.ctx.mbotRuntime.settled(fixture.agent))
  fixture.ctx.subprocess.spawn = spawn
  const journal = JSON.parse(await readFile(join(fixture.ws, '.mbot/runs/active-turn.json'), 'utf8'))
  return { ...fixture, journal, mailbox: mainMailbox(fixture.ctx, fixture.agent) }
}

function workerRecoveryScript({ fault = false } = {}) {
  const steps = new Map()
  return (request, _n, ctx) => {
    const n = (steps.get(request.sessionId) ?? 0) + 1
    steps.set(request.sessionId, n)
    if (request.sessionId.startsWith('mbot-worker-')) return n === 1
      ? response('', { name: 'botctl', args: { action: 'boot', bot: 'coder', task_id: '001' } })
      : n === 2 ? response('', { name: 'botctl', args: { action: 'task_result', task_id: fault ? '002' : '001', text: 'recoverable native Worker result' } }) : response('Worker complete before audit')
    return n === 1 ? response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } })
      : n === 2 ? response('', { name: 'botctl', args: { action: 'worker_wait', worker_id: membersOf(ctx, ctx.agents.get(request.sessionId))[0].id } }) : response('parent Worker audit answer')
  }
}

test('Worker recovery verifies native child history and settles a failed parent commit once', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, journal, mailbox, requests } = await failedRuntime(t, { fixture: { workers: true, persistence: true },
    script: workerRecoveryScript(), prepare: fixture => workerTasks(fixture.ctx) })
  const count = requests.length, base = git(ws, 'rev-parse', 'HEAD')
  assert.equal(journal.schemaVersion, 3)
  const recovered = await recoverNativeTurn(ctx, { botId: bot.botId })
  assert.equal(recovered.success, true)
  assert.equal(recovered.outcome, 'completed')
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal(requests.length, count, 'Native closers must not invoke a Worker model')
  assert.equal(ctx.agents.get(journal.actors[0].sessionId), undefined)
  const receipt = await mailbox.receipt('runtime-recover-request')
  assert.equal(receipt.result.final, true)
  assert.equal(receipt.result.reply.text, 'parent Worker audit answer')
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).needed, false)
  assert.equal(await accessPaused(ws), true)
})

async function accessPaused(ws) { return lstat(join(ws, '.mbot/PAUSED')).then(() => true, () => false) }

test('Worker recovery refuses a competing native child writer and preserves its original journal', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, journal } = await failedRuntime(t, { fixture: { workers: true, persistence: true },
    script: workerRecoveryScript(), prepare: fixture => workerTasks(fixture.ctx) })
  const before = await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8')
  const writer = await ctx.sessionPersistence.open(journal.actors[0].sessionId, 'write')
  try {
    await assert.rejects(recoverNativeTurn(ctx, { botId: bot.botId }), /writer|owned|claim|locked/iu)
    assert.equal(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'), before)
    assert.equal(ctx.mbotRuntime.recoveries.size, 0)
  } finally { await writer.close() }
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).success, true)
})

for (const crash of ['commit', 'settlement']) {
  test(`Worker recovery settles the existing parent audit once after SIGKILL at ${crash}`, { timeout: 30000 }, async t => {
    const { ctx, ws, bot, journal, mailbox, requests } = await failedRuntime(t, { crash, fixture: { workers: true, persistence: true },
      script: workerRecoveryScript(), prepare: fixture => workerTasks(fixture.ctx) })
    const committed = git(ws, 'rev-parse', 'HEAD'), count = requests.length
    assert.equal((await mailbox.receipt('runtime-recover-request')).result.final, false)
    const recovered = await recoverNativeTurn(ctx, { botId: bot.botId })
    assert.equal(recovered.alreadyCommitted, true)
    assert.equal(recovered.runId, journal.runId)
    assert.equal(git(ws, 'rev-parse', 'HEAD'), committed)
    assert.equal((await mailbox.receipt('runtime-recover-request')).result.final, true)
    assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).needed, false)
    assert.equal(requests.length, count)
  })
}

test('Worker recovery rejects changed private child events before restoring Git data', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, journal } = await failedRuntime(t, { fixture: { workers: true, persistence: true },
    script: workerRecoveryScript(), prepare: fixture => workerTasks(fixture.ctx) })
  const file = join(journal.scratch, `actor-${journal.actors[0].actorId}.events.jsonl`)
  const original = await readFile(file, 'utf8'), base = git(ws, 'rev-parse', 'HEAD')
  const rows = original.trim().split('\n').map(line => JSON.parse(line))
  rows[0].type = 'plugin:tampered-worker'
  await writeFile(file, rows.map(row => JSON.stringify(row)+'\n').join(''))
  await assert.rejects(recoverNativeTurn(ctx, { botId: bot.botId }), /Private Worker events contradict/u)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  assert.equal(ctx.mbotRuntime.recoveries.size, 0)
  await writeFile(file, original)
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).success, true)
})

test('Worker recovery refuses a live process holding a derived Actor token', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, journal } = await failedRuntime(t, { fixture: { workers: true, persistence: true },
    script: workerRecoveryScript(), prepare: fixture => workerTasks(fixture.ctx) })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, DSH_MBOT_PERMIT_TOKEN: journal.actors[0].token }, stdio: 'ignore' })
  const exit = new Promise(resolve => child.once('exit', resolve))
  t.after(() => child.kill('SIGKILL'))
  const base = git(ws, 'rev-parse', 'HEAD')
  await assert.rejects(recoverNativeTurn(ctx, { botId: bot.botId }), /permit-bearing process/u)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  child.kill('SIGKILL')
  await exit
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).success, true)
})

test('Worker v3 receipt repair confirms child failure without repeating the committed audit', { timeout: 30000 }, async t => {
  const script = workerRecoveryScript({ fault: true })
  const { ctx, ws, bot, agent } = await app(t, script, { workers: true, main: true, persistence: true })
  await workerTasks(ctx, 2)
  await removalController(ctx, agent)
  const mailbox = mainMailbox(ctx, agent)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let failed = false
  ctx.sessions.flush = async session => {
    const state = ctx.mbotRuntime.states.get(agent)
    if (!failed && session === agent.session && state?.lastReceipt?.phase === 'rejected') { failed = true; throw new Error('Worker receipt flush failed') }
    return flush(session)
  }
  await mailbox.send({ requestId: 'worker-flush', text: 'complete Worker work' })
  await agent.whenIdle()
  await assert.rejects(ctx.mbotRuntime.settled(agent), /receipt flush failed/u)
  const committed = git(ws, 'rev-parse', 'HEAD')
  ctx.sessions.flush = flush
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).receiptRepaired, true)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), committed)
  const receipt = await mailbox.receipt('worker-flush')
  assert.equal(receipt.result.final, true)
  assert.equal(receipt.result.status, 'failed')
})

test('a different Runtime module recovers the original Worker audit and preserves the main Session', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, owner, requests } = await failedRuntime(t, { fixture: { workers: true, persistence: true },
    script: workerRecoveryScript(), prepare: fixture => workerTasks(fixture.ctx) })
  const original = agent.id, count = requests.length, base = git(ws, 'rev-parse', 'HEAD')
  await owner.dispose()
  await ctx.plugin(await replacementRuntime(), { workers: true })
  assert.equal(ctx.agents.get(original), agent)
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).success, true)
  assert.equal(requests.length, count)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'idle')
})

test('Runtime module handoff waits for the owning Worker data writer and its parent audit', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), cancelled = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { ctx, ws, agent, owner } = await app(t, workerRecoveryScript(), { workers: true, main: true, persistence: true })
  await workerTasks(ctx)
  const execute = ctx.mbot.execute.bind(ctx.mbot)
  ctx.mbot.execute = async (program, args, options) => {
    if (args[0] === 'task' && args[1] === 'result' && options?.permit) {
      entered.resolve()
      await new Promise(resolve => options.signal.aborted ? resolve() : options.signal.addEventListener('abort', resolve, { once: true }))
      cancelled.resolve()
      await release.promise
      return execute(program, args, { ...options, signal: undefined })
    }
    return execute(program, args, options)
  }
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('replace Runtime while Worker writes'))
  await entered.promise
  const member = membersOf(ctx, agent)[0], old = ctx.mbotRuntime
  agent.inbox.splice('next-turn', 0, 0, [message('preserve this pending turn')])
  const replacement = await replacementRuntime()
  const disposing = owner.dispose()
  await cancelled.promise
  let activated = false
  const next = ctx.plugin(replacement, { workers: true })
  const starting = Promise.resolve(next).then(() => { activated = true })
  await delay(30)
  assert.equal(activated, false)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  release.resolve()
  await disposing
  await starting
  assert.notEqual(ctx.mbotRuntime, old)
  assert.equal(ctx.agents.get(agent.id), agent)
  assert.equal(ctx.agents.get(member.id), undefined)
  assert.equal(member.actor.closed, true)
  assert.equal(member.done, true, member.error?.stack)
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.phase, 'rejected')
})

test('a native Worker released before sealing cannot be cold-resumed by a creator correction', { timeout: 30000 }, async t => {
  const modelEntered = Promise.withResolvers(), releaseModel = Promise.withResolvers(), sealEntered = Promise.withResolvers(), releaseSeal = Promise.withResolvers()
  t.after(() => { releaseModel.resolve(); releaseSeal.resolve() })
  const script = workerRecoveryScript()
  const { ctx, agent, requests } = await app(t, async (request, n, ctx) => {
    if (request.sessionId.startsWith('mbot-worker-') && requestsForWorker(ctx, request.sessionId)) {
      modelEntered.resolve(); await releaseModel.promise
    }
    return script(request, n, ctx)
  }, { workers: true, main: true, persistence: true })
  function requestsForWorker(ctx, id) { return ctx.mbotRuntime.workerManager.members.get(id)?.state.booted === true }
  await workerTasks(ctx)
  agent.followup(message('correct a Worker at its release boundary'))
  await modelEntered.promise
  const member = membersOf(ctx, agent)[0], seal = member.actor.sealNative.bind(member.actor)
  member.actor.sealNative = async input => { sealEntered.resolve(); await releaseSeal.promise; return seal(input) }
  releaseModel.resolve()
  await sealEntered.promise
  assert.equal(ctx.agents.get(member.id), undefined)
  assert.equal(member.done, false)
  const before = requests.length
  await assert.rejects(ctx.mbotRuntime.workerAction(agent, 'worker_message', { worker_id: member.id, text: 'late creator correction' }, new AbortController().signal), /already ended/u)
  assert.equal(requests.length, before)
  releaseSeal.resolve()
  await settle(ctx, agent)
  assert.equal(member.done, true)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'completed')
})

test('replacing the fresh provider preserves an owned Worker and new admissions use the replacement', { timeout: 30000 }, async t => {
  const parentEntered = Promise.withResolvers(), release = Promise.withResolvers(), children = new Set(), steps = new Map()
  t.after(() => release.resolve())
  const { ctx, agent, workerProvider } = await app(t, async (request, _n, ctx) => {
    const n = (steps.get(request.sessionId) ?? 0) + 1
    steps.set(request.sessionId, n)
    if (request.sessionId.startsWith('mbot-worker-')) {
      const task = ctx.mbotRuntime.workerManager.members.get(request.sessionId).actor.identity.taskId
      if (n === 1) return response('', { name: 'botctl', args: { action: 'boot', bot: 'coder', task_id: task } })
      children.add(request.sessionId)
      await release.promise
      return response(`provider Worker ${task} finished`)
    }
    if (n === 1) return response('', { name: 'botctl', args: { action: 'worker_spawn', bot: 'coder', task_id: '001' } })
    parentEntered.resolve()
    await release.promise
    return response('both provider generations joined')
  }, { workers: true, main: true, persistence: true })
  await workerTasks(ctx, 2)
  agent.followup(message('replace the Worker provider'))
  await parentEntered.promise
  const first = membersOf(ctx, agent)[0], old = ctx.subagents.getProvider('spawn')
  while (!children.has(first.id)) await delay(10)
  await workerProvider.dispose()
  assert.equal(ctx.subagents.getProvider('spawn'), undefined)
  assert.equal(first.controller.signal.aborted, false, 'Native provider removal does not dispose accepted activations')
  await ctx.plugin(SpawnProvider)
  assert.notEqual(ctx.subagents.getProvider('spawn'), old)
  const second = await ctx.mbotRuntime.workerAction(agent, 'worker_spawn', { bot: 'coder', task_id: '002' }, new AbortController().signal)
  while (!children.has(second.worker_id)) await delay(10)
  release.resolve()
  await settle(ctx, agent)
  assert.equal(first.done, true)
  assert.equal(ctx.agents.get(second.worker_id), undefined)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'completed')
})

test('failed Worker recovery retries derived inputs and rejects edits to its recovery ledger', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, journal } = await failedRuntime(t, { fixture: { workers: true, persistence: true },
    script: workerRecoveryScript(), prepare: fixture => workerTasks(fixture.ctx) })
  const shim = await mkdtemp(join(root, 'worker-recovery-commit.'))
  await writeFile(join(shim, 'git'), '#!/bin/sh\nfor arg do\n  if [ "$arg" = commit ]; then exit 1; fi\ndone\nexec /usr/bin/git "$@"\n')
  await chmod(join(shim, 'git'), 0o700)
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess), base = git(ws, 'rev-parse', 'HEAD')
  ctx.subprocess.spawn = spec => spec.argv[0].endsWith('/bin/mbot') && spec.argv.at(-1) === 'recover'
    ? spawn({ ...spec, env: { ...spec.env, PATH: `${shim}:${spec.env.PATH}` } }) : spawn(spec)
  await assert.rejects(recoverNativeTurn(ctx, { botId: bot.botId }), /commit failed/u)
  ctx.subprocess.spawn = spawn
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  const file = join(journal.scratch, 'runtime-recovery.ledger.json'), original = await readFile(file, 'utf8')
  const changed = JSON.parse(original)
  changed.actors[0].native.usage.total_tokens++
  await writeFile(file, JSON.stringify(changed))
  await assert.rejects(recoverNativeTurn(ctx, { botId: bot.botId }), /Derived Worker recovery ledger changed/u)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  await writeFile(file, original)
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).success, true)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
})

test('Worker audit helpers preserve UTF-8 when stdin splits inside a Chinese context character', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent } = await app(t, workerRecoveryScript(), { workers: true, main: true, persistence: true })
  await workerTasks(ctx)
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'worker-utf8', text: 'audit the Chinese Worker context' })
  await settle(ctx, agent)
  const log = await ctx.sessionQuery.readSession(agent.id), index = new MessageIndex()
  for (const event of log.events) index.apply(event, log.inheritedEventCount)
  const record = [...index.requests.values()].find(item => item.message.source.mbot?.requestId === 'worker-utf8')
  const turn = index.turns.get(record.turn)
  const events = log.events.filter(event => event.seq >= turn.startSeq && event.seq <= turn.endSeq && contextAuditEvent(event))
  const workers = await ctx.mbotRuntime.workerLogs(events), current = ctx.mbotRuntime.states.get(agent).current
  const payload = Buffer.from(JSON.stringify({ workspace: ws, botId: bot.botId, sessionId: agent.id, record, turn, events, workers,
    confirmation: 'confirmed', result: current.result, header: { botId: bot.botId, sessionId: agent.id, turn: current.turn,
      writerScope: 'agent-runtime', messages: current.messages } }))
  const cut = payload.lastIndexOf(Buffer.from('工作区协议')) + 1
  assert.ok(cut > 1)
  for (const args of [['bin/turn-receipt.mjs'], ['bin/turn-runtime-recovery.mjs', '--audit-input']]) {
    const child = spawn(process.execPath, args, { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'pipe' })
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    let stdout = '', stderr = ''
    child.stdout.on('data', text => { stdout += text }); child.stderr.on('data', text => { stderr += text })
    const ended = new Promise(resolve => child.once('exit', resolve))
    await new Promise((resolve, reject) => child.stdin.write(payload.subarray(0, cut), error => error ? reject(error) : resolve()))
    await delay(100)
    child.stdin.end(payload.subarray(cut))
    assert.equal(await ended, 0, stderr)
    if (args.length === 1) assert.equal(JSON.parse(stdout).final, true, stdout)
  }
})

test('native Worker repair proves an assistant tool request interrupted before its dispatch', { timeout: 30000 }, async t => {
  const { ctx, agent } = await app(t, workerRecoveryScript(), { workers: true, main: true, persistence: true })
  await workerTasks(ctx)
  agent.followup(message('capture the native Worker tool request boundary'))
  await settle(ctx, agent)
  const member = membersOf(ctx, agent)[0], log = await ctx.sessionQuery.readSession(member.id)
  const request = log.events.find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call'))
  const prefix = log.events.filter(event => event.seq <= request.seq)
  const repaired = [...prefix, ...interruptedTurnClosers(prefix)]
  const actor = { ...member.actor.identity, snapshotHash: createHash('sha256').update(JSON.stringify(member.actor.snapshot)).digest('hex') }
  const input = { quiescent: true, startupFailed: false, session: log.session, inheritedEventCount: 0,
    initialMessageId: member.initialMessageId, parentSessionId: actor.parentSessionId, runId: actor.runId, result: workerCompletion(repaired) }
  const proof = workerProof(actor, member.actor.snapshot, repaired, input, { workerTools: ['botctl'] })
  assert.equal(proof.executionFault, true)
  assert.equal(proof.stopReason, 'aborted')
  const wrong = structuredClone(repaired)
  wrong.find(event => event.type === 'tool/result').data.error.code = 'TOOL_OUTCOME_UNKNOWN'
  assert.throws(() => workerProof(actor, member.actor.snapshot, wrong, input, { workerTools: ['botctl'] }), /no matching dispatch/u)
})

test('native task Workers are enabled by default and clean Chief turns can finish without delegation', { timeout: 30000 }, async t => {
  const { ctx, agent } = await app(t, request => {
    assert.ok(JSON.stringify(request.tools).includes('worker_spawn'))
    return response('default Worker contract is available')
  }, { workers: true, main: true, persistence: true, defaultWorkers: true })
  agent.followup(message('inspect the default Worker capability'))
  await settle(ctx, agent)
  assert.equal(ctx.mbotRuntime.workersEnabled, true)
  assert.equal(ctx.mbotRuntime.states.get(agent).current.lease.runtimeOwnership.schemaVersion, 2)
  const log = await ctx.sessionQuery.readSession(agent.id)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'completed', JSON.stringify(log.events.filter(event => event.type === 'turn/end').map(event => event.data.reason)))
})

test('Runtime recovery joins the native owner, commits the saved answer once and preserves PAUSED and pending work', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, requests, journal, mailbox } = await failedRuntime(t)
  const base = git(ws, 'rev-parse', 'HEAD')
  const input = message('pending work must not execute during recovery')
  agent.inbox.splice('next-turn', 0, 0, [input])
  const recovered = await recoverNativeTurn(ctx, { botId: bot.botId })
  assert.equal(recovered.needed, true)
  assert.equal(recovered.alreadyCommitted, false)
  assert.equal(recovered.success, true)
  assert.equal(recovered.runId, journal.runId)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '0\n')
  assert.ok(await lstat(join(ws, '.mbot/PAUSED')))
  assert.equal(agent.inbox.nextTurn[0].id, input.id)
  assert.equal(requests.length, 1)
  const receipt = await mailbox.receipt('runtime-recover-request')
  assert.equal(receipt.result.final, true)
  assert.equal(receipt.result.reply.text, 'recover this native answer')
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.head, recovered.head)
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).needed, false)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal((await ctx.mbot.execute('mbot', ['resume'], { botId: bot.botId })).exitCode, 0)
  agent.followup(message('resume after review'))
  await settle(ctx, agent)
  assert.equal(requests.length, 3)
})

test('Runtime recovery rejects altered native completion and releases the gate without changing its journal', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, journal, requests } = await failedRuntime(t)
  const finishFile = join(journal.scratch, 'finish.json')
  const original = await readFile(finishFile, 'utf8')
  const finish = JSON.parse(original)
  await writeFile(finishFile, JSON.stringify({ ...finish, text: 'forged native answer' }))
  const before = await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8')
  await assert.rejects(recoverNativeTurn(ctx, { botId: bot.botId }), /completion contradicts/u)
  assert.equal(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'), before)
  assert.equal(ctx.mbotRuntime.recoveries.size, 0)
  assert.equal(requests.length, 1)
  await writeFile(finishFile, original)
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).success, true)
})

test('Runtime recovery after reload uses the persisted foreground contract and holds native input before its proof flush', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, journal, requests, owner } = await failedRuntime(t)
  assert.equal(journal.runtimeOwnership.mode, 'foreground-only')
  await owner.dispose()
  await ctx.plugin(runtime)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let injected = false
  ctx.sessions.flush = async session => {
    if (!injected && ctx.mbotRuntime.recoveries.has(bot.botId)) {
      injected = true
      assert.equal((await ctx.mbotRuntime.status(agent)).state, 'recovering')
      agent.followup(message('another window during recovery'))
      await agent.whenIdle()
      assert.equal(requests.length, 1)
    }
    return flush(session)
  }
  const recovered = await recoverNativeTurn(ctx, { botId: bot.botId })
  ctx.sessions.flush = flush
  assert.equal(recovered.success, true)
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal(ctx.mbotRuntime.recoveries.size, 0)
  assert.equal((await mainMailbox(ctx, agent).receipt('runtime-recover-request')).result.final, true)
  assert.ok(await lstat(join(ws, '.mbot/PAUSED')))
})

test('Runtime recovery of a retired Bot preserves its old gate and allows later data import', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, journal, requests } = await failedRuntime(t)
  await ctx.mbot.removeBot(bot.botId)
  const recovered = await recoverNativeTurn(ctx, { botId: bot.botId })
  assert.equal(recovered.runId, journal.runId)
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'retired')
  assert.equal(requests.length, 1)
  const imported = await ctx.mbot.importBot(ws)
  assert.notEqual(imported.botId, bot.botId)
  await assert.rejects(ctx.mbotRuntime.attach(agent, { botId: imported.botId }), /redirected/u)
})

test('Runtime recovery repairs a failed native receipt without repeating its Git commit, even after a blocked wake', { timeout: 30000 }, async t => {
  let modelEntered = false
  const { ctx, ws, bot, agent, requests } = await app(t, () => { modelEntered = true; return response('committed before a flush failure') }, { main: true })
  await removalController(ctx, agent)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let failed = false
  ctx.sessions.flush = async session => {
    if (modelEntered && !failed) { failed = true; throw new Error('injected native receipt failure') }
    return flush(session)
  }
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'repair-native-receipt', text: 'commit but fail native flush' })
  await agent.whenIdle()
  await assert.rejects(ctx.mbotRuntime.settled(agent))
  const committed = git(ws, 'rev-parse', 'HEAD')
  const queued = message('blocked later wake')
  agent.followup(queued)
  await agent.whenIdle()
  assert.equal(requests.length, 1)
  ctx.sessions.flush = flush
  const repaired = await recoverNativeTurn(ctx, { botId: bot.botId })
  assert.equal(repaired.receiptRepaired, true)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), committed)
  assert.equal(agent.inbox.nextTurn[0].id, queued.id)
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'idle')
  assert.equal((await mailbox.receipt('repair-native-receipt')).result.final, true)
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).needed, false)
})

test('Runtime recovery can retry a flush failure after its own successful Git settlement', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, mailbox } = await failedRuntime(t)
  const base = git(ws, 'rev-parse', 'HEAD')
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let failed = false
  ctx.sessions.flush = async session => {
    if (!failed && ctx.mbotRuntime.recoveries.has(bot.botId) && ctx.mbotRuntime.states.get(agent).lastReceipt.head) {
      failed = true
      throw new Error('injected post-recovery flush failure')
    }
    return flush(session)
  }
  await assert.rejects(recoverNativeTurn(ctx, { botId: bot.botId }), /awaits native receipt/u)
  ctx.sessions.flush = flush
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'failed')
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).receiptRepaired, true)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal((await mailbox.receipt('runtime-recover-request')).result.final, true)
})

for (const crash of ['commit', 'settlement']) {
  test(`Runtime recovery settles the original Git commit once after SIGKILL at ${crash}`, { timeout: 30000 }, async t => {
    const { ctx, ws, bot, journal, mailbox, requests } = await failedRuntime(t, { crash })
    const committed = git(ws, 'rev-parse', 'HEAD')
    assert.equal((await mailbox.receipt('runtime-recover-request')).result.final, false)
    const recovered = await recoverNativeTurn(ctx, { botId: bot.botId })
    assert.equal(recovered.alreadyCommitted, true)
    assert.equal(recovered.runId, journal.runId)
    assert.equal(recovered.success, true)
    assert.equal(git(ws, 'rev-parse', 'HEAD'), committed)
    assert.equal((await mailbox.receipt('runtime-recover-request')).result.final, true)
    assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).needed, false)
    assert.equal(git(ws, 'rev-parse', 'HEAD'), committed)
    assert.equal(requests.length, 1)
  })
}

test('Runtime recovery supports a legacy header only with its captured live owner and does not fabricate reply proof', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, journal, mailbox } = await failedRuntime(t)
  const headerFile = join(journal.scratch, 'header.json')
  const header = JSON.parse(await readFile(headerFile, 'utf8'))
  delete header.messages
  delete header.runtimeOwnership
  delete journal.runtimeOwnership
  await writeFile(headerFile, JSON.stringify(header))
  await writeFile(join(journal.scratch, 'ledger.json'), JSON.stringify(journal))
  await writeFile(join(ws, '.mbot/runs/active-turn.json'), JSON.stringify(journal))
  const result = await recoverNativeTurn(ctx, { botId: bot.botId })
  assert.equal(result.success, true)
  const meta = JSON.parse(await readFile(join(ws, result.meta), 'utf8'))
  assert.equal(meta.runtime.recovered, true)
  assert.equal(meta.runtime.reply, undefined)
  const receipt = await mailbox.receipt('runtime-recover-request')
  assert.equal(receipt.result.final, false)
  assert.equal(receipt.result.reply, undefined)
})

test('Runtime recovery rejects unsupported cold ownership contracts and native writer-held before touching data', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, journal, agent, owner } = await failedRuntime(t)
  const resolve = ctx.sessionController.resolveAgent.bind(ctx.sessionController)
  ctx.sessionController.resolveAgent = async () => ({ error: Object.assign(new Error('other Host owns the native writer'), { code: 'session/writer-held' }) })
  const before = await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8')
  await assert.rejects(recoverNativeTurn(ctx, { botId: bot.botId }), /other Host/u)
  assert.equal(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'), before)
  assert.equal(ctx.mbotRuntime.recoveries.size, 0)
  ctx.sessionController.resolveAgent = resolve
  await owner.dispose()
  // This cold-loss fixture retains native events but intentionally loses the
  // process-local handoff. Warm ESM replacement is covered separately.
  runtimeCells.get(agent).handoff = undefined
  await ctx.plugin(runtime)
  const headerFile = join(journal.scratch, 'header.json')
  const header = JSON.parse(await readFile(headerFile, 'utf8'))
  const bad = { ...journal, runtimeOwnership: { ...journal.runtimeOwnership, workerDepth: 1 } }
  await writeFile(headerFile, JSON.stringify({ ...header, runtimeOwnership: bad.runtimeOwnership }))
  await writeFile(join(journal.scratch, 'ledger.json'), JSON.stringify(bad))
  await writeFile(join(ws, '.mbot/runs/active-turn.json'), JSON.stringify(bad))
  const changed = await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8')
  await assert.rejects(recoverNativeTurn(ctx, { botId: bot.botId }), /Unsupported Runtime writer ownership/u)
  assert.equal(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'), changed)
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'idle')
})

test('Runtime recovery refuses a still live permit-bearing subprocess', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, journal } = await failedRuntime(t)
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
    env: { ...process.env, DSH_MBOT_PERMIT_TOKEN: journal.token }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ended = new Promise(resolve => child.once('exit', resolve))
  t.after(async () => { child.kill(); await ended })
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) })
  const before = git(ws, 'rev-parse', 'HEAD')
  await assert.rejects(recoverNativeTurn(ctx, { botId: bot.botId }), /permit-bearing process/u)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), before)
  assert.ok(await lstat(join(ws, '.mbot/runs/active-turn.json')))
  child.kill()
  await ended
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).success, true)
})

test('Runtime recovery refuses an executing Agent without cancelling it', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { ctx, bot, agent } = await app(t, async () => { entered.resolve(); await release.promise; return response('live turn settled normally') }, { main: true })
  await removalController(ctx, agent)
  agent.followup(message('do not interrupt this active turn'))
  await entered.promise
  await assert.rejects(recoverNativeTurn(ctx, { botId: bot.botId }), /still executing/u)
  assert.equal(ctx.mbotRuntime.states.get(agent).current.signal.aborted, false)
  release.resolve()
  await settle(ctx, agent)
})

test('cold legacy readonly recovery proves the native tool contract and refuses incomplete or unknown dispatches', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, journal, owner } = await failedRuntime(t, { script: (_options, n) => n === 1
    ? response('', { name: 'botctl', args: { action: 'boot', bot: 'chief' } })
    : n === 2 ? response('', { name: 'botctl', args: { action: 'board_show' } }) : response('legacy readonly response') })
  const headerFile = join(journal.scratch, 'header.json')
  const header = JSON.parse(await readFile(headerFile, 'utf8'))
  delete header.messages
  delete header.runtimeOwnership
  delete journal.runtimeOwnership
  await writeFile(headerFile, JSON.stringify(header))
  await writeFile(join(journal.scratch, 'ledger.json'), JSON.stringify(journal))
  await writeFile(join(ws, '.mbot/runs/active-turn.json'), JSON.stringify(journal))
  const input = await recoveryInput(journal, await ctx.sessionQuery.readSession(agent.id))
  assert.deepEqual(readonlyLegacy(journal, input).tools.map(tool => tool.action), ['boot', 'board_show'])
  for (const mutate of [
    value => { value.events.find(event => event.type === 'tool/call').data.arguments = JSON.stringify({ action: 'remember', text: 'writer' }) },
    value => { value.events = value.events.filter(event => event.type !== 'tool/result') },
    value => { value.events = value.events.filter(event => event.type !== 'request/header') },
    value => { value.events.find(event => event.type === 'tool/call').data.name = 'bash' },
    value => { value.events.find(event => event.type === 'tool/result').data.message.isError = true },
    value => { value.events.find(event => event.type === 'tool/call').data.turn = journal.turn + 1 },
  ]) {
    const changed = structuredClone(input); mutate(changed)
    assert.throws(() => readonlyLegacy(journal, changed), /readonly|writer|unknown|contract|boundary/u)
  }
  await owner.dispose()
  runtimeCells.get(agent).handoff = undefined // emulate cold process loss, not a warm reload
  await ctx.plugin(runtime)
  const recovered = await recoverNativeTurn(ctx, { botId: bot.botId })
  assert.equal(recovered.success, true)
  const meta = JSON.parse(await readFile(join(ws, recovered.meta), 'utf8'))
  assert.equal(meta.runtime.recovery_proof.mode, 'legacy-readonly')
  assert.equal(meta.runtime.reply, undefined)
})

async function ipcApp(t, script = () => response('IPC reply')) {
  const fixture = await app(t, script, { main: true })
  // Core fixtures lack the full Web Controller. Native resolve/ownership is
  // separately exercised by installed Web and Chromium acceptance.
  fixture.ctx.mbot.resolveMainSession = async id => fixture.ctx.mbot.bot({ botId: id })
  const directory = join(root, `ipc-${++sequence}`)
  const owner = fixture.ctx.plugin(ipc, { directory })
  await owner
  const endpoint = fixture.ctx.mbotIpc.status()
  assert.equal(endpoint.state, 'ready')
  return { ...fixture, ipcOwner: owner, ipc: fixture.ctx.mbotIpc, endpoint }
}

async function cli(args, input, extraEnv = {}) {
  const child = spawn(join(mbot.packageRoot, 'bin', 'botctl'), args, { env: { ...process.env, ...extraEnv }, stdio: 'pipe' })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  return { exitCode, stdout, stderr }
}

async function until(check) {
  for (let count = 0; count < 500; count++) { if (await check()) return; await delay(10) }
  throw new Error('Timed out waiting for IPC fixture')
}

test('CLI removal requires stable identity and uncertain acknowledgement is resolved by an idempotent retry', { timeout: 30000 }, async t => {
  const { ctx, bot, agent, endpoint, ipc: service } = await ipcApp(t)
  await removalController(ctx, agent)
  const options = ['--endpoint-dir', endpoint.directory, '--bot', bot.botId]
  assert.equal((await cli(['remove', '--endpoint-dir', endpoint.directory, '--bot', bot.name])).exitCode, 1)
  assert.equal((await cli(['remove', ...options, '--revision', '0'])).exitCode, 1)
  assert.equal(ctx.mbot.registry().retiredBots.length, 0)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const edit = ctx.configEditor.edit.bind(ctx.configEditor)
  let calls = 0
  ctx.configEditor.edit = async (...args) => {
    if (++calls === 2) { entered.resolve(); await release.promise }
    return edit(...args)
  }
  const request = { action: 'remove', botId: bot.botId, revision: ctx.mbot.registry().revision }
  const failed = assert.rejects(requestHost(endpoint, request, { timeoutMs: 100 }), error => error.code === 'IPC_UNCONFIRMED' && error.uncertain && /removed Bots/u.test(error.message))
  await entered.promise
  await failed
  assert.equal(service.operations.size, 1)
  release.resolve()
  await until(() => service.operations.size === 0)
  ctx.configEditor.edit = edit
  const retry = await cli(['remove', ...options, '--revision', String(request.revision)])
  assert.equal(retry.exitCode, 0, retry.stderr || retry.stdout)
  assert.equal(JSON.parse(retry.stdout).value.alreadyRemoved, true)
  assert.equal((await cli(['talk', ...options, '--request-id', 'retired-talk', '--text', 'do not dispatch'])).exitCode, 1)
  const listed = await cli(['removed', '--endpoint-dir', endpoint.directory])
  assert.equal(JSON.parse(listed.stdout).value.retiredBots[0].bot.botId, bot.botId)
  const active = await cli(['bots', '--endpoint-dir', endpoint.directory])
  assert.deepEqual(JSON.parse(active.stdout).value.bots, [])
})

test('real botctl CLI talks to the managed Inbox, preserves stdin bytes and retries one request', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, endpoint, requests } = await ipcApp(t)
  const options = ['--endpoint-dir', endpoint.directory, '--bot', bot.botId, '--request-id', 'cli-event:1']
  const text = '第一行\nliteral $() and `code`\n最后一行\n'
  const sent = await cli(['talk', ...options, '--stdin'], text)
  assert.equal(sent.exitCode, 0, sent.stderr || sent.stdout)
  const receipt = JSON.parse(sent.stdout).value
  assert.equal(receipt.confirmation, 'confirmed')
  await settle(ctx, agent)
  assert.equal(requests.length, 1)
  assert.ok(requests[0].messages.some(message => message.content.some(block => block.type === 'text' && block.text === text)))
  const retried = await cli(['talk', ...options, '--text', text])
  assert.equal(retried.exitCode, 0, retried.stderr)
  assert.equal(JSON.parse(retried.stdout).value.messageId, receipt.messageId)
  assert.equal(requests.length, 1)
  const lookup = await cli(['receipt', ...options])
  assert.equal(JSON.parse(lookup.stdout).value.delivery, 'ended')
  const status = await cli(['runtime', '--endpoint-dir', endpoint.directory, '--bot', bot.botId])
  assert.equal(JSON.parse(status.stdout).value.lastReceipt.head, git(ws, 'rev-parse', 'HEAD'))
  const bots = await cli(['bots', '--endpoint-dir', endpoint.directory])
  assert.equal(JSON.parse(bots.stdout).value.bots[0].botId, bot.botId)
})

test('CLI owner commands reject nested runs, invalid routes and changed retries before model dispatch', { timeout: 30000 }, async t => {
  const { ctx, bot, agent, endpoint, requests } = await ipcApp(t)
  const options = ['--endpoint-dir', endpoint.directory, '--bot', bot.botId, '--request-id', 'cli-safe-1']
  const nested = await cli(['talk', ...options, '--text', 'nested'], undefined, { MBOT_RUN_ID: 'owned-turn' })
  assert.equal(nested.exitCode, 2)
  assert.match(nested.stderr, /unavailable inside managed runs/u)
  assert.equal(requests.length, 0)
  const misplaced = await cli(['-C', '/tmp/unused-bot', 'talk', ...options, '--text', 'wrong path'])
  assert.equal(misplaced.exitCode, 2)
  const injected = await requestHost(endpoint, { action: 'talk', botId: bot.botId, requestId: 'cli-safe-1', text: 'forged', ownerId: 'other-owner' })
  assert.equal(injected.ok, false)
  assert.match(injected.error.message, /fields/u)
  assert.equal(requests.length, 0)
  assert.equal((await cli(['talk', ...options, '--text', '--help'])).exitCode, 0)
  await settle(ctx, agent)
  const changed = await cli(['talk', ...options, '--text', 'changed request bytes'])
  assert.equal(changed.exitCode, 1)
  assert.match(JSON.parse(changed.stdout).error.message, /reused/u)
  assert.equal(requests.length, 1)
})

test('IPC disconnect/timeout does not cancel transferred input and same-ID retry recovers acknowledgement', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { ctx, bot, agent, endpoint, requests, ipc: service } = await ipcApp(t)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush = async session => { entered.resolve(); await release.promise; return flush(session) }
  const input = { action: 'talk', botId: bot.botId, requestId: 'disconnected-1', text: 'keep accepted input' }
  const sending = requestHost(endpoint, input, { timeoutMs: 100 })
  const failure = assert.rejects(sending, error => error.code === 'IPC_UNCONFIRMED' && error.uncertain)
  await entered.promise
  await failure
  assert.equal(requests.length, 0)
  assert.equal(service.operations.size, 1)
  release.resolve()
  ctx.sessions.flush = flush
  await until(() => service.operations.size === 0)
  await settle(ctx, agent)
  const recovered = await requestHost(endpoint, input)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.value.delivery, 'ended')
  assert.equal(requests.length, 1)
})

test('IPC disposal drains disconnected operations before another endpoint can acquire the Host lock', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { ctx, bot, endpoint, ipc: service, ipcOwner } = await ipcApp(t)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush = async session => { entered.resolve(); await release.promise; return flush(session) }
  const pending = requestHost(endpoint, { action: 'talk', botId: bot.botId, requestId: 'drain-1', text: 'drain admission' }, { timeoutMs: 100 })
  const expected = assert.rejects(pending, /unconfirmed/u)
  await entered.promise
  const closing = ipcOwner.dispose()
  await until(() => service.closed)
  await expected
  const contender = ctx.plugin(ipc, { directory: endpoint.directory })
  await contender
  assert.equal(ctx.mbotIpc.status().state, 'busy')
  await contender.dispose()
  assert.equal(service.operations.size, 1)
  release.resolve()
  ctx.sessions.flush = flush
  await closing
  const replacement = ctx.plugin(ipc, { directory: endpoint.directory })
  await replacement
  assert.equal(ctx.mbotIpc.status().state, 'ready')
  assert.notEqual(ctx.mbotIpc.status().instanceId, endpoint.instanceId)
})

test('IPC lock rejects a live second owner, then reload reuses original native request history', { timeout: 30000 }, async t => {
  const first = await ipcApp(t)
  const other = await app(t, () => response('other'), { main: true })
  const contender = other.ctx.plugin(ipc, { directory: first.endpoint.directory })
  await contender
  assert.equal(other.ctx.mbotIpc.status().state, 'busy')
  const request = { action: 'talk', botId: first.bot.botId, requestId: 'before-ipc-reload', text: 'once' }
  const original = await requestHost(first.endpoint, request)
  await settle(first.ctx, first.agent)
  await first.ipcOwner.dispose()
  const owner = first.ctx.plugin(ipc, { directory: first.endpoint.directory })
  await owner
  const replacement = first.ctx.mbotIpc.status()
  const retried = await requestHost(replacement, request)
  assert.equal(retried.value.messageId, original.value.messageId)
  assert.equal(first.requests.length, 1)
  assert.equal(other.requests.length, 0)
})

test('losing the flock helper cannot transfer ownership while its live Host still drains input', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { ctx, bot, endpoint, ipc: service, ipcOwner } = await ipcApp(t)
  const other = await app(t, () => response('other'), { main: true })
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush = async session => { entered.resolve(); await release.promise; return flush(session) }
  const pending = requestHost(endpoint, { action: 'talk', botId: bot.botId, requestId: 'lost-lock', text: 'preserve transferred input' })
  const expected = assert.rejects(pending, /unconfirmed/u)
  await entered.promise
  service.lock.terminate()
  await until(() => service.closed)
  await expected
  const contender = other.ctx.plugin(ipc, { directory: endpoint.directory })
  await contender
  assert.equal(other.ctx.mbotIpc.status().state, 'busy')
  await contender.dispose()
  assert.equal(service.operations.size, 1)
  release.resolve()
  ctx.sessions.flush = flush
  await service.close()
  await ipcOwner.dispose()
  await ctx.plugin(ipc, { directory: endpoint.directory })
  assert.equal(ctx.mbotIpc.status().state, 'ready')
})

test('profile discovery uses canonical DSH profile identity and creates only a short private /tmp endpoint', async t => {
  const directory = join(root, 'ipc-profile-home')
  await mkdir(join(directory, 'profiles', 'web'), { recursive: true })
  await mkdir(join(directory, 'profiles', '中文'), { recursive: true })
  const alias = join(root, 'ipc-profile-alias')
  await symlink(directory, alias)
  const canonical = await profileLocation('web', { DSH_HOME: directory })
  const same = await profileLocation('web', { DSH_HOME: alias })
  assert.deepEqual(canonical, same)
  assert.notEqual((await profileLocation('中文', { DSH_HOME: directory })).profileId, canonical.profileId)
  assert.ok(canonical.directory.startsWith('/tmp/dsh-mbot-'))
  assert.ok(Buffer.byteLength(canonical.socketPath) <= 100)
  await assert.rejects(profileLocation('../other', { DSH_HOME: directory }), /Invalid/u)
  const { ctx } = await app(t, () => response('done'), { main: true })
  ctx.provide('profileContext', { dir: join(directory, 'profiles', 'web') })
  await ctx.plugin(ipc)
  assert.equal(ctx.mbotIpc.status().socketPath, canonical.socketPath)
  assert.equal((await lstat(canonical.directory)).mode & 0o777, 0o700)
  assert.equal((await lstat(canonical.socketPath)).mode & 0o777, 0o600)
  const listing = await cli(['bots', '--profile', 'web'], undefined, { DSH_HOME: directory })
  assert.equal(listing.exitCode, 0, listing.stderr || listing.stdout)
})

test('unsafe IPC filesystem objects and overlong paths are rejected without rewriting files', async t => {
  const { ctx } = await app(t, () => response('done'))
  const unsafe = join(root, 'ipc-public')
  await mkdir(unsafe, { mode: 0o755 })
  await assert.rejects(Promise.resolve(ctx.plugin(ipc, { directory: unsafe })), /private/u)
  assert.equal((await lstat(unsafe)).mode & 0o777, 0o755)
  const safe = join(root, 'ipc-file-socket')
  await mkdir(safe, { mode: 0o700 })
  await writeFile(join(safe, 'owner.sock'), 'keep unrelated file', { mode: 0o600 })
  await assert.rejects(Promise.resolve(ctx.plugin(ipc, { directory: safe })), /expected file type/u)
  assert.equal(await readFile(join(safe, 'owner.sock'), 'utf8'), 'keep unrelated file')
  const target = join(root, 'ipc-secret-target')
  await writeFile(target, 'unchanged', { mode: 0o600 })
  const linked = join(root, 'ipc-linked-lock')
  await mkdir(linked, { mode: 0o700 })
  await symlink(target, join(linked, 'owner.lock'))
  await assert.rejects(Promise.resolve(ctx.plugin(ipc, { directory: linked })))
  assert.equal(await readFile(target, 'utf8'), 'unchanged')
  await assert.rejects(ipcLocation({ directory: `/tmp/${'long'.repeat(40)}` }), /too long/u)
})

test('IPC protocol rejects extra frames and malformed sources without executing a model', { timeout: 30000 }, async t => {
  const { bot, endpoint, requests } = await ipcApp(t)
  const extra = await requestHost(endpoint, { action: 'talk', botId: bot.botId, requestId: 'malformed', text: 'data', source: { kind: 'user' } })
  assert.equal(extra.ok, false)
  const disconnected = await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socketPath)
    socket.on('error', reject)
    let text = ''
    socket.on('data', chunk => { text += chunk })
    socket.once('end', () => resolve(text))
    socket.once('connect', () => socket.write('not json\nsecond frame\n'))
  })
  assert.equal(JSON.parse(disconnected).ok, false)
  const invalidUtf8 = await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socketPath)
    socket.on('error', reject)
    let text = ''
    socket.on('data', chunk => { text += chunk })
    socket.once('end', () => resolve(text))
    socket.once('connect', () => socket.write(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10])))
  })
  assert.equal(JSON.parse(invalidUtf8).ok, false)
  await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socketPath)
    socket.on('error', reject)
    socket.once('close', resolve)
    socket.once('connect', () => socket.write(Buffer.alloc(maxFrameBytes + 1, 120)))
  })
  assert.equal(requests.length, 0)
})

test('IPC stop joins the captured turn and preserves queued messages', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const { ctx, bot, agent, endpoint, requests } = await ipcApp(t, async () => { entered.resolve(); await release.promise; return response('stopped') })
  await requestHost(endpoint, { action: 'talk', botId: bot.botId, requestId: 'active-ipc', text: 'active' })
  await entered.promise
  const queued = await requestHost(endpoint, { action: 'talk', botId: bot.botId, requestId: 'queued-ipc', text: 'pending' })
  const stopping = requestHost(endpoint, { action: 'stop', botId: bot.botId })
  await until(() => requests.length === 1 && ctx.mbotRuntime.states.get(agent).current.signal.aborted)
  release.resolve()
  const stopped = await stopping
  assert.equal(stopped.ok, true)
  assert.equal(stopped.value.targetTurn, 1)
  assert.equal(stopped.value.receipt.outcome, 'cancelled')
  assert.equal(agent.inbox.nextTurn[0].id, queued.value.messageId)
  assert.equal(requests.length, 1)
})
const auditAtHead = ws => {
  const path = git(ws, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').findLast(path => path.endsWith('.meta.json'))
  return JSON.parse(git(ws, 'show', `HEAD:${path}`))
}

test('owner mailbox captures bytes, namespaces request identity and deduplicates concurrent clients', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, requests } = await app(t, () => response('owner reply'), { main: true })
  const first = mainMailbox(ctx, agent)
  const second = mainMailbox(ctx, agent)
  const base = git(ws, 'rev-parse', 'HEAD')
  const input = { requestId: 'event:1', text: 'owner original bytes', correlationId: 'thread:1' }
  const sent = first.send(input)
  input.text = 'mutated after submit'
  const [receipt, retry] = await Promise.all([sent, second.send({ requestId: 'event:1', text: 'owner original bytes', correlationId: 'thread:1' })])
  assert.equal(receipt.confirmation, 'confirmed')
  assert.equal(receipt.messageId, retry.messageId)
  assert.match(receipt.rpcId, /^mbot:[a-f0-9]{64}$/u)
  assert.equal(receipt.botId, bot.botId)
  await settle(ctx, agent)
  assert.equal(requests.length, 1)
  assert.ok(JSON.stringify(requests).includes('owner original bytes'))
  assert.ok(!JSON.stringify(requests).includes('mutated after submit'))
  assert.ok(JSON.stringify(requests).includes('test-tg'))
  assert.deepEqual(auditAtHead(ws).runtime.request_ids, [receipt.rpcId])
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.deepEqual(await first.receipt('missing'), undefined)
  assert.equal((await second.receipt('event:1')).delivery, 'ended')
})

test('same request cannot change content, correlation, route or inject source/session fields', { timeout: 30000 }, async t => {
  const { ctx, agent, requests } = await app(t, () => response('done'), { main: true })
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'event:1', text: 'original' })
  await settle(ctx, agent)
  await assert.rejects(mailbox.send({ requestId: 'event:1', text: 'changed' }), /reused/u)
  await assert.rejects(mailbox.send({ requestId: 'event:1', text: 'original', correlationId: 'changed' }), /reused/u)
  const otherRoute = mainMailbox(ctx, agent, { replyRoute: 'chat:group' })
  await assert.rejects(otherRoute.send({ requestId: 'event:1', text: 'original' }), /reused/u)
  await assert.rejects(otherRoute.receipt('event:1'), /different owner route/u)
  await assert.rejects(mailbox.send({ requestId: 'event:2', text: 'attack', sessionId: 'other-bot' }), /fields/u)
  assert.throws(() => mainMailbox(ctx, agent, { visibility: 'group' }), /owner-private/u)
  mailbox.dispose()
  await assert.rejects(mailbox.send({ requestId: 'event:2', text: 'revoked' }), /unavailable/u)
  assert.equal(requests.length, 1)
})

test('Web RPC and owner mailbox share FIFO, and native steer IDs join the same audit', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { ctx, ws, agent, requests } = await app(t, async (_options, count) => {
    if (count === 1) { entered.resolve(); await release.promise }
    return response(`reply ${count}`)
  }, { main: true })
  const mailbox = mainMailbox(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'native Web request' }], source: { kind: 'user', rpcId: 'web-request-1' } }))
  await entered.promise
  const receipt = await mailbox.send({ requestId: 'tg-event-1', text: 'queued private message' })
  assert.equal(receipt.delivery, 'queued')
  agent.steer(createUserMessage({ content: [{ type: 'text', text: 'explicit native steer' }], source: { kind: 'user', rpcId: 'web-steer-1' } }))
  assert.equal(requests.length, 1)
  release.resolve()
  await settle(ctx, agent)
  assert.equal(requests.length, 3)
  const paths = git(ws, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(path => path.endsWith('.meta.json'))
  const audits = paths.map(path => JSON.parse(git(ws, 'show', `HEAD:${path}`)))
  assert.deepEqual(audits.find(audit => audit.runtime.turn === 1).runtime.request_ids, ['web-request-1', 'web-steer-1'])
  assert.deepEqual(audits.find(audit => audit.runtime.turn === 2).runtime.request_ids, [receipt.rpcId])
})

test('all native input waits for a persistence flush before acquiring a lease or calling the model', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests } = await app(t, () => response('durable reply'))
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  t.after(() => { release.resolve(); if (ctx.sessions) ctx.sessions.flush = flush })
  let first = true
  ctx.sessions.flush = async session => {
    if (first) { first = false; entered.resolve(); await release.promise }
    return flush(session)
  }
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('native message requiring flush'))
  await entered.promise
  assert.equal(requests.length, 0)
  assert.throws(() => ctx.mbotRuntime.dataLease(agent), /No active/u)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  release.resolve()
  await settle(ctx, agent)
  assert.equal(requests.length, 1)
})

test('uncertain admission is kept in native Inbox; same-ID retry confirms it without duplication', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests } = await app(t, () => response('done'), { main: true })
  const mailbox = mainMailbox(ctx, agent)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  t.after(() => { if (ctx.sessions) ctx.sessions.flush = flush })
  let failures = 2
  ctx.sessions.flush = async session => {
    if (failures-- > 0) throw new Error('admission store unavailable')
    return flush(session)
  }
  const base = git(ws, 'rev-parse', 'HEAD')
  const receipt = await mailbox.send({ requestId: 'uncertain-1', text: 'retain this request' })
  assert.equal(receipt.confirmation, 'unconfirmed')
  await settle(ctx, agent)
  assert.equal(requests.length, 0)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  assert.equal(agent.inbox.nextTurn[0].id, receipt.messageId)
  const retried = await mailbox.send({ requestId: 'uncertain-1', text: 'retain this request' })
  assert.equal(retried.confirmation, 'confirmed')
  assert.equal(retried.messageId, receipt.messageId)
  assert.equal(agent.inbox.nextTurn.length, 1)
  // DSH has no public wake-only operation; a new waking input resumes pending
  // work. A confirmation retry does not create a synthetic model message.
  await mailbox.send({ requestId: 'next-2', text: 'continue pending work' })
  await settle(ctx, agent)
  assert.equal(requests.length, 2)
  const log = await ctx.sessionQuery.readSession(agent.id)
  assert.equal(log.events.filter(event => event.type === 'user/message' && event.data.id === receipt.messageId).length, 1)
})

test('Runtime reload revokes old capabilities and rebuilds request receipts from native history', { timeout: 30000 }, async t => {
  const { ctx, bot, agent, requests, owner } = await app(t, () => response('done'), { main: true })
  const mailbox = mainMailbox(ctx, agent)
  const original = await mailbox.send({ requestId: 'before-reload', text: 'once' })
  await settle(ctx, agent)
  await owner.dispose()
  await assert.rejects(mailbox.receipt('before-reload'), /unavailable/u)
  await ctx.plugin(runtime)
  await ctx.mbotRuntime.attach(agent, { botId: bot.botId })
  const replacement = mainMailbox(ctx, agent)
  const receipt = await replacement.receipt('before-reload')
  assert.equal(receipt.messageId, original.messageId)
  assert.equal(receipt.delivery, 'ended')
  assert.equal((await replacement.send({ requestId: 'before-reload', text: 'once' })).messageId, original.messageId)
  await settle(ctx, agent)
  assert.equal(requests.length, 1)
})

test('unknown or non-owner producers cannot dispatch, including input injected during an active turn', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests } = await app(t, () => response('done'))
  const base = git(ws, 'rev-parse', 'HEAD')
  for (const source of [{ kind: 'peer-bot', senderBotId: 'other-bot' }, { kind: 'user', rpcId: 'non-owner', principal: { id: 'other-user' } }]) {
    const rejected = createUserMessage({ content: [{ type: 'text', text: 'unapproved business input' }], source })
    agent.followup(rejected)
    await settle(ctx, agent)
    assert.equal(requests.length, 0)
    assert.ok(agent.inbox.nextTurn.some(message => message.id === rejected.id))
    agent.inbox.clear()
  }
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const active = await app(t, async (_options, count) => { if (count === 1) { entered.resolve(); await release.promise } return response('done') })
  active.agent.followup(message('owner'))
  await entered.promise
  const injected = createUserMessage({ content: [{ type: 'text', text: 'unapproved peer relay' }], source: { kind: 'peer-bot' } })
  active.agent.inject(injected)
  release.resolve()
  await settle(active.ctx, active.agent)
  assert.equal(active.requests.length, 1)
  assert.equal(active.agent.inbox.nextTurn[0].id, injected.id)
  assert.equal((await active.ctx.mbotRuntime.status(active.agent)).lastReceipt.outcome, 'failed')
})

test('native queued cancellation and stopped claimed input have distinct delivery receipts', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { ctx, agent } = await app(t, async () => { entered.resolve(); await release.promise; return response('stopped') }, { main: true })
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'active', text: 'active' })
  await entered.promise
  const queued = await mailbox.send({ requestId: 'queued', text: 'cancel before run' })
  assert.equal(agent.inbox.remove(queued.messageId), true)
  assert.equal((await mailbox.receipt('queued')).delivery, 'cancelled')
  const stopping = ctx.mbotRuntime.stop(agent)
  release.resolve()
  await stopping
  const stopped = await mailbox.receipt('active')
  assert.equal(stopped.delivery, 'ended')
  assert.equal(stopped.reason, 'aborted')
})

test('teardown during admission preserves an unexecuted claim across Runtime reload', { timeout: 30000 }, async t => {
  const { ctx, bot, agent, requests, owner } = await app(t, () => response('done'), { main: true })
  const mailbox = mainMailbox(ctx, agent)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  t.after(() => { release.resolve(); if (ctx.sessions) ctx.sessions.flush = flush })
  let calls = 0
  ctx.sessions.flush = async session => {
    if (++calls === 2) { entered.resolve(); await release.promise }
    return flush(session)
  }
  const receipt = await mailbox.send({ requestId: 'unexecuted', text: 'preserve on unload' })
  await entered.promise
  await owner.dispose()
  assert.equal(requests.length, 0)
  assert.equal(agent.inbox.nextTurn[0].id, receipt.messageId)
  release.resolve()
  ctx.sessions.flush = flush
  await ctx.plugin(runtime)
  await ctx.mbotRuntime.attach(agent, { botId: bot.botId })
  const replacement = mainMailbox(ctx, agent)
  assert.equal((await replacement.receipt('unexecuted')).delivery, 'queued')
  await replacement.send({ requestId: 'wake-next', text: 'continue' })
  await settle(ctx, agent)
  assert.equal(requests.length, 2)
})

test('message projection excludes inherited request identity while preserving native splice offsets', () => {
  const index = new MessageIndex()
  const inherited = createUserMessage({ content: [{ type: 'text', text: 'inherited' }], source: { kind: 'user', rpcId: 'old-parent' } })
  const owned = createUserMessage({ content: [{ type: 'text', text: 'owned' }], source: { kind: 'user', rpcId: 'new-child' } })
  const events = [
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [inherited] } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 1, inserted: [owned] } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  for (const [seq, event] of events.entries()) index.apply({ ...event, seq }, 1)
  assert.equal(index.requests.has('old-parent'), false)
  assert.equal(index.requests.get('new-child').delivery, 'queued')
  assert.equal(index.pending['next-turn'][0].id, owned.id)
})

test('native pending edits preserve request identity, while duplicate Web input is rejected', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { ctx, agent, requests } = await app(t, async (_options, count) => { if (count === 1) { entered.resolve(); await release.promise } return response('done') })
  agent.followup(message('hold turn'))
  await entered.promise
  const pending = createUserMessage({ content: [{ type: 'text', text: 'pending original' }], source: { kind: 'user', rpcId: 'editable-web-id' } })
  agent.followup(pending)
  assert.equal(agent.inbox.replace(pending.id, { ...pending, content: [{ type: 'text', text: 'pending correction' }] }), true)
  release.resolve()
  await settle(ctx, agent)
  assert.equal(requests.length, 2)
  assert.ok(JSON.stringify(requests[1].messages).includes('pending correction'))
  assert.ok(!JSON.stringify(requests[1].messages).includes('pending original'))
  const duplicate = createUserMessage({ content: [{ type: 'text', text: 'pending correction' }], source: { kind: 'user', rpcId: 'editable-web-id' } })
  agent.followup(duplicate)
  await settle(ctx, agent)
  assert.equal(requests.length, 2)
  assert.equal(agent.inbox.nextTurn[0].id, duplicate.id)
})

test('native context producers and prepared text survive, while pre-step business injection is blocked', { timeout: 30000 }, async t => {
  const prepared = await app(t, () => response('done'), { main: true, beforeRuntime(ctx) {
    ctx.on('agent/pre-step', async (_input, next) => {
      const decision = await next()
      return { ...decision, messages: decision.messages.map(message => message.source.mbot ? {
        ...message, content: [{ type: 'text', text: 'prepared native reference text' }],
      } : message).concat(createUserMessage({ content: [{ type: 'text', text: 'native instructions context' }],
        source: { kind: 'agent-instructions', form: 'instructions' } })) }
    })
  } })
  const mailbox = mainMailbox(prepared.ctx, prepared.agent)
  const original = await mailbox.send({ requestId: 'reference:1', text: 'original reference input' })
  await settle(prepared.ctx, prepared.agent)
  assert.ok(JSON.stringify(prepared.requests).includes('prepared native reference text'))
  assert.ok(JSON.stringify(prepared.requests).includes('native instructions context'))
  assert.equal((await mailbox.send({ requestId: 'reference:1', text: 'original reference input' })).messageId, original.messageId)
  assert.equal(prepared.requests.length, 1)
  const rejected = await app(t, () => response('should not run'), { beforeRuntime(ctx) {
    ctx.on('agent/pre-step', async (_input, next) => {
      const decision = await next()
      return { ...decision, messages: decision.messages.concat(message('unclaimed business prompt')) }
    })
  } })
  const input = message('legitimate owner request')
  rejected.agent.followup(input)
  await settle(rejected.ctx, rejected.agent)
  assert.equal(rejected.requests.length, 0)
  assert.equal(rejected.agent.inbox.nextTurn[0].id, input.id)
})

test('tampered owner envelope versions and fingerprints cannot dispatch business input', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { ctx, agent, requests } = await app(t, async (_options, count) => { if (count === 1) { entered.resolve(); await release.promise } return response('done') }, { main: true })
  const mailbox = mainMailbox(ctx, agent)
  agent.followup(message('hold owner turn'))
  await entered.promise
  await mailbox.send({ requestId: 'tampered', text: 'original immutable bytes' })
  const pending = agent.inbox.nextTurn[0]
  agent.inbox.replace(pending.id, { ...pending, source: { ...pending.source, mbot: { ...pending.source.mbot, schemaVersion: 2 } } })
  release.resolve()
  await settle(ctx, agent)
  assert.equal(requests.length, 1)
  assert.equal(agent.inbox.nextTurn[0].id, pending.id)
  await assert.rejects(mailbox.receipt('tampered'), /reused/u)
  agent.inbox.replace(pending.id, { ...pending, content: [{ type: 'text', text: 'changed bytes with old fingerprint' }] })
  agent.followup(message('try pending modified bytes'))
  await settle(ctx, agent)
  assert.equal(requests.length, 1)
  assert.equal(agent.inbox.nextTurn[0].id, pending.id)
})

test('audited receipts return the original answer after later work and Runtime reload', { timeout: 30000 }, async t => {
  const { ctx, bot, ws, agent, requests, owner } = await app(t, (_options, count) => response(`sealed answer ${count}`), { main: true })
  let mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'reply-one', text: 'first request', correlationId: 'thread-one' })
  await settle(ctx, agent)
  const first = await mailbox.receipt('reply-one')
  assert.equal(first.result.final, true, JSON.stringify(first.result))
  assert.equal(first.result.status, 'completed')
  assert.equal(first.result.reply.text, 'sealed answer 1')
  assert.equal(first.result.reply.replyRoute, privateRoute.replyRoute)
  assert.equal(first.result.reply.correlationId, 'thread-one')
  assert.equal(first.result.audit.commit, git(ws, 'rev-parse', 'HEAD'))
  await mailbox.send({ requestId: 'reply-two', text: 'second request' })
  await settle(ctx, agent)
  const afterLaterWork = await mailbox.receipt('reply-one')
  assert.equal(afterLaterWork.result.reply.replyId, first.result.reply.replyId)
  assert.equal(afterLaterWork.result.reply.text, 'sealed answer 1')
  assert.equal((await mailbox.receipt('reply-two')).result.reply.text, 'sealed answer 2')
  await owner.dispose()
  await ctx.plugin(runtime)
  await ctx.mbotRuntime.attach(agent, { botId: bot.botId })
  mailbox = mainMailbox(ctx, agent)
  assert.equal((await mailbox.receipt('reply-one')).result.reply.replyId, first.result.reply.replyId)
  assert.equal(requests.length, 2)
})

test('Agent idle and forged presentation cards do not release replies before Git settlement', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { ctx, bot, agent } = await app(t, (_options, _count, ctx) => {
    const lease = ctx.mbotRuntime.dataLease(ctx.agents.list()[0])
    const finish = lease.finish.bind(lease)
    lease.finish = async outcome => { entered.resolve(); await release.promise; return finish(outcome) }
    return response('do not publish before audit')
  }, { main: true })
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'audit-pending', text: 'pending audit' })
  await entered.promise
  assert.equal(agent.status, 'idle')
  appendPluginRecord(agent.session, runtime.runtimeRecordType, { schemaVersion: 1, botId: bot.botId, sessionId: agent.id,
    turn: 1, phase: 'committed', head: 'f'.repeat(40), success: true, outcome: 'completed', failureCountEffect: 'reset' })
  const pending = await mailbox.receipt('audit-pending')
  assert.equal(pending.result.status, 'auditing')
  assert.equal(pending.result.final, false)
  assert.equal(pending.result.reply, undefined)
  release.resolve()
  await settle(ctx, agent)
  assert.equal((await mailbox.receipt('audit-pending')).result.final, true)
})

test('user stop and guard failure produce distinct verified terminal replies', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const stopped = await app(t, async () => { entered.resolve(); await release.promise; return response('stopped text') }, { main: true })
  const mailbox = mainMailbox(stopped.ctx, stopped.agent)
  await mailbox.send({ requestId: 'stopped', text: 'stop this' })
  await entered.promise
  const stopping = stopped.ctx.mbotRuntime.stop(stopped.agent)
  release.resolve()
  await stopping
  const cancelled = await mailbox.receipt('stopped')
  assert.equal(cancelled.result.final, true)
  assert.equal(cancelled.result.status, 'cancelled')
  assert.equal(cancelled.result.audit.failureCountEffect, 'preserve')
  assert.equal(cancelled.result.reply.outcome, 'cancelled')
  const violated = await app(t, async (_options, _count, ctx) => {
    const lease = ctx.mbotRuntime.dataLease(ctx.agents.list()[0])
    await writeFile(join(lease.snapshot.workspace, 'MEMORY.md'), 'illegal memory edit\n')
    return response('claimed success')
  }, { main: true })
  const faulty = mainMailbox(violated.ctx, violated.agent)
  await faulty.send({ requestId: 'guard-failed', text: 'guard this' })
  await settle(violated.ctx, violated.agent)
  const failed = await faulty.receipt('guard-failed')
  assert.equal(failed.result.final, true)
  assert.equal(failed.result.status, 'failed')
  assert.equal(failed.result.reply.outcome, 'failed')
  assert.equal(failed.result.audit.success, false)
})

test('sealed native text, route, source cut and outcome contradictions cannot become replies', { timeout: 30000 }, async t => {
  const { ctx, ws, agent } = await app(t, () => response('original sealed text'), { main: true })
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'sealed', text: 'sealed request' })
  await settle(ctx, agent)
  const valid = await mailbox.receipt('sealed')
  assert.equal(valid.result.final, true)
  const path = valid.result.audit.meta
  const original = JSON.parse(git(ws, 'show', `HEAD:${path}`))
  const changes = [
    meta => { meta.runtime.reply.text = 'forged reply'; meta.runtime.reply.textHash = '0'.repeat(64) },
    meta => { meta.runtime.reply.targets[0].replyRoute = 'other-chat' },
    meta => { meta.runtime.reply.endEventSeq++ },
    meta => { meta.failure_count_effect = 'preserve' },
    meta => { delete meta.runtime.journal_schema_version },
  ]
  for (const change of changes) {
    const modified = structuredClone(original)
    change(modified)
    await writeFile(join(ws, path), JSON.stringify(modified) + '\n')
    git(ws, 'add', path)
    git(ws, 'commit', '--amend', '--no-edit')
    const receipt = await mailbox.receipt('sealed')
    assert.equal(receipt.result.final, false)
    assert.equal(receipt.result.status, 'unverified')
    assert.equal(receipt.result.reply, undefined)
  }
})

test('working-tree edits and later failure do not rewrite an earlier verified Git reply', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests } = await app(t, () => response('immutable answer'), { main: true })
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'immutable', text: 'immutable' })
  await settle(ctx, agent)
  const original = await mailbox.receipt('immutable')
  await writeFile(join(ws, original.result.audit.meta), '{"fake":"working-tree reply"}\n')
  const receipt = await mailbox.receipt('immutable')
  assert.equal(receipt.result.reply.replyId, original.result.reply.replyId)
  assert.equal(receipt.result.reply.text, 'immutable answer')
  git(ws, 'restore', original.result.audit.meta)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'unknown producer' }], source: { kind: 'unmanaged-peer' } }))
  await settle(ctx, agent)
  assert.equal((await mailbox.receipt('immutable')).result.reply.replyId, original.result.reply.replyId)
  assert.equal(requests.length, 1)
})

test('an audited reply remains verifiable through a merge and later transcript removal', { timeout: 30000 }, async t => {
  const { ctx, ws, agent } = await app(t, () => response('answer from merged branch'), { main: true })
  const originalBranch = git(ws, 'branch', '--show-current')
  git(ws, 'switch', '-c', 'reply-side')
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'merged-reply', text: 'branch reply' })
  await settle(ctx, agent)
  const original = await mailbox.receipt('merged-reply')
  git(ws, 'switch', originalBranch)
  await writeFile(join(ws, 'human-note'), 'human branch work\n')
  git(ws, 'add', 'human-note')
  git(ws, 'commit', '-m', 'human branch work')
  git(ws, 'merge', '--no-ff', 'reply-side', '-m', 'merge audited reply')
  assert.equal((await mailbox.receipt('merged-reply')).result.audit.commit, original.result.audit.commit)
  git(ws, 'rm', original.result.audit.meta)
  git(ws, 'commit', '-m', 'human: remove current transcript copy')
  const historical = await mailbox.receipt('merged-reply')
  assert.equal(historical.result.reply.replyId, original.result.reply.replyId)
  assert.equal(historical.result.reply.text, 'answer from merged branch')
})

test('a presentation commit without a reachable Git audit remains unverified', { timeout: 30000 }, async t => {
  const { ctx, ws, agent } = await app(t, () => response('historical answer'), { main: true })
  const base = git(ws, 'rev-parse', 'HEAD')
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'unreachable', text: 'unreachable' })
  await settle(ctx, agent)
  assert.equal((await mailbox.receipt('unreachable')).result.final, true)
  git(ws, 'reset', '--hard', base)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.phase, 'committed')
  const receipt = await mailbox.receipt('unreachable')
  assert.equal(receipt.result.final, false)
  assert.equal(receipt.result.status, 'unverified')
})

test('commit failure preserves journal and withholds a terminal reply for coordinated recovery', { timeout: 30000 }, async t => {
  const { ctx, ws, agent } = await app(t, () => response('not committed'), { main: true })
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const shim = join(root, `reply-git-fail-${++sequence}`)
  await mkdir(shim)
  await writeFile(join(shim, 'git'), '#!/bin/sh\nfor arg do\n  if [ "$arg" = commit ]; then exit 1; fi\ndone\nexec /usr/bin/git "$@"\n')
  await chmod(join(shim, 'git'), 0o700)
  ctx.subprocess.spawn = spec => spec.argv[0].endsWith('/bin/mbot-turn') ? spawn({ ...spec, env: { ...spec.env, PATH: `${shim}:${spec.env.PATH}` } }) : spawn(spec)
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'commit-failed', text: 'commit failure' })
  await agent.whenIdle()
  await assert.rejects(ctx.mbotRuntime.settled(agent))
  const receipt = await mailbox.receipt('commit-failed')
  assert.equal(receipt.result.final, false)
  assert.equal(receipt.result.status, 'recovering')
  assert.equal(receipt.result.reply, undefined)
  assert.equal(JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8')).writerScope, 'agent-runtime')
})

test('SIGKILL after Git commit exposes the verified commit but withholds reply until counter settlement', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests } = await app(t, () => response('committed before interruption'), { main: true })
  await writeFile(join(ws, '.mbot/failures'), '2\n')
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const shim = join(root, `reply-crash-${++sequence}`)
  await mkdir(shim)
  await writeFile(join(shim, 'git'), '#!/usr/bin/env bash\ncrash=0\nfor arg in "$@"; do [[ $arg != commit ]] || crash=1; done\nif ((crash)); then\n  /usr/bin/git "$@" || exit $?\n  kill -KILL "$PPID"\n  exit 143\nfi\nexec /usr/bin/git "$@"\n')
  await chmod(join(shim, 'git'), 0o700)
  ctx.subprocess.spawn = spec => spec.argv[0].endsWith('/bin/mbot-turn') ? spawn({ ...spec, env: { ...spec.env, PATH: `${shim}:${spec.env.PATH}` } }) : spawn(spec)
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'commit-cut', text: 'commit then interrupt' })
  await agent.whenIdle()
  await assert.rejects(ctx.mbotRuntime.settled(agent))
  const receipt = await mailbox.receipt('commit-cut')
  assert.equal(receipt.result.final, false)
  assert.equal(receipt.result.status, 'recovering')
  assert.equal(receipt.result.audit.commit, git(ws, 'rev-parse', 'HEAD'))
  assert.equal(receipt.result.audit.outcome, 'completed')
  assert.equal(receipt.result.reply, undefined)
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '2\n')
  assert.equal(JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8')).phase, 'committing')
  await mailbox.send({ requestId: 'commit-cut', text: 'commit then interrupt' })
  assert.equal(requests.length, 1)
})

test('reply redaction is traceable to native text and a later successful flush recovers a committed result', { timeout: 30000 }, async t => {
  let token, emitted = false, failed = false
  const { ctx, agent } = await app(t, (_options, _count, ctx) => {
    token = ctx.mbotRuntime.dataLease(ctx.agents.list()[0]).shellEnvironment().DSH_MBOT_PERMIT_TOKEN
    emitted = true
    return response(`before ${token} after\n中文 suffix`)
  }, { main: true })
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush = async session => { if (emitted && !failed) { failed = true; throw new Error('fixture receipt flush failure') } return flush(session) }
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'redacted', text: 'redaction' })
  await agent.whenIdle()
  await assert.rejects(ctx.mbotRuntime.settled(agent))
  const receipt = await mailbox.receipt('redacted')
  assert.equal(receipt.result.final, true)
  assert.equal(receipt.result.status, 'completed')
  assert.equal(receipt.result.reply.text, 'before [REDACTED] after\n中文 suffix')
  assert.ok(!JSON.stringify(receipt).includes(token))
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'failed')
})

test('a warm older Host header still commits using legacy audit without fabricating sealed replies', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests } = await app(t, () => response('warm Host reply'), { main: true })
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = spec => {
    const child = spawn(spec)
    if (spec.argv[0].endsWith('/bin/mbot-turn')) {
      const write = child.stdin.write.bind(child.stdin)
      child.stdin.write = (chunk, ...args) => {
        let frame
        try { frame = JSON.parse(chunk) } catch {}
        if (frame?.kind === 'begin') { delete frame.messages; chunk = JSON.stringify(frame) + '\n' }
        return write(chunk, ...args)
      }
    }
    return child
  }
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'warm-old-header', text: 'old header' })
  await settle(ctx, agent)
  assert.equal(requests.length, 1)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.phase, 'committed')
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '0\n')
  const receipt = await mailbox.receipt('warm-old-header')
  assert.equal(receipt.result.final, false)
  assert.equal(receipt.result.status, 'unverified')
  assert.match(receipt.result.error, /Historical audit/u)
})

test('CLI receipt wait returns verified text or a deadline while preserving shared execution', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { ctx, bot, agent, endpoint, requests } = await ipcApp(t, async () => { entered.resolve(); await release.promise; return response('CLI sealed reply') })
  const options = ['--endpoint-dir', endpoint.directory, '--bot', bot.botId, '--request-id', 'cli-wait']
  await cli(['talk', ...options, '--text', 'wait for result'])
  await entered.promise
  const timeout = await cli(['receipt', ...options, '--wait', '--timeout-ms', '200'])
  assert.equal(timeout.exitCode, 4)
  assert.equal(JSON.parse(timeout.stdout).wait.status, 'timed-out')
  assert.equal(requests.length, 1)
  const pending = await cli(['receipt', ...options])
  assert.equal(JSON.parse(pending.stdout).value.result.status, 'running')
  release.resolve()
  await settle(ctx, agent)
  const done = await cli(['receipt', ...options, '--wait', '--timeout-ms', '2000'])
  assert.equal(done.exitCode, 0, done.stderr || done.stdout)
  assert.equal(JSON.parse(done.stdout).value.result.reply.text, 'CLI sealed reply')
  assert.equal(JSON.parse(done.stdout).value.result.final, true)
  assert.equal(requests.length, 1)
})

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
  const status = await ctx.mbotRuntime.status(agent)
  assert.equal(status.state, 'idle')
  assert.equal(status.lastReceipt.phase, 'committed')
  assert.equal(status.lastReceipt.head, git(ws, 'rev-parse', 'HEAD'))
  const log = await ctx.sessionQuery.readSession(agent.id)
  assert.deepEqual(log.events.filter(event => event.type === runtime.runtimeRecordType).map(event => event.data.phase), ['active', 'auditing', 'committed'])
  assert.ok(!surface.events.some(event => event.type === runtime.runtimeRecordType))
  assert.ok(!JSON.stringify(requests).includes(runtime.runtimeRecordType))
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
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.phase, 'committed')
  agent.followup(message('after reload'))
  await settle(ctx, agent)
  assert.equal(requests.length, 3)
  assert.ok(JSON.stringify(requests[1].messages).includes('while Runtime is unavailable'))
  assert.equal(ctx.agents.list().length, 1)
})

// Load new source and a new registry module namespace, as ESM eviction does.
// Local dependencies keep their official identities; no real profile is used.
async function replacementRuntime(rewrite = source => source) {
  const directory = await mkdtemp(join(root, 'replacement.'))
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(directory, 'node_modules'))
  await writeFile(join(directory, 'package.json'), '{"type":"module"}')
  const source = (await readFile(new URL('../plugin/runtime.js', import.meta.url), 'utf8'))
    .replace(/from '(\.\/[^']+)'/gu, (match, path) => path === './runtime-cells.js' ? match
      : `from '${new URL(path, new URL('../plugin/runtime.js', import.meta.url)).href}'`)
  await writeFile(join(directory, 'runtime.js'), rewrite(source))
  await writeFile(join(directory, 'runtime-cells.js'), await readFile(new URL('../plugin/runtime-cells.js', import.meta.url)))
  const replacement = await import(pathToFileURL(join(directory, 'runtime.js')).href)
  assert.notEqual(replacement, runtime)
  assert.notEqual(replacement.MBotRuntime, runtime.MBotRuntime)
  return replacement
}

test('different Runtime module adopts the same Agent, refreshes driver code and preserves request proofs', { timeout: 30000 }, async t => {
  const { ctx, agent, owner, requests } = await app(t, (_options, n) => n === 2
    ? response('', { name: 'replacement_unowned', args: {} }) : response('module replacement reply'), { main: true })
  const beforeMailbox = mainMailbox(ctx, agent)
  const sent = await beforeMailbox.send({ requestId: 'before-replacement', text: 'before new module' })
  await settle(ctx, agent)
  const beforeReply = (await beforeMailbox.receipt('before-replacement')).result.reply
  const replacement = await replacementRuntime(source => source.replace('This tool has no managed foreground lifetime contract', 'Replacement driver rejects unowned lifetime'))
  await owner.dispose()
  await ctx.plugin(replacement)
  assert.equal(ctx.mbotRuntime.states.get(agent).current, undefined, 'A settled old current record is not a live new turn')
  const mailbox = mainMailbox(ctx, agent)
  assert.equal((await mailbox.send({ requestId: 'before-replacement', text: 'before new module' })).messageId, sent.messageId)
  assert.deepEqual((await mailbox.receipt('before-replacement')).result.reply, beforeReply)
  assert.equal(requests.length, 1, 'Dedup does not manufacture a wake')
  let executed = false
  ctx.tools.register(defineTool({ name: 'replacement_unowned', description: 'Unowned replacement probe', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() { executed = true; return 'must not execute' } }))
  await mailbox.send({ requestId: 'after-replacement', text: 'use new driver' })
  await settle(ctx, agent)
  assert.equal(executed, false)
  assert.ok(JSON.stringify(requests[2].messages).includes('Replacement driver rejects unowned lifetime'))
  assert.equal((await mailbox.receipt('after-replacement')).result.final, true)
  assert.equal(ctx.agents.get(agent.id), agent)
  assert.equal(ctx.agents.list().length, 1)
})

test('a closed shared ABI 1 gate gains one compaction gate while keeping the same native Agent', { timeout: 30000 }, async t => {
  const { ctx, bot, handle, owner, requests } = await app(t, options => response(options.purpose === summaryPurpose
    ? '{"items":[]}' : 'reference report '.repeat(1500)), { compaction: true })
  await handle.dispose(); await owner.dispose()
  // Emulate the prior shared gate contract without LLM middleware. The
  // data bridge stays current; this tests the supported Agent gate migration.
  const legacy = await replacementRuntime(source => {
    const start = source.indexOf("  on('llm/stream'"), end = source.indexOf('  const layout =', start)
    assert.ok(start >= 0 && end > start)
    return (source.slice(0, start) + source.slice(end)).replace(
      "import { runtimeCells as cells, gateSchemaVersion } from './runtime-cells.js'",
      "import { runtimeCells as cells } from './runtime-cells.js'\nconst gateSchemaVersion = 1")
  })
  const oldOwner = ctx.plugin(legacy); await oldOwner
  const managed = await ctx.agents.create({ sessionId: `legacy-gate-${++sequence}`, meta: { cwd: ctx.mbot.workspace() },
    agentOptions: { provider: 'runtime-test', model: 'scripted' }, setup: (_scope, agent) => ctx.mbotRuntime.attach(agent, { botId: bot.botId }) })
  const agent = managed.agent
  agent.followup(message('legacy raw sources '.repeat(1500)))
  await settle(ctx, agent)
  assert.equal(runtimeCells.get(agent).schemaVersion, 1)
  await oldOwner.dispose()
  await ctx.plugin(runtime)
  await ctx.mbotRuntime.attach(agent, { botId: bot.botId })
  assert.equal(runtimeCells.get(agent).schemaVersion, 2)
  assert.equal(runtimeCells.get(agent).hasLlmGate, true)
  agent.followup(message('compact: after ABI upgrade'))
  await settle(ctx, agent)
  assert.equal((await ctx.mbotRuntime.checkpoint(agent)).compactions[0].status, 'completed')
  assert.equal(requests.filter(request => request.purpose === summaryPurpose).length, 1)
  assert.equal(ctx.agents.get(agent.id), agent)
})

test('input claimed while a new module initializes stays queued and does not replace the old audit state', { timeout: 30000 }, async t => {
  const { ctx, agent, owner, requests } = await app(t, () => response('after initialization'), { main: true })
  agent.followup(message('first completed turn'))
  await settle(ctx, agent)
  await owner.dispose()
  const read = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
  const parked = message('another window during initialization')
  let injected = false
  ctx.sessionQuery.readSession = async id => {
    const log = await read(id)
    if (!injected && id === agent.id) {
      injected = true
      assert.equal((await ctx.mbotRuntime.status(agent)).state, 'unavailable')
      agent.followup(parked)
      await agent.whenIdle()
      assert.equal(requests.length, 1)
    }
    return log
  }
  t.after(() => { if (ctx.sessionQuery) ctx.sessionQuery.readSession = read })
  await ctx.plugin(await replacementRuntime())
  ctx.sessionQuery.readSession = read
  assert.equal(agent.inbox.nextTurn[0].id, parked.id)
  assert.equal(ctx.mbotRuntime.states.get(agent).current.messages.length, 0)
  agent.followup(message('explicit wake after replacement'))
  await settle(ctx, agent)
  assert.equal(requests.length, 3)
  assert.ok(JSON.stringify(requests[1].messages).includes('another window during initialization'))
})

test('different Runtime module retains failed audit proof and repairs the original request without a second commit', { timeout: 30000 }, async t => {
  let emitted = false, failed = false
  const { ctx, ws, bot, agent, owner, requests } = await app(t, () => { emitted = true; return response('flush repair after replacement') }, { main: true })
  await removalController(ctx, agent)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush = async session => {
    if (emitted && !failed) { failed = true; throw new Error('replacement receipt flush failure') }
    return flush(session)
  }
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'replacement-repair', text: 'commit then fail flush' })
  await agent.whenIdle()
  await assert.rejects(ctx.mbotRuntime.settled(agent))
  const head = git(ws, 'rev-parse', 'HEAD')
  const runId = ctx.mbotRuntime.states.get(agent).failedAuditRunId
  ctx.sessions.flush = flush
  await owner.dispose()
  await ctx.plugin(await replacementRuntime())
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'failed')
  assert.equal(ctx.mbotRuntime.states.get(agent).failedAuditRunId, runId)
  agent.followup(message('must remain parked before repair'))
  await agent.whenIdle()
  assert.equal(requests.length, 1)
  assert.equal((await recoverNativeTurn(ctx, { botId: bot.botId })).receiptRepaired, true)
  assert.equal((await mainMailbox(ctx, agent).receipt('replacement-repair')).result.final, true)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), head)
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'idle')
})

test('new module cannot activate before old tool cleanup, audit and message flush drain', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), cancelled = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { ctx, ws, agent, owner, requests } = await app(t, (_options, n) => n === 1
    ? response('', { name: 'handoff_writer', args: {} }) : response('after writer handoff'), { main: true })
  ctx.tools.register(defineTool({ name: 'handoff_writer', description: 'Owns late cancellation cleanup', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      const lease = ctx.mbotRuntime.dataLease(exec.agent)
      entered.resolve()
      await new Promise(resolve => exec.signal.aborted ? resolve() : exec.signal.addEventListener('abort', resolve, { once: true }))
      cancelled.resolve()
      await release.promise
      await lease.execute('botctl', ['remember', 'old module cleanup joined'])
      return 'joined'
    } }))
  ctx.mbotRuntime.foregroundTool('handoff_writer')
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('old writer'))
  await entered.promise
  agent.inbox.splice('next-turn', 0, 0, [message('queued during unload')])
  const replacement = await replacementRuntime()
  const disposing = owner.dispose()
  await cancelled.promise
  const next = ctx.plugin(replacement)
  let activated = false
  const starting = Promise.resolve(next).then(() => { activated = true })
  await delay(30)
  assert.equal(activated, false)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  release.resolve()
  await disposing
  await starting
  assert.notEqual(git(ws, 'rev-parse', 'HEAD'), base)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.phase, 'rejected')
  assert.equal(agent.inbox.nextTurn.length, 1)
  agent.followup(message('explicit wake after writer handoff'))
  await settle(ctx, agent)
  assert.equal(requests.length, 3)
  assert.ok(git(ws, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').some(path => /^inbox\/.*\.md$/u.test(path)
    && git(ws, 'show', `HEAD:${path}`).includes('old module cleanup joined')))
})

test('native Agent disposal retains an in-flight reply flush until Runtime close joins it', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { ctx, agent, handle, owner } = await app(t, () => response('receipt flush lifetime'), { main: true })
  const mailbox = mainMailbox(ctx, agent)
  await mailbox.send({ requestId: 'handoff-receipt', text: 'a verified answer' })
  await settle(ctx, agent)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  t.after(() => { if (ctx.sessions) ctx.sessions.flush = flush })
  ctx.sessions.flush = async session => { entered.resolve(); await release.promise; return flush(session) }
  const receipt = mailbox.receipt('handoff-receipt')
  const rejected = assert.rejects(receipt, /unavailable/u)
  await entered.promise
  const old = ctx.mbotRuntime
  await handle.dispose()
  const closing = owner.dispose()
  let closed = false
  const draining = closing.then(() => { closed = true })
  await delay(30)
  assert.equal(old.states.has(agent), true, 'Native Agent disposal must retain the state until reply flush drains')
  assert.equal(closed, false, 'The captured state still owns a pending native flush')
  release.resolve()
  await rejected
  await draining
  assert.equal(old.states.has(agent), false)
})

test('first gate registration rolls back its own effects and preserves foreign legacy providers', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, requests } = await app(t, () => response('registration rollback reply'))
  const handle = await ctx.agents.create({ sessionId: `legacy-gates-${++sequence}`, meta: { cwd: ws }, agentOptions: { provider: 'runtime-test', model: 'scripted' } })
  const agent = handle.agent
  const foreign = agent.ctx.systemPrompt.section({ name: 'mbot:protocol', order: 10, text: 'foreign legacy protocol' })
  await assert.rejects(ctx.mbotRuntime.attach(agent, { botId: bot.botId }), /legacy or conflicting providers/u)
  assert.equal(ctx.mbotRuntime.managed(agent), false)
  const assembly = await agent.ctx.systemPrompt.assemble({ agent, scope: agent })
  assert.equal(assembly.sections.filter(section => section.name === 'mbot:protocol').length, 1)
  assert.equal(assembly.sections.find(section => section.name === 'mbot:protocol').text, 'foreign legacy protocol')
  assert.equal(assembly.contexts.some(section => section.name === 'mbot:turn'), false)
  agent.followup(message('ordinary unbound Agent still works'))
  await agent.whenIdle()
  assert.equal(requests.length, 1, 'No leaked managed callbacks or guards')
  foreign()
  await ctx.mbotRuntime.attach(agent, { botId: bot.botId })
  agent.followup(message('retry after supported cleanup'))
  await settle(ctx, agent)
  assert.equal(requests.length, 2)
})

test('incompatible prompt ABI rejects replacement and compatible module can reacquire unchanged proofs', { timeout: 30000 }, async t => {
  const { ctx, agent, owner, requests } = await app(t, () => response('ABI retained'), { main: true })
  agent.followup(message('before ABI failure'))
  await settle(ctx, agent)
  await owner.dispose()
  const incompatible = await replacementRuntime(source => source.replace('if (installed && cell.sectionSignature !== signature)', 'if (installed)'))
  const rejected = ctx.plugin(incompatible)
  await assert.rejects(Promise.resolve(rejected), /prompt layout changed/u)
  await rejected.dispose()
  agent.followup(message('parked after ABI failure'))
  await agent.whenIdle()
  assert.equal(requests.length, 1)
  await ctx.plugin(await replacementRuntime())
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.phase, 'committed')
  agent.followup(message('compatible explicit wake'))
  await settle(ctx, agent)
  assert.equal(requests.length, 3)
})

test('partial group activation parks input for initialized Agents and retains failed proof for compatible retry', { timeout: 30000 }, async t => {
  const { ctx, agent, owner, requests } = await failedRuntime(t)
  const priorRun = ctx.mbotRuntime.states.get(agent).failedAuditRunId
  const ws2 = join(root, `group Bot ${++sequence}`)
  assert.equal((await ctx.mbot.execute('mbot', ['init'], { workspace: ws2 })).exitCode, 0)
  const bot2 = await ctx.mbot.importBot(ws2)
  const handle2 = await ctx.agents.create({ sessionId: `group-second-${++sequence}`, meta: { cwd: ws2 },
    agentOptions: { provider: 'runtime-test', model: 'scripted' }, setup: (_ctx, agent) => ctx.mbotRuntime.attach(agent, { botId: bot2.botId }) })
  await ctx.configEditor.edit(ctx.configEditor.entries()[0], current => ({ ...current, registry: { ...current.registry,
    revision: current.registry.revision + 1, bots: current.registry.bots.map(item => item.botId !== bot2.botId ? item : {
      ...item, workspaceId: `workspace-group-${sequence}`, mainSessionId: handle2.agent.id,
      binding: { state: 'ready', pendingSessionId: null, error: null },
    }) } }))
  await owner.dispose()
  const read = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
  const parked = message('arrived after first Agent initialized before group readiness')
  ctx.sessionQuery.readSession = async id => {
    if (id === handle2.agent.id) {
      assert.equal((await ctx.mbotRuntime.status(agent)).state, 'unavailable')
      agent.followup(parked)
      await agent.whenIdle()
      assert.equal(requests.length, 1)
      throw new Error('second Agent activation failed')
    }
    return read(id)
  }
  t.after(() => { if (ctx.sessionQuery) ctx.sessionQuery.readSession = read })
  const rejected = ctx.plugin(await replacementRuntime())
  await assert.rejects(Promise.resolve(rejected), /second Agent activation failed/u)
  await rejected.dispose()
  ctx.sessionQuery.readSession = read
  assert.equal(agent.inbox.nextTurn[0].id, parked.id)
  await ctx.plugin(await replacementRuntime())
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'failed')
  assert.equal(ctx.mbotRuntime.states.get(agent).failedAuditRunId, priorRun)
  assert.equal(ctx.mbotRuntime.managed(handle2.agent), true)
  assert.equal(requests.length, 1)
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
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'failed')
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '1\n')
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

test('status distinguishes Agent idle from pending audit and the next turn waits for the receipt', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let firstReceiptAtNextCall
  const { ctx, ws, agent, requests } = await app(t, async (_options, count, ctx) => {
    if (count === 1) {
      const lease = ctx.mbotRuntime.dataLease(ctx.agents.list()[0])
      const finish = lease.finish.bind(lease)
      lease.finish = async outcome => { entered.resolve(); await release.promise; return finish(outcome) }
    } else {
      const log = await ctx.sessionQuery.readSession(ctx.agents.list()[0].id)
      firstReceiptAtNextCall = log.events.find(event => event.type === runtime.runtimeRecordType && event.data.phase === 'committed')
    }
    return response('complete')
  })
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('first audited request'))
  await entered.promise
  await agent.whenIdle()
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'auditing')
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  agent.followup(message('second audited request'))
  assert.equal(requests.length, 1)
  release.resolve()
  await settle(ctx, agent)
  assert.equal(requests.length, 2)
  assert.equal(firstReceiptAtNextCall.data.head, git(ws, 'rev-parse', 'HEAD^'))
})

test('commit failure publishes an incomplete audit, preserves the journal and blocks later model calls', { timeout: 30000 }, async t => {
  const { ctx, ws, agent, requests } = await app(t, () => response('model response completed'))
  // Managed Git intentionally disables user hooks. Inject a commit failure
  // in this one bridge process's PATH and keep all other Git operations real.
  const shim = join(root, `failing-commit-${++sequence}`)
  await mkdir(shim)
  await writeFile(join(shim, 'git'), '#!/bin/sh\nfor arg do\n  if [ "$arg" = commit ]; then exit 1; fi\ndone\nexec /usr/bin/git "$@"\n')
  await chmod(join(shim, 'git'), 0o700)
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = spec => spawn(spec.argv[0].endsWith('/bin/mbot-turn')
    ? { ...spec, env: { ...spec.env, PATH: `${shim}:${spec.env.PATH}` } } : spec)
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('respond before host commit'))
  await agent.whenIdle()
  await assert.rejects(ctx.mbotRuntime.settled(agent), /commit/u)
  const status = await ctx.mbotRuntime.status(agent)
  assert.equal(status.state, 'failed')
  assert.equal(status.lastReceipt.phase, 'failed')
  assert.equal(status.lastReceipt.head, undefined)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  assert.equal(JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8')).writerScope, 'agent-runtime')
  const queued = message('must remain pending after failed audit')
  agent.followup(queued)
  await agent.whenIdle()
  assert.equal(requests.length, 1)
  assert.equal(agent.inbox.nextTurn[0].id, queued.id)
})

test('receipt persistence failure retains the verified Git commit and redacts private permit bytes', { timeout: 30000 }, async t => {
  let token
  const { ctx, ws, agent, requests } = await app(t, (_options, _count, ctx) => {
    token = ctx.mbotRuntime.dataLease(ctx.agents.list()[0]).shellEnvironment().DSH_MBOT_PERMIT_TOKEN
    return response('audited result')
  })
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let failed = false
  ctx.sessions.flush = async session => {
    if (!failed && token) { failed = true; throw new Error(`receipt persistence failed ${token}`) }
    return flush(session)
  }
  const base = git(ws, 'rev-parse', 'HEAD')
  agent.followup(message('commit then fail receipt save'))
  await agent.whenIdle()
  await assert.rejects(ctx.mbotRuntime.settled(agent), error => /receipt persistence failed/u.test(error.message) && !error.message.includes(token))
  const status = await ctx.mbotRuntime.status(agent)
  assert.equal(status.state, 'failed')
  assert.equal(status.lastReceipt.phase, 'failed')
  assert.equal(status.lastReceipt.head, git(ws, 'rev-parse', 'HEAD'))
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.ok(!JSON.stringify(status).includes(token))
  const log = await ctx.sessionQuery.readSession(agent.id)
  assert.ok(!JSON.stringify(log.events).includes(token))
  agent.followup(message('do not duplicate the already committed turn'))
  await agent.whenIdle()
  assert.equal(requests.length, 1)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
})

test('/mbot stop joins late writers and audit while retaining native pending input', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { ctx, ws, agent, requests } = await app(t, (_options, count) => count === 1
    ? response('', { name: 'stop_cleanup_writer', args: {} }) : response('queued work done'))
  await ctx.plugin(Commands)
  await ctx.plugin(botCommands)
  const base = git(ws, 'rev-parse', 'HEAD')
  ctx.tools.register(defineTool({ name: 'stop_cleanup_writer', description: 'A foreground writer with cancellation cleanup.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      entered.resolve()
      await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
      await release.promise
      await writeFile(join(ws, 'inbox/stop-cleanup.md'), 'joined stop cleanup\n')
      return 'joined'
    },
  }))
  const dispose = ctx.mbotRuntime.foregroundTool('stop_cleanup_writer')
  t.after(dispose)
  agent.followup(message('begin writer'))
  await entered.promise
  const queued = message('retain this queued request')
  agent.followup(queued)
  let stopped = false
  const stopping = ctx.commands.execute(agent, '/mbot stop', [], new AbortController().signal).then(result => { stopped = true; return result })
  assert.equal(stopped, false)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  release.resolve()
  const result = await stopping
  assert.equal(result.result.kind, 'success', result.result.text)
  assert.match(result.result.text, /Stop completed; queued inputs retained/u)
  assert.equal(agent.inbox.nextTurn[0].id, queued.id)
  assert.equal(requests.length, 1)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.match(git(ws, 'show', 'HEAD:inbox/stop-cleanup.md'), /joined stop cleanup/u)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.reason, 'aborted')
  agent.followup(message('continue queued requests'))
  await settle(ctx, agent)
  assert.equal(requests.length, 3)
})

test('stop returns its captured turn receipt without waiting for work accepted by another window afterward', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers()
  const nextEntered = Promise.withResolvers()
  const releaseNext = Promise.withResolvers()
  t.after(() => releaseNext.resolve())
  const { ctx, agent, requests } = await app(t, async (options, count) => {
    if (count === 1) {
      entered.resolve()
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
    } else {
      nextEntered.resolve()
      await releaseNext.promise
    }
    return response('new work completed')
  })
  agent.followup(message('turn to stop'))
  await entered.promise
  const stopping = ctx.mbotRuntime.stop(agent)
  agent.followup(message('another window submitted after the stop request'))
  const result = await stopping
  assert.equal(result.targetTurn, 1)
  assert.equal(result.receipt.turn, 1)
  assert.equal(result.receipt.reason, 'aborted')
  await nextEntered.promise
  assert.equal(requests.length, 2)
  assert.equal(agent.status, 'running')
  releaseNext.resolve()
  await settle(ctx, agent)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.phase, 'committed')
})

test('three clean user stops preserve earlier failures and the next genuine fault still trips the breaker', { timeout: 30000 }, async t => {
  let entered = Promise.withResolvers()
  const { ctx, ws, agent } = await app(t, async (options, count) => {
    if (count > 3) throw new Error('genuine failure after stopped turns')
    entered.resolve()
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
    return response('cancelled stream')
  })
  await writeFile(join(ws, '.mbot/failures'), '2\n')
  const base = git(ws, 'rev-parse', 'HEAD')
  for (let turn = 1; turn <= 3; turn++) {
    entered = Promise.withResolvers()
    agent.followup(message(`user-stopped turn ${turn}`))
    await entered.promise
    const result = await ctx.mbotRuntime.stop(agent)
    assert.equal(result.receipt.outcome, 'cancelled')
    assert.equal(result.receipt.failureCountEffect, 'preserve')
    assert.equal(result.receipt.success, false, 'Cancelled work is not a completed task')
    assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '2\n')
    assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), String(turn))
    await assert.rejects(readFile(join(ws, '.mbot/PAUSED')), { code: 'ENOENT' })
    const meta = JSON.parse(await readFile(join(ws, result.receipt.meta), 'utf8'))
    assert.equal(meta.runtime.outcome_schema_version, 1)
    assert.equal(meta.runtime.execution_fault, false)
    assert.equal(meta.outcome, 'cancelled')
  }
  agent.followup(message('now fail'))
  await settle(ctx, agent)
  assert.equal((await ctx.mbotRuntime.status(agent)).lastReceipt.outcome, 'failed')
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '3\n')
  assert.match(await readFile(join(ws, '.mbot/PAUSED'), 'utf8'), /three failed/u)
})

test('user stop does not neutralize a guarded memory violation from late tool cleanup', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers()
  const { ctx, ws, agent } = await app(t, () => response('', { name: 'bad_stop_writer', args: {} }))
  const memory = await readFile(join(ws, 'MEMORY.md'), 'utf8')
  ctx.tools.register(defineTool({ name: 'bad_stop_writer', description: 'Fixture cleanup violates protected memory.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute(_args, exec) {
      entered.resolve()
      await new Promise(resolve => exec.signal.addEventListener('abort', resolve, { once: true }))
      await writeFile(join(ws, 'MEMORY.md'), 'forbidden stopped memory edit\n')
      return 'stopped'
    },
  }))
  t.after(ctx.mbotRuntime.foregroundTool('bad_stop_writer'))
  agent.followup(message('stop this violating writer'))
  await entered.promise
  const result = await ctx.mbotRuntime.stop(agent)
  assert.equal(result.receipt.reason, 'aborted')
  assert.equal(result.receipt.outcome, 'failed')
  assert.equal(result.receipt.failureCountEffect, 'increment')
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '1\n')
  assert.equal(await readFile(join(ws, 'MEMORY.md'), 'utf8'), memory)
  const meta = JSON.parse(await readFile(join(ws, result.receipt.meta), 'utf8'))
  assert.ok(meta.violations.some(item => item.path === 'MEMORY.md'))
})

test('a recorded tool error remains a fault when the user stops the following model step', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers()
  const { ctx, ws, agent } = await app(t, async (options, count) => {
    if (count === 1) return response('', { name: 'error_before_stop', args: {} })
    entered.resolve()
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
    return response('stopped after failed tool')
  })
  ctx.tools.register(defineTool({ name: 'error_before_stop', description: 'Fixture reports a genuine error.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute() { throw new Error('genuine tool failure') },
  }))
  t.after(ctx.mbotRuntime.foregroundTool('error_before_stop'))
  agent.followup(message('try the failing tool then stop'))
  await entered.promise
  const result = await ctx.mbotRuntime.stop(agent)
  assert.equal(result.receipt.outcome, 'failed')
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '1\n')
  const meta = JSON.parse(await readFile(join(ws, result.receipt.meta), 'utf8'))
  assert.equal(meta.runtime.execution_fault, true)
})
