// Real browser acceptance over an installed tarball and an isolated DSH Web host.
// Supply MBOT_PLAYWRIGHT_MODULE and PLAYWRIGHT_BROWSERS_PATH for /tmp installations.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rename } from 'node:fs/promises'
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
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
  timer.unref()
  let code
  try { code = await child.finished } finally { clearTimeout(timer) }
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
  await writeFile(profilePatch, `- id: workspace-controller\n  config:\n    documentsDirectory: ${join(root, 'documents')}\n- insert:\n    - id: mbot-gui-observer\n      name: ${observer}\n`)
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
  const observed = async () => (await readFile(eventsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  async function submit(line) {
    const before = (await observed()).filter(row => row.event.type === 'command/done').length
    const input = page.locator('[contenteditable=true]')
    // Keyless-profile onboarding may appear after navigation. Use its real
    // controls, then require pointer focus so a blocked composer cannot pass
    // via programmatic fill behind an overlay.
    for (let attempt = 0; ; attempt++) {
      try { await input.click({ timeout: 2000 }); break }
      catch (error) {
        const dismiss = page.getByRole('dialog').getByRole('button', { name: /^(关闭|继续|稍后配置)$/u }).first()
        if (attempt >= 3 || !await dismiss.isVisible()) throw error
        await dismiss.click()
      }
    }
    await input.fill(line)
    await input.press('Enter')
    const done = await until(async () => {
      const rows = (await observed()).filter(row => row.event.type === 'command/done')
      return rows.length > before ? rows.at(-1) : undefined
    })
    const text = done.event.data.text ?? ''
    if (!text.includes('Open main Session:')) await until(async () => (await commandRows.last().innerText()).includes(text.split('\n')[0]))
    await delay(100)
    return text
  }
  const witness = await context.newPage()
  await witness.goto(server.url)
  await witness.locator('[contenteditable=true]').waitFor()
  const workspace = join(root, '文档', 'bot demo')
  const init = await submit(`/mbot init ${workspace}`)
  assert.ok(init.includes(`Initialized ${workspace}`), init)
  assert.ok(init.includes('Selected for subsequent'), init)
  assert.ok(init.includes('Next: /mbot status'), init)
  const mainId = /^Main Session: (session-[0-9a-f-]+)$/mu.exec(init)[1]
  const originalId = (await observed()).find(row => row.event.type === 'command/done').sessionId
  assert.ok((await submit('/mbot status')).includes(`Main Session: ${mainId}`))
  assert.equal((await observed()).filter(row => row.event.type === 'command/done').at(-1).sessionId, mainId, 'Initiating window must open the main Session')
  await until(async () => await witness.locator('[data-variant="others"][data-state]').count() === 1)
  assert.ok((await witness.locator('[data-variant="others"][data-state]').innerText()).includes('Initialized'), 'Other window must stay on the original Session')
  await witness.close()
  const firstList = await submit('/mbot list')
  assert.ok(firstList.includes('Bot: bot demo'), firstList)
  assert.ok(firstList.includes(`Main Session: ${mainId}`), firstList)
  assert.ok(firstList.includes('Binding: ready'), firstList)
  assert.ok((await submit('/mbot repair')).includes(`Main Session: ${mainId}`))
  const firstBotId = /Bot: bot demo \((bot-[0-9a-f-]+)\)/u.exec(firstList)[1]
  const importedPath = join(root, '文档', 'second bot')
  await run(join(repo, 'bin', 'mbot'), ['init', importedPath])
  const importHead = await run('git', ['-C', importedPath, 'rev-parse', 'HEAD'])
  assert.ok((await submit(`/mbot import ${importedPath}`)).includes('Imported Bot: second bot'))
  assert.ok((await submit('/mbot status')).includes(`Workspace: ${workspace}`), 'Import must retain the default selection')
  await submit(`/mbot import ${importedPath}`)
  const twoBots = await submit('/mbot list')
  assert.equal((twoBots.match(/Bot: second bot \(/gu) ?? []).length, 1)
  await submit('/mbot select second bot')
  assert.ok((await submit('/mbot status')).includes(`Workspace: ${workspace}`), 'Bound main Session must stay on its own Bot after global selection changes')
  await submit('/mbot open second bot')
  assert.ok((await submit('/mbot status')).includes(`Workspace: ${importedPath}`))
  await submit(`/mbot select ${firstBotId}`)
  await submit(`/mbot open ${firstBotId}`)
  assert.equal(await run('git', ['-C', importedPath, 'rev-parse', 'HEAD']), importHead)
  assert.ok((await submit('/mbot status')).includes(`Workspace: ${workspace}`))
  const restored = await submit('/mbot list')
  assert.ok(restored.includes(firstBotId))
  assert.equal((restored.match(/Bot: second bot \(/gu) ?? []).length, 1)
  // A second real profile starts with its own empty Bot registry, even over the same DSH_HOME.
  await run('dsh', ['plugin', '--profile', 'isolated-registry', 'add', join(root, packed.filename), '--store-dir', join(root, 'pnpm-store'), '--ignore-scripts'])
  const profileProbe = join(root, 'profile-probe.mjs')
  const profileResult = join(root, 'profile-result.json')
  await writeFile(profileProbe, `import { writeFile } from 'node:fs/promises'\nexport const inject = ['mbot', 'appExit']\nexport function apply(ctx) { setImmediate(() => probe(ctx)) }\nasync function probe(ctx) { try { if(ctx.mbot.registry().bots.length) throw new Error('profile registry leaked'); const bot=await ctx.mbot.importBot(${JSON.stringify(workspace)}); if(bot.botId===${JSON.stringify(firstBotId)}) throw new Error('profile reused foreign Bot id'); await writeFile(${JSON.stringify(profileResult)}, JSON.stringify({bot,registry:ctx.mbot.registry()})); ctx.appExit(0) } catch(error) { await writeFile(${JSON.stringify(profileResult)}, JSON.stringify({error:String(error)})); ctx.appExit(1) } }\n`)
  await writeFile(join(env.DSH_HOME, 'profiles', 'isolated-registry', 'cordis.patch.yml'), `- insert:\n    - id: mbot-profile-probe\n      name: ${profileProbe}\n`)
  await run('dsh', ['--profile', 'isolated-registry'])
  const isolated = JSON.parse(await readFile(profileResult, 'utf8'))
  assert.equal(isolated.registry.bots.length, 1)
  assert.equal(isolated.registry.selectedBotId, null)
  assert.notEqual(isolated.bot.botId, firstBotId)
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
  await page.goto(`${server.url}#mbot-session=${mainId}`)
  await page.locator('[contenteditable=true]').waitFor()
  await until(async () => await commandRows.count() === count + 1).catch(async error => {
    await page.screenshot({ path: join(root, 'restart-failure.png'), fullPage: true })
    await writeFile(join(root, 'restart-failure.txt'), await page.locator('body').innerText())
    throw error
  })
  const afterRestart = await submit('/mbot status')
  assert.ok(afterRestart.includes(`Workspace: ${workspace}`))
  assert.ok(afterRestart.includes(firstBotId), 'Restart must restore the selected Bot identity, not just the legacy directory')
  const afterRestartList = await submit('/mbot list')
  assert.ok(afterRestartList.includes(firstBotId))
  assert.equal((afterRestartList.match(/Bot: second bot \(/gu) ?? []).length, 1)
  await page.screenshot({ path: join(root, 'restart.png'), fullPage: true })
  // Deep links use the plugin's hash handoff; native navigation owns the view.
  await page.goto(`${server.url}#mbot-session=${originalId}`)
  await page.locator('[contenteditable=true]').waitFor()
  await until(async () => await commandRows.count() === 1)
  assert.ok((await commandRows.innerText()).includes('Initialized'), 'Original command Session must be retained')
  await page.goto(`${server.url}#mbot-session=${mainId}`)
  await page.locator('[contenteditable=true]').waitFor()
  assert.ok((await submit('/mbot status')).includes(firstBotId))
  const events = (await observed()).map(row => row.event)
  assert.ok(events.some(event => event.type === 'command/run'))
  assert.ok(events.some(event => event.type === 'command/done'))
  assert.ok(events.every(event => !['user/message', 'assistant/message', 'turn/start', 'llm/request'].includes(event.type)), 'Control commands must not send model content or start turns')
  // A cold old Bot whose data went missing must report failure and release the
  // command/composer, rather than block every subsequent registry operation.
  await page.goto(`${server.url}#mbot-session=${originalId}`)
  await page.locator('[contenteditable=true]').waitFor()
  server.child.kill('SIGINT')
  await server.child.finished
  const offline = `${workspace}.offline`
  await rename(workspace, offline)
  try {
    server = await host()
    await page.goto(`${server.url}#mbot-session=${originalId}`)
    await page.locator('[contenteditable=true]').waitFor()
    const refused = await submit(`/mbot open ${firstBotId}`)
    assert.ok(refused.includes('Context checkpoint does not match native/Git evidence'), refused)
    assert.equal(await commandRows.last().getAttribute('data-state'), 'error')
    assert.equal(await page.locator('[contenteditable=true]').innerText(), '', 'Failed command must release and clear the composer')
    const newPath = join(root, '文档', 'after missing old Bot')
    const created = await submit(`/mbot init ${newPath}`)
    assert.ok(created.includes(`Initialized ${newPath}`), created)
    const newMain = /^Main Session: (session-[0-9a-f-]+)$/mu.exec(created)[1]
    assert.ok((await submit('/mbot status')).includes(`Main Session: ${newMain}`))
    assert.equal((await observed()).filter(row => row.event.type === 'command/done').at(-1).sessionId, newMain)
    assert.ok((await submit('/mbot list')).includes(firstBotId), 'Missing data must retain the old Bot identity')
    assert.equal(await page.locator('[contenteditable=true]').innerText(), '')
    await page.screenshot({ path: join(root, 'init-after-missing-old-bot.png'), fullPage: true })
  } finally { await rename(offline, workspace) }
  await submit(`/mbot open ${firstBotId}`)
  assert.ok((await submit('/mbot status')).includes(`Main Session: ${mainId}`), 'Restored data must resume the original main Session')
  assert.ok((await observed()).every(row => !['user/message', 'assistant/message', 'turn/start', 'llm/request'].includes(row.event.type)))
  assert.deepEqual(errors, [])
  console.log('GUI PASS: tarball/init-auto-main/import/list/select/open/repair/bound-routing/original-session/profile-isolation/status/error/skip/multiple-tabs/reload/host-restart/deep-link/missing-old-bot/failed-command-composer/new-bot-after-failure/same-session-retry/no-model')
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGINT')
  await Promise.allSettled([...processes].map(child => child.finished))
  console.log(`GUI artifacts: ${root}`)
}
