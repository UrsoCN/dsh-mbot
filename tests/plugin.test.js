import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, access, writeFile, mkdir, symlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { Context, Service } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Commands from '@deepseek-ai/dsh-commands'
import { Session } from '@deepseek-ai/dsh-session'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as plugin from '../plugin/index.js'
import * as tools from '../plugin/tools.js'
import * as commands from '../plugin/commands.js'
import { redact } from '../plugin/redact.js'

const root = await mkdtemp('/tmp/mbot-plugin-tests.')
process.env.XDG_CONFIG_HOME = join(root, 'config')
process.env.DSH_HOME = join(root, 'dsh')
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'mbot plugin tests'
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'mbot-tests@example.invalid'
delete process.env.MBOT_RUN_ID
delete process.env.MBOT_WS
let seq = 0

async function app(t) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocess)
  let mode = 'danger-full-access'
  class Policy extends Service {
    constructor(ctx) { super(ctx, 'sandboxPolicy') }
    resolve() { return { mode, workspaceRoot: root } }
  }
  await ctx.plugin(Policy)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(nativeExecutor)
  await ctx.plugin(Commands)
  const ws = join(root, `workspace ${++seq}`)
  const owner = ctx.plugin(plugin, { workspace: ws })
  await owner
  await ctx.plugin(tools)
  await ctx.plugin(commands)
  const result = await ctx.mbot.execute('mbot', ['init'])
  assert.equal(result.exitCode, 0, result.stderr)
  return { ctx, ws, owner, mode: value => { mode = value } }
}

function git(ws, ...args) { return execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8' }).trim() }
async function call(ctx, args, extra = {}) {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: `mbot-test-${++seq}`, name: 'botctl', arguments: JSON.stringify(args) }],
    signal: new AbortController().signal, ...extra })
  return batch.results[0].result
}
function text(result) { return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }

test('native tool pipeline builds a task, enforces blocked reason and leaves memory unchanged', async t => {
  const { ctx, ws } = await app(t)
  const memory = await readFile(join(ws, 'MEMORY.md'), 'utf8')
  const created = await call(ctx, { action: 'board_add', text: 'native tool task', owner: 'coder' })
  assert.equal(created.isError, false)
  assert.match(text(created), /001/u)
  assert.match(git(ws, 'log', '-1', '--format=%s'), /^human: board add 001/u)
  assert.equal((await call(ctx, { action: 'board_set', task_id: '001', state: 'blocked' })).isError, true)
  assert.equal((await call(ctx, { action: 'board_set', task_id: '001', state: 'blocked', reason: 'external dependency' })).isError, false)
  assert.equal((await call(ctx, { action: 'task_result', task_id: '001', text: 'line one\n## literal section\nline three', as: 'coder' })).isError, false)
  assert.equal((await call(ctx, { action: 'remember', text: 'native candidate', as: 'chief', task_id: '001' })).isError, false)
  assert.equal(await readFile(join(ws, 'MEMORY.md'), 'utf8'), memory)
  assert.equal((await call(ctx, { action: 'lint' })).isError, false)
  assert.equal(git(ws, 'status', '--porcelain'), '')
  assert.equal(git(ws, 'check-ignore', '.env', '.mbot/runs/sample.jsonl'), '.env\n.mbot/runs/sample.jsonl')
})

test('host tool permission refusal happens before any mutation, even for agentless calls', async t => {
  const { ctx, ws, mode } = await app(t)
  const head = git(ws, 'rev-parse', 'HEAD')
  for (const value of ['read-only', 'workspace-write']) {
    mode(value)
    const result = await call(ctx, { action: 'board_add', text: 'must be denied' })
    assert.equal(result.isError, true)
    assert.match(text(result), /approval|escalat/iu)
    assert.equal(git(ws, 'rev-parse', 'HEAD'), head)
  }
})

test('one-call approval authorizes a host operation without changing the session mode', async t => {
  const { ctx, ws, mode } = await app(t)
  mode('workspace-write')
  const requests = []
  class Approval extends Service {
    constructor(ctx) { super(ctx, 'approval') }
    async request(request) { requests.push(request); return 'allowed-once' }
  }
  await ctx.plugin(Approval)
  const definition = ctx.tools.get('botctl')
  const agent = { session: {} }
  await definition.execute({ action: 'board_add', text: 'approved operation' }, { agent, callId: 'approval-call', signal: new AbortController().signal })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].toolName, 'botctl')
  assert.equal(ctx.sandboxPolicy.resolve().mode, 'workspace-write')
  assert.match(await readFile(join(ws, 'BOARD.md'), 'utf8'), /approved operation/u)
})

