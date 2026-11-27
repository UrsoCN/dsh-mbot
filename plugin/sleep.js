// Staged Sleep/Wake lifecycle for a managed Bot (R4).
// Stages:
//   1. Acquire BotCoordinator maintenance barrier ('sleep') + Bot data lock
//   2. Fix completed history cutoff (HEAD + native session seqs) while native Inbox keeps accepting messages
//   3. Write durable maintenance journal ('sleep', phase='dreaming')
//   4. Run Dreaming (mbot dream) with lock handoff; record dreamCommit + dreamOutcome in journal
//   5. Optional conversation compact/checkpoint refresh (skips Dreaming on recovery if Git commit already landed)
//   6. Mark Bot sleeping (durable sleeping marker + release live Agent if requested; Session ID & Inbox preserved)
//   7. Wake: clear sleeping state, resolve original main Session (never create a replacement), restore context
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readMaintenanceJournal, writeMaintenanceJournal, clearMaintenanceJournal, isMaintenanceOwnerLive } from './maintenance-journal.js'
import { readJournal } from './recovery-proof.js'
import { readKnowledge } from './context-audit.js'
import { restoreContext } from './context-checkpoint.js'
import { runManualCompaction } from './compaction.js'
import { runtimeCells as cells } from './runtime-cells.js'

const gitHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u

function gitHead(workspace) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', workspace, 'rev-parse', 'HEAD'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitIsAncestor(workspace, ancestor, descendant) {
  try {
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', workspace,
      'merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' })
    return true
  } catch { return false }
}

async function withBotLock(runtime, workspace, signal, operation) {
  const lockPath = join(workspace, '.mbot/lock')
  const child = runtime.ctx.subprocess.spawn({
    argv: ['flock', '-n', lockPath, 'sh', '-c', 'printf "ready\\n"; cat >/dev/null'],
    cwd: workspace, signal, graceMs: 5000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8000 } },
  })
  runtime.ctx.mbot.active.add(child)
  child.stdin.on('error', () => {})
  const reader = createInterface({ input: child.stdout })
  try {
    const first = await reader[Symbol.asyncIterator]().next()
    if (first.done || first.value !== 'ready') throw new Error('Bot data lock is busy; settle active writers before sleep')
    return await operation()
  } finally {
    child.stdin.end()
    child.terminate()
    await child.waitForExit()
    reader.close()
    runtime.ctx.mbot.active.delete(child)
  }
}

/**
 * Sleep a managed Bot:
 * - Blocks new turns via BotCoordinator barrier while native Inbox keeps accepting messages
 * - Fixes cutoff HEAD & session seqs
 * - Runs independent Dreaming (unless skipDream: true) and records committed HEAD in durable maintenance journal
 * - Optionally compacts conversation history after Dreaming (if compact: true and compactor available)
 * - Publishes durable sleeping state (cleared by wake), retaining original mainSessionId and queued Inbox
 */
