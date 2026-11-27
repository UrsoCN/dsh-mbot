#!/usr/bin/env node
// Restore context identities from native snapshots AND reachable Git audits.
import { isDeepStrictEqual } from 'node:util'
import { contextSnapshotType, contextAuditEvent } from '../plugin/context-state.js'
import { contextGit, readKnowledge, sealContextAudit } from '../plugin/context-audit.js'
import { verifyRecoveryAudit } from '../plugin/recovery-audit.js'
import { readJournal } from '../plugin/recovery-proof.js'

try {
  const [mode, workspace, commit, role] = process.argv.slice(2)
  if (mode === '--knowledge') {
    process.stdout.write(JSON.stringify(readKnowledge(workspace, commit, role)) + '\n')
  } else if (mode === '--restore') {
    process.stdin.setEncoding('utf8')
    let text = ''; for await (const chunk of process.stdin) text += chunk
    const { botId, log } = JSON.parse(text)
    const journal = await readJournal(workspace)
    if (journal && (![1, 2, 3].includes(journal.schemaVersion) || typeof journal.runId !== 'string')) throw new Error('Unknown turn journal while restoring context')
    const snapshots = new Map(log.events.filter(event => event.type === contextSnapshotType).map(event => [event.data.turn, event]))
    const history = contextGit(workspace, 'log', '--no-merges', '--format=%H%x00', '--name-only', '-z', '--diff-filter=A', 'HEAD', '--', 'transcripts').toString('utf8')
    let head, checkpoint = null
    const proofs = []
    for (const field of history.split('\0')) {
      const value = field.replace(/^\n+/u, '')
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) { head = value; continue }
      if (!head || !/^transcripts\/\d{4}-\d{2}-\d{2}\/\d{8}T\d{6}Z-turn-[a-f0-9]{16}\.meta\.json$/u.test(value)) continue
      const meta = JSON.parse(contextGit(workspace, 'show', `${head}:${value}`).toString('utf8'))
      if (meta.runtime?.bot_id !== botId || meta.runtime.session_id !== log.session.id) continue
      // Git can have committed before counters/permit settlement. That run's
      // checkpoint stays unpublished until its original journal is resolved.
      if (journal?.runId === meta.run_id) continue
      if (!meta.runtime.context) {
        if (snapshots.has(meta.runtime.turn)) throw new Error('Audited turn dropped its captured context proof')
        continue
      }
      const snapshot = snapshots.get(meta.runtime.turn)
      if (!snapshot) {
        if (meta.runtime.context.snapshotSeq > (log.events.at(-1)?.seq ?? -1)) {
          throw Object.assign(new Error('Context observations crossed a new commit'), { code: 'MBOT_CONTEXT_OBSERVATION_CHANGED' })
        }
        throw new Error('Audited context snapshot is missing from the native Session')
      }
      const start = log.events.find(event => event.type === 'turn/start' && event.data.turn === meta.runtime.turn)
      const end = log.events.find(event => event.type === 'turn/end' && event.data.turn === meta.runtime.turn)
      if (start && !end) throw Object.assign(new Error('Context observations crossed a turn completion'), { code: 'MBOT_CONTEXT_OBSERVATION_CHANGED' })
      if (!start || !end) throw new Error('Audited context turn is incomplete')
      const events = log.events.filter(event => event.seq >= start.seq && event.seq <= end.seq && contextAuditEvent(event))
      const result = { head, meta: value, runId: meta.run_id, success: meta.success, outcome: meta.outcome, failureCountEffect: meta.failure_count_effect }
      verifyRecoveryAudit(workspace, { botId, sessionId: log.session.id, turn: meta.runtime.turn,
        ...(meta.runtime.reply ? { messages: events.filter(event => event.type === 'user/message').map(event => event.data) } : {}) }, events, result, meta.runtime.actors)
      const sealed = sealContextAudit(meta, events, workspace)
      if (!isDeepStrictEqual(sealed, meta.runtime.context)) throw new Error('Git context seal contradicts its native snapshot')
      proofs.push({ ...sealed, commit: head, meta: value, actors: meta.runtime.actors, turn: meta.runtime.turn,
        ...(meta.runtime.compactions?.length ? { compactions: meta.runtime.compactions } : {}) })
    }
    proofs.sort((left, right) => left.turn - right.turn)
    const seen = new Set()
    for (const proof of proofs) {
      if (seen.has(proof.turn)) throw new Error('Multiple Git audits claim the same context turn')
      seen.add(proof.turn)
      const previous = checkpoint === null ? null : { schemaVersion: 1, snapshotHash: checkpoint.snapshotHash,
        knowledgeVersion: checkpoint.snapshot.knowledge.version, contextEpoch: checkpoint.snapshot.contextEpoch, commit: checkpoint.commit }
      if (!isDeepStrictEqual(proof.snapshot.previous, previous)) throw new Error('Context checkpoint chain changed or is incomplete')
      checkpoint = proof
    }
    process.stdout.write(JSON.stringify({ checkpoint, snapshots: proofs.map(proof => ({ seq: proof.snapshotSeq, hash: proof.snapshotHash })),
      compactions: proofs.flatMap(proof => proof.compactions ?? []) }) + '\n')
  } else throw new Error('Invalid context checkpoint operation')
} catch (error) {
  if (error.code === 'MBOT_CONTEXT_OBSERVATION_CHANGED') {
    process.stdout.write(JSON.stringify({ kind: 'context-observation-changed' }) + '\n')
    process.exitCode = 2
  } else {
    process.stderr.write(`mbot: ${error.code ? 'Context checkpoint proof could not be verified' : error.message}\n`)
    process.exitCode = 1
  }
}
