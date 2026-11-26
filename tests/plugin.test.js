import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, access, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Context, Service } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Commands from '@deepseek-ai/dsh-commands'
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
