#!/usr/bin/env node
// Read-only proof over one captured native turn and immutable Git objects.
import { execFileSync } from 'node:child_process'
import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { processStart } from '../plugin/recovery.js'
import { applyRedactions } from '../plugin/reply-proof.js'
import { isDeepStrictEqual } from 'node:util'
import { verifyWorkerAudit } from '../plugin/worker-recovery-proof.js'
import { sealContextAudit } from '../plugin/context-audit.js'
import { sealCompactionAudit, compactInputType, compactOutputType } from '../plugin/compaction-data.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const hashPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const metaPattern = /^transcripts\/\d{4}-\d{2}-\d{2}\/(\d{8}T\d{6}Z-turn-[a-f0-9]{16})\.meta\.json$/u
const pending = (status, error, audit) => ({ schemaVersion: 1, status, final: false, ...(error ? { error } : {}), ...(audit ? { audit } : {}) })

async function prove(input) {
  const { workspace, botId, sessionId, record, turn, events, confirmation } = input
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false', '-C', workspace, ...args],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  const observedHead = git('rev-parse', 'HEAD').trim()
  if (!hashPattern.test(observedHead)) throw new Error('Invalid Git cut')
  let journal, journalStatus
  try {
    const journalPath = join(workspace, '.mbot/runs/active-turn.json')
    const stat = await lstat(journalPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error('Unsafe turn journal')
    journal = JSON.parse(await readFile(journalPath, 'utf8'))
    if (![1, 2, 3].includes(journal.schemaVersion) || journal.workspace !== workspace || typeof journal.runId !== 'string'
      || !/^\d{8}T\d{6}Z-turn-[a-f0-9]{16}$/u.test(journal.runId) || !Number.isSafeInteger(journal.turn) || journal.turn < 1
      || typeof journal.botId !== 'string' || typeof journal.sessionId !== 'string' || !['data-subprocesses', 'agent-runtime'].includes(journal.writerScope)
      || !Number.isSafeInteger(journal.pid) || journal.pid < 1 || !/^\d+$/u.test(journal.pidStart)
      || !Number.isSafeInteger(journal.ownerPid) || journal.ownerPid < 0) throw new Error('Invalid turn journal')
    if (journal.botId === botId && journal.sessionId === sessionId && journal.turn === record.turn) {
      let live = false
      try { live = await processStart(journal.pid) === journal.pidStart && await processStart(journal.ownerPid) === journal.ownerStart }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      journalStatus = live ? 'auditing' : 'recovering'
    }
  } catch (error) { if (error.code !== 'ENOENT') journalStatus = 'unverified' }
  const history = git('log', '--no-merges', '--format=%H%x00', '--name-only', '-z', '--diff-filter=A', observedHead, '--', 'transcripts')
  const candidates = []
  let commit
  for (const field of history.split('\0')) {
    const value = field.replace(/^\n+/u, '')
    if (hashPattern.test(value)) commit = value
    else if (commit && metaPattern.test(value)) candidates.push({ commit, path: value })
  }
  const found = []
  let legacy = false, invalid = false
  for (const candidate of candidates) {
    let meta
    try { meta = JSON.parse(git('show', `${candidate.commit}:${candidate.path}`)) } catch { continue }
    if (meta.runtime?.bot_id !== botId || meta.runtime.session_id !== sessionId || meta.runtime.turn !== record.turn
      || !Array.isArray(meta.runtime.request_ids) || !meta.runtime.request_ids.includes(record.rpcId)) continue
    if (!meta.runtime.reply) { legacy = true; continue }
    try {
      if (meta.runtime.context && !isDeepStrictEqual(meta.runtime.context, sealContextAudit(meta, events, workspace))) throw new Error('Request context proof contradicts native evidence')
      if ((meta.runtime.compaction_policy_version === 1 || events.some(event => [compactInputType, compactOutputType].includes(event.type)))
        && !isDeepStrictEqual(meta.runtime.compactions, sealCompactionAudit(meta, events))) throw new Error('Request compaction proof contradicts native evidence')
      const reply = meta.runtime.reply
      const assistant = events.findLast(event => event.type === 'assistant/message' && event.data.turn === record.turn && event.seq < turn.endSeq)
      const text = assistant?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
      const nativeTarget = { rpcId: record.rpcId, messageId: record.message.id, ...record.message.source.mbot }
      const target = reply.targets?.find(target => target.rpcId === record.rpcId)
      if (meta.runtime.kind !== 'managed-turn' || meta.runtime.schemaVersion !== 1 || meta.runtime.writer_scope !== 'agent-runtime'
        || ![2, 3].includes(meta.runtime.journal_schema_version) || meta.run_id !== metaPattern.exec(candidate.path)[1] || meta.session_id !== sessionId
        || meta.mode !== 'run' || typeof meta.bot !== 'string' || meta.bot === 'human' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(meta.bot)
        || typeof meta.summary !== 'string' || !hashPattern.test(meta.base_head)
        || git('show', '-s', '--format=%P', candidate.commit).trim() !== meta.base_head
        || git('show', '-s', '--format=%B', candidate.commit).replace(/\n$/u, '') !== `run(${meta.bot}): ${meta.run_id} ${meta.summary}\n`
        || reply.schemaVersion !== 1 || reply.endEventSeq !== turn.endSeq || reply.assistantEventSeq !== (assistant?.seq ?? null)
        || reply.nativeTextHash !== digest(text) || typeof reply.text !== 'string' || reply.textHash !== digest(reply.text)
        || applyRedactions(text, reply.redactions) !== reply.text || !isDeepStrictEqual(target, nativeTarget)
        || meta.reason?.kind !== turn.reason.kind || (meta.reason.kind === 'aborted' && meta.reason.reason?.kind !== turn.reason.reason?.kind)) throw new Error('Audit identity mismatch')
      if (meta.runtime.journal_schema_version === 3) verifyWorkerAudit(meta.runtime.actors, input.workers, { workspace, sessionId, runId: meta.run_id, memoryCommit: meta.base_head })
      else if (meta.runtime.actors !== undefined) throw new Error('Foreground audit unexpectedly contains Worker ownership')
      const outcome = execFileSync('jq', ['-L', join(root, 'lib'), '-er', 'include "turn-outcome"; . as $x | $x.meta | mbot_outcome(.runtime.journal_schema_version) as $outcome | if .runtime.execution_fault != (mbot_execution_fault($x.events) or any($x.meta.runtime.actors[]?; .native.executionFault==true)) then error("native execution fault mismatch") else $outcome end'],
        { input: JSON.stringify({ meta, events }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }).trim()
      found.push({ meta, candidate, outcome, target })
    } catch { invalid = true }
  }
  if (found.length !== 1 || invalid) return pending(journalStatus ?? 'unverified', found.length > 1 ? 'Multiple Git audits match this native request'
    : invalid ? 'Git audit contradicts native reply or outcome evidence' : legacy ? 'Historical audit lacks sealed native reply evidence' : 'No matching Git audit is confirmed')
  const { meta, candidate, outcome, target } = found[0]
  const audit = { commit: candidate.commit, observedHead, runId: meta.run_id, meta: candidate.path,
    memoryCommit: meta.base_head, outcome, failureCountEffect: meta.failure_count_effect, success: meta.success }
  if (journalStatus === 'unverified') return pending('unverified', 'Turn journal cannot confirm settlement', audit)
  if (journal?.runId === meta.run_id) return pending(journalStatus ?? 'recovering', 'Git commit exists; turn settlement is not yet confirmed', audit)
  if (confirmation !== 'confirmed') return pending('unverified', 'Native request and ending are not durably confirmed', audit)
  const reply = { schemaVersion: 1, botId, sessionId, requestId: target.requestId, rpcId: record.rpcId, messageId: target.messageId,
    conversationKey: target.conversationKey, replyRoute: target.replyRoute, adapterId: target.adapterId, ownerId: target.ownerId,
    ...(target.correlationId === undefined ? {} : { correlationId: target.correlationId }), turn: record.turn, outcome,
    commit: candidate.commit, endEventSeq: turn.endSeq, assistantEventSeq: meta.runtime.reply.assistantEventSeq,
    text: meta.runtime.reply.text }
  return { schemaVersion: 1, status: outcome, final: true, audit, reply: { ...reply, replyId: `mbot-reply:${digest(reply)}` } }
}

let data = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) data += chunk
try { process.stdout.write(JSON.stringify(await prove(JSON.parse(data))) + '\n') }
catch { process.stdout.write(JSON.stringify(pending('unverified', 'Audit proof could not be validated')) + '\n') }
