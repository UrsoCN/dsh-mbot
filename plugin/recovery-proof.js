import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { readFile, lstat } from 'node:fs/promises'
import { contextAuditEvent } from './context-state.js'
import { dirname, join } from 'node:path'
import { processStart, validBootId } from './recovery.js'
import { readonlyLegacy, readonlyDataCut } from './readonly-migration.js'
import { workerRecoveryContract, workerRecoveryInput } from './worker-recovery-proof.js'
import { validateTurnScratch } from './turn-state.js'
import { validateDomainJournal } from './domain-contract.js'
import { contentHash } from './context-hash.js'

export const journalDigest = journal => {
  const { phase, ...identity } = journal
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}
export function validateOwnership(value, allowWorkers = false) {
  const tools = names => Array.isArray(names) && names.length > 0 && names.every(name => typeof name === 'string' && name
    && !/[\0\r\n]/u.test(name) && !['run_code', 'spawn_agent', 'send_message'].includes(name)) && new Set(names).size === names.length
  const foreground = value?.schemaVersion === 1 && value.mode === 'foreground-only' && value.workerDepth === 0
    && Object.keys(value).every(key => ['schemaVersion', 'mode', 'workerDepth', 'tools'].includes(key))
  const workers = allowWorkers && value?.schemaVersion === 2 && value.mode === 'foreground-workers' && value.workerDepth === 1
    && value.maxWorkers === 2 && tools(value.workerTools)
    && Object.keys(value).every(key => ['schemaVersion', 'mode', 'workerDepth', 'maxWorkers', 'tools', 'workerTools'].includes(key))
  if (!value || !(foreground || workers) || !tools(value.tools)) throw new Error('Unsupported Runtime writer ownership contract')
  return value
}
export async function privateFile(path, maxSize = 16 * 1024 * 1024) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.size > maxSize) throw new Error('Unsafe private recovery input')
  return readFile(path, 'utf8')
}
export async function readJournal(workspace) {
  try {
    const journal = JSON.parse(await privateFile(join(workspace, '.mbot/runs/active-turn.json'), 32768))
    if (!journal || typeof journal !== 'object' || Array.isArray(journal)) throw new Error('Invalid turn recovery journal')
    return journal
  }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
}

/** Compare private bridge evidence to an exclusively owned native Session. */
export async function recoveryInput(journal, log) {
  if (![1, 2, 3, 4].includes(journal.schemaVersion) || journal.writerScope !== 'agent-runtime'
    || (journal.bootId !== undefined && !validBootId(journal.bootId))
    || !Number.isSafeInteger(journal.turn) || journal.turn < 1 || typeof journal.sessionId !== 'string'
    || log.session.id !== journal.sessionId || log.session.cwd !== journal.workspace || log.session.origin === 'subagent') throw new Error('Runtime recovery identity does not match its native Session')
  await validateTurnScratch(journal)
  const info = await lstat(journal.scratch)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('Unsafe Runtime recovery snapshot')
  const saved = JSON.parse(await privateFile(join(journal.scratch, 'ledger.json')))
  const { phase: currentPhase, ...current } = journal
  const { phase: savedPhase, ...original } = saved
  if (!isDeepStrictEqual(current, original)) throw new Error('Runtime journal does not match its private snapshot')
  const header = JSON.parse(await privateFile(join(journal.scratch, 'header.json')))
  if (header.botId !== journal.botId || header.sessionId !== journal.sessionId || header.turn !== journal.turn
    || header.writerScope !== 'agent-runtime' || !isDeepStrictEqual(header.runtimeOwnership, journal.runtimeOwnership)
    || header.compactionPolicyVersion !== journal.compactionPolicyVersion
    || !isDeepStrictEqual(header.conversation, journal.conversation)) throw new Error('Runtime header does not match its journal')
  if (journal.schemaVersion === 4) {
    validateDomainJournal(journal)
    if (contentHash(await privateFile(join(journal.scratch, 'context.json'))) !== journal.contextHash) throw new Error('Domain context snapshot changed')
  } else {
    if (header.conversation !== undefined || journal.contextHash !== undefined) throw new Error('Domain journal cannot be downgraded')
    if (journal.runtimeOwnership) validateOwnership(journal.runtimeOwnership, journal.schemaVersion === 3)
  }
  if (journal.schemaVersion === 3) workerRecoveryContract(journal)
  const starts = log.events.filter(event => event.type === 'turn/start' && event.data.turn === journal.turn)
  if (starts.length !== 1 || starts[0].seq < log.inheritedEventCount) throw new Error('Native recovery turn is missing or inherited')
  const start = starts[0].seq
  const ends = log.events.filter(event => event.type === 'turn/end' && event.data.turn === journal.turn && event.seq > start)
  if (ends.length !== 1) throw new Error('Native recovery turn has not ended; resolve and settle its original Agent first')
  const end = ends[0]
  const events = log.events.filter(event => event.seq >= start && event.seq <= end.seq && contextAuditEvent(event))
  const native = new Map(log.events.map(event => [event.seq, event]))
  const captured = (await privateFile(join(journal.scratch, 'session-events.jsonl'))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  let previous = start - 1
  for (const event of captured) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= previous || event.seq < start || event.seq > end.seq
      || !isDeepStrictEqual(event, native.get(event.seq))) throw new Error('Saved Runtime events contradict the native Session')
    previous = event.seq
  }
  const assistant = events.findLast(event => event.type === 'assistant/message' && event.data.turn === journal.turn && event.seq < end.seq)
  const text = assistant?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
  const finish = { reason: end.data.reason, text }
  try {
    const savedFinish = JSON.parse(await privateFile(join(journal.scratch, 'finish.json')))
    if (!isDeepStrictEqual(savedFinish.reason, finish.reason) || savedFinish.text !== text || savedFinish.token !== journal.token) throw new Error('Saved Runtime completion contradicts the native Session')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (journal.runtimeOwnership && events.some(event => event.type === 'tool/call' && !journal.runtimeOwnership.tools.includes(event.data.name))) throw new Error('Native tool is outside the captured writer ownership contract')
  return { events, finish, ...(Array.isArray(header.messages) ? { messages: header.messages } : {}) }
}

