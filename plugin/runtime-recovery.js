import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { journalDigest, readJournal, recoveryInput, validateOwnership } from './recovery-proof.js'
import { processStart, currentBootId } from './recovery.js'
import { fileURLToPath } from 'node:url'
import { readonlyLegacy } from './readonly-migration.js'
import { workerRecoveryContract, workerRecoveryInput } from './worker-recovery-proof.js'
import { restoreContext, recoverCompactionCatalog } from './context-checkpoint.js'
import { contextAuditEvent } from './context-state.js'
import { sealCompactionAudit, verifyCompactionSources, compactInputType, compactOutputType } from './compaction-data.js'
import { botSessionIds, conversationForSession } from './conversations.js'
import { conversationViewScope } from './conversation-view.js'
import { validateDomainJournal } from './domain-contract.js'
import { isDeepStrictEqual } from 'node:util'
const packageRoot = fileURLToPath(new URL('../', import.meta.url))

function awaited(signal, operation) {
  if (signal?.aborted) { void Promise.resolve(operation).catch(() => {}); return Promise.reject(signal.reason) }
  if (!signal) return operation
  const aborted = Promise.withResolvers()
  const cancel = () => aborted.reject(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  return Promise.race([operation, aborted.promise]).finally(() => signal.removeEventListener('abort', cancel))
}

export async function repairNativeReceipt(runtime, bot, options) {
  const states = [...runtime.states.values()].filter(state => state.botId === bot.botId)
  const failed = states.filter(state => state.error && (state.failedAuditRecord ?? state.current)?.result && (state.failedAuditRecord ?? state.current).settled)
  if (!failed.length) return
  if (runtime.closed || runtime.recoveries.has(bot.botId) || states.some(state => state.closing || state.agent.status !== 'idle' || state.current?.lease && !state.current.settled)) throw new Error('Bot is still executing or auditing; settle it before receipt recovery')
  const completion = Promise.withResolvers()
  runtime.recoveries.set(bot.botId, completion)
  try {
    for (const state of failed) {
      await awaited(options.signal, state.pending.catch(() => {}))
      const record = state.failedAuditRecord ?? state.current, result = record.result
      await awaited(options.signal, runtime.ctx.sessions.flush(state.agent.session))
      const log = await awaited(options.signal, runtime.ctx.sessionQuery.readSession(state.agent.id))
      const start = log.events.find(event => event.type === 'turn/start' && event.data.turn === record.turn)
      const end = log.events.find(event => event.type === 'turn/end' && event.data.turn === record.turn)
      if (!start || !end || log.session.id !== state.agent.id || log.session.cwd !== bot.workspacePath) throw new Error('Native receipt recovery identity changed')
      const events = log.events.filter(event => event.seq >= start.seq && event.seq <= end.seq && contextAuditEvent(event))
      const workers = await runtime.workerLogs(events)
      const check = runtime.ctx.mbot.ctx.subprocess.spawn({ argv: [process.execPath, join(packageRoot, 'bin/turn-runtime-recovery.mjs'), '--audit-input'],
        cwd: packageRoot, signal: options.signal, graceMs: 5000, stdio: { stdin: { data: JSON.stringify({ workspace: bot.workspacePath,
          header: { botId: bot.botId, sessionId: state.agent.id, turn: record.turn, writerScope: 'agent-runtime', messages: record.messages,
            ...(state.domainScope ? { conversation: state.domainScope } : {}) },
          events, workers, result }) },
          stdout: { maxBytes: 8000 }, stderr: { maxBytes: 8000 } } })
      runtime.ctx.mbot.active.add(check)
      try {
        const exit = await check.done
        if (exit.exitCode !== 0) throw new Error('Git audit could not confirm the pending native receipt')
      } finally { check.terminate(); await check.waitForExit(); runtime.ctx.mbot.active.delete(check) }
      await state.publish(record, result.success ? 'committed' : 'rejected', { runId: result.runId,
        ...(record.memoryCommit || record.lease?.snapshot.head ? { memoryCommit: record.memoryCommit ?? record.lease.snapshot.head } : {}) })
      await awaited(options.signal, runtime.ctx.sessions.flush(state.agent.session))
      await restoreContext(state)
      state.error = undefined
      state.failedAuditRunId = undefined
      state.failedAuditRecord = undefined
      state.pending = Promise.resolve()
    }
    return { kind: 'recovered', needed: false, receiptRepaired: true }
  } finally { runtime.recoveries.delete(bot.botId); completion.resolve() }
}

/** The native writer and Agent-owned gates remain held until Git/flush settle. */
export async function recoverRuntime(runtime, bot, journal, options) {
  if (runtime.closed || runtime.recoveries.has(bot.botId) || [...runtime.attachments.values()].some(item => item.botId === bot.botId)) throw new Error('Runtime recovery or attachment is already in progress')
  const states = [...runtime.states.values()].filter(state => state.botId === bot.botId)
  if (states.some(state => state.closing || state.retiring || state.agent.status !== 'idle' || state.current?.lease && !state.current.settled)) throw new Error('Bot is still executing or auditing; stop and settle it before recovery')
  const completion = Promise.withResolvers()
  // Publication is synchronous: all existing/new Agent gates now reject turns.
  runtime.recoveries.set(bot.botId, completion)
  let directory
  const workerHandles = []
  try {
    options.signal?.throwIfAborted()
    await awaited(options.signal, Promise.allSettled(states.map(state => state.pending)))
    await awaited(options.signal, Promise.allSettled(states.map(state => state.messageOperations)))
    for (const lease of runtime.ctx.mbot.leases) {
      if (lease.identity.botId !== bot.botId) continue
      if (!lease.transportEnded) throw new Error('Managed writer is still active; settle it before recovery')
      await lease.cancel('Settling disconnected Runtime turn').catch(() => {})
    }
    const controller = runtime.ctx.get('sessionController')
    if (!controller) throw new Error('Runtime recovery requires the native Session Controller')
    if (journal.botId !== bot.botId || journal.workspace !== bot.workspacePath
      || ![...botSessionIds(runtime.ctx.mbot.registry(), bot), ...states.map(state => state.agent.id), ...(options.retiredSessionIds ?? [])].includes(journal.sessionId)) throw new Error('Recovery journal does not belong to the selected Bot Session')
    const conversation = conversationForSession(runtime.ctx.mbot.registry(), journal.sessionId)
    if (conversation) {
      validateDomainJournal(journal)
      if (!isDeepStrictEqual(journal.conversation, conversationViewScope(conversation))) throw new Error('Recovery journal changed its persistent domain ownership')
    } else if (journal.conversation || journal.schemaVersion === 4) throw new Error('Domain recovery requires persistent conversation ownership')
    const resolved = await awaited(options.signal, controller.resolveAgent(journal.sessionId))
    if ('error' in resolved) throw resolved.error
    const agent = resolved.agent
    if (agent.id !== journal.sessionId || agent.session.header.cwd !== bot.workspacePath || agent.status !== 'idle') throw new Error('Native recovery Session ownership is not idle or does not match the Bot')
    const retired = runtime.ctx.mbot.registry().retiredBots.find(entry => entry.bot.botId === bot.botId)
    if (retired) await awaited(options.signal, runtime.attachRetired(agent, retired))
    else await awaited(options.signal, runtime.attach(agent, { botId: bot.botId }))
    const ownerStart = await processStart()
    const bootId = await currentBootId()
    const captured = journal.ownerPid === process.pid && journal.ownerStart === ownerStart
      && (journal.bootId === undefined || journal.bootId === bootId)
      && states.some(state => state.current?.lease?.identity.runId === journal.runId || state.failedAuditRunId === journal.runId)
    if (journal.schemaVersion === 3) workerRecoveryContract(journal)
    if (journal.schemaVersion !== 4 && !captured && journal.runtimeOwnership !== undefined) validateOwnership(journal.runtimeOwnership, journal.schemaVersion === 3)
    options.signal?.throwIfAborted()
    if (runtime.closed || runtime.ctx.mbot.closed) throw new Error('MBot Runtime closed during recovery')
    await awaited(options.signal, runtime.ctx.sessions.flush(agent.session))
    const log = await awaited(options.signal, runtime.ctx.sessionQuery.readSession(agent.id))
    const input = await recoveryInput(journal, log)
    if (journal.compactionPolicyVersion === 1 || input.events.some(event => [compactInputType, compactOutputType].includes(event.type))) {
      const context = input.events.find(event => event.type === 'plugin:mbot/context-snapshot')
      const meta = { run_id: journal.runId, base_head: journal.baseHead, runtime: { bot_id: bot.botId, session_id: agent.id,
        turn: journal.turn, context: context ? { snapshot: context.data } : undefined } }
      const proofs = sealCompactionAudit(meta, input.events) ?? []
      const trusted = proofs.length ? new Map(runtime.states.get(agent)?.compactionCatalog
        ?? await recoverCompactionCatalog(runtime, bot, agent, log)) : new Map()
      for (const proof of proofs) {
        verifyCompactionSources(proof, log.events, trusted)
        trusted.set(proof.compactionId, proof)
      }
    }
    const workers = []
    if (journal.schemaVersion === 3) {
      for (const actor of journal.actors) {
        // Native creation owns rollback on cancellation. Never abandon a
        // resolving handle behind an observation-only Promise.race.
        const handle = await runtime.acquireRecoveryWorker(journal, actor, options.signal)
        workerHandles.push(handle)
        workers.push(handle.log)
      }
      input.actors = await workerRecoveryInput(journal, workers)
    }
    const legacyEvidence = !captured && journal.runtimeOwnership === undefined ? readonlyLegacy(journal, input) : undefined
    const start = input.events[0].seq, end = input.events.at(-1).seq
    directory = await mkdtemp('/tmp/mbot-runtime-recovery.')
    const proofFile = join(directory, 'proof.json')
    await writeFile(proofFile, JSON.stringify({ schemaVersion: 1, kind: 'runtime-quiescent', ownerPid: process.pid, ownerStart, bootId,
      mode: journal.schemaVersion === 4 ? 'recorded-domain-v1' : journal.schemaVersion === 3 ? 'recorded-workers-v2' : captured ? 'captured-runtime' : legacyEvidence ? 'legacy-readonly' : 'recorded-foreground-v1',
      ...(captured ? { capturedRunId: journal.runId } : {}), ...(legacyEvidence ? { evidence: legacyEvidence } : {}),
      journalHash: journalDigest(journal), ...(journal.schemaVersion === 3 ? { workers } : {}), log: { session: log.session, inheritedEventCount: log.inheritedEventCount,
        events: log.events.filter(event => event.seq >= start && event.seq <= end) }, input }), { mode: 0o600, flag: 'wx' })
    const result = await runtime.ctx.mbot.execute('mbot', ['recover'], { workspace: bot.workspacePath, signal: options.signal,
      recoveryOwner: { pid: process.pid, start: ownerStart, runtimeProof: proofFile } })
    if (result.exitCode) throw new Error(result.stderr || result.stdout)
    const recovered = JSON.parse(result.stdout)
    if (!recovered.needed || recovered.runId !== journal.runId) throw new Error('Runtime journal changed during recovery; inspect its audit')
    const state = runtime.states.get(agent)
    if (state) {
      const receiptRecord = { turn: journal.turn, reason: input.finish.reason, result: recovered, messages: input.messages, memoryCommit: journal.baseHead, settled: true }
      state.failedAuditRecord = receiptRecord
      state.failedAuditRunId = journal.runId
      try {
        await state.publish(receiptRecord, recovered.success ? 'committed' : 'rejected', { runId: journal.runId, memoryCommit: journal.baseHead })
        await awaited(options.signal, runtime.ctx.sessions.flush(agent.session))
        await restoreContext(state)
      } catch (error) {
        state.error = new Error('Recovered Git audit awaits native receipt confirmation')
        throw state.error
      }
      for (const item of [...runtime.states.values()].filter(item => item.botId === bot.botId)) {
        if (item.failedAuditRunId === journal.runId || item.current?.lease?.identity.runId === journal.runId) {
          item.error = undefined
          item.failedAuditRunId = undefined
          item.failedAuditRecord = undefined
          item.pending = Promise.resolve()
        }
      }
    }
    return recovered
  } finally {
    const released = await Promise.allSettled(workerHandles.map(handle => handle.dispose()))
    if (directory) await rm(directory, { recursive: true, force: true })
    runtime.recoveries.delete(bot.botId)
    completion.resolve()
    const failure = released.find(item => item.status === 'rejected')
    if (failure) throw failure.reason
  }
}

export function recoveryBot(host, options) {
  const registry = host.registry()
  const retired = registry.retiredBots.find(entry => options.botId === entry.bot.botId
    || options.botId === undefined && options.sessionId && entry.sessionIds.includes(options.sessionId))
  return retired ? { bot: retired.bot, retiredSessionIds: retired.sessionIds } : { bot: host.bot(options) }
}

export async function recoverSelected(host, options) {
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) }
  const selected = recoveryBot(host, options)
  const bot = selected.bot
  if (!bot) throw new Error('Recovery requires a registered Bot')
  const journal = await readJournal(bot.workspacePath)
  if (!journal) {
    const runtime = host.ctx.get('mbotRuntime')
    const repaired = runtime && await runtime.coordinateRecovery(bot, undefined, options)
    if (repaired) return repaired
  }
  if (journal?.writerScope === 'agent-runtime') {
    const runtime = host.ctx.get('mbotRuntime')
    if (!runtime) throw new Error('Agent Runtime recovery requires the active MBot Runtime')
    return runtime.coordinateRecovery(bot, journal, { ...options, ...selected })
  }
  for (const lease of host.leases) {
    if (lease.snapshot.workspace !== bot.workspacePath) continue
    if (!lease.transportEnded) throw new Error('Managed turn is still active; cancel or settle it first')
    await lease.cancel('Settling disconnected turn for recovery').catch(() => {})
  }
  const result = await host.execute('mbot', ['recover'], { workspace: bot.workspacePath, signal: options.signal,
    recoveryOwner: { pid: process.pid, start: await processStart() } })
  if (result.exitCode) throw new Error(result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}
