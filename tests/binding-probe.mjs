// Runs inside the real, isolated Web Harness after installation acceptance.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { setImmediate } from 'node:timers/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['mbot', 'mbotRuntime', 'workspaceController', 'workspaceRegistry', 'sessionController', 'sessions', 'sessionQuery', 'llm', 'appExit']
export function apply(ctx) { void setImmediate().then(() => probe(ctx)) }

async function probe(ctx) {
  const evidence = { success: false }
  let lock
  try {
    const path = process.env.MBOT_BINDING_WS
    const rename = ctx.sessionController.rename.bind(ctx.sessionController)
    let fail = true
    ctx.sessionController.rename = request => {
      if (fail) { fail = false; throw new Error('injected rename interruption\nretry preserves the reservation') }
      return rename(request)
    }
    let initial
    try { initial = await ctx.mbot.initialize(path) }
    finally { ctx.sessionController.rename = rename }
    assert.equal(initial.exitCode, 1)
    assert.match(initial.stderr, /rename interruption/u)
    const failed = ctx.mbot.registry().bots.find(bot => bot.workspacePath === path)
    assert.equal(failed.binding.state, 'failed')
    assert.equal(failed.mainSessionId, null)
    assert.ok(failed.workspaceId && failed.binding.pendingSessionId)
    const pendingId = failed.binding.pendingSessionId
    const resolved = await ctx.sessionController.resolveAgent(pendingId)
    assert.ok('agent' in resolved)
    assert.ok(ctx.mbotRuntime.managed(resolved.agent))
    assert.equal(resolved.agent.session.header.cwd, path)
    assert.ok(!(await ctx.sessionQuery.readSession(pendingId)).events.some(event => event.type === 'turn/start'))
    let modelCalls = 0
    const errors = []
    const stopErrors = ctx.on('agent/error', ({ agent, error }) => { if (agent.id === pendingId) errors.push(error) })
    const stop = ctx.on('llm/before-request', () => { modelCalls++ })
    resolved.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'park until binding repair' }], source: { kind: 'user' } }))
    await resolved.agent.whenIdle()
    assert.equal(modelCalls, 0, 'A reserved/failed Session must not execute business turns')
    assert.ok(errors.some(error => /binding needs \/mbot repair/u.test(error.message)), 'Setup gate must be the reason admission failed')
    assert.equal(resolved.agent.inbox.nextTurn.length, 1, 'Failed setup must retain accepted input')
    resolved.agent.inbox.clear()
    stop()
    stopErrors()
    const before = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    const count = ctx.workspaceRegistry.get(failed.workspaceId).sessionIds.length
    const [a, b] = await Promise.all([ctx.mbot.ensureBinding(failed.botId), ctx.mbot.ensureBinding(failed.botId)])
    assert.equal(a.mainSessionId, pendingId)
    assert.equal(b.mainSessionId, pendingId)
    assert.equal(a.binding.state, 'ready')
    assert.equal(ctx.workspaceRegistry.get(a.workspaceId).sessionIds.length, count)
    assert.equal(execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), before)
    assert.equal(execFileSync('git', ['-C', path, 'status', '--porcelain'], { encoding: 'utf8' }), '')
    const title = await ctx.sessionController.rename({ sessionId: pendingId, title: 'User-owned title' })
    await ctx.mbot.ensureBinding(a.botId)
    assert.equal((await ctx.sessionQuery.readSession(pendingId)).events.findLast(event => event.type === 'session/title').data.title, title.title)

    // A data writer in a separate process must exclude native binding too.
    lock = spawn('flock', [join(path, '.mbot', 'lock'), 'sh', '-c', 'printf ready; cat >/dev/null'], { stdio: 'pipe' })
    lock.finished = new Promise(resolve => lock.once('exit', resolve))
    await new Promise((resolve, reject) => { lock.once('error', reject); lock.stdout.once('data', resolve) })
    const registry = ctx.mbot.registry()
    await assert.rejects(ctx.mbot.ensureBinding(a.botId), /busy/u)
    assert.equal((await ctx.mbot.resolveMainSession(a.botId)).mainSessionId, pendingId, 'Opening a ready main must not need a data writer lock')
    assert.deepEqual(ctx.mbot.registry(), registry)
    lock.stdin.end()
    await lock.finished
    lock = undefined

    // Archival refuses repair without replacement; restoration reuses the ID.
    await ctx.workspaceController.archiveSession({ sessionId: pendingId })
    await assert.rejects(ctx.mbot.ensureBinding(a.botId), /archived/u)
    assert.equal(ctx.mbot.bot({ botId: a.botId }).mainSessionId, pendingId)
    await ctx.workspaceController.unarchiveSession({ sessionId: pendingId })
    assert.equal((await ctx.mbot.ensureBinding(a.botId)).mainSessionId, pendingId)

    // A writer-held response cannot fall through to create a second main.
    const resolve = ctx.sessionController.resolveAgent.bind(ctx.sessionController)
    const createSession = ctx.sessionController.create.bind(ctx.sessionController)
    let creations = 0
    ctx.sessionController.resolveAgent = async () => ({ error: Object.assign(new Error('injected writer-held refusal'), { code: 'session/writer-held' }) })
    ctx.sessionController.create = async request => { creations++; return createSession(request) }
    try { await assert.rejects(ctx.mbot.ensureBinding(a.botId), /writer-held/u) }
    finally { ctx.sessionController.resolveAgent = resolve; ctx.sessionController.create = createSession }
    assert.equal(creations, 0)
    assert.equal(ctx.mbot.bot({ botId: a.botId }).mainSessionId, pendingId)
    assert.equal((await ctx.mbot.ensureBinding(a.botId)).mainSessionId, pendingId)

    // A newer selection/settings edit during a native operation is preserved.
    const create = ctx.workspaceController.create.bind(ctx.workspaceController)
    let edited = false
    ctx.workspaceController.create = async request => {
      const result = await create(request)
      if (!edited) {
        edited = true
        const { editor, entry } = ctx.mbot.configurationEntry()
        await editor.edit(entry, current => ({ ...current, workspace: '', registry: {
          ...current.registry, revision: current.registry.revision + 1, selectedBotId: null,
        } }))
      }
      return result
    }
    try { await ctx.mbot.ensureBinding(a.botId) }
    finally { ctx.workspaceController.create = create }
    assert.equal(ctx.mbot.registry().selectedBotId, null)
    assert.equal(ctx.mbot.config.workspace.get(), '')
    assert.equal(ctx.mbot.bot({ sessionId: pendingId }).botId, a.botId)
    evidence.success = true
    evidence.bot = ctx.mbot.bot({ botId: a.botId })
    evidence.checks = ['partial-native-create', 'reserved-agent-managed', 'failed-binding-gate', 'concurrent-repair', 'title-preserved', 'cross-process-lock', 'archive-restore', 'injected-writer-held-refusal', 'selection-CAS', 'data-unchanged', 'no-model-init']
    // Deleting a native workspace leaves its Bot identity explicit. Retirement
    // uses the real Controller, retaining the old Agent gate and data history.
    await ctx.workspaceController.delete({ workspaceId: a.workspaceId })
    assert.ok(ctx.mbot.registry().bots.some(bot => bot.botId === a.botId))
    const retired = await ctx.mbot.removeBot(a.botId)
    assert.ok(retired.sessionIds.includes(pendingId))
    assert.ok(!ctx.mbot.registry().bots.some(bot => bot.botId === a.botId))
    assert.equal((await ctx.mbotRuntime.status(resolved.agent)).state, 'retired')
    assert.equal(execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), before)
    assert.ok((await ctx.sessionQuery.readSession(pendingId)).events.length > 0)
    const imported = await ctx.mbot.importBot(path)
    assert.notEqual(imported.botId, a.botId)
    const newMain = await ctx.mbot.ensureBinding(imported.botId)
    assert.notEqual(newMain.mainSessionId, pendingId)
    evidence.retired = retired
    evidence.checks.push('native-workspace-delete', 'persistent-retirement', 'data-and-history-retained', 'reimport-new-main')
  } catch (error) { evidence.error = error.stack ?? String(error) }
  finally {
    if (lock) { lock.stdin.end(); lock.kill('SIGTERM'); await lock.finished }
    await writeFile(process.env.MBOT_BINDING_RESULT, JSON.stringify(evidence, null, 2))
    ctx.appExit(evidence.success ? 0 : 1)
  }
}
