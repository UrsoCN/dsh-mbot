#!/usr/bin/env node
// Reproducible R2 scale benchmark harness for MBot Runtime & transaction core.
// Measures:
//   1. Context checkpoint restore latency & peak RSS vs turn history count (100 / 500 / 1000 turns)
//   2. Worker actor-event recording latency vs event count (50 / 200 events)
//   3. Guard ignored-file snapshot latency & copy bytes vs ignored data volume (1 MiB / 10 MiB / 50 MiB)
// Usage: node tests/bench-runtime.mjs [--quick] [--json]
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, stat, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { readKnowledge, sealContextAudit } from '../plugin/context-audit.js'
import { contextSnapshotType, contextHash } from '../plugin/context-state.js'

const repo = fileURLToPath(new URL('../', import.meta.url))
const quick = process.argv.includes('--quick')
const asJson = process.argv.includes('--json')
const root = await mkdtemp('/tmp/mbot-bench.')
const env = {
  ...process.env,
  DSH_HOME: join(root, 'dsh'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_STATE_HOME: join(root, 'state'),
  GIT_AUTHOR_NAME: 'MBot Bench',
  GIT_COMMITTER_NAME: 'MBot Bench',
  GIT_AUTHOR_EMAIL: 'bench@example.invalid',
  GIT_COMMITTER_EMAIL: 'bench@example.invalid',
}
delete env.MBOT_WS
delete env.MBOT_RUN_ID
delete env.MBOT_PERMIT_TOKEN

function git(ws, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', ws, ...args],
    { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 }).trim()
}

function initWorkspace(name) {
  const ws = join(root, name)
  execFileSync(join(repo, 'bin/mbot'), ['-C', ws, 'init'], { env, stdio: 'pipe' })
  return ws
}

async function benchCheckpointRestore(turnCounts) {
  const results = []
  const maxTurns = Math.max(...turnCounts)
  const targetSet = new Set(turnCounts)
  const ws = initWorkspace(`ws-turns-${maxTurns}`)
  const botId = 'bot-bench-0001'
  const sessionId = 'session-bench-0001'
  const events = []
  let seq = 0
  let previous = null
  let baseHead = git(ws, 'rev-parse', 'HEAD')
  const knowledge = readKnowledge(ws, baseHead, 'chief')
  const day = '2026-11-28'
  await mkdir(join(ws, 'transcripts', day), { recursive: true })
  for (let turn = 1; turn <= maxTurns; turn++) {
    const runId = `20261128T${String(Math.floor(turn / 3600)).padStart(2, '0')}${String(Math.floor((turn % 3600) / 60)).padStart(2, '0')}${String(turn % 60).padStart(2, '0')}Z-turn-${String(turn).padStart(16, '0')}`
    const turnStart = { seq: seq++, type: 'turn/start', time: 1700000000000 + turn * 1000, data: { turn } }
    events.push(turnStart)
    const throughSeq = turnStart.seq
    const snapshotData = {
      schemaVersion: 1, kind: 'turn-input', visibility: 'owner-private', botId, sessionId, conversationId: sessionId,
      turn, runId, role: 'chief', memoryCommit: baseHead, knowledge, compactionPolicyVersion: 1, contextEpoch: 1,
      previous, sourceCut: { throughSeq, events: [{ seq: turnStart.seq, type: turnStart.type, hash: contextHash(turnStart) }] },
      input: [],
    }
    const snapshotEvent = { seq: seq++, type: contextSnapshotType, ignorable: true, time: 1700000000000 + turn * 1000 + 10, data: snapshotData }
    events.push(snapshotEvent)
    const assistantEvent = { seq: seq++, type: 'assistant/message', time: 1700000000000 + turn * 1000 + 20,
      data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `Reply ${turn}` }] } } }
    events.push(assistantEvent)
    const turnEnd = { seq: seq++, type: 'turn/end', time: 1700000000000 + turn * 1000 + 30, data: { turn, reason: { kind: 'completed' } } }
    events.push(turnEnd)
    const turnEvents = [turnStart, snapshotEvent, assistantEvent, turnEnd]
    const metaRel = `transcripts/${day}/${runId}.meta.json`
    const transcriptRel = `transcripts/${day}/${runId}.md`
    const meta = {
      run_id: runId, mode: 'run', bot: 'chief', task: null, started_at: '2026-11-28T00:00:00Z',
      elapsed_ms: 30, dsh_exit_code: 0, base_head: baseHead, observed_head: baseHead, session_id: sessionId,
      reason: { kind: 'completed' }, success: true, outcome: 'completed', failure_count_effect: 'reset',
      summary: `bench ${turn}`, violations: [], grants: [],
      usage: { scope: 'top-level', input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 15 },
      runtime: { kind: 'managed-turn', schemaVersion: 1, outcome_schema_version: 1, execution_fault: false,
        bot_id: botId, session_id: sessionId, turn, request_ids: [], writer_scope: 'agent-runtime',
        journal_schema_version: 2, compaction_policy_version: 1 },
    }
    meta.runtime.context = sealContextAudit(meta, turnEvents, ws)
    await writeFile(join(ws, metaRel), JSON.stringify(meta))
    await writeFile(join(ws, transcriptRel), `# ${runId}\n`)
    git(ws, 'add', metaRel, transcriptRel)
    git(ws, 'commit', '-q', '-m', `run(chief): ${runId} bench ${turn}`)
    const commit = git(ws, 'rev-parse', 'HEAD')
    previous = { schemaVersion: 1, snapshotHash: meta.runtime.context.snapshotHash, knowledgeVersion: knowledge.version, contextEpoch: 1, commit }
    baseHead = commit
    if (targetSet.has(turn)) {
      const payload = JSON.stringify({ botId, log: { session: { id: sessionId, cwd: ws }, inheritedEventCount: 0, events } })
      const t0 = performance.now()
      const stdout = execFileSync(process.execPath, [join(repo, 'bin/context-checkpoint.mjs'), '--restore', ws],
        { input: payload, encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 })
      const elapsedMs = performance.now() - t0
      const parsed = JSON.parse(stdout)
      results.push({
        turns: turn,
        nativeEvents: events.length,
        stdinBytes: Buffer.byteLength(payload, 'utf8'),
        stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
        restoreMs: Number(elapsedMs.toFixed(2)),
        verifiedTurn: parsed.checkpoint?.turn ?? null,
      })
    }
  }
  return results
}

