import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const { chromium } = await import(process.env.MBOT_PLAYWRIGHT_MODULE || 'playwright')
process.umask(0o077)
const repo = fileURLToPath(new URL('../', import.meta.url))
const root = await mkdtemp('/tmp/mbot-gui-migration.')
const env = { ...process.env, DSH_HOME: join(root, 'dsh'), TMPDIR: root,
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  COREPACK_HOME: join(root, 'corepack'), DSH_TELEMETRY_MODE: 'DISABLED', DEEPSEEK_API_KEY: 'local-migration-fixture-key',
  MBOT_MIGRATION_ROOT: root, MBOT_MIGRATION_PACKAGE: join(root, 'dsh/profiles/web/node_modules/dsh-mbot/package.json'),
  GIT_AUTHOR_NAME: 'MBot migration', GIT_COMMITTER_NAME: 'MBot migration', GIT_AUTHOR_EMAIL: 'mbot-tests@example.invalid', GIT_COMMITTER_EMAIL: 'mbot-tests@example.invalid' }
for (const key of ['MBOT_WS', 'MBOT_RUN_ID', 'DSH_MBOT_RUN_ID', 'DSH_MBOT_PERMIT_TOKEN', 'MBOT_PERMIT_TOKEN']) delete env[key]
const processes = new Set()
function start(program, args, cwd = root) {
  const child = spawn(program, args, { cwd, env, stdio: 'pipe' }); processes.add(child); child.output = ''
  child.stdout.on('data', data => { child.output += data }); child.stderr.on('data', data => { child.output += data })
  child.finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => { processes.delete(child); resolve(code) }) })
  return child
}
async function run(program, args, cwd) {
  const child = start(program, args, cwd), timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  try { return { code: await child.finished, text: child.output } } finally { clearTimeout(timer) }
}
async function good(program, args, cwd) { const result = await run(program, args, cwd); assert.equal(result.code, 0, result.text); return result.text }
async function until(check, timeout = 15000) { const end = Date.now()+timeout; while (Date.now()<end) { const value = await check(); if (value) return value; await delay(30) } throw new Error('Migration GUI condition timed out') }
const exists = path => access(path).then(() => true, () => false)
const ctl = join(repo, 'bin/botctl')
const hostCall = async args => JSON.parse(await good(ctl, [...args, '--profile', 'web']))
let browser, page, server
try {
  const supervisor = start('python3', ['-u', '-c', 'import subprocess,sys,signal\nchild=None\ndef stop(*args): raise SystemExit()\nsignal.signal(signal.SIGTERM,stop)\ntry:\n print("parent-ready",flush=True)\n for line in sys.stdin:\n  if line.strip()=="spawn":\n   child=subprocess.Popen([sys.executable,"-u","-c","import ctypes,time; ctypes.CDLL(None).prctl(4,0); print(\\\"child-ready\\\",flush=True); time.sleep(120)"])\nfinally:\n if child is not None:\n  child.terminate(); child.wait()\n'])
  await until(() => supervisor.output.includes('parent-ready'))
  const oldSource = join(root, 'old-source'); await mkdir(oldSource)
  const archive = execFileSync('git', ['archive', 'bcec931'], { cwd: repo, maxBuffer: 16*1024*1024 })
  execFileSync('tar', ['-xf', '-', '-C', oldSource], { input: archive })
  // Reproduce an old loaded Host with current on-disk Bash helpers.
  for (const directory of ['bin', 'lib']) await cp(join(repo, directory), join(oldSource, directory), { recursive: true, force: true })
  for (const file of ['recovery-proof.js', 'readonly-migration.js', 'native-reply.js', 'recovery-audit.js', 'reply-proof.js', 'native-storage.js']) await cp(join(repo, 'plugin', file), join(oldSource, 'plugin', file))
  const oldPack = JSON.parse(await good('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], oldSource))[0]
  const oldTarball = join(root, 'legacy.tgz'); await cp(join(root, oldPack.filename), oldTarball)
  const currentPack = JSON.parse(await good('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], repo))[0]
  const currentTarball = join(root, currentPack.filename)
  await good('dsh', ['plugin', '--profile', 'web', 'add', oldTarball, '--store-dir', join(root, 'pnpm-store'), '--ignore-scripts'])
  await mkdir(join(root, 'documents'))
  await writeFile(join(root, 'dsh/profiles/web/cordis.patch.yml'), `- id: workspace-controller\n  config:\n    documentsDirectory: ${join(root, 'documents')}\n- id: agent-default-model\n  config:\n    provider: mbot-legacy-fixture\n    model: scripted\n- id: sandbox-policy\n  config:\n    mode: danger-full-access\n- id: approval\n  config:\n    policy: never\n- insert:\n    - id: migration-fixture\n      name: ${join(repo, 'tests/gui-migration-fixture.mjs')}\n`)
  await writeFile(join(root, 'legacy-mode'), '')
  async function host() {
    const child = start('dsh', ['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'])
    const url = await until(() => /dsh web: (http:\/\/\S+)/u.exec(child.output)?.[1])
    await until(() => exists(join(root, 'fixture-ready'))).catch(async error => { await writeFile(join(root, 'host.log'), child.output); throw error })
    return { child, url }
  }
  server = await host(); browser = await chromium.launch({ headless: true }); page = await browser.newPage()
  await page.goto(server.url); await page.locator('[contenteditable=true]').waitFor()
  await page.getByRole('button', { name: '继续', exact: true }).waitFor({ timeout: 3000 }).then(() => page.getByRole('button', { name: '继续', exact: true }).click(), () => {})
  async function send(text) { const input = page.locator('[contenteditable=true]'); await input.fill(text); await input.press('Enter') }
  async function create(name) {
    const workspace = join(root, name); await send(`/mbot init ${workspace}`)
    const bot = await until(async () => (await hostCall(['bots'])).value.bots.find(bot => bot.workspacePath === workspace && bot.mainSessionId))
    await page.goto(`${server.url}#mbot-session=${bot.mainSessionId}`); await page.locator('[contenteditable=true]').waitFor()
    return { bot, workspace }
  }
  const { bot, workspace } = await create('Legacy Bot')
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { env, encoding: 'utf8' }).trim()
  const base = git('rev-parse', 'HEAD'), memory = await readFile(join(workspace, 'MEMORY.md'), 'utf8')
  await hostCall(['talk', '--bot', bot.botId, '--request-id', 'legacy-readonly', '--text', 'inspect readonly'])
  await page.locator('[data-mbot-audit="1"][data-phase="failed"]').waitFor()
  assert.equal((await hostCall(['runtime', '--bot', bot.botId])).value.state, 'failed')
  const unsupported = await run(ctl, ['recover', '--bot', bot.botId, '--profile', 'web'])
  assert.equal(unsupported.code, 1)
  assert.equal(JSON.parse(unsupported.text).ok, false, 'Old IPC must actually lack the new action')
  const journalPath = join(workspace, '.mbot/runs/active-turn.json'), journal = JSON.parse(await readFile(journalPath, 'utf8'))
  assert.equal(journal.runtimeOwnership, undefined)
  assert.equal(JSON.parse(await readFile(join(journal.scratch, 'header.json'), 'utf8')).messages, undefined)
  supervisor.stdin.write('spawn\n'); await until(() => supervisor.output.includes('child-ready'))
  const check = JSON.parse(await good(ctl, ['-C', workspace, 'migrate-readonly', '--check']))
  assert.equal(check.ready, true); assert.deepEqual(check.evidence.tools.map(tool => tool.action), ['boot', 'board_show'])
  assert.equal(git('rev-parse', 'HEAD'), base); assert.equal(git('status', '--porcelain'), '')
  assert.ok(await exists(journalPath))
  const beforeProtected = await readFile(journalPath, 'utf8')
  await send('/mbot_fixture_protected'); await until(() => exists(join(root, 'protected-host-child')))
  const blocked = await run(ctl, ['-C', workspace, 'migrate-readonly', '--check'])
  assert.equal(blocked.code, 1); assert.match(blocked.text, /Cannot inspect possible writer/u)
  assert.equal(await readFile(journalPath, 'utf8'), beforeProtected)
  assert.equal(git('rev-parse', 'HEAD'), base)
  await send('/mbot_fixture_unprotect'); await until(() => exists(join(root, 'protected-host-child-ended')))
  const migrated = JSON.parse(await good(ctl, ['-C', workspace, 'migrate-readonly']))
  assert.equal(migrated.success, true); assert.equal(migrated.runtimeReloadRequired, true)
  assert.equal(git('rev-list', '--count', `${base}..HEAD`), '1'); assert.equal(await exists(journalPath), false)
  assert.equal(await readFile(join(workspace, 'MEMORY.md'), 'utf8'), memory)
  assert.equal(await exists(join(workspace, '.mbot/PAUSED')), true)
  const meta = JSON.parse(await readFile(join(workspace, migrated.meta), 'utf8'))
  assert.equal(meta.runtime.recovery_proof.mode, 'legacy-readonly'); assert.equal(meta.runtime.reply, undefined)
  assert.equal((await hostCall(['runtime', '--bot', bot.botId])).value.state, 'failed', 'Readonly migration does not rewrite the old live Runtime')
  assert.equal(JSON.parse(await good(ctl, ['-C', workspace, 'migrate-readonly'])).needed, false)
  for (const [name, text] of [['Writer Bot', 'write legacy'], ['Unknown Bot', 'unknown legacy']]) {
    const other = await create(name)
    await hostCall(['talk', '--bot', other.bot.botId, '--request-id', text, '--text', text])
    await page.locator('[data-mbot-audit="1"][data-phase="failed"]').waitFor()
    const before = await readFile(join(other.workspace, '.mbot/runs/active-turn.json'), 'utf8')
    const refused = await run(ctl, ['-C', other.workspace, 'migrate-readonly'])
    assert.equal(refused.code, 1); assert.match(refused.text, /writer or unknown tool/u)
    assert.equal(await readFile(join(other.workspace, '.mbot/runs/active-turn.json'), 'utf8'), before)
  }
  await page.screenshot({ path: join(root, 'legacy-refusals.png'), fullPage: true })
  server.child.kill('SIGINT'); await server.child.finished; await rm(join(root, 'fixture-ready')); await rm(join(root, 'legacy-mode'))
  await good('dsh', ['plugin', '--profile', 'web', 'add', currentTarball, '--store-dir', join(root, 'pnpm-store'), '--ignore-scripts'])
  server = await host(); await page.goto(`${server.url}#mbot-session=${bot.mainSessionId}`); await page.locator('[contenteditable=true]').waitFor()
  assert.equal((await hostCall(['runtime', '--bot', bot.botId])).value.state, 'idle')
  assert.equal((await hostCall(['bots'])).value.bots.find(item => item.botId === bot.botId).mainSessionId, bot.mainSessionId)
  await send('/mbot resume'); await until(() => exists(join(workspace, '.mbot/PAUSED')).then(value => !value))
  await send('resume after legacy migration'); await page.locator('[data-mbot-audit="2"][data-phase="committed"]').waitFor()
  assert.equal(git('rev-list', '--count', `${base}..HEAD`), '2')
  assert.equal(await readFile(join(workspace, 'MEMORY.md'), 'utf8'), memory)
  assert.equal(await page.locator('body').innerText().then(text => text.includes('Legacy answer retained')), true)
  await page.screenshot({ path: join(root, 'legacy-upgraded-session.png'), fullPage: true })
  console.log('GUI migration PASS: actual-old-Host/native-read-handle/readonly-dry-run/protected-independent-branch/protected-owner-child-refused/live-owner-migration/one-audit/paused/writer-and-shell-refusal/current-upgrade/stable-session/dialogue/no-external-model')
} catch (error) {
  if (page) { await page.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText()).catch(() => {}) }
  throw error
} finally {
  await browser?.close(); for (const child of processes) child.kill('SIGINT')
  await Promise.allSettled([...processes].map(child => child.finished)); console.log(`GUI migration artifacts: ${root}`)
}
