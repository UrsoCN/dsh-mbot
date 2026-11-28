#!/usr/bin/env node
// Restore context identities from native snapshots AND reachable Git audits.
import { readKnowledge } from '../plugin/context-audit.js'
import { readContextEvidence } from '../plugin/context-restore.js'

try {
  const [mode, workspace, commit, role] = process.argv.slice(2)
  if (mode === '--knowledge') {
    process.stdout.write(JSON.stringify(readKnowledge(workspace, commit, role)) + '\n')
  } else if (mode === '--restore') {
    process.stdin.setEncoding('utf8')
    let text = ''; for await (const chunk of process.stdin) text += chunk
    process.stdout.write(JSON.stringify(await readContextEvidence(workspace, JSON.parse(text))) + '\n')
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
