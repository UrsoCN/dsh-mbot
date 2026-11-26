import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, access, writeFile, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
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
