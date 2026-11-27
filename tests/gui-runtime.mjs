import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const { chromium } = await import(process.env.MBOT_PLAYWRIGHT_MODULE || 'playwright')
const repo = fileURLToPath(new URL('../', import.meta.url))
const root = await mkdtemp('/tmp/mbot-gui-runtime.')
const env = { ...process.env, DSH_HOME: join(root, 'dsh'), TMPDIR: root,
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'), COREPACK_HOME: join(root, 'corepack'), DSH_TELEMETRY_MODE: 'DISABLED',
  DEEPSEEK_API_KEY: 'mbot-disposable-local-adapter-key', MBOT_GUI_RUNTIME_ROOT: root,
  MBOT_GUI_PACKAGE: join(root, 'dsh/profiles/web/node_modules/dsh-mbot/package.json'),
  GIT_AUTHOR_NAME: 'MBot GUI Runtime', GIT_COMMITTER_NAME: 'MBot GUI Runtime',
  GIT_AUTHOR_EMAIL: 'mbot-tests@example.invalid', GIT_COMMITTER_EMAIL: 'mbot-tests@example.invalid' }
delete env.MBOT_WS
delete env.MBOT_RUN_ID
const processes = new Set()
function start(program, args) {
  const child = spawn(program, args, { cwd: root, env, stdio: 'pipe' })
  processes.add(child)
  child.output = ''
  child.stdout.on('data', data => { child.output += data })
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
  let code
  try { code = await child.finished } finally { clearTimeout(timer) }
  assert.equal(code, 0, child.output)
  return child.output
}
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(30)
  }
  throw new Error('Timed out waiting for GUI Runtime condition')
}
const exists = name => access(join(root, name)).then(() => true, () => false)
const events = async () => (await readFile(join(root, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
let browser, page
try {
  const [packed] = JSON.parse(await run('npm', ['pack', repo, '--json', '--ignore-scripts', '--pack-destination', root, '--cache', join(root, 'npm-cache')]))
  await run('dsh', ['plugin', '--profile', 'web', 'add', join(root, packed.filename), '--store-dir', join(root, 'pnpm-store'), '--ignore-scripts'])
  await mkdir(join(root, 'documents'))
  const patch = join(env.DSH_HOME, 'profiles/web/cordis.patch.yml')
  await writeFile(patch, `- id: workspace-controller\n  config:\n    documentsDirectory: ${join(root, 'documents')}\n- id: agent-default-model\n  config:\n    provider: mbot-ui-fixture\n    model: scripted\n- insert:\n    - id: mbot-runtime-fixture\n      name: ${join(repo, 'tests/gui-runtime-fixture.mjs')}\n`)
  async function host() {
    const child = start('dsh', ['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'])
    const url = await until(() => /dsh web: (http:\/\/\S+)/u.exec(child.output)?.[1])
    await until(() => exists('fixture-ready')).catch(async error => { await writeFile(join(root, 'host.log'), child.output); throw error })
    return { child, url }
  }
  let server = await host()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(server.url)
  await page.locator('[contenteditable=true]').waitFor()
  await page.getByRole('button', { name: '继续', exact: true }).waitFor({ timeout: 3000 }).then(() => page.getByRole('button', { name: '继续', exact: true }).click(), () => {})
  async function send(text) { const input = page.locator('[contenteditable=true]'); await input.fill(text); await input.press('Enter') }
  async function command(text) {
    const before = (await events()).filter(row => row.event.type === 'command/done').length
    await send(text)
    return until(async () => {
      const rows = (await events()).filter(row => row.event.type === 'command/done')
      return rows.length > before ? rows.at(-1).event.data.text : undefined
    })
  }
  const ws = join(root, 'GUI Bot')
  const init = await command(`/mbot init ${ws}`)
  const sessionId = /^Main Session: (session-[0-9a-f-]+)$/mu.exec(init)[1]
  await command('/mbot runtime')
  const git = (...args) => execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8' }).trim()
  const firstBase = git('rev-parse', 'HEAD')
  await send('hold audit')
  await until(() => exists('audit-waiting'))
  const audit = turn => page.locator(`[data-mbot-audit="${turn}"]`)
  await until(async () => await audit(1).getAttribute('data-phase') === 'auditing')
  assert.equal(git('rev-parse', 'HEAD'), firstBase)
  assert.ok((await command('/mbot runtime')).includes('MBot Runtime: auditing'))
  await page.screenshot({ path: join(root, 'audit-pending.png'), fullPage: true })
  await writeFile(join(root, 'release-audit'), '')
  await until(async () => await audit(1).getAttribute('data-phase') === 'committed' && await audit(1).isVisible())
  assert.ok((await audit(1).innerText()).includes(git('rev-parse', 'HEAD').slice(0, 12)))

  await send('slow writer')
  await until(() => exists('writer-started'))
  await send('queued after writer')
  await until(async () => (await command('/mbot runtime')).includes('Queued: 1 next-turn'))
  const stopBase = git('rev-parse', 'HEAD')
  // This is the native composer Stop button, through conversation.cancel → session.cancel.
  const stop = page.getByRole('button', { name: /停止|Stop/u })
  await stop.last().click()
  await until(() => exists('writer-cancelled'))
  assert.equal(git('rev-parse', 'HEAD'), stopBase)
  await writeFile(join(root, 'release-writer'), '')
  await until(async () => await audit(2).getAttribute('data-phase') === 'rejected')
  assert.match(await audit(2).innerText(), /已停止|stopped/u)
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '0\n')
  assert.ok((await command('/mbot runtime')).includes('Queued: 1 next-turn'))
  assert.match(await command('/mbot stop'), /Stop completed; queued inputs retained/u)
  await send('wake')
  await until(async () => await audit(4).getAttribute('data-phase') === 'committed')
  assert.equal(git('rev-list', '--count', `${firstBase}..HEAD`), '4')
  await page.screenshot({ path: join(root, 'native-stop-and-audits.png'), fullPage: true })

  // A cancelled native turn whose cleanup violates memory is a failed audit.
  const memory = await readFile(join(ws, 'MEMORY.md'), 'utf8')
  for (const name of ['writer-started', 'writer-cancelled', 'release-writer']) await rm(join(root, name))
  await writeFile(join(root, 'violate-next-stop'), '')
  await send('slow writer')
  await until(() => exists('writer-started'))
  await page.getByRole('button', { name: /停止|Stop/u }).last().click()
  await until(() => exists('writer-cancelled'))
  await writeFile(join(root, 'release-writer'), '')
  await until(async () => await audit(5).getAttribute('data-phase') === 'rejected')
  assert.match(await audit(5).innerText(), /未通过验收|did not pass/u)
  assert.doesNotMatch(await audit(5).innerText(), /已停止|MBot stopped/u)
  assert.equal(await readFile(join(ws, 'MEMORY.md'), 'utf8'), memory)
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '1\n')
  await page.screenshot({ path: join(root, 'stopped-but-guard-failed.png'), fullPage: true })

  const beforeFailure = git('rev-parse', 'HEAD')
  await writeFile(join(root, 'fail-next-commit'), '')
  await send('fail audit')
  await until(async () => await audit(6).getAttribute('data-phase') === 'failed')
  assert.match(await audit(6).innerText(), /commit failed/u)
  assert.equal(git('rev-parse', 'HEAD'), beforeFailure)
  assert.equal(JSON.parse(await readFile(join(ws, '.mbot/runs/active-turn.json'), 'utf8')).writerScope, 'agent-runtime')
  assert.match(await command('/mbot runtime'), /MBot Runtime: failed/u)
  const second = await context.newPage()
  await second.goto(`${server.url}#mbot-session=${sessionId}`)
  await second.locator('[data-mbot-audit="6"][data-phase="failed"]').waitFor()
  await page.reload()
  await audit(6).waitFor()
  assert.equal(await page.locator('[data-mbot-audit]').count(), 6)
  await page.screenshot({ path: join(root, 'audit-failure-replay.png'), fullPage: true })
  await second.close()
  const calls = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').length
  assert.equal(calls, 6)
  assert.deepEqual(errors, [])
  assert.match(await command('/mbot recover'), /Turn recovered and audited/u)
  await until(async () => await audit(6).getAttribute('data-phase') === 'committed')
  assert.match(await command('/mbot runtime'), /MBot Runtime: idle/u)
  assert.equal(await access(join(ws, '.mbot/runs/active-turn.json')).then(() => true, () => false), false)
  assert.equal(await readFile(join(ws, '.mbot/failures'), 'utf8'), '0\n')
  assert.match(await command('/mbot resume'), /Resumed/u)
  // External CLI uses the installed package and the same native main Session.
  const cliWs = join(root, 'CLI GUI Bot')
  await command(`/mbot init ${cliWs}`)
  const ctl = join(env.DSH_HOME, 'profiles/web/node_modules/.bin/botctl')
  const hostCall = async args => JSON.parse(await run(ctl, [...args, '--profile', 'web']))
  const recoverHost = async botId => {
    const deadline = Date.now() + 5000
    for (;;) {
      try { return await hostCall(['recover', '--bot', botId]) }
      catch (error) {
        // A sandboxed browser process can be briefly unreadable while exiting.
        // Retry only the explicitly refused operation; every attempt rechecks
        // ownership and Git/native evidence through the ordinary Host API.
        if (Date.now() >= deadline || !error.message.includes('IPC_REJECTED')
          || !error.message.includes('Cannot inspect possible writer pid ')) throw error
        await delay(50)
      }
    }
  }
  const cliBot = (await hostCall(['bots'])).value.bots.find(bot => bot.workspacePath === cliWs)
  assert.ok(cliBot.mainSessionId)
  const cliArgs = ['talk', '--bot', cliBot.botId, '--request-id', 'gui-cli-1', '--text', 'External CLI message']
  const submitted = await hostCall(cliArgs)
  assert.equal(submitted.value.confirmation, 'confirmed')
  await until(async () => await audit(1).getAttribute('data-phase') === 'committed')
  await page.getByText('External CLI message', { exact: true }).waitFor()
  const firstReply = await hostCall(['receipt', '--bot', cliBot.botId, '--request-id', 'gui-cli-1', '--wait', '--timeout-ms', '2000'])
  assert.equal(firstReply.value.delivery, 'ended')
  assert.equal(firstReply.value.result.final, true)
  assert.equal(firstReply.value.result.status, 'completed')
  assert.match(firstReply.value.result.reply.text, /GUI reply:/u)
  assert.equal((await hostCall(cliArgs)).value.messageId, submitted.value.messageId)
  const cliGit = (...args) => execFileSync('git', ['-C', cliWs, ...args], { encoding: 'utf8' }).trim()
  assert.equal((await hostCall(['runtime', '--bot', cliBot.botId])).value.lastReceipt.head, cliGit('rev-parse', 'HEAD'))
  for (const name of ['writer-started', 'writer-cancelled', 'release-writer']) await rm(join(root, name))
  await hostCall(['talk', '--bot', cliBot.botId, '--request-id', 'gui-cli-2', '--text', 'slow writer'])
  await until(() => exists('writer-started'))
  const queuedCli = await hostCall(['talk', '--bot', cliBot.botId, '--request-id', 'gui-cli-3', '--text', 'queued after writer'])
  const stoppingCli = hostCall(['stop', '--bot', cliBot.botId])
  await until(() => exists('writer-cancelled'))
  await writeFile(join(root, 'release-writer'), '')
  const stoppedCli = await stoppingCli
  assert.equal(stoppedCli.value.receipt.outcome, 'cancelled')
  assert.equal((await hostCall(['receipt', '--bot', cliBot.botId, '--request-id', 'gui-cli-3'])).value.messageId, queuedCli.value.messageId)
  assert.equal((await hostCall(['runtime', '--bot', cliBot.botId])).value.queued.nextTurn, 1)
  await hostCall(['talk', '--bot', cliBot.botId, '--request-id', 'gui-cli-4', '--text', 'wake'])
  await until(async () => await audit(4).getAttribute('data-phase') === 'committed')
  await page.screenshot({ path: join(root, 'external-cli-in-chat.png'), fullPage: true })
  const callsBeforeRestart = (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').length
  assert.equal(callsBeforeRestart, 10)
  // SIGKILL leaves the Unix path behind. A new Host must acquire flock before
  // reclaiming it; same-ID retry reads persisted native history after restart.
  server.child.kill('SIGKILL')
  await server.child.finished
  await rm(join(root, 'fixture-ready'))
  server = await host()
  const afterRestart = await hostCall(cliArgs)
  assert.equal(afterRestart.value.messageId, submitted.value.messageId)
  assert.equal(afterRestart.value.delivery, 'ended')
  const recoveredReply = await hostCall(['receipt', '--bot', cliBot.botId, '--request-id', 'gui-cli-1'])
  assert.equal(recoveredReply.value.result.final, true)
  assert.equal(recoveredReply.value.result.reply.replyId, firstReply.value.result.reply.replyId)
  assert.equal(recoveredReply.value.result.reply.text, firstReply.value.result.reply.text)
  await page.goto(`${server.url}#mbot-session=${cliBot.mainSessionId}`)
  await page.locator('[data-mbot-audit="4"][data-phase="committed"]').waitFor()
  assert.equal(await page.locator('[data-mbot-audit]').count(), 4)
  assert.equal((await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').length, callsBeforeRestart)
  // A native workspace deletion does not silently unregister the independent
  // Bot. Explicit removal also gates archived old windows after a real restart.
  assert.match(await command('/mbot_fixture_delete'), /Native workspace deleted/u)
  assert.ok((await hostCall(['bots'])).value.bots.some(bot => bot.botId === cliBot.botId))
  assert.match(await command(`/mbot remove ${cliBot.botId}`), /Data preserved:/u)
  assert.ok(!(await hostCall(['bots'])).value.bots.some(bot => bot.botId === cliBot.botId))
  assert.ok((await hostCall(['removed'])).value.retiredBots.some(item => item.bot.botId === cliBot.botId))
  assert.match(await command('/mbot removed'), new RegExp(cliBot.mainSessionId))
  assert.match(await command('/mbot runtime'), /MBot Runtime: retired/u)
  const retiredHead = cliGit('rev-parse', 'HEAD')
  await send('blocked old Bot after removal')
  await until(async () => (await events()).some(row => row.sessionId === cliBot.mainSessionId
    && row.event.type === 'turn/end' && row.event.data.turn === 5))
  assert.equal(cliGit('rev-parse', 'HEAD'), retiredHead)
  assert.equal((await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').length, callsBeforeRestart)
  await page.screenshot({ path: join(root, 'bot-removed.png'), fullPage: true })
  server.child.kill('SIGKILL')
  await server.child.finished
  await rm(join(root, 'fixture-ready'))
  server = await host()
  await page.goto(`${server.url}#mbot-session=${cliBot.mainSessionId}`)
  await page.locator('[contenteditable=true]').waitFor()
  assert.match(await command('/mbot runtime'), /MBot Runtime: retired/u)
  await send('blocked retired Bot after restart')
  await until(async () => (await events()).some(row => row.sessionId === cliBot.mainSessionId
    && row.event.type === 'turn/end' && row.event.data.turn === 6))
  assert.equal((await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').length, callsBeforeRestart)
  assert.equal(cliGit('rev-parse', 'HEAD'), retiredHead)
  assert.equal((await hostCall(['remove', '--bot', cliBot.botId, '--revision', '0'])).value.alreadyRemoved, true)
  const imported = await command(`/mbot import ${cliWs}`)
  const newId = /^Imported Bot: .*\((bot-[0-9a-f-]+)\)$/mu.exec(imported)[1]
  assert.notEqual(newId, cliBot.botId)
  const replacement = (await hostCall(['bots'])).value.bots.find(bot => bot.botId === newId)
  assert.notEqual(replacement.mainSessionId, cliBot.mainSessionId)
  assert.equal(cliGit('rev-parse', 'HEAD'), retiredHead)
  const crashWs = join(root, 'Crash GUI Bot')
  await command(`/mbot init ${crashWs}`)
  const crashBot = (await hostCall(['bots'])).value.bots.find(bot => bot.workspacePath === crashWs)
  const crashGit = (...args) => execFileSync('git', ['-C', crashWs, ...args], { encoding: 'utf8' }).trim()
  const crashBase = crashGit('rev-parse', 'HEAD')
  await hostCall(['talk', '--bot', crashBot.botId, '--request-id', 'crash-active-1', '--text', 'crash hold'])
  await until(() => exists('crash-model-waiting'))
  server.child.kill('SIGKILL')
  await server.child.finished
  await rm(join(root, 'fixture-ready'))
  server = await host()
  const recoveredCrash = await recoverHost(crashBot.botId)
  assert.equal(recoveredCrash.value.success, false)
  assert.equal(recoveredCrash.value.outcome, 'failed')
  assert.equal(crashGit('rev-list', '--count', `${crashBase}..HEAD`), '1')
  assert.equal((await hostCall(['recover', '--bot', crashBot.botId])).value.needed, false)
  const interruptedReply = await hostCall(['receipt', '--bot', crashBot.botId, '--request-id', 'crash-active-1'])
  assert.equal(interruptedReply.value.result.final, true)
  assert.equal(interruptedReply.value.result.reply.text, '')
  assert.equal(await readFile(join(crashWs, '.mbot/failures'), 'utf8'), '1\n')
  await access(join(crashWs, '.mbot/PAUSED'))
  await page.goto(`${server.url}#mbot-session=${crashBot.mainSessionId}`)
  await page.locator('[contenteditable=true]').waitFor()
  assert.match(await command('/mbot resume'), /Resumed/u)
  await send('resume after crash recovery')
  await until(async () => await audit(2).getAttribute('data-phase') === 'committed')
  await page.screenshot({ path: join(root, 'runtime-recovered-after-crash.png'), fullPage: true })
  // Enable only after the foreground recovery matrix: Worker journals retain
  // their distinct, currently unsupported cold recovery contract.
  server.child.kill('SIGTERM')
  await server.child.finished
  await rm(join(root, 'fixture-ready'))
  await writeFile(patch, (await readFile(patch, 'utf8')) + '- id: mbot-runtime\n  config:\n    workers: true\n- id: sandbox-policy\n  config:\n    mode: danger-full-access\n- id: approval\n  config:\n    policy: never\n')
  server = await host()
  await page.goto(`${server.url}#mbot-session=${crashBot.mainSessionId}`)
  await page.locator('[contenteditable=true]').waitFor()
  const workerWs = join(root, 'Worker GUI Bot')
  const workerInit = await command(`/mbot init ${workerWs}`)
  const workerMain = /^Main Session: (session-[0-9a-f-]+)$/mu.exec(workerInit)[1]
  await command('/mbot runtime')
  await run(ctl, ['-C', workerWs, 'board', 'add', 'GUI native Worker task', '--owner', 'coder'])
  await run(ctl, ['-C', workerWs, 'board', 'set', '001', 'doing'])
  const workerMemory = join(workerWs, 'bots/coder/MEMORY.md')
  await writeFile(workerMemory, (await readFile(workerMemory, 'utf8')) + '\ngui-coder-private-memory-334411\n')
  const workerGit = (...args) => execFileSync('git', ['-C', workerWs, ...args], { encoding: 'utf8', env }).trim()
  workerGit('add', 'bots/coder/MEMORY.md')
  workerGit('commit', '-m', 'fixture: GUI Worker private memory')
  const workerBase = workerGit('rev-parse', 'HEAD')
  await send('native worker')
  await until(async () => await audit(1).getAttribute('data-phase') === 'committed')
  await page.getByText('GUI Chief audited Worker result', { exact: true }).waitFor()
  assert.equal(workerGit('rev-list', '--count', `${workerBase}..HEAD`), '1')
  assert.match(await readFile(join(workerWs, 'tasks/001.md'), 'utf8'), /GUI native Worker result/u)
  const workerMeta = JSON.parse(workerGit('show', 'HEAD:' + workerGit('ls-tree', '-r', '--name-only', 'HEAD').split('\n').find(path => path.endsWith('.meta.json'))))
  assert.equal(workerMeta.runtime.actors[0].native.kind, 'native-worker')
  assert.equal(workerMeta.runtime.actors[0].native.executionFault, false)
  const parentEvents = (await events()).filter(row => row.sessionId === workerMain)
  assert.ok(!JSON.stringify(parentEvents).includes('gui-coder-private-memory-334411'))
  assert.ok(!parentEvents.some(row => row.event.type === 'user/message' && row.event.data.source.kind === 'subagent-settled'))
  const observer = await context.newPage()
  await observer.goto(`${server.url}#mbot-session=${workerMain}`)
  await observer.locator('[data-mbot-audit="1"][data-phase="committed"]').waitFor()
  await observer.getByText('GUI Chief audited Worker result', { exact: true }).waitFor()
  await page.screenshot({ path: join(root, 'native-worker-audit.png'), fullPage: true })
  await observer.close()
  assert.deepEqual(errors, [])
  console.log('GUI Runtime PASS: installed/local-adapter/pending-audit/native-stop/late-writer/queue-retained/commit-failure/recovery/shared-replay/external-cli/cli-stop/crash-restart-dedup/native-workspace-delete/removal/restart-retirement/reimport-new-main/active-crash/native-closers/runtime-recovery/verified-interrupted-reply/resume/native-worker/worker-context-isolation/worker-single-audit/multi-window/no-external-model')
} catch (error) {
  if (page) { await page.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText()).catch(() => {}) }
  throw error
} finally {
  await browser?.close()
  for (const child of processes) child.kill('SIGINT')
  await Promise.allSettled([...processes].map(child => child.finished))
  console.log(`GUI Runtime artifacts: ${root}`)
}
