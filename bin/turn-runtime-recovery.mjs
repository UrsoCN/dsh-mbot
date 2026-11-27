#!/usr/bin/env node
import { join } from 'node:path'
import { validateRecoveryProof, readJournal, privateFile } from '../plugin/recovery-proof.js'
import { verifyRecoveryAudit } from '../plugin/recovery-audit.js'
import { verifyWorkerAudit } from '../plugin/worker-recovery-proof.js'
import { atomicWriteSync } from '../plugin/turn-state.js'
import { execFileSync } from 'node:child_process'
import { lstat } from 'node:fs/promises'
try {
  const [mode, file, workspace] = process.argv.slice(2)
  if (mode === '--audit-input') {
    process.stdin.setEncoding('utf8')
    let data = ''; for await (const chunk of process.stdin) data += chunk
    const input = JSON.parse(data)
    const meta = JSON.parse(execFileSync('git', ['-C', input.workspace, 'show', `${input.result.head}:${input.result.meta}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    const actors = meta.runtime?.journal_schema_version === 3 ? verifyWorkerAudit(meta.runtime.actors, input.workers,
      { workspace: input.workspace, sessionId: input.header.sessionId, runId: input.result.runId, memoryCommit: meta.base_head }) : undefined
    verifyRecoveryAudit(input.workspace, input.header, input.events, input.result, actors)
    process.exit(0)
  }
  const journal = await readJournal(workspace)
  const proof = await validateRecoveryProof(file, journal)
  async function derived(name, value) {
    const target = join(journal.scratch, name)
    let exists = false
    try { await lstat(target); exists = true } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (exists) {
      if (await privateFile(target) !== value) throw new Error('Derived recovery inputs changed; preserve evidence and review')
      return
    }
    await atomicWriteSync(target, value, 0o600)
  }
  if (mode === '--materialize') {
    await derived('runtime-recovery.events.jsonl', proof.input.events.map(event => JSON.stringify(event)+'\n').join(''))
    await derived('runtime-recovery.finish.json', JSON.stringify({ kind: 'finish', token: journal.token, ...proof.input.finish }))
    if (journal.schemaVersion === 3) await derived('runtime-recovery.ledger.json', JSON.stringify({ ...journal, phase: 'abandoned', actors: proof.input.actors }))
  } else if (mode === '--audit-existing') {
    const intent = JSON.parse(await privateFile(join(journal.scratch, 'commit-intent.json')))
    const meta = JSON.parse(await privateFile(join(journal.scratch, 'meta.json')))
    const header = JSON.parse(await privateFile(join(journal.scratch, 'header.json')))
    const result = { head: process.argv[5], runId: journal.runId, meta: intent.meta, success: meta.success, outcome: meta.outcome, failureCountEffect: meta.failure_count_effect }
    verifyRecoveryAudit(workspace, header, proof.input.events, result, proof.input.actors?.map(({ token, ...actor }) => actor))
  } else if (mode !== '--validate') throw new Error('Invalid Runtime recovery operation')
} catch (error) {
  process.stderr.write(`mbot: ${error.code ? 'Runtime recovery proof could not be validated' : error.message}\n`)
  process.exitCode = 1
}