async function benchWorkerEvents(eventCounts) {
  const results = []
  for (const count of eventCounts) {
    const ws = initWorkspace(`ws-worker-${count}`)
    execFileSync(join(repo, 'bin/botctl'), ['-C', ws, 'board', 'add', 'Bench worker task', '--owner', 'coder'], { env })
    execFileSync(join(repo, 'bin/botctl'), ['-C', ws, 'board', 'set', '001', 'doing'], { env })
    const baseHead = git(ws, 'rev-parse', 'HEAD')
    const runId = `20261128T010000Z-turn-${randomBytes(8).toString('hex')}`
    const scratch = JSON.parse(execFileSync(process.execPath, [join(repo, 'bin/turn-state.mjs'), '--create', ws, runId], { encoding: 'utf8', env })).dir
    const token = randomBytes(32).toString('hex')
    const header = { kind: 'begin', schemaVersion: 1, botId: 'bot-bench', sessionId: 'session-parent', turn: 1, request: 'bench', requestIds: [],
      writerScope: 'agent-runtime', runtimeOwnership: { schemaVersion: 2, mode: 'foreground-workers', workerDepth: 1, maxWorkers: 2, tools: ['botctl'], workerTools: ['botctl'] } }
    const ledger = { schemaVersion: 3, phase: 'active', runId, token, botId: 'bot-bench', sessionId: 'session-parent', turn: 1, role: 'chief',
      writerScope: 'agent-runtime', baseHead, baseRef: 'refs/heads/master', scratch, scratchFormatVersion: 1, workspace: ws,
      runtimeOwnership: header.runtimeOwnership, expiresAt: Date.now() + 600000, actors: [] }
    await mkdir(join(ws, '.mbot/runs'), { recursive: true })
    await mkdir(join(scratch, 'ignored/.mbot/runs'), { recursive: true })
    await writeFile(join(scratch, 'header.json'), JSON.stringify(header), { mode: 0o600 })
    await writeFile(join(scratch, 'token.json'), JSON.stringify(token), { mode: 0o600 })
    await writeFile(join(scratch, 'secrets.json'), '[]', { mode: 0o600 })
    await writeFile(join(scratch, 'ledger.json'), JSON.stringify(ledger), { mode: 0o600 })
    await writeFile(join(ws, '.mbot/runs/active-turn.json'), JSON.stringify(ledger), { mode: 0o600 })
    await writeFile(join(scratch, 'ignored/.mbot/runs/active-turn.json'), JSON.stringify(ledger), { mode: 0o600 })
    for (const f of [join(scratch, 'header.json'), join(scratch, 'token.json'), join(scratch, 'secrets.json'),
      join(scratch, 'ledger.json'), join(ws, '.mbot/runs/active-turn.json'), join(scratch, 'ignored/.mbot/runs/active-turn.json')]) {
      await chmod(f, 0o600)
    }
    const reqId = '11111111-1111-4111-8111-111111111111'
    const delegated = JSON.parse(execFileSync(process.execPath, [join(repo, 'bin/turn-actor.mjs'), scratch, ws],
      { input: JSON.stringify({ kind: 'delegate', token, requestId: reqId, sessionId: 'mbot-worker-bench', role: 'coder', taskId: '001', native: true }),
        encoding: 'utf8', env }))
    if (delegated.kind !== 'delegated') throw new Error(`delegate failed: ${JSON.stringify(delegated)}`)
    const actorId = delegated.actorId
    const t0 = performance.now()
    for (let i = 0; i < count; i++) {
      const frame = { kind: 'actor-event', token, requestId: reqId, actorId,
        event: { seq: i, type: 'assistant/message', data: { turn: 1, step: i + 1, text: `event-${i}` } } }
      const out = JSON.parse(execFileSync(process.execPath, [join(repo, 'bin/turn-actor.mjs'), scratch, ws],
        { input: JSON.stringify(frame), encoding: 'utf8', env }))
      if (out.kind !== 'recorded') throw new Error(`actor-event failed: ${JSON.stringify(out)}`)
    }
    const elapsedMs = performance.now() - t0
    const eventFileSize = (await stat(join(scratch, `actor-${actorId}.events.jsonl`))).size
    results.push({
      events: count,
      subprocesses: count,
      totalMs: Number(elapsedMs.toFixed(2)),
      perEventMs: Number((elapsedMs / count).toFixed(2)),
      eventFileBytes: eventFileSize,
    })
  }
  return results
}