test('schema and argument errors cannot execute shell input or host run/dream actions', async t => {
  const { ctx, ws } = await app(t)
  const head = git(ws, 'rev-parse', 'HEAD')
  for (const request of [{ action: 'run', text: 'forbidden' }, { action: 'board_add' },
    { action: 'board_set', task_id: '001', state: 'oops' }, { action: 'remember', text: '--help' }]) {
    assert.equal((await call(ctx, request)).isError, true)
  }
  assert.equal(git(ws, 'rev-parse', 'HEAD'), head)
  const marker = join(root, 'shell-injection')
  const literal = `$(touch ${marker}) backticks \`false\``
  assert.equal((await call(ctx, { action: 'board_add', text: literal })).isError, false)
  assert.match(await readFile(join(ws, 'BOARD.md'), 'utf8'), /\$\(touch /u)
  await assert.rejects(access(marker))
})

test('managed runs cannot use native tools or human controls to bypass the Bash guard', async t => {
  const { ctx, ws } = await app(t)
  process.env.MBOT_RUN_ID = 'inside-managed-run'
  try {
    assert.equal((await call(ctx, { action: 'board_add', text: 'forbidden' })).isError, true)
    const command = ctx.commands.find({}, 'mbot')
    assert.equal((await command.handler({ rawInput: 'dream', signal: new AbortController().signal })).kind, 'error')
    assert.equal(git(ws, 'log', '-1', '--format=%s'), 'human: init')
  } finally { delete process.env.MBOT_RUN_ID }
})

test('slash commands execute without a model and treat request text literally', async t => {
  const { ctx } = await app(t)
  const command = ctx.commands.find({}, 'mbot')
  assert.equal(command.recordInput, false)
  const status = await command.handler({ rawInput: 'status', signal: new AbortController().signal })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /Workspace: /u)
  assert.equal((await command.handler({ rawInput: 'unknown', signal: new AbortController().signal })).kind, 'error')
  assert.deepEqual(commands.commandArgs('run say hello; $(touch /tmp/should-not-execute)'), { program: 'mbot', argv: ['run', 'chief', 'say hello; $(touch /tmp/should-not-execute)'] })
  assert.deepEqual(commands.commandArgs('init /tmp/path with spaces'), { program: 'mbot', argv: ['init', '/tmp/path with spaces'] })
  assert.deepEqual(commands.commandArgs('recover'), { program: 'host', argv: ['recover'] })
})

test('commands.execute persists native lifecycle events without model-visible content', async t => {
  const { ctx } = await app(t)
  const session = Session.create('mbot-command-lifecycle')
  const agent = { session }
  const signal = new AbortController().signal
  for (const line of ['/mbot status', '/mbot unknown', '/mbot help']) {
    const execution = await ctx.commands.execute(agent, line, [], signal)
    assert.ok(execution.result.text)
    const [run, done] = session.snapshotEvents().slice(-2)
    assert.equal(run.type, 'command/run')
    assert.equal(done.type, 'command/done')
    assert.equal(run.data.commandId, done.data.commandId)
    assert.equal(done.data.text, execution.result.text)
    assert.equal(run.data.args, undefined)
  }
  assert.ok(session.snapshotEvents().every(event => event.type.startsWith('command/')))
  assert.equal(session.surface.nodes.length, 0)
})

