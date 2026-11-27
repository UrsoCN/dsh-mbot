#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateRecoveryProof, readJournal, privateFile } from '../plugin/recovery-proof.js'
import { verifyRecoveryAudit } from '../plugin/recovery-audit.js'
try {
  const [mode, file, workspace] = process.argv.slice(2)
  if (mode === '--audit-input') {
    let data = ''; for await (const chunk of process.stdin) data += chunk
    const input = JSON.parse(data)
    verifyRecoveryAudit(input.workspace, input.header, input.events, input.result)
    process.exit(0)
  }
  const journal = await readJournal(workspace)
  const proof = await validateRecoveryProof(file, journal)
  async function derived(name, value) {
    const target = join(journal.scratch, name)
    try { await writeFile(target, value, { mode: 0o600, flag: 'wx' }) }
    catch (error) { if (error.code !== 'EEXIST') throw error; if (await privateFile(target) !== value) throw new Error('Derived recovery inputs changed; preserve evidence and review') }
  }
  if (mode === '--materialize') {
    await derived('runtime-recovery.events.jsonl', proof.input.events.map(event => JSON.stringify(event)+'\n').join(''))
    await derived('runtime-recovery.finish.json', JSON.stringify({ kind: 'finish', token: journal.token, ...proof.input.finish }))
  } else if (mode === '--audit-existing') {
    const intent = JSON.parse(await privateFile(join(journal.scratch, 'commit-intent.json')))
    const meta = JSON.parse(await privateFile(join(journal.scratch, 'meta.json')))
    const header = JSON.parse(await privateFile(join(journal.scratch, 'header.json')))
    const result = { head: process.argv[5], runId: journal.runId, meta: intent.meta, success: meta.success, outcome: meta.outcome, failureCountEffect: meta.failure_count_effect }
    verifyRecoveryAudit(workspace, header, proof.input.events, result)
  } else if (mode !== '--validate') throw new Error('Invalid Runtime recovery operation')
} catch (error) {
  process.stderr.write(`mbot: ${error.code ? 'Runtime recovery proof could not be validated' : error.message}\n`)
  process.exitCode = 1
}