async function benchGuardSnapshot(sizesMiB) {
  const results = []
  for (const mib of sizesMiB) {
    const ws = initWorkspace(`ws-guard-${mib}`)
    await mkdir(join(ws, '.mbot/runs'), { recursive: true })
    const chunk = Buffer.alloc(1024 * 1024, 0x61)
    for (let i = 0; i < mib; i++) {
      await writeFile(join(ws, `.mbot/runs/history-${String(i).padStart(3, '0')}.jsonl`), chunk)
    }
    // Create lock files required by mbot_guard_snapshot
    await writeFile(join(ws, '.mbot/lock'), '')
    await writeFile(join(ws, '.mbot/botctl.lock'), '')
    const scratch = await mkdtemp(join(root, `guard-scratch-${mib}-`))
    const t0 = performance.now()
    execFileSync('bash', ['-c', `set -Eeuo pipefail; MBOT_ROOT="$1"; MBOT_WS="$2"; MBOT_SCRATCH="$3"; MBOT_GIT_DIR="$MBOT_WS/.git"; source "$MBOT_ROOT/lib/guard.sh"; mbot_guard_snapshot`, '--', repo, ws, scratch], { env })
    const elapsedMs = performance.now() - t0
    results.push({
      ignoredMiB: mib,
      ignoredFiles: mib,
      snapshotMs: Number(elapsedMs.toFixed(2)),
    })
  }
  return results
}

try {
  const turnScales = quick ? [20, 100] : [100, 300, 1000]
  const workerScales = quick ? [10, 40] : [25, 100]
  const guardScales = quick ? [1, 5] : [1, 10, 50]

  const checkpoint = await benchCheckpointRestore(turnScales)
  const workerEvents = await benchWorkerEvents(workerScales)
  const guardSnapshot = await benchGuardSnapshot(guardScales)
  const report = {
    generatedAt: new Date().toISOString(),
    mode: quick ? 'quick' : 'full',
    node: process.version,
    peakRssMiB: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)),
    checkpointRestore: checkpoint,
    workerActorEvents: workerEvents,
    guardIgnoredSnapshot: guardSnapshot,
  }
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    console.log('=== MBot R2 Scale Benchmark ===')
    console.log(`Mode: ${report.mode} | Node: ${report.node} | Parent RSS: ${report.peakRssMiB} MiB`)
    console.log('\n1. Context Checkpoint Restore (bin/context-checkpoint.mjs --restore):')
    console.table(checkpoint)
    console.log('\n2. Worker Actor-Event Recording (bin/turn-actor.mjs):')
    console.table(workerEvents)
    console.log('\n3. Guard Ignored-File Snapshot (lib/guard.sh mbot_guard_snapshot):')
    console.table(guardSnapshot)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