test('command lifecycle exposes running work and settles cancellation as a visible error', async t => {
  const { ctx } = await app(t)
  const session = Session.create('mbot-cancel-command')
  const controller = new AbortController()
  const entered = Promise.withResolvers()
  ctx.mbot.execute = (_program, _args, { signal }) => new Promise((_resolve, reject) => {
    entered.resolve()
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const execution = ctx.commands.execute({ session }, '/mbot status', [], controller.signal)
  await entered.promise
  assert.equal(session.snapshotEvents().at(-1).type, 'command/run')
  controller.abort(new Error('cancelled'))
  await assert.rejects(execution, /cancelled/u)
  const settled = session.snapshotEvents().at(-1)
  assert.equal(settled.type, 'command/done')
  assert.equal(settled.data.kind, 'error')
  assert.match(settled.data.text, /cancelled/iu)
})

async function configEditor(ctx, owner, initial) {
  await owner.dispose()
  class MemoryLoader extends Loader { commit() {} }
  await ctx.plugin(MemoryLoader)
  ctx.loader.builtins['mbot-selection'] = plugin
  const id = await ctx.loader.create({ name: 'cordis:mbot-selection', config: { workspace: initial } })
  await ctx.loader.await()
  let raw = { workspace: initial }
  let fail = false
  const entry = ctx.loader.resolve(id)
  class Editor extends Service {
    constructor(ctx) { super(ctx, 'configEditor') }
    entries() { return [entry] }
    async edit(target, change) {
      assert.equal(target.fiber.uid, entry.fiber.uid)
      const next = change(raw, {})
      if (fail) throw new Error('disk write failed')
      entry.fiber.resolveConfig(next)
      await ctx.loader.update(id, { config: next })
      raw = next
    }
  }
  await ctx.plugin(Editor)
  return { raw: () => structuredClone(raw), fail: () => { fail = true }, edit: change => ctx.configEditor.edit(entry, change),
    update: async path => { raw = { workspace: path }; await ctx.loader.update(id, { config: raw }) } }
}

test('init selects a canonical Unicode directory and failed init keeps the previous selection', async t => {
  const { ctx, ws, owner } = await app(t)
  const editor = await configEditor(ctx, owner, ws)
  const directory = join(root, '文档', 'bot with spaces')
  const agent = { session: Session.create('mbot-init-command') }
  const signal = new AbortController().signal
  const result = await ctx.commands.execute(agent, `/mbot init ${directory}/../bot with spaces`, [], signal)
  assert.equal(result.result.kind, 'success', result.result.text)
  assert.match(result.result.text, /Next: \/mbot status/u)
  assert.equal(editor.raw().workspace, directory)
  assert.equal(editor.raw().registry.bots.length, 1)
  assert.equal(editor.raw().registry.bots[0].workspacePath, directory)
  assert.equal(editor.raw().registry.selectedBotId, editor.raw().registry.bots[0].botId)
  assert.equal(ctx.mbot.workspace(), directory)
  const status = await ctx.commands.execute(agent, '/mbot status', [], signal)
  assert.ok(status.result.text.includes(`Workspace: ${directory}`))
  assert.equal((await ctx.mbot.initialize(directory)).exitCode, 1)
  assert.equal(ctx.mbot.workspace(), directory)
  assert.equal(git(directory, 'status', '--porcelain'), '')
})

test('selection persistence failure retains the old config and reports the initialized repository', async t => {
  const { ctx, ws, owner } = await app(t)
  const editor = await configEditor(ctx, owner, ws)
  editor.fail()
  const directory = join(root, 'unsaved init')
  const result = await ctx.mbot.initialize(directory)
  assert.equal(result.exitCode, 1)
  assert.match(result.stdout, /Initialized/u)
  assert.match(result.stderr, /selection was not saved: disk write failed/u)
  assert.equal(ctx.mbot.workspace(), ws)
  assert.equal(git(directory, 'log', '-1', '--format=%s'), 'human: init')
})

test('parallel init is serialized and does not overwrite a concurrent configuration edit', async t => {
  const { ctx, ws, owner } = await app(t)
  const editor = await configEditor(ctx, owner, ws)
  const paths = [join(root, 'queued A'), join(root, 'queued B')]
  const results = await Promise.all(paths.map(path => ctx.mbot.initialize(path)))
  assert.ok(results.every(result => result.exitCode === 0))
  assert.equal(ctx.mbot.workspace(), paths[1])
  const original = ctx.mbot.execute.bind(ctx.mbot)
  ctx.mbot.execute = async (...args) => {
    const result = await original(...args)
    await editor.update(ws)
    return result
  }
  const changed = await ctx.mbot.initialize(join(root, 'selection conflict'))
  assert.equal(changed.exitCode, 1)
  assert.match(changed.stderr, /newer selection retained/u)
  assert.equal(ctx.mbot.workspace(), ws)
})

test('import preserves an existing dirty repository and deduplicates canonical directory aliases', async t => {
  const { ctx, ws, owner } = await app(t)
  const editor = await configEditor(ctx, owner, ws)
  await writeFile(join(ws, 'user-notes.txt'), 'keep this untracked file\n')
  const head = git(ws, 'rev-parse', 'HEAD')
  const status = git(ws, 'status', '--porcelain')
  const memory = await readFile(join(ws, 'MEMORY.md'))
  const bot = await ctx.mbot.importBot(ws, { name: '源', defaultRole: 'coder' })
  assert.equal(bot.defaultRole, 'coder')
  assert.equal(bot.workspaceId, null)
  assert.equal(bot.mainSessionId, null)
  assert.equal(ctx.mbot.registry().selectedBotId, null)
  const revision = ctx.mbot.registry().revision
  const alias = join(root, `import-alias-${++seq}`)
  await symlink(ws, alias)
  assert.equal((await ctx.mbot.importBot(alias)).botId, bot.botId)
  assert.equal(ctx.mbot.registry().revision, revision)
  assert.equal(editor.raw().registry.bots.length, 1)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), head)
  assert.equal(git(ws, 'status', '--porcelain'), status)
  assert.deepEqual(await readFile(join(ws, 'MEMORY.md')), memory)
  await assert.rejects(ctx.mbot.importBot(alias, { name: 'different' }), /already registered/u)
  const snapshot = ctx.mbot.registry()
  snapshot.bots[0].name = 'external mutation'
  assert.equal(ctx.mbot.registry().bots[0].name, '源')
})

test('default names remain unique across directories and import errors leave the registry unchanged', async t => {
  const { ctx, ws, owner } = await app(t)
  await configEditor(ctx, owner, ws)
  const prefix = join(root, `duplicate-names-${++seq}`)
  const paths = [join(prefix, 'A', 'bot demo'), join(prefix, 'B', 'bot demo')]
  for (const path of paths) assert.equal((await ctx.mbot.initialize(path)).exitCode, 0)
  assert.deepEqual(ctx.mbot.registry().bots.map(bot => bot.name), ['bot demo', 'bot demo (2)'])
  const before = ctx.mbot.registry()
  await assert.rejects(ctx.mbot.importBot(ws, { name: 'bot demo' }), /Duplicate Bot name/u)
  await assert.rejects(ctx.mbot.importBot(ws, { defaultRole: 'missing-role' }), /unknown bot/u)
  await assert.rejects(ctx.mbot.importBot(join(prefix, 'missing')), /ENOENT/u)
  await assert.rejects(ctx.mbot.importBot(root), /independent Git repository/u)
  await assert.rejects(ctx.mbot.selectBot('unknown'), /Unknown Bot/u)
  assert.deepEqual(ctx.mbot.registry(), before)
})

