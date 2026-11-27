#!/usr/bin/env node
// Private turn protocol, invoked while the owning bridge holds botctl.lock.
// An actor permit is DATA for that turn, never permission to spawn an Agent.
import { readFile, lstat, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { validateOwnership } from '../plugin/recovery-proof.js'
import { workerProof } from '../plugin/worker-proof.js'
import { redactValue } from '../plugin/redact.js'
import { validateTurnScratch, atomicWriteSync, syncFile } from '../plugin/turn-state.js'

const prepare = process.argv[2] === '--prepare-finalization'
const verify = prepare || process.argv[2] === '--verify'
const context = process.argv[2] === '--context'
const [scratch, workspace] = process.argv.slice(verify || context ? 3 : 2)
let request
const fail = message => { throw new Error(message) }
async function safeFile(base, relative, privateMode = false) {
  let path = base
  const parts = relative.split('/')
  for (const [index, part] of parts.entries()) {
    if (!part || part === '.' || part === '..') fail('Invalid actor path')
    path = join(path, part)
    const info = await lstat(path)
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
      || info.uid !== process.getuid() || info.size > 16 * 1024 * 1024
      || privateMode && index === parts.length - 1 && (info.mode & 0o777) !== 0o600) fail('Unsafe actor input')
  }
  return readFile(path, 'utf8')
}
async function replace(file, data, raw = false) {
  await atomicWriteSync(file, raw ? data : JSON.stringify(data), 0o600)
}
try {
  if (!verify && !context) {
    process.stdin.setEncoding('utf8')
    let raw = ''; for await (const chunk of process.stdin) raw += chunk
    request = JSON.parse(raw)
  }
  if (!scratch || await realpath(workspace) !== workspace) fail('Invalid actor transaction location')
  const directory = await lstat(scratch)
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700) fail('Unsafe actor transaction snapshot')
  const ledgerBytes = await safeFile(scratch, 'ledger.json', true)
  const saved = JSON.parse(ledgerBytes)
  const active = JSON.parse(await safeFile(workspace, '.mbot/runs/active-turn.json', true))
  await validateTurnScratch(saved)
  const header = JSON.parse(await safeFile(scratch, 'header.json', true))
  const token = JSON.parse(await safeFile(scratch, 'token.json', true))
  if (saved.schemaVersion !== 3 || saved.writerScope !== 'agent-runtime' || saved.role !== 'chief'
    || saved.workspace !== workspace || saved.scratch !== scratch || saved.phase !== 'active' || active.phase !== 'active'
    || token !== saved.token || !isDeepStrictEqual(saved, active)
    || !isDeepStrictEqual(header.runtimeOwnership, saved.runtimeOwnership)
    || header.botId !== saved.botId || header.sessionId !== saved.sessionId || header.turn !== saved.turn) fail('Actor transaction ownership changed')
  const baseline = JSON.parse(await safeFile(scratch, 'ignored/.mbot/runs/active-turn.json', true))
  const withoutActors = value => { const { actors, ...identity } = value; return identity }
  if (!isDeepStrictEqual(withoutActors(saved), withoutActors(baseline))) fail('Actor transaction baseline changed')
  validateOwnership(saved.runtimeOwnership, true)
  if (saved.runtimeOwnership.schemaVersion !== 2 || !Array.isArray(saved.actors)) fail('Actor transaction has no delegated lifetime contract')
  const ids = new Set(), sessions = new Set(), tokens = new Set([token]), tasks = new Set()
  if (saved.actors.length > 256) fail('Invalid actor manifest')
  let live = 0
  for (const actor of saved.actors) {
    if (actor?.schemaVersion !== 1 || !/^[a-f0-9]{32}$/u.test(actor.actorId ?? '') || !/^[a-f0-9]{64}$/u.test(actor.token ?? '')
      || !/^[a-f0-9]{64}$/u.test(actor.snapshotHash ?? '') || typeof actor.sessionId !== 'string' || !actor.sessionId
      || actor.sessionId === saved.sessionId || actor.sessionId.length > 256 || /[\0\r\n]/u.test(actor.sessionId)
      || typeof actor.role !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(actor.role) || ['human', 'chief'].includes(actor.role)
      || typeof actor.taskId !== 'string' || !/^[0-9]{3,9}$/u.test(actor.taskId) || actor.taskId === '000'
      || !['active', 'revoked'].includes(actor.state) || ids.has(actor.actorId) || sessions.has(actor.sessionId) || tokens.has(actor.token)) fail('Invalid actor manifest')
    ids.add(actor.actorId); sessions.add(actor.sessionId); tokens.add(actor.token)
    if (actor.state === 'active') { if (tasks.has(actor.taskId)) fail('Invalid actor task reservation'); tasks.add(actor.taskId); live++ }
    const proof = JSON.parse(await safeFile(scratch, `actor-${actor.actorId}.json`, true))
    if (!isDeepStrictEqual(proof.actor, (() => { const { native, ...identity } = actor; return { ...identity, state: 'active' } })()) || proof.snapshot.role !== actor.role
      || proof.snapshot.head !== saved.baseHead || proof.snapshot.workspace !== workspace || proof.snapshot.taskId !== actor.taskId
      || createHash('sha256').update(JSON.stringify(proof.snapshot)).digest('hex') !== actor.snapshotHash) fail('Actor snapshot does not match its manifest')
    if (actor.native) {
      const seal = JSON.parse(await safeFile(scratch, `actor-${actor.actorId}.native.json`, true))
      const events = (await safeFile(scratch, `actor-${actor.actorId}.events.jsonl`, true)).split('\n').filter(Boolean).map(line => JSON.parse(line))
      const expected = workerProof(actor, proof.snapshot, events, { ...seal.input, parentSessionId: saved.sessionId, runId: saved.runId }, saved.runtimeOwnership)
      if (!isDeepStrictEqual(expected, actor.native) || !isDeepStrictEqual(expected, seal.native)) fail('Worker native completion proof changed')
    }
  }
  if (live > saved.runtimeOwnership.maxWorkers) fail('Invalid actor capacity')
  if (context) {
    const actor = saved.actors.find(actor => actor.state === 'active' && actor.token === process.env.MBOT_PERMIT_TOKEN)
    if (!actor || saved.expiresAt <= Date.now() || process.env.MBOT_RUN_ID !== saved.runId) fail('Delegated actor context permission is stale')
    const proof = JSON.parse(await safeFile(scratch, `actor-${actor.actorId}.json`, true))
    process.stdout.write(JSON.stringify(proof.snapshot) + '\n')
    process.exit(0)
  }
  if (verify) {
    if (saved.actors.some(actor => actor.state !== 'revoked')) fail('Delegated actors must drain and close before turn settlement')
    // With no delegations the original journal is jq-formatted; controls use
    // compact JSON. Preserve the proven ledger bytes so representation alone
    // cannot turn a clean foreground-only execution into a guard violation.
    if (prepare) await replace(join(scratch, 'ignored/.mbot/runs/active-turn.json'), ledgerBytes, true)
    process.exit(0)
  }
  if (typeof request.requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(request.requestId) || request.token !== token) fail('Invalid actor control permission')
  if (!['delegate', 'revoke', 'actor-event', 'actor-seal'].includes(request.kind)) fail('Unknown actor operation')
  let response
  if (request.kind === 'delegate') {
    if (saved.expiresAt <= Date.now()) fail('Actor transaction expired')
    if (Object.keys(request).some(key => !['kind', 'token', 'requestId', 'sessionId', 'role', 'taskId', 'native'].includes(key))
      || !/^[a-z][a-z0-9_-]{0,31}$/u.test(request.role ?? '') || ['chief', 'human'].includes(request.role)
      || request.native !== undefined && typeof request.native !== 'boolean'
      || typeof request.taskId !== 'string' || !/^[0-9]{3,9}$/u.test(request.taskId) || request.taskId === '000' || typeof request.sessionId !== 'string' || !request.sessionId
      || request.sessionId.length > 256 || /[\0\r\n]/u.test(request.sessionId) || request.sessionId === saved.sessionId) fail('Invalid actor assignment')
    if (saved.actors.length >= 256 || saved.actors.some(actor => actor.sessionId === request.sessionId)
      || saved.actors.some(actor => actor.state === 'active' && actor.taskId === request.taskId)
      || saved.actors.filter(actor => actor.state === 'active').length >= saved.runtimeOwnership.maxWorkers) fail('Actor identity, task or capacity is already reserved')
    const task = await safeFile(workspace, `tasks/${request.taskId}.md`)
    const board = await safeFile(workspace, 'BOARD.md')
    const rows = board.split('\n').map(line => line.split('|').map(cell => cell.trim())).filter(row => row.length === 7 && row[1] === request.taskId)
    if (rows.length !== 1 || rows[0][2] !== 'doing' || rows[0][3] !== request.role
      || !task.startsWith(`# ${request.taskId} `) || !task.includes(`\n- owner: ${request.role}\n`)
      || !task.includes('\n- 状态: doing\n')) fail('Delegation requires its assigned doing task')
    for (const file of [`bots/${request.role}/SOUL.md`, `bots/${request.role}/MEMORY.md`]) await safeFile(workspace, file)
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(saved.baseHead)) fail('Invalid actor context baseline')
    const git = path => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', workspace,
      'show', `${saved.baseHead}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
    const actorToken = randomBytes(32).toString('hex')
    const reference = await redactValue({ protocol: git('AGENTS.md'), memory: git('MEMORY.md'),
      soul: git(`bots/${request.role}/SOUL.md`), roleMemory: git(`bots/${request.role}/MEMORY.md`), board, task },
      workspace, [token, actorToken, ...saved.actors.map(actor => actor.token)])
    // Control identities must survive reference-text redaction unchanged.
    const snapshot = { head: saved.baseHead, role: request.role, workspace, taskId: request.taskId, ...reference }
    const actor = { schemaVersion: 1, ...(request.native ? { kind: 'native-worker' } : {}), actorId: randomBytes(16).toString('hex'), sessionId: request.sessionId, role: request.role, taskId: request.taskId,
      snapshotHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), token: actorToken, state: 'active' }
    await replace(join(scratch, `actor-${actor.actorId}.json`), { actor, snapshot })
    if (request.native) await writeFile(join(scratch, `actor-${actor.actorId}.events.jsonl`), '', { mode: 0o600, flag: 'wx' })
    saved.actors.push(actor)
    const secrets = JSON.parse(await safeFile(scratch, 'secrets.json', true))
    await replace(join(scratch, 'secrets.json'), [...new Set([...secrets, actorToken])])
    response = { kind: 'delegated', requestId: request.requestId, actorId: actor.actorId, token: actorToken, snapshot }
  } else if (request.kind === 'actor-event' || request.kind === 'actor-seal') {
    const actor = saved.actors.find(actor => actor.actorId === request.actorId)
    if (!actor || actor.kind !== 'native-worker' || actor.state !== 'active' || actor.native) fail('Worker native lifetime is not active')
    const file = `actor-${actor.actorId}.events.jsonl`
    const events = (await safeFile(scratch, file, true)).split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (request.kind === 'actor-event') {
      if (request.event?.seq !== events.length || typeof request.event.type !== 'string') fail('Worker native event cut changed')
      await writeFile(join(scratch, file), JSON.stringify(request.event) + '\n', { flag: 'a' })
      await syncFile(join(scratch, file))
      response = { kind: 'recorded', requestId: request.requestId }
    } else {
      const proof = JSON.parse(await safeFile(scratch, `actor-${actor.actorId}.json`, true))
      actor.native = workerProof(actor, proof.snapshot, events, { ...request.input, parentSessionId: saved.sessionId, runId: saved.runId }, saved.runtimeOwnership)
      await replace(join(scratch, `actor-${actor.actorId}.native.json`), { input: request.input, native: actor.native })
      response = { kind: 'sealed', requestId: request.requestId, native: actor.native }
    }
  } else {
    if (Object.keys(request).some(key => !['kind', 'token', 'requestId', 'actorId'].includes(key)) || !/^[a-f0-9]{32}$/u.test(request.actorId ?? '')) fail('Invalid actor revocation')
    const actor = saved.actors.find(actor => actor.actorId === request.actorId)
    if (!actor) fail('Actor permission was not issued by this turn')
    if (actor.kind === 'native-worker' && !actor.native) fail('Native Worker must settle before data permission revocation')
    actor.state = 'revoked'
    response = { kind: 'revoked', requestId: request.requestId, actorId: actor.actorId }
  }
  // No response is emitted before both durable identities agree. A crash or
  // partial replacement leaves disagreement and refuses further operations.
  await replace(join(scratch, 'ledger.json'), saved)
  await replace(join(workspace, '.mbot/runs/active-turn.json'), saved)
  process.stdout.write(JSON.stringify(response) + '\n')
} catch (error) {
  const message = error.code || error instanceof SyntaxError ? 'Actor inputs are unavailable or invalid' : error.message
  if (verify || context) { process.stderr.write(`mbot: ${message}\n`); process.exitCode = 1 }
  else process.stdout.write(JSON.stringify({ kind: 'actor-error', requestId: request?.requestId, error: message }) + '\n')
}
