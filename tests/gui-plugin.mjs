// Real browser acceptance over an installed tarball and an isolated DSH Web host.
// Supply MBOT_PLAYWRIGHT_MODULE and PLAYWRIGHT_BROWSERS_PATH for /tmp installations.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const { chromium } = await import(process.env.MBOT_PLAYWRIGHT_MODULE || 'playwright')
const repo = fileURLToPath(new URL('../', import.meta.url))
const root = await mkdtemp('/tmp/mbot-gui-test.')
const env = { ...process.env, DSH_HOME: join(root, 'dsh'), TMPDIR: root,
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  COREPACK_HOME: join(root, 'corepack'), DSH_TELEMETRY_MODE: 'DISABLED',
  GIT_AUTHOR_NAME: 'mbot GUI tests', GIT_COMMITTER_NAME: 'mbot GUI tests',
  GIT_AUTHOR_EMAIL: 'mbot-tests@example.invalid', GIT_COMMITTER_EMAIL: 'mbot-tests@example.invalid' }
delete env.DEEPSEEK_API_KEY
delete env.MBOT_WS
delete env.MBOT_RUN_ID
const processes = new Set()
function start(program, args) {
  const child = spawn(program, args, { cwd: root, env, stdio: 'pipe' })
  processes.add(child)
  child.output = ''
  child.stdoutText = ''
  child.stdout.on('data', data => { child.output += data; child.stdoutText += data })
  child.stderr.on('data', data => { child.output += data })
  child.finished = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => { processes.delete(child); resolve(code) })
  })
  return child
}
async function run(program, args) {
  const child = start(program, args)
  const code = await child.finished
  assert.equal(code, 0, child.output)
  return child.stdoutText
}
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(50)
  }
  throw new Error('Timed out waiting for GUI acceptance condition')
}
let browser
try {
  const [packed] = JSON.parse(await run('npm', ['pack', repo, '--json', '--ignore-scripts', '--pack-destination', root, '--cache', join(root, 'npm-cache')]))
  await run('dsh', ['plugin', '--profile', 'web', 'add', join(root, packed.filename), '--store-dir', join(root, 'pnpm-store'), '--ignore-scripts'])
  await mkdir(join(root, 'documents'))
  const profilePatch = join(env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
  // This observer supplies evidence only; it never changes session/model behavior.
  const observer = join(root, 'observer.mjs')
  const eventsPath = join(root, 'events.jsonl')
  await writeFile(observer, `import { appendFileSync } from 'node:fs'\nexport function apply(ctx) { ctx.on('session/event', (session, event) => { appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({sessionId: session.id, event}) + '\\n') }) }\n`)
  await writeFile(profilePatch, `- id: workspace-controller\n  config:\n    documentsDirectory: ${join(root, 'documents')}\n- insert:\n    - name: ${observer}\n`)
  async function host() {
    const child = start('dsh', ['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'])
    const url = await until(() => /dsh web: (http:\/\/\S+)/u.exec(child.output)?.[1])
    return { child, url }
  }
  let server = await host()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(server.url)
  await page.locator('[contenteditable=true]').waitFor()
  const welcome = page.getByRole('button', { name: '继续', exact: true })
  await welcome.waitFor({ timeout: 3000 }).then(() => welcome.click(), () => {})
  const commandRows = page.locator('[data-variant="others"][data-state]')
  async function submit(line) {
    const before = await commandRows.count()
    const input = page.locator('[contenteditable=true]')
    await input.fill(line)
    await input.press('Enter')
    await until(async () => await commandRows.count() === before + 1 && await commandRows.last().getAttribute('data-state') !== 'running')
    return commandRows.last().innerText()
  }
  const workspace = join(root, '文档', 'bot demo')
  const init = await submit(`/mbot init ${workspace}`)
  assert.ok(init.includes(`Initialized ${workspace}`), init)
  assert.ok(init.includes('Selected for subsequent'), init)
  assert.ok(init.includes('Next: /mbot status'), init)
  assert.ok((await submit('/mbot status')).includes(`Workspace: ${workspace}`))
  assert.ok((await submit(`/mbot init ${workspace}`)).includes('absent or empty'))
  assert.ok((await submit('/mbot status')).includes(`Workspace: ${workspace}`))
  assert.ok((await submit('/mbot unknown')).includes('/mbot init'))
  assert.ok((await submit('/mbot tick')).includes('Skipped: no todo or doing tasks.'))
  const lock = start('flock', [join(workspace, '.mbot', 'lock'), 'sh', '-c', 'printf ready; cat'])
  await until(() => lock.stdoutText.includes('ready'))
  assert.ok((await submit('/mbot dream')).includes('Skipped: another run is active.'))
  lock.stdin.end()
  await lock.finished
  await submit('/mbot pause GUI acceptance')
  assert.ok((await submit('/mbot dream')).includes('Skipped: workspace is PAUSED.'))
  await submit('/mbot resume')
  assert.ok((await submit('/mbot status')).includes('PAUSED: no'))
  await page.locator('[contenteditable=true]').press('Escape')
  await page.screenshot({ path: join(root, 'before-expand.png'), fullPage: true })
  await commandRows.last().click()
  assert.equal(await commandRows.last().locator('pre').isVisible(), true)
  assert.ok((await commandRows.last().locator('pre').innerText()).includes('MEMORY.md:'))
  await page.screenshot({ path: join(root, 'commands.png'), fullPage: true })
  assert.ok((await readFile(profilePatch, 'utf8')).includes(workspace))
  const second = await context.newPage()
  await second.goto(page.url())
  await second.locator('[contenteditable=true]').waitFor()
  await until(async () => await second.locator('[data-variant="others"][data-state]').count() === await commandRows.count())
  const count = await commandRows.count()
  await submit('/mbot status')
  await until(async () => await second.locator('[data-variant="others"][data-state]').count() === count + 1)
  await second.close()
  await page.reload()
  await page.locator('[contenteditable=true]').waitFor()
  await until(async () => await commandRows.count() === count + 1)
  server.child.kill('SIGINT')
  await server.child.finished
  server = await host()
  await page.goto(server.url)
  await page.locator('[contenteditable=true]').waitFor()
  await until(async () => await commandRows.count() === count + 1)
  assert.ok((await submit('/mbot status')).includes(`Workspace: ${workspace}`))
  await page.screenshot({ path: join(root, 'restart.png'), fullPage: true })
  const events = (await readFile(eventsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line).event)
  assert.ok(events.some(event => event.type === 'command/run'))
  assert.ok(events.some(event => event.type === 'command/done'))
  assert.ok(events.every(event => !['user/message', 'assistant/message', 'turn/start', 'llm/request'].includes(event.type)), 'Control commands must not send model content or start turns')
  assert.deepEqual(errors, [])
  console.log('GUI PASS: tarball/blank-session/init/status/error/skip/multiple-tabs/reload/host-restart/no-model')
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGINT')
  await Promise.allSettled([...processes].map(child => child.finished))
  console.log(`GUI artifacts: ${root}`)
}