test('bound commands and native tools stay on A when another window selects B', async t => {
  const { ctx, ws, owner } = await app(t)
  const editor = await configEditor(ctx, owner, ws)
  const a = await ctx.mbot.importBot(ws, { name: 'A' })
  const other = join(root, `bound-B-${++seq}`)
  assert.equal((await ctx.mbot.initialize(other)).exitCode, 0)
  const b = ctx.mbot.bot()
  await editor.edit(current => ({ ...current, registry: { ...current.registry, revision: current.registry.revision + 1,
    bots: current.registry.bots.map(bot => bot.botId === a.botId ? { ...bot, workspaceId: 'workspace-A', mainSessionId: 'session-A' } : bot) } }))
  assert.equal(ctx.mbot.workspace(), b.workspacePath)
  assert.equal(ctx.mbot.workspace({ sessionId: 'session-A' }), ws)
  const agent = { id: 'session-A', session: Session.create('session-A') }
  const signal = new AbortController().signal
  const status = await ctx.commands.execute(agent, '/mbot status', [], signal)
  assert.ok(status.result.text.includes(`Bot: A (${a.botId})`))
  assert.ok(status.result.text.includes(`Workspace: ${ws}`))
  await ctx.tools.get('botctl').execute({ action: 'board_add', text: 'bound A task' }, { agent, signal, callId: 'bound-A-tool' })
  assert.match(await readFile(join(ws, 'BOARD.md'), 'utf8'), /bound A task/u)
  assert.doesNotMatch(await readFile(join(other, 'BOARD.md'), 'utf8'), /bound A task/u)
  const command = await ctx.commands.execute(agent, '/mbot select A', [], signal)
  assert.equal(command.result.kind, 'success')
  await ctx.mbot.selectBot(b.botId)
  assert.equal(ctx.mbot.workspace({ sessionId: 'session-A' }), ws)
})

test('pending native-tool approval retains the captured Bot directory', async t => {
  const { ctx, ws, owner, mode } = await app(t)
  await configEditor(ctx, owner, ws)
  const a = await ctx.mbot.importBot(ws, { name: 'approval A' })
  const other = join(root, `approval-B-${++seq}`)
  assert.equal((await ctx.mbot.initialize(other)).exitCode, 0)
  const b = ctx.mbot.bot()
  await ctx.mbot.selectBot(a.botId)
  mode('workspace-write')
  const entered = Promise.withResolvers()
  const approval = Promise.withResolvers()
  class Approval extends Service {
    constructor(ctx) { super(ctx, 'approval') }
    request() { entered.resolve(); return approval.promise }
  }
  await ctx.plugin(Approval)
  const operation = ctx.tools.get('botctl').execute({ action: 'board_add', text: 'captured A' },
    { agent: { session: {} }, signal: new AbortController().signal, callId: 'captured-A' })
  await entered.promise
  await ctx.mbot.selectBot(b.botId)
  approval.resolve('allowed-once')
  await operation
  assert.match(await readFile(join(ws, 'BOARD.md'), 'utf8'), /captured A/u)
  assert.doesNotMatch(await readFile(join(other, 'BOARD.md'), 'utf8'), /captured A/u)
})

test('registry revisions and invalid persisted references reject without changing effective selection', async t => {
  const { ctx, ws, owner } = await app(t)
  const editor = await configEditor(ctx, owner, ws)
  const bot = await ctx.mbot.importBot(ws, { name: 'revision bot' })
  const stale = ctx.mbot.registry().revision
  await ctx.mbot.selectBot(bot.botId, { revision: stale })
  const before = ctx.mbot.registry()
  await assert.rejects(ctx.mbot.selectBot(bot.botId, { revision: stale }), /registry changed/u)
  for (const change of [
    registry => ({ ...registry, schemaVersion: 2 }),
    registry => ({ ...registry, selectedBotId: 'bot-00000000-0000-0000-0000-000000000000' }),
    registry => ({ ...registry, bots: [...registry.bots, registry.bots[0]] }),
    registry => ({ ...registry, bots: registry.bots.map(bot => ({ ...bot, mainSessionId: 'unbound-session' })) }),
  ]) {
    await assert.rejects(editor.edit(current => ({ ...current, registry: change(current.registry) })))
    assert.deepEqual(ctx.mbot.registry(), before)
  }
  assert.equal(ctx.mbot.workspace(), ws)
})

test('managed turn pins context, lets its tools mutate without requeue, and makes one audited commit', async t => {
  const { ctx, ws, owner } = await app(t)
  await configEditor(ctx, owner, ws)
  const bot = await ctx.mbot.importBot(ws)
  const base = git(ws, 'rev-parse', 'HEAD')
  const lease = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'managed-session', turn: 1, request: 'create a task', requestIds: ['request-one'] })
  assert.equal(lease.snapshot.head, base)
  assert.equal(lease.snapshot.memory, await readFile(join(ws, 'MEMORY.md'), 'utf8'))
  assert.ok(Object.isFrozen(lease.snapshot))
  assert.equal((await lease.execute('botctl', ['board', 'add', 'managed task'])).exitCode, 0)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  assert.equal((await lease.execute('botctl', ['remember', 'managed candidate', '--as', 'chief'])).exitCode, 0)
  const finish = lease.finish({ reason: { kind: 'completed' }, text: 'task created' })
  assert.equal(lease.finish({ reason: { kind: 'error' }, text: 'duplicate finish' }), finish)
  const result = await finish
  assert.equal(result.success, true)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal(git(ws, 'status', '--porcelain'), '')
  const meta = JSON.parse(await readFile(join(ws, result.meta), 'utf8'))
  assert.equal(meta.base_head, base)
  assert.equal(meta.runtime.bot_id, bot.botId)
  assert.equal(meta.session_id, 'managed-session')
  assert.deepEqual(meta.runtime.request_ids, ['request-one'])
  await assert.rejects(lease.execute('botctl', ['board', 'add', 'late task']), /closed/u)
  await assert.rejects(access(join(ws, '.mbot/runs/active-turn.json')))
})