export async function sleepBot(runtime, botId, options = {}) {
  const bot = runtime.ctx.mbot.bot({ botId })
  if (!bot) throw new Error('Sleep requires a registered Bot')
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const existing = await readMaintenanceJournal(bot.workspacePath)
  if (existing) {
    if (existing.record.kind === 'sleep' && existing.record.phase === 'sleeping') {
      return {
        kind: 'slept',
        alreadySleeping: true,
        botId: bot.botId,
        maintenanceId: existing.record.maintenanceId,
        sessionId: bot.mainSessionId ?? existing.record.sessionId ?? null,
        cutoffHead: existing.record.cutoffHead,
        dreamCommit: existing.record.dreamCommit ?? null,
        dreamSkipped: existing.record.dreamSkipped === true,
        compacted: existing.record.compacted === true,
        knowledgeVersion: existing.record.knowledgeVersion,
      }
    }
    throw new Error(`Bot has an unfinished ${existing.record.kind} maintenance journal (${existing.record.phase}); run /mbot recover first`)
  }
  const barrier = await runtime.coordinator.acquireBarrier(bot.botId, 'sleep', { signal })
  try {
    const turnJournal = await readJournal(bot.workspacePath)
    if (turnJournal) throw new Error('Managed turn journal is pending; run /mbot recover before sleep')
    const paused = await lstat(join(bot.workspacePath, '.mbot/PAUSED')).then(() => true, error => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (paused) throw new Error('Workspace is PAUSED; inspect status and /mbot resume before sleep')

    const states = barrier.states
    const mainState = states.find(state => !state.worker)
    const sessionId = mainState?.agent.id ?? bot.mainSessionId ?? null
    const sessionCutoffs = {}
    for (const state of states) {
      if (state.worker) continue
      await runtime.ctx.sessions.flush(state.agent.session)
      const log = await runtime.ctx.sessionQuery.readSession(state.agent.id)
      sessionCutoffs[state.agent.id] = {
        throughSeq: log.events.at(-1)?.seq ?? -1,
        queuedNextTurn: state.agent.inbox.nextTurn.length,
        queuedNextStep: state.agent.inbox.nextStep.length,
      }
    }
    const cutoffHead = gitHead(bot.workspacePath)
    const beforeKnowledge = readKnowledge(bot.workspacePath, cutoffHead, bot.defaultRole)
    const maintenanceId = `sleep-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    const skipDream = options.skipDream === true

    await writeMaintenanceJournal(bot.workspacePath, {
      kind: 'sleep',
      phase: skipDream ? 'post-dream' : 'dreaming',
      maintenanceId,
      botId: bot.botId,
      sessionId,
      cutoffHead,
      beforeKnowledgeVersion: beforeKnowledge.version,
      knowledgeVersion: beforeKnowledge.version,
      sessionCutoffs,
      dreamSkipped: skipDream,
      dreamCommit: null,
      compacted: false,
    })

    // Stage 1: Dreaming runs under mbot dream's own Bot lock (no active turn can enter because barrier is held).
    let dreamCommit = null
    let dreamSucceeded = true
    let dreamOutput = ''
    if (!skipDream) {
      const dreamResult = await runtime.ctx.mbot.execute('mbot', ['dream'], { botId: bot.botId, signal })
      dreamOutput = dreamResult.stdout + dreamResult.stderr
      const afterDreamHead = gitHead(bot.workspacePath)
      if (afterDreamHead !== cutoffHead && gitIsAncestor(bot.workspacePath, cutoffHead, afterDreamHead)) {
        dreamCommit = afterDreamHead
      }
      dreamSucceeded = dreamResult.exitCode === 0
      if (!dreamSucceeded) {
        // Dreaming failed: do not advance epoch or enter sleeping state; preserve failure audit and clear journal.
        await clearMaintenanceJournal(bot.workspacePath)
        throw new Error(`Sleep Dreaming failed: ${dreamOutput.trim() || `exit ${dreamResult.exitCode}`}`)
      }
    }

    const postDreamHead = gitHead(bot.workspacePath)
    const afterKnowledge = readKnowledge(bot.workspacePath, postDreamHead, bot.defaultRole)
    await writeMaintenanceJournal(bot.workspacePath, {
      kind: 'sleep',
      phase: 'checkpointing',
      maintenanceId,
      botId: bot.botId,
      sessionId,
      cutoffHead,
      beforeKnowledgeVersion: beforeKnowledge.version,
      knowledgeVersion: afterKnowledge.version,
      sessionCutoffs,
      dreamSkipped: skipDream,
      dreamCommit,
      compacted: false,
    })

    // Stage 2: Optional compact & context checkpoint verification for active main Session.
    let compacted = false
    if (mainState && options.compact === true && mainState.agent.ctx.get('compaction')) {
      const cell = cells.get(mainState.agent)
      if (cell) {
        // Temporarily release the sleep barrier's exclusivity only for our nested maintenance compaction
        // by invoking compactor directly under Bot data lock with activeMaintenanceCompaction.
        const compactRes = await withBotLock(runtime, bot.workspacePath, signal, async () => {
          cell.activeMaintenanceCompaction = {
            maintenanceId: `${maintenanceId}-compact`,
            workspace: bot.workspacePath,
            memoryCommit: postDreamHead,
            knowledgeVersion: afterKnowledge.version,
          }
          try {
            const res = await mainState.agent.ctx.get('compaction').compactNow(mainState.agent, signal)
            await runtime.ctx.sessions.flush(mainState.agent.session)
            return res
          } finally {
            cell.activeMaintenanceCompaction = undefined
          }
        })
        compacted = compactRes !== null
      }
    }

    if (mainState) {
      await restoreContext(mainState)
    }

    // Stage 3: Publish durable sleeping state. The Bot stays blocked from business turns
    // until explicit wake(); native Inbox continues accepting new messages.
    await writeMaintenanceJournal(bot.workspacePath, {
      kind: 'sleep',
      phase: 'sleeping',
      maintenanceId,
      botId: bot.botId,
      sessionId,
      cutoffHead,
      beforeKnowledgeVersion: beforeKnowledge.version,
      knowledgeVersion: afterKnowledge.version,
      sessionCutoffs,
      dreamSkipped: skipDream,
      dreamCommit,
      compacted,
    })
    runtime.coordinator.setSleeping(bot.botId, {
      maintenanceId,
      sessionId,
      cutoffHead,
      dreamCommit,
      knowledgeVersion: afterKnowledge.version,
      compacted,
    })

    return {
      kind: 'slept',
      alreadySleeping: false,
      botId: bot.botId,
      maintenanceId,
      sessionId,
      cutoffHead,
      dreamCommit,
      dreamSkipped: skipDream,
      compacted,
      knowledgeVersion: afterKnowledge.version,
    }
  } finally {
    barrier.release()
  }
}

/**
 * Wake a sleeping Bot:
 * - Clears durable sleeping state and unblocks business turns
 * - Preserves original mainSessionId (resolves existing Agent, never creates a duplicate)
 * - Refreshes context checkpoint from current Git HEAD/MEMORY and reports queued Inbox count
 */
export async function wakeBot(runtime, botId, options = {}) {
  const bot = runtime.ctx.mbot.bot({ botId })
  if (!bot) throw new Error('Wake requires a registered Bot')
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const existing = await readMaintenanceJournal(bot.workspacePath)
  if (existing && (existing.record.kind !== 'sleep' || existing.record.phase !== 'sleeping')) {
    throw new Error(`Bot has an unfinished ${existing.record.kind} maintenance journal (${existing.record.phase}); run /mbot recover first`)
  }
  const wasSleeping = Boolean(existing || runtime.coordinator.isSleeping(bot.botId))
  if (existing) await clearMaintenanceJournal(bot.workspacePath)
  runtime.coordinator.clearSleeping(bot.botId)

  let agent = bot.mainSessionId ? runtime.ctx.agents.get(bot.mainSessionId) : undefined
  if (!agent) {
    agent = [...runtime.states.values()].find(state => state.botId === bot.botId && !state.worker)?.agent
  }
  if (!agent && bot.mainSessionId && runtime.ctx.get('sessionController')) {
    const resolved = await runtime.ctx.get('sessionController').resolveAgent(bot.mainSessionId)
    if ('error' in resolved) throw resolved.error
    agent = resolved.agent
    if (!runtime.managed(agent)) await runtime.attach(agent, { botId: bot.botId })
  }
  const state = agent ? runtime.states.get(agent) : undefined
  if (state) {
    await restoreContext(state)
  }
  const head = gitHead(bot.workspacePath)
  const knowledge = readKnowledge(bot.workspacePath, head, bot.defaultRole)
  return {
    kind: 'woken',
    wasSleeping,
    botId: bot.botId,
    sessionId: agent?.id ?? bot.mainSessionId ?? null,
    head,
    knowledgeVersion: knowledge.version,
    queued: agent ? { nextTurn: agent.inbox.nextTurn.length, nextStep: agent.inbox.nextStep.length } : { nextTurn: 0, nextStep: 0 },
  }
}

/**
 * Cold-recover an interrupted sleep maintenance journal (phase !== 'sleeping'):
 * - If Dreaming already advanced Git HEAD, never re-runs Dreaming; only completes
 *   context restoration and settles into clean idle/sleeping state.
 * - Rejects if the previous owner is still live in the same boot.
 */
export async function recoverSleepMaintenance(runtime, bot, options = {}) {
  const existing = await readMaintenanceJournal(bot.workspacePath)
  if (!existing || existing.record.kind !== 'sleep' || existing.record.phase === 'sleeping') return null
  const record = existing.record
  if (await isMaintenanceOwnerLive(record)) throw new Error('Sleep maintenance owner is still alive; wait for it to finish')
  const barrier = await runtime.coordinator.acquireBarrier(bot.botId, 'sleep-recover', options)
  try {
    return await withBotLock(runtime, bot.workspacePath, options.signal, async () => {
      const currentHead = gitHead(bot.workspacePath)
      const dreamAlreadyCommitted = Boolean(record.dreamCommit && gitHash.test(record.dreamCommit)
        && gitIsAncestor(bot.workspacePath, record.dreamCommit, currentHead))
        || (record.cutoffHead && currentHead !== record.cutoffHead && gitIsAncestor(bot.workspacePath, record.cutoffHead, currentHead))
      let agent = record.sessionId ? runtime.ctx.agents.get(record.sessionId) : undefined
      if (!agent && record.sessionId && runtime.ctx.get('sessionController')) {
        const resolved = await runtime.ctx.get('sessionController').resolveAgent(record.sessionId)
        if ('error' in resolved) throw resolved.error
        agent = resolved.agent
      }
      const state = agent ? runtime.states.get(agent) : undefined
      if (state) {
        await runtime.ctx.sessions.flush(state.agent.session)
        await restoreContext(state)
      }
      await clearMaintenanceJournal(bot.workspacePath)
      runtime.coordinator.clearSleeping(bot.botId)
      return {
        kind: 'recovered',
        needed: true,
        maintenanceRecovered: true,
        sleepRecovered: true,
        maintenanceId: record.maintenanceId,
        dreamAlreadyCommitted,
        head: currentHead,
      }
    })
  } finally {
    barrier.release()
  }
}

/** Read-only Bot overview snapshot for CLI/commands/management panel. */
const WORKSPACE_CONFIG_DEFAULTS = {
  MBOT_MEMORY_MAX_LINES: 150,
  MBOT_MEMORY_MAX_CHARS: 3000,
  MBOT_SOUL_MAX_CHARS: 5000,
  MBOT_WIKI_MAX_LINES: 200,
  MBOT_BOARD_MAX_LINES: 80,
  MBOT_TIMEOUT: 300,
  MBOT_DREAM_MAX_BYTES: 64000,
  MBOT_GRANTS: '',
  MBOT_DSH: 'dsh',
  MBOT_PUSH_AFTER_DREAM: 0,
  MBOT_PUSH_TIMEOUT: 30,
}

const NUMERIC_CONFIG_KEYS = new Set([
  'MBOT_MEMORY_MAX_LINES', 'MBOT_MEMORY_MAX_CHARS', 'MBOT_SOUL_MAX_CHARS',
  'MBOT_WIKI_MAX_LINES', 'MBOT_BOARD_MAX_LINES', 'MBOT_TIMEOUT',
  'MBOT_DREAM_MAX_BYTES', 'MBOT_PUSH_AFTER_DREAM', 'MBOT_PUSH_TIMEOUT',
])

/** Read-only effective config with source attribution; credentials are referenced/masked, never returned plaintext. */
export async function effectiveBotConfig(runtime, bot) {
  const ws = bot.workspacePath
  const fileValues = {}
  try {
    const raw = await readFile(join(ws, '.mbot/config'), 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = /^([A-Z_]+)=(.*)$/u.exec(line)
      if (!match || !(match[1] in WORKSPACE_CONFIG_DEFAULTS)) continue
      let val = match[2]
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
      fileValues[match[1]] = val
    }
  } catch {}
  const workspace = {}
  for (const [key, fallback] of Object.entries(WORKSPACE_CONFIG_DEFAULTS)) {
    let raw, source
    if (process.env[key] !== undefined) { raw = process.env[key]; source = 'env' }
    else if (key in fileValues) { raw = fileValues[key]; source = 'workspace-config' }
    else { raw = fallback; source = 'default' }
    workspace[key] = { value: NUMERIC_CONFIG_KEYS.has(key) ? Number(raw) : raw, source }
  }
  const runtimeConfig = {
    workers: { value: runtime.workersEnabled, source: runtime.config?.workers === undefined ? 'default' : 'cordis' },
    compactMaxBytes: { value: runtime.config?.compactMaxBytes ?? 64000, source: runtime.config?.compactMaxBytes === undefined ? 'default' : 'cordis' },
  }
  const credentialRefs = [
    { name: 'DEEPSEEK_API_KEY', present: Boolean(process.env.DEEPSEEK_API_KEY), source: process.env.DEEPSEEK_API_KEY ? 'env' : 'unset', masked: process.env.DEEPSEEK_API_KEY ? '[REDACTED]' : null },
  ]
  return { schemaVersion: 1, botId: bot.botId, workspace, runtime: runtimeConfig, credentialRefs }
}

export async function botOverview(runtime, bot) {
  const ws = bot.workspacePath
  let paused = null
  let failures = 0
  let head = null
  let knowledgeVersion = null
  let hasTurnJournal = false
  let maintenance = null
  let board = { todo: 0, doing: 0, blocked: 0, done: 0 }
  let memory = { lines: 0, chars: 0 }
  let workspaceExists = false
  let config = null
  try {
    workspaceExists = (await lstat(ws)).isDirectory()
  } catch {}
  if (workspaceExists) {
    try { paused = (await readFile(join(ws, '.mbot/PAUSED'), 'utf8')).trim() } catch {}
    try { failures = Number((await readFile(join(ws, '.mbot/failures'), 'utf8')).trim()) || 0 } catch {}
    try {
      head = gitHead(ws)
      knowledgeVersion = readKnowledge(ws, head, bot.defaultRole).version
    } catch {}
    try { hasTurnJournal = Boolean(await readJournal(ws)) } catch { hasTurnJournal = true }
    try { maintenance = (await readMaintenanceJournal(ws))?.record ?? null } catch { maintenance = { kind: 'corrupt', phase: 'unknown' } }
    try {
      const boardText = await readFile(join(ws, 'BOARD.md'), 'utf8')
      for (const line of boardText.split('\n')) {
        const cols = line.split('|').map(c => c.trim())
        if (cols.length >= 6 && /^[0-9]{3,9}$/u.test(cols[1]) && cols[2] in board) board[cols[2]]++
      }
    } catch {}
    try {
      const memText = await readFile(join(ws, 'MEMORY.md'), 'utf8')
      memory = { lines: memText ? memText.split('\n').length - (memText.endsWith('\n') ? 1 : 0) : 0, chars: [...memText].length }
    } catch {}
    try { config = await effectiveBotConfig(runtime, bot) } catch {}
  }
  const stateObj = [...runtime.states.values()].find(s => s.botId === bot.botId && !s.worker)
  const runtimeStatus = stateObj ? await runtime.status(stateObj.agent).catch(() => null) : null
  const sleeping = runtime.coordinator.isSleeping(bot.botId) || (maintenance?.kind === 'sleep' && maintenance.phase === 'sleeping')
  const budgets = config ? {
    memoryLines: { used: memory.lines, limit: config.workspace.MBOT_MEMORY_MAX_LINES.value },
    memoryChars: { used: memory.chars, limit: config.workspace.MBOT_MEMORY_MAX_CHARS.value },
    boardMaxLines: config.workspace.MBOT_BOARD_MAX_LINES.value,
    timeoutSec: config.workspace.MBOT_TIMEOUT.value,
  } : null
  return {
    botId: bot.botId,
    name: bot.name,
    role: bot.defaultRole,
    workspacePath: ws,
    workspaceExists,
    mainSessionId: bot.mainSessionId ?? null,
    bindingState: bot.binding?.state ?? 'unbound',
    bindingError: bot.binding?.error ?? null,
    needsRepair: !workspaceExists || bot.binding?.state !== 'ready' || Boolean(paused) || hasTurnJournal || Boolean(maintenance && !(maintenance.kind === 'sleep' && maintenance.phase === 'sleeping')),
    runtimeState: sleeping ? 'sleeping' : (runtimeStatus?.state ?? 'cold'),
    queued: runtimeStatus?.queued ?? { nextTurn: 0, nextStep: 0 },
    paused,
    failures,
    head,
    knowledgeVersion,
    hasTurnJournal,
    maintenancePhase: maintenance ? `${maintenance.kind}:${maintenance.phase}` : null,
    board,
    memory,
    budgets,
    effectiveConfig: config,
  }
}
