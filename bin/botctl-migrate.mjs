#!/usr/bin/env node
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readJournal, recoveryInput, journalDigest } from '../plugin/recovery-proof.js'
import { readonlyLegacy, readonlyDataCut } from '../plugin/readonly-migration.js'
import { openNativeRead } from '../plugin/native-storage.js'
import { processStart } from '../plugin/recovery.js'
import { redactValue } from '../plugin/redact.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const usage = 'Usage: botctl -C DATA_DIRECTORY migrate-readonly [--session-root DIRECTORY] [--dsh EXECUTABLE] [--check]\nOnly completed legacy core readonly turns qualify; the native Session is never resumed or rewritten.\n'
let recoveryWorkspace, recoveryToken
async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(usage); return }
  if (['MBOT_RUN_ID', 'DSH_MBOT_RUN_ID', 'MBOT_PERMIT_TOKEN', 'DSH_MBOT_PERMIT_TOKEN'].some(key => process.env[key] !== undefined)) throw new Error('Readonly migration is unavailable inside managed runs')
  const options = {}, flags = new Set(['--workspace', '--session-root', '--dsh', '--check'])
  while (args.length) {
    const flag = args.shift()
    if (!flags.has(flag) || flag in options) throw new Error('Unknown or duplicate migration option')
    if (flag === '--check') options[flag] = true
    else { if (!args.length) throw new Error('Migration option requires a value'); options[flag] = args.shift() }
  }
  if (!options['--workspace']) throw new Error('Readonly migration requires an explicit -C data directory')
  const workspace = await realpath(options['--workspace'])
  recoveryWorkspace = workspace
  const journal = await readJournal(workspace)
  recoveryToken = journal?.token
  if (!journal) { process.stdout.write(JSON.stringify({ kind: 'recovered', needed: false })+'\n'); return }
  if (journal.workspace !== workspace) throw new Error('Migration journal belongs to a different data directory')
  const signal = AbortSignal.timeout(60000)
  let native, directory, child
  try {
    native = await openNativeRead(journal.sessionId, { sessionRoot: options['--session-root'], dsh: options['--dsh'], signal })
    const input = await recoveryInput(journal, native.log)
    const evidence = readonlyLegacy(journal, input)
    readonlyDataCut(journal)

    directory = await mkdtemp('/tmp/mbot-runtime-recovery.')
    const proof = join(directory, 'proof.json')
    const ownerStart = await processStart()
    await writeFile(proof, JSON.stringify({ schemaVersion: 1, kind: 'runtime-quiescent', mode: 'legacy-readonly', ownerPid: process.pid, ownerStart,
      journalHash: journalDigest(journal), log: native.log, input, evidence }), { mode: 0o600, flag: 'wx' })
    child = spawn(join(root, 'bin/mbot'), ['-C', workspace, 'recover'], { cwd: root, signal,
      env: Object.fromEntries(Object.entries({ PATH: `${join(root, 'bin')}:${process.env.PATH || '/usr/bin:/bin'}`, HOME: process.env.HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, DSH_HOME: process.env.DSH_HOME,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
        MBOT_RECOVERY_CHECK: options['--check'] ? '1' : '0', MBOT_RECOVERY_OWNER: String(process.pid), MBOT_RECOVERY_START: ownerStart, MBOT_RUNTIME_RECOVERY_PROOF: proof }).filter(([, value]) => value !== undefined)),
      stdio: ['ignore', 'pipe', 'pipe'] })
    child.finished = new Promise(resolve => child.once('exit', resolve))
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    if (exit !== 0) throw new Error(stderr || 'Readonly migration did not complete')
    const result = JSON.parse(stdout)
    if (options['--check']) process.stdout.write(JSON.stringify({ ...result, kind: 'migration-check', evidence, botId: journal.botId, sessionId: journal.sessionId })+'\n')
    else process.stdout.write(JSON.stringify({ ...result, nativeAccess: 'read', paused: true, runtimeReloadRequired: true })+'\n')
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (child?.finished) await child.finished
    await native?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
}
await main().catch(async error => {
  let diagnostic = 'Readonly migration did not complete; private evidence was retained'
  try { diagnostic = await redactValue(error.message, recoveryWorkspace, recoveryToken ? [recoveryToken] : []) } catch {}
  process.stderr.write(`botctl: ${diagnostic}\n`); process.exitCode = 1
})