test('managed turn rejects stale permits and restores forbidden memory and HEAD changes', async t => {
  const { ctx, ws, owner } = await app(t)
  await configEditor(ctx, owner, ws)
  const bot = await ctx.mbot.importBot(ws)
  const base = git(ws, 'rev-parse', 'HEAD')
  const original = await readFile(join(ws, 'MEMORY.md'), 'utf8')
  const lease = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'guard-session', turn: 1, request: 'guard test' })
  const permit = JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'))
  await writeFile(join(ws, 'MEMORY.md'), 'forbidden memory overwrite\n')
  git(ws, 'add', 'MEMORY.md')
  git(ws, 'commit', '-m', 'illegal Agent commit')
  const result = await lease.finish({ reason: { kind: 'completed' }, text: 'claimed success' })
  assert.equal(result.success, false)
  assert.equal(await readFile(join(ws, 'MEMORY.md'), 'utf8'), original)
  assert.equal(git(ws, 'rev-parse', 'HEAD^'), base)
  assert.equal(git(ws, 'status', '--porcelain'), '')
  const meta = JSON.parse(await readFile(join(ws, result.meta), 'utf8'))
  assert.ok(meta.violations.some(value => value.reason === 'head_moved'))
  assert.ok(meta.violations.some(value => value.path === 'MEMORY.md'))
  const stale = await ctx.mbot.execute('botctl', ['board', 'add', 'late token'], { workspace: ws, permit: { runId: permit.runId, token: permit.token } })
  assert.equal(stale.exitCode, 1)
  assert.match(stale.stderr, /no longer active/u)
})

test('another Host waits for the Bot lease and queued cancellation does not start a turn', async t => {
  const first = await app(t)
  await configEditor(first.ctx, first.owner, first.ws)
  const bot = await first.ctx.mbot.importBot(first.ws)
  const second = await app(t)
  await configEditor(second.ctx, second.owner, second.ws)
  const other = await second.ctx.mbot.importBot(first.ws)
  const lease = await first.ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'first-writer', turn: 1, request: 'first' })
  const abort = new AbortController()
  const waiting = second.ctx.mbot.beginTurn({ botId: other.botId, sessionId: 'second-writer', turn: 1, request: 'second', signal: abort.signal })
  await new Promise(resolve => setTimeout(resolve, 100))
  abort.abort(new Error('queue cancelled'))
  await assert.rejects(waiting)
  assert.equal((await lease.finish({ reason: { kind: 'completed' }, text: 'first done' })).success, true)
  const next = await second.ctx.mbot.beginTurn({ botId: other.botId, sessionId: 'second-writer', turn: 2, request: 'after lease' })
  assert.equal((await next.finish({ reason: { kind: 'completed' }, text: 'next done' })).success, true)
})

test('managed audit records Session tool/usage events and redacts private credential literals', async t => {
  const { ctx, ws, owner } = await app(t)
  await configEditor(ctx, owner, ws)
  const bot = await ctx.mbot.importBot(ws)
  const secret = 'managed-private-credential-123456'
  await writeFile(join(ws, '.env'), `DEEPSEEK_API_KEY=${secret}\n`)
  const lease = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'audit-session', turn: 1, request: `request ${secret}` })
  await lease.record({ type: 'tool/call', seq: 1, time: Date.now(), data: { turn: 1, step: 1, callId: 'audit-tool', name: 'botctl', arguments: JSON.stringify({ action: 'remember', text: secret }) } })
  await lease.record({ type: 'tool/result', seq: 2, time: Date.now(), data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: secret }] } } })
  await lease.record({ type: 'assistant/message', seq: 3, time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 8, totalTokens: 15 } } })
  const result = await lease.finish({ reason: { kind: 'completed' }, text: secret })
  const meta = await readFile(join(ws, result.meta), 'utf8')
  const transcript = await readFile(join(ws, result.transcript), 'utf8')
  assert.doesNotMatch(meta + transcript, new RegExp(secret, 'u'))
  assert.match(transcript, /\[REDACTED\]/u)
  assert.match(transcript, /botctl/u)
  assert.equal(JSON.parse(meta).usage.total_tokens, 15)
  assert.ok((await readFile(join(ws, '.mbot/runs', `${result.runId}.session.jsonl`), 'utf8')).includes(secret))
})

test('managed cancellation joins a waiting data tool before auditing and releasing the lease', async t => {
  const { ctx, ws, owner } = await app(t)
  await configEditor(ctx, owner, ws)
  const bot = await ctx.mbot.importBot(ws)
  const lease = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'cancel-session', turn: 1, request: 'cancel work' })
  const blocker = spawn('flock', [join(ws, '.mbot/botctl.lock'), 'sh', '-c', 'printf ready; cat'], { stdio: 'pipe' })
  t.after(() => blocker.kill('SIGKILL'))
  await new Promise(resolve => blocker.stdout.once('data', resolve))
  const pending = assert.rejects(lease.execute('botctl', ['board', 'add', 'must not complete']), /Managed turn cancelled/u)
  await new Promise(resolve => setTimeout(resolve, 100))
  const completion = lease.cancel()
  blocker.stdin.end()
  await pending
  assert.equal((await completion).success, false)
  assert.doesNotMatch(await readFile(join(ws, 'BOARD.md'), 'utf8'), /must not complete/u)
  assert.equal(git(ws, 'status', '--porcelain'), '')
  await assert.rejects(access(join(ws, '.mbot/runs/active-turn.json')))
})

