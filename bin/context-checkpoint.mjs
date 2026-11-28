#!/usr/bin/env node
// Restore context identities from native snapshots AND reachable Git audits.
import { isDeepStrictEqual } from 'node:util'
import { contextSnapshotType, contextAuditEvent, contextHash } from '../plugin/context-state.js'
import { contextGit, createGitBatchReader, readKnowledge, sealContextAudit } from '../plugin/context-audit.js'
import { verifyRecoveryAudit } from '../plugin/recovery-audit.js'
import { readJournal } from '../plugin/recovery-proof.js'
import { validateDomainScope } from '../plugin/domain-contract.js'

try {
  const [mode, workspace, commit, role] = process.argv.slice(2)
  if (mode === '--knowledge') {
    process.stdout.write(JSON.stringify(readKnowledge(workspace, commit, role)) + '\n')
  } else if (mode === '--restore') {
    process.stdin.setEncoding('utf8')
    let text = ''; for await (const chunk of process.stdin) text += chunk
    const { botId, log, conversation } = JSON.parse(text)
    if (conversation) {
      validateDomainScope(conversation)
      if (conversation.botId !== botId || conversation.sessionId !== log.session.id) throw new Error('Context restore changed its domain ownership')
    }
    const journal = await readJournal(workspace)
    if (journal && (![1, 2, 3, 4].includes(journal.schemaVersion) || typeof journal.runId !== 'string')) throw new Error('Unknown turn journal while restoring context')
    // Single-pass index of native events by turn to eliminate O(T * E) scans.
    const snapshots = new Map()
    const turnStarts = new Map()
    const turnEnds = new Map()
    const eventsByTurn = new Map()
    let activeTurn = null
    for (const event of log.events) {
      if (event.type === contextSnapshotType) snapshots.set(event.data.turn, event)
      if (event.type === 'turn/start') {
        activeTurn = event.data.turn
        turnStarts.set(activeTurn, event)
        if (!eventsByTurn.has(activeTurn)) eventsByTurn.set(activeTurn, [])
      }
      if (activeTurn !== null && contextAuditEvent(event)) {
        eventsByTurn.get(activeTurn).push(event)
      }
      if (event.type === 'turn/end') {
        turnEnds.set(event.data.turn, event)
        if (activeTurn === event.data.turn) activeTurn = null
      }
    }
    // Single git log invocation captures commit hash, parent hash, full body, and added transcript files.
    const history = contextGit(workspace, 'log', '--no-merges', '--format=%x1e%H%x1f%P%x1f%B%x1f', '--name-only', '-z', '--diff-filter=A', 'HEAD', '--', 'transcripts').toString('utf8')
    const entries = []
    for (const chunk of history.split('\x1e')) {
      if (!chunk) continue
      const parts = chunk.split('\x1f')
      if (parts.length < 4) continue
      const [head, parentHash, rawCommitBody, filesPart] = parts
      const commitBody = rawCommitBody.endsWith('\n') ? rawCommitBody : `${rawCommitBody}\n`
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) continue
      for (const field of filesPart.split('\0')) {
        const value = field.replace(/^\n+/u, '')
        if (/^transcripts\/\d{4}-\d{2}-\d{2}\/\d{8}T\d{6}Z-turn-[a-f0-9]{16}\.meta\.json$/u.test(value)) {
          entries.push({ head, parentHash: parentHash.trim(), commitBody, value })
        }
      }
    }
    const gitBatch = createGitBatchReader(workspace)
    let checkpoint = null
    const proofs = []
    try {
      for (const entry of entries) {
        const { head, parentHash, commitBody, value } = entry
        const metaObj = await gitBatch.readBlob(`${head}:${value}`)
        const meta = JSON.parse(metaObj.body.toString('utf8'))
        if (meta.runtime?.bot_id !== botId || meta.runtime.session_id !== log.session.id) continue
        if (!isDeepStrictEqual(meta.runtime.conversation, conversation)) throw new Error('Context audit changed its registered conversation')
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
        const start = turnStarts.get(meta.runtime.turn)
        const end = turnEnds.get(meta.runtime.turn)
        if (start && !end) throw Object.assign(new Error('Context observations crossed a turn completion'), { code: 'MBOT_CONTEXT_OBSERVATION_CHANGED' })
        if (!start || !end) throw new Error('Audited context turn is incomplete')
        const events = eventsByTurn.get(meta.runtime.turn) ?? []
        const knowledge = await gitBatch.readKnowledge(meta.base_head, meta.bot, conversation)
        const sealed = sealContextAudit(meta, events, workspace, knowledge)
        let messages = events.filter(event => event.type === 'user/message').map(event => event.data)
        if (conversation) {
          // Failed admission may never append user/message. The captured native
          // Inbox cut is still the initial reply-target authority for that turn.
          const accepted = new Map()
          for (const event of log.events) if (event.seq <= snapshot.data.sourceCut.throughSeq && event.type === 'agent/inbox/spliced') {
            for (const message of event.data.inserted) accepted.set(message.id, message)
          }
          messages = snapshot.data.input.map(input => {
            const message = accepted.get(input.messageId)
            if (!message || contextHash(message) !== input.hash) throw new Error('Domain reply input is missing from its captured native cut')
            return message
          })
        }
        const result = { head, meta: value, runId: meta.run_id, success: meta.success, outcome: meta.outcome, failureCountEffect: meta.failure_count_effect }
        verifyRecoveryAudit(workspace, { botId, sessionId: log.session.id, turn: meta.runtime.turn, ...(conversation ? { conversation } : {}),
          ...(meta.runtime.reply ? { messages } : {}) }, events, result, meta.runtime.actors,
          { meta, parentHash, commitBody: commitBody.replace(/\n$/u, '') + '\n\n', knowledge, sealedContext: sealed })
        if (!isDeepStrictEqual(sealed, meta.runtime.context)) throw new Error('Git context seal contradicts its native snapshot')
        proofs.push({ ...sealed, commit: head, meta: value, actors: meta.runtime.actors, turn: meta.runtime.turn,
          ...(meta.runtime.compactions?.length ? { compactions: meta.runtime.compactions } : {}) })
      }
    } finally {
      gitBatch.close()
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
      compactions: proofs.flatMap(proof => proof.compactions ?? []),
      ...(conversation ? { domainTurns: proofs.map(proof => ({ turn: proof.turn, startSeq: turnStarts.get(proof.turn).seq,
        endSeq: turnEnds.get(proof.turn).seq, commit: proof.commit })) } : {}) }) + '\n')
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