export async function validateRecoveryProof(path, journal) {
  if (!/^\/tmp\/mbot-runtime-recovery\.[A-Za-z0-9]+\/proof\.json$/u.test(path ?? '')) throw new Error('Runtime recovery requires a private Host proof')
  const directory = await lstat(dirname(path)), file = await lstat(path)
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700
    || !file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid() || (file.mode & 0o777) !== 0o600) throw new Error('Unsafe Runtime recovery proof')
  const proof = JSON.parse(await privateFile(path))
  if (!Number.isSafeInteger(proof.ownerPid) || proof.ownerPid <= 0) throw new Error('Invalid Runtime recovery proof owner')
  const ownerStat = await readFile(`/proc/${proof.ownerPid}/stat`, 'utf8')
  const ownerState = ownerStat.slice(ownerStat.lastIndexOf(')') + 2).trim().split(/\s+/u)[0]
  if (proof.schemaVersion !== 1 || proof.kind !== 'runtime-quiescent' || proof.journalHash !== journalDigest(journal)
    || !Number.isSafeInteger(proof.ownerPid) || proof.ownerPid <= 0 || !/^\d+$/u.test(proof.ownerStart)
    || ownerState === 'Z' || await processStart(proof.ownerPid) !== proof.ownerStart) throw new Error('Runtime recovery proof is stale or does not match its journal')
  if (proof.mode === 'captured-runtime') {
    if (journal.ownerPid !== proof.ownerPid || journal.ownerStart !== proof.ownerStart
      || (journal.bootId !== undefined && journal.bootId !== proof.bootId)
      || proof.capturedRunId !== journal.runId) throw new Error('Legacy Runtime recovery needs its original live owner')
  } else if (proof.mode === 'recorded-domain-v1') validateDomainJournal(journal)
  else if (proof.mode === 'recorded-foreground-v1') validateOwnership(journal.runtimeOwnership)
  else if (proof.mode === 'recorded-workers-v2') { validateOwnership(journal.runtimeOwnership, true); workerRecoveryContract(journal) }
  else if (proof.mode === 'legacy-readonly' && journal.runtimeOwnership === undefined) { /* checked against native facts below */ }
  else throw new Error('Unsupported Runtime recovery ownership proof')
  const input = await recoveryInput(journal, proof.log)
  if (journal.schemaVersion === 3) input.actors = await workerRecoveryInput(journal, proof.workers)
  if (!isDeepStrictEqual(input, proof.input)) throw new Error('Runtime recovery proof inputs changed')
  if (journal.schemaVersion === 3) {
    const derived = { ...journal, phase: 'abandoned', actors: input.actors }
    try {
      const materialized = JSON.parse(await privateFile(join(journal.scratch, 'runtime-recovery.ledger.json')))
      if (!isDeepStrictEqual(materialized, derived)) throw new Error('Derived Worker recovery ledger changed')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (proof.mode === 'legacy-readonly') {
    if (!isDeepStrictEqual(proof.evidence, readonlyLegacy(journal, input))) throw new Error('Readonly migration evidence does not match the native turn')
    readonlyDataCut(journal)
  }
  return proof
}