test('dirty admission is rejected, while a disconnected writer preserves recovery evidence and blocks new writes', async t => {
  const { ctx, ws, owner } = await app(t)
  await configEditor(ctx, owner, ws)
  const bot = await ctx.mbot.importBot(ws)
  const options = { botId: bot.botId, sessionId: 'disconnected-session', turn: 1, request: 'disconnection' }
  await writeFile(join(ws, 'uncommitted'), 'human pending data\n')
  await assert.rejects(ctx.mbot.beginTurn(options), /clean before managed turn/u)
  await rm(join(ws, 'uncommitted'))
  const lease = await ctx.mbot.beginTurn(options)
  const base = git(ws, 'rev-parse', 'HEAD')
  lease.child.stdin.end()
  await lease.child.done
  const ledger = JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'))
  t.after(() => rm(ledger.scratch, { recursive: true, force: true }))
  assert.equal(ledger.phase, 'abandoned')
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  assert.ok(await readFile(join(ws, '.mbot/PAUSED'), 'utf8'))
  await assert.rejects(ctx.mbot.beginTurn({ ...options, turn: 2 }), /needs recovery/u)
  assert.equal((await ctx.mbot.execute('botctl', ['board', 'show'])).exitCode, 0)
  assert.equal((await ctx.mbot.execute('botctl', ['board', 'add', 'unsafe human retry'])).exitCode, 1)
  assert.equal((await ctx.mbot.execute('mbot', ['resume'])).exitCode, 1)
})

test('stalled finalization is bounded and keeps a paused recovery journal', async t => {
  const { ctx, ws, owner } = await app(t)
  await configEditor(ctx, owner, ws)
  const bot = await ctx.mbot.importBot(ws)
  const lease = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'stalled-session', turn: 1, request: 'stalled commit', finalizationTimeoutMs: 100 })
  const blocker = spawn('flock', [join(ws, '.mbot/botctl.lock'), 'sh', '-c', 'printf ready; cat'], { stdio: 'pipe' })
  t.after(() => blocker.kill('SIGKILL'))
  await new Promise(resolve => blocker.stdout.once('data', resolve))
  await assert.rejects(lease.finish({ reason: { kind: 'completed' }, text: 'not committed' }))
  blocker.stdin.end()
  const ledger = JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'))
  t.after(() => rm(ledger.scratch, { recursive: true, force: true }))
  assert.equal(ledger.phase, 'abandoned')
  assert.ok(await readFile(join(ws, '.mbot/PAUSED'), 'utf8'))
})

test('recovery audits an interrupted turn once and retains PAUSED for explicit resume', async t => {
  const { ctx, ws, owner } = await app(t)
  await configEditor(ctx, owner, ws)
  const bot = await ctx.mbot.importBot(ws)
  const lease = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'recovery-session', turn: 1, request: 'interrupted work' })
  const base = git(ws, 'rev-parse', 'HEAD')
  const memory = await readFile(join(ws, 'MEMORY.md'), 'utf8')
  const config = await readFile(join(ws, '.mbot/config'), 'utf8')
  const record = JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'))
  t.after(() => rm(record.scratch, { recursive: true, force: true }))
  await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /still active/u)
  assert.equal((await lease.execute('botctl', ['board', 'add', 'preserved task'])).exitCode, 0)
  await writeFile(join(ws, 'MEMORY.md'), 'forbidden interrupted memory edit\n')
  process.kill(record.pid, 'SIGKILL')
  await lease.child.done
  assert.equal(JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8')).phase, 'active')
  await writeFile(join(record.scratch, 'finish.json'), '{}')
  await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /invalid saved turn completion/u)
  assert.equal(JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8')).phase, 'abandoned')
  const stale = await ctx.mbot.execute('botctl', ['board', 'add', 'late recovery write'],
    { permit: { runId: record.runId, token: record.token } })
  assert.equal(stale.exitCode, 1)
  assert.match(stale.stderr, /stale or invalid/u)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  await rm(join(record.scratch, 'finish.json'))
  // Recovery uses the saved limits even when the live configuration is corrupt.
  await writeFile(join(ws, '.mbot/config'), 'invalid configuration\n')
  const recovered = await ctx.mbot.recoverTurn({ botId: bot.botId })
  assert.equal(recovered.kind, 'recovered')
  assert.equal(recovered.success, false)
  assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
  assert.equal(git(ws, 'status', '--porcelain'), '')
  assert.match(await readFile(join(ws, 'BOARD.md'), 'utf8'), /preserved task/u)
  assert.equal(await readFile(join(ws, 'MEMORY.md'), 'utf8'), memory)
  assert.equal(await readFile(join(ws, '.mbot/config'), 'utf8'), config)
  const meta = JSON.parse(await readFile(join(ws, recovered.meta), 'utf8'))
  assert.equal(meta.runtime.recovered, true)
  assert.ok(meta.violations.some(item => item.path === 'MEMORY.md'))
  assert.ok(await readFile(join(ws, '.mbot/PAUSED'), 'utf8'))
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '1\n')
  const head = git(ws, 'rev-parse', 'HEAD')
  assert.equal((await ctx.mbot.recoverTurn({ botId: bot.botId })).needed, false)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), head)
  assert.equal((await ctx.mbot.execute('mbot', ['resume'])).exitCode, 0)
  const next = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'recovery-session', turn: 2, request: 'next turn' })
  assert.equal((await next.finish({ reason: { kind: 'completed' }, text: 'resumed' })).success, true)
})

