import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { workerProof, workerCompletion } from './worker-proof.js'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function privateInput(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600
    || info.size > 16 * 1024 * 1024) throw new Error('Unsafe private Worker recovery input')
  return readFile(path, 'utf8')
}

export function workerRecoveryContract(journal) {
  const ownership = journal.runtimeOwnership
  if (journal.schemaVersion !== 3 || journal.writerScope !== 'agent-runtime' || journal.role !== 'chief'
    || ownership?.schemaVersion !== 2 || ownership.mode !== 'foreground-workers' || ownership.workerDepth !== 1
    || ownership.maxWorkers !== 2 || !isDeepStrictEqual(ownership.workerTools, ['botctl'])
    || !Array.isArray(journal.actors) || journal.actors.length > 256) throw new Error('Unsupported Worker recovery contract')
  const ids = new Set(), sessions = new Set(), tokens = new Set([journal.token]), tasks = new Set()
  for (const actor of journal.actors) {
    if (actor.schemaVersion !== 1 || actor.kind !== 'native-worker' || !/^[a-f0-9]{32}$/u.test(actor.actorId ?? '')
      || !/^[a-f0-9]{64}$/u.test(actor.token ?? '') || !/^[a-f0-9]{64}$/u.test(actor.snapshotHash ?? '')
      || typeof actor.sessionId !== 'string' || !actor.sessionId || actor.sessionId === journal.sessionId || actor.sessionId.length > 256
      || /[\0\r\n]/u.test(actor.sessionId) || !/^[a-z][a-z0-9_-]{0,31}$/u.test(actor.role ?? '') || ['chief', 'human'].includes(actor.role)
      || !/^[0-9]{3,9}$/u.test(actor.taskId ?? '') || actor.taskId === '000' || !['active', 'revoked'].includes(actor.state)
      || ids.has(actor.actorId) || sessions.has(actor.sessionId) || tokens.has(actor.token)) throw new Error('Worker recovery manifest is invalid')
    ids.add(actor.actorId); sessions.add(actor.sessionId); tokens.add(actor.token)
    if (actor.state === 'active') { if (tasks.has(actor.taskId)) throw new Error('Worker task ownership overlaps'); tasks.add(actor.taskId) }
  }
  if (tasks.size > 2) throw new Error('Worker recovery capacity exceeds its contract')
}

function completionInput(actor, log, journal) {
  const messages = new Map(log.events.filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted ?? []).filter(message => message.source.kind === 'user').map(message => [message.id, message]))
  if (messages.size > 1) throw new Error('Worker recovery found unbound user input')
  const initialMessageId = [...messages.keys()][0]
  const result = workerCompletion(log.events)
  return { quiescent: true, startupFailed: !initialMessageId,
    ...(initialMessageId ? { initialMessageId } : {}), result: initialMessageId ? result : { ...result, stopReason: actor.native?.stopReason ?? 'error' },
    session: log.session, inheritedEventCount: log.inheritedEventCount, parentSessionId: journal.sessionId, runId: journal.runId }
}

function sealedLog(actor, log) {
  if (!log || !Array.isArray(log.events)) throw new Error('Worker native recovery log is missing')
  if (!actor.native) return log
  const cut = actor.native.eventCount
  if (!Number.isSafeInteger(cut) || cut < 0 || cut > log.events.length || log.events.slice(cut).some(event =>
    !(event.type === 'session/end-seed' && Object.keys(event.data).length === 0)
      && !(event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled'
        && event.data.removedCount === 0 && event.data.inserted.length === 0))) throw new Error('Worker received execution or input after its sealed event cut')
  return { ...log, events: log.events.slice(0, cut) }
}

/** Validate original evidence before native crash repair appends any closers. */
export async function workerRecoveryPrefix(journal, actor, log) {
  if (log?.session?.id !== actor.sessionId) throw new Error('Worker recovery native identity changed')
  const saved = JSON.parse(await privateInput(join(journal.scratch, `actor-${actor.actorId}.json`)))
  const { native, ...identity } = actor
  if (!isDeepStrictEqual(saved.actor, { ...identity, state: 'active' }) || hash(saved.snapshot) !== actor.snapshotHash
    || saved.snapshot.head !== journal.baseHead || saved.snapshot.workspace !== journal.workspace
    || saved.snapshot.role !== actor.role || saved.snapshot.taskId !== actor.taskId) throw new Error('Worker recovery snapshot changed')
  const recorded = (await privateInput(join(journal.scratch, `actor-${actor.actorId}.events.jsonl`))).split('\n').filter(Boolean).map(line => JSON.parse(line))
  if (recorded.length > log.events.length || !isDeepStrictEqual(recorded, log.events.slice(0, recorded.length))) throw new Error('Private Worker events contradict the native recovery log')
  return { saved, recorded }
}

/** Derive settlement actors without rewriting the original ledger or child event files. */
export async function workerRecoveryInput(journal, logs) {
  workerRecoveryContract(journal)
  if (!Array.isArray(logs) || logs.length !== journal.actors.length) throw new Error('Every Worker needs an owned native recovery log')
  const derived = []
  for (const [index, actor] of journal.actors.entries()) {
    const log = sealedLog(actor, logs[index])
    const { saved, recorded } = await workerRecoveryPrefix(journal, actor, log)
    const { native } = actor
    const input = completionInput(actor, log, journal)
    const proof = workerProof(actor, saved.snapshot, log.events, input, journal.runtimeOwnership)
    if (native) {
      const seal = JSON.parse(await privateInput(join(journal.scratch, `actor-${actor.actorId}.native.json`)))
      if (!isDeepStrictEqual(native, proof) || !isDeepStrictEqual(native, seal.native)
        || !isDeepStrictEqual(native, workerProof(actor, saved.snapshot, recorded, { ...seal.input, parentSessionId: journal.sessionId, runId: journal.runId }, journal.runtimeOwnership))) throw new Error('Sealed Worker completion changed')
    }
    derived.push({ ...actor, state: 'revoked', native: proof })
  }
  return derived
}

/** After a commit, native assignment records bind the token-free Git Actor audit. */
export function verifyWorkerAudit(actors, logs, identity) {
  if (!Array.isArray(actors) || !Array.isArray(logs) || logs.length !== actors.length) throw new Error('Worker audit lacks native child evidence')
  const ids = new Set(), sessions = new Set()
  const bySession = new Map(logs.map(log => [log.session?.id, log]))
  if (bySession.size !== logs.length) throw new Error('Worker audit repeats native child evidence')
  for (const [index, actor] of actors.entries()) {
    if (actor?.kind !== 'native-worker' || actor.state !== 'revoked' || actor.token !== undefined || ids.has(actor.actorId)
      || sessions.has(actor.sessionId) || !/^[a-f0-9]{64}$/u.test(actor.snapshotHash ?? '')) throw new Error('Worker Git audit identity is invalid')
    ids.add(actor.actorId); sessions.add(actor.sessionId)
    const log = sealedLog(actor, bySession.get(actor.sessionId))
    if (log?.session?.id !== actor.sessionId) throw new Error('Worker audit native identity changed')
    const input = completionInput(actor, log, { sessionId: identity.sessionId, runId: identity.runId })
    const proof = workerProof(actor, { workspace: identity.workspace, head: identity.memoryCommit }, log.events, input, { workerTools: ['botctl'] })
    if (!isDeepStrictEqual(actor.native, proof)) throw new Error('Worker Git audit contradicts its native child')
  }
  return actors
}
