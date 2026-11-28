import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const { chromium } = await import(process.env.MBOT_PLAYWRIGHT_MODULE || 'playwright')
const repo = fileURLToPath(new URL('../', import.meta.url))
const root = await mkdtemp('/tmp/mbot-gui-conversations.')
const env = { ...process.env, DSH_HOME: join(root, 'dsh'), TMPDIR: root,
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  COREPACK_HOME: join(root, 'corepack'), COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', DSH_TELEMETRY_MODE: 'DISABLED',
  DEEPSEEK_API_KEY: 'disposable-scripted-adapter-key', MBOT_GUI_RUNTIME_ROOT: root,
  MBOT_GUI_PACKAGE: join(root, 'dsh/profiles/web/node_modules/dsh-mbot/package.json'),
  GIT_AUTHOR_NAME: 'MBot GUI domains', GIT_COMMITTER_NAME: 'MBot GUI domains',
  GIT_AUTHOR_EMAIL: 'mbot-tests@example.invalid', GIT_COMMITTER_EMAIL: 'mbot-tests@example.invalid' }
delete env.MBOT_WS; delete env.MBOT_RUN_ID
const children = new Set()
function start(program, args) {
  const child = spawn(program, args, { cwd: root, env, stdio: 'pipe' })
  children.add(child); child.output = ''
  child.stdout.on('data', data => { child.output += data })
  child.stderr.on('data', data => { child.output += data })
  child.finished = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => { children.delete(child); resolve(code) })
  })
  return child
}
async function run(program, args) {
  const child = start(program, args), timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  try { assert.equal(await child.finished, 0, child.output); return child.output }
  finally { clearTimeout(timer) }
}
async function until(check) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(40) }
  throw new Error('Timed out waiting for conversation GUI condition')
}
const events = async () => (await readFile(join(root, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const requests = async () => (await readFile(join(root, 'requests.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
async function send(page, text) { const input = page.locator('[contenteditable=true]'); await input.fill(text); await input.press('Enter') }
async function command(page, text) {
  const count = (await events()).filter(row => row.event.type === 'command/done').length
  await send(page, text)
  return until(async () => {
    const rows = (await events()).filter(row => row.event.type === 'command/done')
    return rows.length > count ? rows.at(-1).event.data : undefined
  })
}
let browser, server, page
try {
  const [packed] = JSON.parse(await run('npm', ['pack', repo, '--json', '--ignore-scripts', '--pack-destination', root]))
  await run('dsh', ['plugin', '--profile', 'web', 'add', join(root, packed.filename), '--store-dir', join(root, 'pnpm-store'), '--ignore-scripts'])
  await mkdir(join(root, 'documents'))
  await writeFile(join(env.DSH_HOME, 'profiles/web/cordis.patch.yml'), `- id: workspace-controller\n  config:\n    documentsDirectory: ${join(root, 'documents')}\n- id: mbot-runtime\n  config:\n    workers: false\n- id: agent-default-model\n  config:\n    provider: mbot-ui-fixture\n    model: scripted\n- insert:\n    - id: mbot-runtime-fixture\n      name: ${join(repo, 'tests/gui-runtime-fixture.mjs')}\n`)
  async function host() {
    await rm(join(root, 'fixture-ready'), { force: true })
    const child = start('dsh', ['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'])
    server = child
    const url = await until(() => /dsh web: (http:\/\/\S+)/u.exec(child.output)?.[1])
    await until(() => access(join(root, 'fixture-ready')).then(() => true, () => false))
    return url
  }
  let url = await host()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  page = await context.newPage()
  const errors = []
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url); await page.locator('[contenteditable=true]').waitFor()
  await page.getByRole('button', { name: '继续', exact: true }).waitFor({ timeout: 3000 }).then(() => page.getByRole('button', { name: '继续', exact: true }).click(), () => {})
  const ws = join(root, 'Domain Bot')
  const init = await command(page, `/mbot init ${ws}`)
  assert.equal(init.kind, 'success')
  const mainId = /^Main Session: (session-[0-9a-f-]+)$/mu.exec(init.text)[1]
  const record = JSON.parse((await command(page, '/mbot_fixture_conversation')).text)
  const git = (...args) => execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8' }).trim()
  const head = git('rev-parse', 'HEAD')
  await page.goto(`${url}#mbot-session=${record.sessionId}`)
  await page.locator('[contenteditable=true]').waitFor()
  await send(page, 'group window A')
  await page.getByText('Reserved conversation requires memory and tool visibility filtering before execution', { exact: false }).first().waitFor()
  const other = await context.newPage()
  await other.goto(`${url}#mbot-session=${record.sessionId}`); await other.locator('[contenteditable=true]').waitFor()
  await send(other, 'group window B')
  let state = JSON.parse((await command(other, '/mbot_fixture_domain_state')).text)
  assert.equal(state.pending.length, 2)
  assert.deepEqual(state.registry.conversations[0], record)
  assert.equal(state.descriptor.state, 'reserved')
  const denied = await command(page, '/mbot status')
  assert.equal(denied.kind, 'error'); assert.match(denied.text, /owner management/u)
  await page.getByText('Conversation inputs cannot invoke owner management commands', { exact: false }).first().waitFor()
  await page.screenshot({ path: join(root, 'reserved-domain.png'), fullPage: true })
  await page.reload(); await page.locator('[contenteditable=true]').waitFor()
  assert.equal(JSON.parse((await command(page, '/mbot_fixture_domain_state')).text).pending.length, 2)
  await other.close()
  assert.equal((await requests()).length, 0)
  server.kill('SIGKILL'); await server.finished
  url = await host()
  await page.goto(`${url}#mbot-session=${record.sessionId}`); await page.locator('[contenteditable=true]').waitFor()
  state = JSON.parse((await command(page, '/mbot_fixture_domain_state')).text)
  assert.equal(state.pending.length, 2)
  assert.deepEqual(state.registry.conversations[0], record)
  await send(page, 'group after restart')
  state = JSON.parse((await command(page, '/mbot_fixture_domain_state')).text)
  assert.equal(state.pending.length, 3)
  assert.equal((await requests()).length, 0)
  assert.equal(git('rev-parse', 'HEAD'), head)
  await page.screenshot({ path: join(root, 'reserved-after-restart.png'), fullPage: true })
  await page.goto(`${url}#mbot-session=${mainId}`); await page.locator('[contenteditable=true]').waitFor()
  await send(page, 'wake')
  await page.locator('[data-mbot-audit="1"][data-phase="committed"]').waitFor()
  await page.getByText('GUI reply: wake', { exact: true }).first().waitFor()
  assert.equal((await requests()).length, 1)
  assert.equal(git('rev-list', '--count', `${head}..HEAD`), '1')
  assert.deepEqual(errors, [])
  await page.screenshot({ path: join(root, 'main-after-domain-restart.png'), fullPage: true })
  console.log(`GUI conversations PASS: installed schema, two windows, refusal, reload, SIGKILL/resume, private main; artifacts ${root}`)
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {})
    await writeFile(join(root, 'failure.txt'), `${page.url()}\n${await page.locator('body').innerText().catch(() => '')}`)
  }
  throw error
} finally {
  if (server) await writeFile(join(root, 'host.log'), server.output)
  await browser?.close()
  await Promise.all([...children].map(async child => {
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    try { await child.finished } finally { clearTimeout(timer) }
  }))
  console.log(`Conversation GUI artifacts: ${root}`)
}