test('recovery refuses a surviving permit process and succeeds after it settles', async t => {
  const { ctx, ws, owner } = await app(t)
  await configEditor(ctx, owner, ws)
  const bot = await ctx.mbot.importBot(ws)
  const lease = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'writer-session', turn: 1, request: 'writer loss' })
  const record = JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'))
  t.after(() => rm(record.scratch, { recursive: true, force: true }))
  const writer = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
    { env: { ...process.env, MBOT_PERMIT_TOKEN: record.token }, stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => writer.kill('SIGKILL'))
  const exited = new Promise(resolve => writer.once('exit', resolve))
  await new Promise(resolve => writer.stdout.once('data', resolve))
  lease.child.stdin.end()
  await lease.child.done
  const head = git(ws, 'rev-parse', 'HEAD')
  await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /permit-bearing process/u)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), head)
  assert.ok(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'))
  writer.kill('SIGTERM')
  await exited
  assert.equal((await ctx.mbot.recoverTurn({ botId: bot.botId })).success, false)
})

test('recovery preserves evidence when private snapshot, journal or lock identity is invalid', async t => {
  const { ctx, ws, owner } = await app(t)
  await configEditor(ctx, owner, ws)
  const bot = await ctx.mbot.importBot(ws)
  const lease = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: 'snapshot-session', turn: 1, request: 'snapshot loss' })
  lease.child.stdin.end()
  await lease.child.done
  const journal = join(ws, '.mbot/runs/active-turn.json')
  const text = await readFile(journal, 'utf8')
  const record = JSON.parse(text)
  t.after(() => rm(record.scratch, { recursive: true, force: true }))
  const base = git(ws, 'rev-parse', 'HEAD')
  await writeFile(journal, JSON.stringify({ ...record, turn: record.turn + 1 }))
  await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /does not match/u)
  await writeFile(journal, text)
  const saved = join(record.scratch, 'ignored/.mbot')
  const backup = join(record.scratch, 'ignored-mbot-backup')
  const outside = join(root, `outside-snapshot-${++seq}`)
  await mkdir(outside)
  await writeFile(join(outside, 'marker'), 'untouched\n')
  await rename(saved, backup)
  await symlink(outside, saved)
  try { await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /unsafe.*snapshot|unsafe.*ancestor/iu) }
  finally { await rm(saved); await rename(backup, saved) }
  assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'untouched\n')
  const settings = join(record.scratch, 'settings')
  const limits = await readFile(settings, 'utf8')
  await writeFile(settings, limits.split('\n').slice(1).join('\n'))
  await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /missing saved turn limit/u)
  await writeFile(settings, limits)
  const lock = join(ws, '.mbot/botctl.lock')
  await rename(lock, `${lock}.original`)
  await writeFile(lock, '')
  try { await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /lock identity changed/u) }
  finally { await rm(lock); await rename(`${lock}.original`, lock) }
  assert.equal(git(ws, 'rev-parse', 'HEAD'), base)
  assert.equal(await readFile(journal, 'utf8'), text)
  assert.equal((await ctx.mbot.recoverTurn({ botId: bot.botId })).success, false)
})

for (const crashAt of ['commit', 'receipt']) {
  test(`recovery recognizes a completed Git commit after a crash at ${crashAt}`, async t => {
    const { ctx, ws, owner } = await app(t)
    await configEditor(ctx, owner, ws)
    const bot = await ctx.mbot.importBot(ws)
    const path = process.env.PATH
    const fixture = join(root, `crash-bin-${++seq}`)
    await mkdir(fixture)
    // A fixture-only wrapper kills the Bash owner at the actual durability boundary.
    const executable = crashAt === 'commit' ? 'git' : 'rm'
    const matches = crashAt === 'commit'
      ? 'for arg in "$@"; do [[ $arg != commit ]] || crash=1; done'
      : 'for arg in "$@"; do [[ $arg != */active-turn.json ]] || crash=1; done'
    await writeFile(join(fixture, executable), `#!/usr/bin/env bash\ncrash=0\n${matches}\n`
      + (crashAt === 'commit' ? '/usr/bin/git "$@" || exit $?\n' : '')
      + 'if ((crash)); then kill -KILL "$PPID"; exit 0; fi\n'
      + (crashAt === 'receipt' ? 'exec /usr/bin/rm "$@"\n' : ''), { mode: 0o700 })
    const base = git(ws, 'rev-parse', 'HEAD')
    let lease
    try {
      process.env.PATH = `${fixture}:${path}`
      lease = await ctx.mbot.beginTurn({ botId: bot.botId, sessionId: `crash-${crashAt}`, turn: 1, request: 'durable outcome' })
    } finally { process.env.PATH = path }
    const record = JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8'))
    t.after(() => rm(record.scratch, { recursive: true, force: true }))
    await assert.rejects(lease.finish({ reason: { kind: 'completed' }, text: 'committed outcome' }))
    const head = git(ws, 'rev-parse', 'HEAD')
    assert.equal(git(ws, 'rev-list', '--count', `${base}..HEAD`), '1')
    assert.equal(JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8')).phase,
      crashAt === 'commit' ? 'committing' : 'committed')
    if (crashAt === 'commit') {
      await writeFile(join(ws, 'human-work'), 'later human commit\n')
      git(ws, 'add', 'human-work')
      git(ws, 'commit', '-m', 'fixture: later human commit')
      const later = git(ws, 'rev-parse', 'HEAD')
      await assert.rejects(ctx.mbot.recoverTurn({ botId: bot.botId }), /HEAD does not match/u)
      assert.equal(git(ws, 'rev-parse', 'HEAD'), later)
      git(ws, 'reset', '--hard', head)
    }
    const recovered = await ctx.mbot.recoverTurn({ botId: bot.botId })
    assert.equal(recovered.alreadyCommitted, true)
    assert.equal(recovered.success, true)
    assert.equal(git(ws, 'rev-parse', 'HEAD'), head)
    assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '0\n')
    assert.ok(await readFile(join(ws, '.mbot/PAUSED'), 'utf8'))
    assert.equal((await ctx.mbot.recoverTurn({ botId: bot.botId })).needed, false)
    assert.equal(git(ws, 'status', '--porcelain'), '')
  })
}

