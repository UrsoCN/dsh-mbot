import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, chmod, lstat, symlink, unlink } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
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
import Commands from '@deepseek-ai/dsh-commands'
import * as botCommands from '../plugin/commands.js'
import { MessageIndex } from '../plugin/messages.js'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import * as ipc from '../plugin/ipc.js'
import { ipcLocation, profileLocation, requestHost, maxFrameBytes } from '../plugin/ipc-protocol.js'
import { readonlyLegacy } from '../plugin/readonly-migration.js'
import { recoveryInput } from '../plugin/recovery-proof.js'

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
  if (options.main) await ctx.configEditor.edit(entry, current => ({ ...current, registry: { ...current.registry,
    revision: current.registry.revision + 1, bots: current.registry.bots.map(item => item.botId !== bot.botId ? item : {
      ...item, workspaceId: `workspace-${sequence}`, mainSessionId: handle.agent.id,
      binding: { state: 'ready', pendingSessionId: null, error: null },
    }) } }))
  return { ctx, ws, bot, agent: handle.agent, handle, requests, owner, errors }
}

async function settle(ctx, agent) { await agent.whenIdle(); await ctx.mbotRuntime.settled(agent) }

async function removalController(ctx, agent, resolve = async () => ({ agent })) {
  class Controller extends Service {
    constructor(ctx) { super(ctx, 'sessionController') }
    resolveAgent(id) { assert.equal(id, agent.id); return resolve() }
  }
  await ctx.plugin(Controller)
}

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
  await ctx.plugin(runtime)
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

const privateRoute = { visibility: 'owner-private', adapterId: 'test-tg', ownerId: 'verified-owner', conversationKey: 'private-chat', replyRoute: 'chat:owner' }
const mainMailbox = (ctx, agent, changes = {}) => ctx.mbotRuntime.ownerMailbox(agent, { ...privateRoute, ...changes })

async function failedRuntime(t, options = {}) {
  const fixture = await app(t, options.script ?? (() => response('recover this native answer')), { main: true })
  await removalController(fixture.ctx, fixture.agent)
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

test('Runtime recovery joins the native owner, commits the saved answer once and preserves PAUSED and pending work', { timeout: 30000 }, async t => {
  const { ctx, ws, bot, agent, requests, journal, mailbox } = await failedRuntime(t)
  const base = git(ws, 'rev-parse', 'HEAD')
  const input = message('pending work must not execute during recovery')
  agent.inbox.splice('next-turn', 0, 0, [input])
  const recovered = await ctx.mbot.recoverTurn({ botId: bot.botId })
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
  assert.equal((await ctx.mbot.recoverTurn({ botId: bot.botId })).needed, false)
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
  await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /completion contradicts/u)
  assert.equal(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'), before)
  assert.equal(ctx.mbotRuntime.recoveries.size, 0)
  assert.equal(requests.length, 1)
  await writeFile(finishFile, original)
  assert.equal((await ctx.mbot.recoverTurn({ botId: bot.botId })).success, true)
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
  const recovered = await ctx.mbot.recoverTurn({ botId: bot.botId })
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
  const recovered = await ctx.mbot.recoverTurn({ botId: bot.botId })
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
  const repaired = await ctx.mbot.recoverTurn({ botId: bot.botId })
  assert.equal(repaired.receiptRepaired, true)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), committed)
  assert.equal(agent.inbox.nextTurn[0].id, queued.id)
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'idle')
  assert.equal((await mailbox.receipt('repair-native-receipt')).result.final, true)
  assert.equal((await ctx.mbot.recoverTurn({ botId: bot.botId })).needed, false)
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
  await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /awaits native receipt/u)
  ctx.sessions.flush = flush
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal((await ctx.mbotRuntime.status(agent)).state, 'failed')
  assert.equal((await ctx.mbot.recoverTurn({ botId: bot.botId })).receiptRepaired, true)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal((await mailbox.receipt('runtime-recover-request')).result.final, true)
})

for (const crash of ['commit', 'settlement']) {
  test(`Runtime recovery settles the original Git commit once after SIGKILL at ${crash}`, { timeout: 30000 }, async t => {
    const { ctx, ws, bot, journal, mailbox, requests } = await failedRuntime(t, { crash })
    const committed = git(ws, 'rev-parse', 'HEAD')
    assert.equal((await mailbox.receipt('runtime-recover-request')).result.final, false)
    const recovered = await ctx.mbot.recoverTurn({ botId: bot.botId })
    assert.equal(recovered.alreadyCommitted, true)
    assert.equal(recovered.runId, journal.runId)
    assert.equal(recovered.success, true)
    assert.equal(git(ws, 'rev-parse', 'HEAD'), committed)
    assert.equal((await mailbox.receipt('runtime-recover-request')).result.final, true)
    assert.equal((await ctx.mbot.recoverTurn({ botId: bot.botId })).needed, false)
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
  const result = await ctx.mbot.recoverTurn({ botId: bot.botId })
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
  await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /other Host/u)
  assert.equal(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'), before)
  assert.equal(ctx.mbotRuntime.recoveries.size, 0)
  ctx.sessionController.resolveAgent = resolve
  await owner.dispose()
  await ctx.plugin(runtime)
  const headerFile = join(journal.scratch, 'header.json')
  const header = JSON.parse(await readFile(headerFile, 'utf8'))
  const bad = { ...journal, runtimeOwnership: { ...journal.runtimeOwnership, workerDepth: 1 } }
  await writeFile(headerFile, JSON.stringify({ ...header, runtimeOwnership: bad.runtimeOwnership }))
  await writeFile(join(journal.scratch, 'ledger.json'), JSON.stringify(bad))
  await writeFile(join(ws, '.mbot/runs/active-turn.json'), JSON.stringify(bad))
  const changed = await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8')
  await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /Unsupported Runtime writer ownership/u)
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
  await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /permit-bearing process/u)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), before)
  assert.ok(await lstat(join(ws, '.mbot/runs/active-turn.json')))
  child.kill()
  await ended
  assert.equal((await ctx.mbot.recoverTurn({ botId: bot.botId })).success, true)
})

test('Runtime recovery refuses an executing Agent without cancelling it', { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { ctx, bot, agent } = await app(t, async () => { entered.resolve(); await release.promise; return response('live turn settled normally') }, { main: true })
  await removalController(ctx, agent)
  agent.followup(message('do not interrupt this active turn'))
  await entered.promise
  await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /still executing/u)
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
  await owner.dispose(); await ctx.plugin(runtime)
  const recovered = await ctx.mbot.recoverTurn({ botId: bot.botId })
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
