import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, access, symlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const { chromium } = await import(process.env.MBOT_PLAYWRIGHT_MODULE || 'playwright')
const repo = fileURLToPath(new URL('../', import.meta.url))
const root = await mkdtemp('/tmp/mbot-gui-handoff.')
const linked = join(root, 'linked-package')
const profile = join(root, 'dsh/profiles/web')
const env = { ...process.env, DSH_HOME: join(root, 'dsh'), TMPDIR: root,
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'), COREPACK_HOME: join(root, 'corepack'), COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', DSH_TELEMETRY_MODE: 'DISABLED',
  DEEPSEEK_API_KEY: 'mbot-disposable-hmr-key', MBOT_GUI_HANDOFF_ROOT: root, MBOT_GUI_PACKAGE: join(linked, 'package.json'),
  GIT_AUTHOR_NAME: 'MBot HMR fixture', GIT_COMMITTER_NAME: 'MBot HMR fixture',
  GIT_AUTHOR_EMAIL: 'mbot-tests@example.invalid', GIT_COMMITTER_EMAIL: 'mbot-tests@example.invalid' }
delete env.MBOT_WS
delete env.MBOT_RUN_ID
const processes = new Set()
function start(program, args) {
  const child = spawn(program, args, { cwd: root, env, stdio: 'pipe' })
  processes.add(child)
  child.output = ''
  child.stdout.on('data', value => { child.output += value })
  child.stderr.on('data', value => { child.output += value })
  child.finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => { processes.delete(child); resolve(code) }) })
  return child
}
async function run(program, args) {
  const child = start(program, args)
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  try { assert.equal(await child.finished, 0, child.output); return child.output } finally { clearTimeout(timer) }
}
async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(30) }
  throw new Error('Timed out waiting for HMR GUI condition')
}
const exists = name => access(join(root, name)).then(() => true, () => false)
const rows = async file => (await readFile(join(root, file), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
let browser, server, page
try {
  const [packed] = JSON.parse(await run('npm', ['pack', repo, '--json', '--ignore-scripts', '--pack-destination', root, '--cache', join(root, 'npm-cache')]))
  const tarball = join(root, packed.filename)
  await run('dsh', ['plugin', '--profile', 'web', 'add', tarball, '--store-dir', join(root, 'pnpm-store'), '--ignore-scripts'])
  await mkdir(linked)
  await run('tar', ['-xzf', tarball, '-C', linked, '--strip-components=1'])
  // Preserve the installed SDK identities and edit only a disposable package.
  await mkdir(join(linked, 'node_modules'))
  for (const scope of ['@deepseek-ai', '@standard-schema']) {
    await symlink(join(profile, 'node_modules', scope), join(linked, 'node_modules', scope))
  }
  await rename(join(profile, 'node_modules/dsh-mbot'), join(root, 'installed-original'))
  await symlink(linked, join(profile, 'node_modules/dsh-mbot'))
  await mkdir(join(root, 'documents'))
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: hmr\n  config:\n    root: [${linked}]\n    debounce: 100\n- id: workspace-controller\n  config:\n    documentsDirectory: ${join(root, 'documents')}\n- id: agent-default-model\n  config:\n    provider: mbot-hmr-fixture\n    model: scripted\n- insert:\n    - id: mbot-handoff-fixture\n      name: ${join(repo, 'tests/gui-handoff-fixture.mjs')}\n`)
  server = start('dsh', ['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'])
  const url = await until(() => /dsh web: (http:\/\/\S+)/u.exec(server.output)?.[1])
  await until(() => exists('fixture-ready'))
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.getByRole('button', { name: '继续', exact: true }).waitFor({ timeout: 3000 }).then(() => page.getByRole('button', { name: '继续', exact: true }).click(), () => {})
  await page.locator('[contenteditable=true]').waitFor()
  async function send(text) { const input = page.locator('[contenteditable=true]'); await input.fill(text); await input.press('Enter') }
  async function command(text) {
    const before = (await rows('events.jsonl')).filter(row => row.event.type === 'command/done').length
    await send(text)
    return until(async () => {
      const events = (await rows('events.jsonl')).filter(row => row.event.type === 'command/done')
      return events.length > before ? events.at(-1).event.data.text : undefined
    })
  }
  const ws = join(root, 'HMR Bot')
  const init = await command(`/mbot init ${ws}`)
  const sessionId = /^Main Session: (session-[0-9a-f-]+)$/mu.exec(init)[1]
  const requests = async () => (await rows('requests.jsonl')).filter(row => row.sessionId === sessionId)
  const phase = async turn => (await rows('events.jsonl')).findLast(row => row.sessionId === sessionId
    && row.event.type === 'plugin:mbot/runtime-turn' && row.event.data.turn === turn)?.event.data.phase
  await command('/mbot runtime')
  assert.match(await command('/hmr_unrelated'), /Unrelated Agent alive/u)
  await send('hmr first turn')
  await until(async () => await phase(1) === 'committed')
  const runtimeFile = join(linked, 'plugin/runtime.js')
  const original = await readFile(runtimeFile, 'utf8')
  const updated = original.replace('this.ready = false', "this.ready = false\n    this.buildMarker = 'new-module'")
  const git = (...args) => execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8' }).trim()
  const beforeWriter = git('rev-parse', 'HEAD')
  await send('hmr slow writer')
  await until(() => exists('writer-started'))
  await send('hmr queued during unload')
  await until(async () => (await command('/mbot runtime')).includes('Queued: 1 next-turn'))
  await writeFile(runtimeFile, updated)
  await until(() => exists('writer-cancelled'))
  assert.equal(git('rev-parse', 'HEAD'), beforeWriter)
  assert.equal((await rows('lifecycle.jsonl')).filter(row => row.phase === 'attached').length, 1)
  await writeFile(join(root, 'release-writer'), '')
  await until(async () => (await rows('lifecycle.jsonl')).some(row => row.phase === 'attached' && row.build === 'new-module'))
  await until(async () => await phase(2) === 'rejected')
  assert.equal(await phase(2), 'rejected')
  assert.match(await command('/mbot runtime'), /Queued: 1 next-turn/u)
  assert.match(await command('/hmr_unrelated'), /Unrelated Agent alive/u)
  const soul = join(ws, 'bots/chief/SOUL.md')
  await writeFile(soul, (await readFile(soul, 'utf8')) + '\nHMR fresh persona marker 772211\n')
  await writeFile(join(ws, 'MEMORY.md'), (await readFile(join(ws, 'MEMORY.md'), 'utf8')) + '\nHMR fresh memory marker 998822\n')
  git('add', 'bots/chief/SOUL.md', 'MEMORY.md')
  git('commit', '-m', 'human: update HMR context')
  await send('hmr explicit wake')
  await until(async () => (await requests()).length === 4 && await phase(4) === 'committed')
  const model = JSON.stringify((await requests()).at(-1).messages)
  assert.ok(model.includes('HMR fresh persona marker 772211'))
  assert.ok(model.includes('HMR fresh memory marker 998822'))
  await page.screenshot({ path: join(root, 'handoff-and-context.png'), fullPage: true })
  // Profile reconciliation stops the changed provider before import; unlike
  // watcher import preflight, an import failure here leaves it unavailable.
  await writeFile(runtimeFile, updated + '\nthis is invalid JavaScript !\n')
  assert.match(await command('/hmr_recompose'), /failed/u)
  await until(async () => (await rows('lifecycle.jsonl')).some(row => row.phase === 'detached' && row.generation === 2))
  const count = (await requests()).length
  await send('hmr queued after failed import')
  await delay(300)
  assert.equal((await requests()).length, count)
  assert.match(await command('/hmr_unrelated'), /Unrelated Agent alive/u)
  await writeFile(runtimeFile, updated.replace("'new-module'", "'corrected-module'"))
  assert.match(await command('/hmr_recompose'), /Profile reconciliation:/u)
  await until(async () => (await rows('lifecycle.jsonl')).some(row => row.phase === 'attached' && row.build === 'corrected-module'))
  await send('hmr wake after corrected import')
  await until(async () => (await requests()).length === count + 2)
  await until(async () => /MBot Runtime: idle/u.test(await command('/mbot runtime')))
  assert.equal((await requests()).every(row => row.sessionId === sessionId), true)
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(errors.length, 0, errors.join('\n'))
  await page.screenshot({ path: join(root, 'corrected-import.png'), fullPage: true })
  console.log(`GUI module handoff passed: ${root}`)
} catch (error) { await page?.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {}); console.error(`GUI module handoff failed; artifacts: ${root}`); throw error }
finally {
  if (server) await writeFile(join(root, 'host.log'), server.output)
  await writeFile(join(root, 'release-writer'), '')
  await browser?.close()
  for (const child of processes) child.kill('SIGTERM')
  const kill = setTimeout(() => { for (const child of processes) child.kill('SIGKILL') }, 10000)
  try { await Promise.all([...processes].map(child => child.finished)) } finally { clearTimeout(kill) }
}