test('live workspace config is captured per operation and unloading removes tools and commands', async t => {
  const { ctx, ws, owner } = await app(t)
  await owner.dispose()
  class MemoryLoader extends Loader { commit() {} }
  await ctx.plugin(MemoryLoader)
  ctx.loader.builtins['mbot-test'] = plugin
  const id = await ctx.loader.create({ name: 'cordis:mbot-test', config: { workspace: ws } })
  await ctx.loader.await()
  const service = ctx.mbot
  await ctx.loader.update(id, { config: { workspace: join(root, 'another workspace') } })
  // Cordis preserves the service on a volatile update.
  assert.equal(service.closed, false)
  assert.equal(service.workspace(), join(root, 'another workspace'))
  assert.notEqual(ctx.mbot.workspace(), ws)
  const result = await ctx.mbot.execute('mbot', ['init'])
  assert.equal(result.exitCode, 0, result.stderr)
  await ctx.loader.resolve(id).fiber.dispose()
  assert.equal(ctx.get('mbot'), undefined)
  assert.equal(ctx.tools.get('botctl'), undefined)
  assert.equal(ctx.commands.find({}, 'mbot'), undefined)
  await assert.rejects(service.execute('mbot', ['status']), /disposed/u)
})

test('disposal joins outstanding subprocesses and cancellation settles before returning', async t => {
  const { ctx, owner } = await app(t)
  // Exercise the service's owned process set with a controllable provider handle.
  const pending = Promise.withResolvers()
  let terminated = false
  const original = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = () => ({ done: pending.promise, terminate() { terminated = true; pending.resolve({ exitCode: 1, signal: 'SIGTERM' }) },
    waitForExit: async () => true, collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } } })
  const running = ctx.mbot.execute('mbot', ['status'])
  await owner.dispose()
  assert.equal(terminated, true)
  await running
  ctx.subprocess.spawn = original
})

test('native results redact environment keys and credential-file literals', async t => {
  const { ctx, ws, owner } = await app(t)
  process.env.MBOT_TEST_SECRET = 'native-secret-123456789'
  try {
    await writeFile(join(ws, '.env'), 'DEEPSEEK_API_KEY="credential-file-secret-12345"\n')
    assert.equal((await call(ctx, { action: 'board_add', text: 'native-secret-123456789 credential-file-secret-12345' })).isError, false)
    const result = await call(ctx, { action: 'board_show' })
    assert.doesNotMatch(text(result), /native-secret|credential-file-secret/u)
    assert.match(text(result), /\[REDACTED\]/u)
    await mkdir(join(process.env.XDG_CONFIG_HOME, 'mbot'), { recursive: true })
    const config = join(process.env.XDG_CONFIG_HOME, 'mbot', 'config')
    await writeFile(config, `MBOT_WS="${ws}"\n`)
    await owner.update({ workspace: '' })
    const fallback = await call(ctx, { action: 'board_show' })
    assert.equal(fallback.isError, false)
    assert.doesNotMatch(text(fallback), /credential-file-secret/u)
    await rm(config)
    assert.equal(await redact('https://user:password@example.test Bearer abcdefgh123456'), 'https://[REDACTED]@example.test Bearer [REDACTED]')
  } finally { delete process.env.MBOT_TEST_SECRET }
})

test('abort signals reach the provider, prevent pre-aborted work and join active cancellation', async t => {
  const { ctx, ws } = await app(t)
  const before = git(ws, 'rev-parse', 'HEAD')
  const controller = new AbortController()
  controller.abort(new Error('pre-aborted'))
  await assert.rejects(ctx.mbot.execute('mbot', ['status'], { signal: controller.signal }), /pre-aborted/u)
  assert.equal(git(ws, 'rev-parse', 'HEAD'), before)
  const active = new AbortController()
  let joined = false
  let forwarded = false
  const original = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = spec => {
    forwarded = spec.signal === active.signal
    const pending = Promise.withResolvers()
    const child = { done: pending.promise, terminate: () => pending.resolve({ exitCode: 1, signal: 'SIGTERM' }),
      waitForExit: async () => { joined = true; return true } }
    spec.signal.addEventListener('abort', child.terminate, { once: true })
    return child
  }
  const result = ctx.mbot.execute('mbot', ['status'], { signal: active.signal })
  active.abort(new Error('cancelled'))
  await assert.rejects(result, /cancelled/u)
  assert.equal(forwarded, true)
  assert.equal(joined, true)
  ctx.subprocess.spawn = original
})

test('plugin does not initialize repositories on load and rejects invalid configuration before updating', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocess)
  const workspace = join(root, 'not automatically initialized')
  const owner = ctx.plugin(plugin, { workspace })
  await owner
  await assert.rejects(access(workspace))
  await assert.rejects(Promise.resolve().then(() => owner.update({ workspace: 'relative/path' })))
  assert.equal(ctx.mbot.workspace(), workspace)
})

test.after(async () => { await rm(root, { recursive: true, force: true }) })
