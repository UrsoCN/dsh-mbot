import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const { chromium } = await import(process.env.MBOT_PLAYWRIGHT_MODULE || 'playwright')
const repo = fileURLToPath(new URL('../', import.meta.url))
const root = await mkdtemp('/tmp/mbot-gui-compaction.')
const env = { ...process.env, DSH_HOME: join(root, 'dsh'), TMPDIR: root, COREPACK_HOME: join(root, 'corepack'),
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  DSH_TELEMETRY_MODE: 'DISABLED', DEEPSEEK_API_KEY: 'disposable-local-compaction-fixture-key',
  MBOT_GUI_COMPACTION_ROOT: root, MBOT_GUI_PACKAGE: join(root, 'dsh/profiles/web/node_modules/dsh-mbot/package.json'),
  GIT_AUTHOR_NAME: 'MBot GUI compaction', GIT_COMMITTER_NAME: 'MBot GUI compaction',
  GIT_AUTHOR_EMAIL: 'mbot-tests@example.invalid', GIT_COMMITTER_EMAIL: 'mbot-tests@example.invalid' }
delete env.MBOT_RUN_ID; delete env.MBOT_WS
const processes = new Set()
function start(program, args) {
  const child = spawn(program, args, { cwd: root, env, stdio: 'pipe' })
  processes.add(child); child.output = ''
  child.stdout.on('data', data => { child.output += data }); child.stderr.on('data', data => { child.output += data })
  child.finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => { processes.delete(child); resolve(code) }) })
  return child
}
async function run(program, args) {
  const child = start(program, args), timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  try { assert.equal(await child.finished, 0, child.output); return child.output } finally { clearTimeout(timer) }
}
async function until(check) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(30) }
  throw new Error('Timed out waiting for GUI compaction')
}
const rows = async filename => {
  const text = await readFile(join(root, filename), 'utf8').catch(() => '')
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
}
let browser, page, host
try {
  const [pack] = JSON.parse(await run('npm', ['pack', repo, '--json', '--ignore-scripts', '--pack-destination', root, '--cache', join(root, 'npm-cache')]))
  await run('dsh', ['plugin', '--profile', 'web', 'add', join(root, pack.filename), '--store-dir', join(root, 'pnpm-store'), '--ignore-scripts'])
  await mkdir(join(root, 'documents'))
  await writeFile(join(env.DSH_HOME, 'profiles/web/cordis.patch.yml'),
    `- id: workspace-controller\n  config:\n    documentsDirectory: ${join(root, 'documents')}\n- id: mbot-runtime\n  config:\n    workers: false\n- id: agent-default-model\n  config:\n    provider: mbot-compaction-fixture\n    model: scripted\n- insert:\n    - id: mbot-compaction-fixture\n      name: ${join(repo, 'tests/gui-compaction-fixture.mjs')}\n`)
  host = start('dsh', ['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'])
  const url = await until(() => /dsh web: (http:\/\/\S+)/u.exec(host.output)?.[1])
  await until(() => access(join(root, 'fixture-ready')).then(() => true, () => false))
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(url); await page.locator('[contenteditable=true]').waitFor()
  await page.getByRole('button', { name: '继续', exact: true }).waitFor({ timeout: 3000 }).then(() => page.getByRole('button', { name: '继续', exact: true }).click(), () => {})
  const send = async text => { const input = page.locator('[contenteditable=true]'); await input.fill(text); await input.press('Enter') }
  async function command(text) {
    const before = (await rows('events.jsonl')).filter(row => row.event.type === 'command/done').length
    await send(text)
    return until(async () => {
      const done = (await rows('events.jsonl')).filter(row => row.event.type === 'command/done')
      return done.length > before ? done.at(-1).event.data.text : undefined
    })
  }
  const ws = join(root, 'GUI Bot'), init = await command(`/mbot init ${ws}`)
  const sessionId = /^Main Session: (session-[0-9a-f-]+)$/mu.exec(init)[1]
  await command('/mbot runtime')
  for (const [i, text] of ['compaction seed', 'compaction next', 'compaction now'].entries()) {
    await send(text)
    await until(async () => page.locator(`[data-mbot-audit="${i + 1}"]`).getAttribute('data-phase').catch(() => null).then(value => value === 'committed'))
  }
  const checkpoint = JSON.parse(await command('/mbot_fixture_checkpoint'))
  assert.ok(checkpoint.compactions.some(proof => proof.status === 'completed'))
  assert.equal(checkpoint.snapshot.sessionId, sessionId)
  const history = await rows('events.jsonl'), proof = checkpoint.compactions.find(proof => proof.status === 'completed')
  assert.ok(history.some(row => row.event.type === 'compaction/summary' && row.event.data.compactionId === proof.compactionId))
  const summaries = (await rows('summaries.jsonl')).length
  assert.ok(summaries >= 1)
  assert.equal(history.filter(row => row.event.type === 'compaction/summary').length, 1)
  assert.equal(execFileSync('git', ['-C', ws, 'status', '--porcelain'], { encoding: 'utf8' }), '')
  await page.screenshot({ path: join(root, 'managed-compaction.png'), fullPage: true })
  await page.reload(); await page.locator('[contenteditable=true]').waitFor()
  const restored = JSON.parse(await command('/mbot_fixture_checkpoint'))
  assert.deepEqual(restored.compactions, checkpoint.compactions)
  const before = (await rows('requests.jsonl')).length
  const rejected = await command('/compact')
  assert.match(rejected, /compact|summary|压缩/u)
  assert.equal((await rows('requests.jsonl')).length, before)
  assert.equal((await rows('summaries.jsonl')).length, summaries)
  assert.deepEqual(errors, [])
  console.log(`Installed GUI compaction passed: ${sessionId}, attributed native summary, Git checkpoint, reload and standalone maintenance gate.`)
} catch (error) {
  if (page) await page.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {})
  await writeFile(join(root, 'failure.txt'), error.stack ?? String(error)); throw error
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const child of processes) child.kill('SIGTERM')
  for (const child of processes) await child.finished
  if (host) await writeFile(join(root, 'host.log'), host.output)
  console.log(`GUI compaction artifacts: ${root}`)
}
