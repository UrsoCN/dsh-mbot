import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { BlockAssembler, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { compactInputType, compactOutputType, summaryPurpose, summaryPolicy, summarySources, summaryRequest,
  validateSummaryItems, renderSummary, sealCompactionAudit, verifyCompactionSources } from './compaction-data.js'
import { contextHash, freezeContext } from './context-state.js'
import { redactionSpans } from './reply-proof.js'
import { redact } from './redact.js'
import { readKnowledge } from './context-audit.js'
import { execFileSync } from 'node:child_process'
import { readMaintenanceJournal, writeMaintenanceJournal, clearMaintenanceJournal, isMaintenanceOwnerLive } from './maintenance-journal.js'
import { readJournal } from './recovery-proof.js'
import { restoreContext } from './context-checkpoint.js'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

function nativeRegion(agent, surface, options) {
  const final = options.messages.at(-1)
  if (isAgentLoopRequest(options) || final?.role !== 'user' || final.source !== undefined || final.content.length !== 1
    || !final.content[0].text?.startsWith('You are now acting as a compaction engine for this AI coding assistant.')) throw new Error('Unsupported native compaction request contract')
  let messages = options.messages.slice(0, -1)
  const derived = surface.events.map(event => agent.session.deriveEventMessage(event))
  if (derived[0]?.role === 'system') {
    if (contextHash(messages[0]) !== contextHash(derived[0])) throw new Error('Native compaction system prefix changed')
    messages = messages.slice(1)
  }
  const matches = []
  for (let start = derived[0]?.role === 'system' ? 1 : 0; start < derived.length; start++) {
    let cursor = 0
    for (let end = start; end < derived.length; end++) {
      if (derived[end]) {
        if (cursor >= messages.length || contextHash(derived[end]) !== contextHash(messages[cursor])) break
        cursor++
      }
      if (cursor === messages.length && messages.length) matches.push(surface.events.slice(start, end + 1).map(event => event.seq))
    }
  }
  if (!matches.length || matches.length > 256) throw new Error('Native compaction range is missing or ambiguous')
  const positions = new Map(surface.events.map((event, index) => [event.seq, index]))
  const visible = span => span.filter(seq => derived[positions.get(seq)] !== null)
  const concrete = visible(matches[0])
  if (matches.some(span => contextHash(visible(span)) !== contextHash(concrete))) throw new Error('Native compaction range is ambiguous')
  const begin = positions.get(concrete[0]), end = positions.get(concrete.at(-1))
  return { sourceSpan: surface.events.slice(begin, end + 1).map(event => event.seq), candidateSpans: matches }
}

export async function verifyManagedCompactions(state, record, { open = false } = {}) {
  if (!record.compactionSeen) return []
  const log = await state.runtime.ctx.sessionQuery.readSession(state.agent.id)
  const starts = log.events.filter(event => event.type === 'compaction/start' && event.data.turn === record.turn)
  // Use an exact native turn slice; compaction records carry IDs, not all carry turn.
  const start = log.events.find(event => event.type === 'turn/start' && event.data.turn === record.turn)
  const end = log.events.find(event => event.type === 'turn/end' && event.data.turn === record.turn)
  const slice = log.events.filter(event => event.seq >= start.seq && (!end || event.seq <= end.seq))
  const pending = starts.filter(event => !slice.some(item => item.type === 'compaction/end' && item.data.compactionId === event.data.compactionId))
  const selected = open ? slice.filter(event => !pending.some(start => event.data?.compactionId === start.data.compactionId)) : slice
  const meta = { run_id: record.lease.identity.runId, base_head: record.lease.snapshot.head,
    runtime: { bot_id: state.botId, session_id: state.agent.id, turn: record.turn, context: record.context } }
  const proofs = sealCompactionAudit(meta, selected) ?? []
  const trusted = new Map(state.compactionCatalog)
  for (const proof of proofs) { verifyCompactionSources(proof, log.events, trusted); trusted.set(proof.compactionId, proof) }
  record.compactions = proofs
  return proofs
}

export async function* managedCompaction(state, cell, options, next) {
  if (options.purpose === summaryPurpose) {
    if (!cell.compactionRequests?.has(options)) throw new Error('MBot auxiliary compaction request has no managed owner')
    yield* next(); return
  }
  if (options.purpose !== 'compaction') {
    if (isAgentLoopRequest(options) && state.current?.lease) await verifyManagedCompactions(state, state.current)
    yield* next(); return
  }
  if (state.worker) throw new Error('Worker compaction needs its own managed lifetime contract')
  const maintenance = cell.activeMaintenanceCompaction
  const record = state.current
  if (maintenance) {
    if (record && !record.ended) throw new Error('Maintenance compaction cannot overlap an active business turn')
    if (!options.signal) throw new Error('Maintenance compaction requires a cancellation signal')
    yield* runManagedCompactionBody(state, cell, options, {
      standalone: true,
      turn: null,
      runId: maintenance.maintenanceId,
      memoryCommit: maintenance.memoryCommit,
      knowledgeVersion: maintenance.knowledgeVersion,
      redactText: text => redact(text, maintenance.workspace),
    })
    return
  }
  if (!record || record.ended || !options.signal) throw new Error('Standalone compact requires the MBot maintenance lifecycle')
  await state.admit(options.signal)
  const done = Promise.withResolvers()
  record.calls.add(done.promise)
  try {
    yield* runManagedCompactionBody(state, cell, options, {
      standalone: false,
      turn: record.turn,
      runId: record.lease.identity.runId,
      memoryCommit: record.lease.snapshot.head,
      knowledgeVersion: record.lease.snapshot.knowledge.version,
      record,
      redactText: text => record.lease.redactResult(text),
    })
  } finally { record.calls.delete(done.promise); done.resolve() }
}

async function* runManagedCompactionBody(state, cell, options, scope) {
  let input, output, assembler, sawFinish = false
  const log = await state.runtime.ctx.sessionQuery.readSession(state.agent.id)
  const start = log.events.findLast(event => event.type === 'compaction/start' && event.data.turn === scope.turn)
  if (!start || log.events.some(event => event.type === 'compaction/end' && event.data.compactionId === start.data.compactionId)) throw new Error('Native compaction is not active in this turn')
  input = { schemaVersion: 1, mode: 'rejected', policyHash: contextHash(summaryPolicy), botId: state.botId, sessionId: state.agent.id,
    turn: scope.turn, ...(scope.standalone ? { maintenance: true } : {}), runId: scope.runId, memoryCommit: scope.memoryCommit,
    knowledgeVersion: scope.knowledgeVersion, compactionId: start.data.compactionId, nativeStartSeq: start.seq }
  try {
    const surface = await state.runtime.ctx.sessionQuery.readSurface(state.agent.id)
    const region = nativeRegion(state.agent, surface, options)
    const prior = scope.standalone ? [] : await verifyManagedCompactions(state, scope.record, { open: true })
    const trusted = new Map([...state.compactionCatalog, ...prior.map(proof => [proof.compactionId, proof])])
    const data = summarySources(log.events, region.sourceSpan, trusted, input.knowledgeVersion)
    const sourceText = JSON.stringify(data.sources), clean = await scope.redactText(sourceText)
    if (Buffer.byteLength(clean, 'utf8') > state.runtime.compactMaxBytes) throw new Error('Compaction sources exceed the configured byte budget')
    input = { ...input, mode: 'accepted', throughSeq: log.events.at(-1).seq, ...region, sourceRefs: data.refs, reusedSummaries: data.reused,
      redactions: redactionSpans(sourceText, clean), options: { provider: options.provider, model: options.model,
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) } }
    const request = summaryRequest(input, clean)
    input.requestHash = contextHash(request)
    appendPluginRecord(state.agent.session, compactInputType, input)
    assembler = new BlockAssembler()
    cell.compactionRequests ??= new WeakSet()
    const inner = Object.freeze({ ...request, messages: freezeContext(request.messages), signal: options.signal })
    cell.compactionRequests.add(inner)
    for await (const chunk of state.runtime.ctx.llm.stream(inner)) { assembler.push(chunk); if (chunk.type === 'finish') sawFinish = true }
    const blocks = assembler.blocks()
    output = { schemaVersion: 1, mode: 'failed', compactionId: input.compactionId, rawOutputHash: contextHash(blocks),
      ...(assembler.usage ? { usage: assembler.usage } : {}) }
    if (!sawFinish || assembler.finish.kind !== 'stop' || blocks.some(block => !['text', 'reasoning'].includes(block.type))) throw new Error('Compaction model did not complete a text-only summary')
    const raw = JSON.parse(blocks.filter(block => block.type === 'text').map(block => block.text).join(''))
    if (!raw || Object.keys(raw).some(key => key !== 'items')) throw new Error('Invalid structured compaction response')
    const validated = validateSummaryItems(raw.items, data.sources)
    const items = scope.standalone
      ? await Promise.all(validated.map(async item => ({ ...item, text: await scope.redactText(item.text) })))
      : await scope.record.lease.redactResult(validated)
    const rendered = renderSummary(input, items, log.events)
    output = { ...output, mode: 'completed', items, rendered }
    appendPluginRecord(state.agent.session, compactOutputType, output)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: rendered } }
    if (assembler.usage) yield { type: 'usage', usage: assembler.usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } catch (error) {
    if (input.mode === 'rejected') appendPluginRecord(state.agent.session, compactInputType, input)
    else if (output?.mode !== 'completed') appendPluginRecord(state.agent.session, compactOutputType, output ?? {
      schemaVersion: 1, mode: 'failed', compactionId: input.compactionId, rawOutputHash: contextHash(assembler?.blocks() ?? []),
      ...(assembler?.usage ? { usage: assembler.usage } : {}) })
    if (options.signal.aborted) throw options.signal.reason
    throw new Error(await scope.redactText(error.message ?? String(error)))
  }
}

async function withBotDataLock(runtime, workspace, signal, operation) {
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
    if (first.done || first.value !== 'ready') throw new Error('Bot data lock is busy; settle active writers before manual compact')
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
 * Run audited manual compaction for a managed main Session under BotCoordinator
 * barrier, Bot data lock, and durable maintenance journal.
 */
export async function runManualCompaction(runtime, agent, cell, options = {}) {
  const state = runtime.states.get(agent)
  if (!state || state.worker || runtime.closed || !runtime.ready || state.closing || state.initializing) {
    throw new Error('Manual compaction requires an active managed main Session')
  }
  const bot = runtime.ctx.mbot.bot({ botId: state.botId })
  if (!bot) throw new Error('Manual compaction requires a registered Bot')
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const compactor = agent.ctx.get('compaction')
  if (!compactor) throw new Error('No native compaction backend is available for this Session')
  const barrier = await runtime.coordinator.acquireBarrier(bot.botId, 'compact', { signal })
  try {
    return await withBotDataLock(runtime, bot.workspacePath, signal, async () => {
      const turnJournal = await readJournal(bot.workspacePath)
      if (turnJournal) throw new Error('Managed turn journal is pending; run /mbot recover before manual compact')
      const existing = await readMaintenanceJournal(bot.workspacePath)
      if (existing && existing.record.kind !== 'compact') {
        throw new Error(`Bot has an unfinished ${existing.record.kind} maintenance journal; recover it first`)
      }
      if (existing && await isMaintenanceOwnerLive(existing.record)) {
        throw new Error('Another manual compaction owner is still active')
      }
      const memoryCommit = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        '-C', bot.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      const knowledge = readKnowledge(bot.workspacePath, memoryCommit, bot.defaultRole)
      const maintenanceId = existing?.record.maintenanceId ?? `compact-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
      const beforeLog = await runtime.ctx.sessionQuery.readSession(agent.id)
      const baselineSeq = existing?.record.baselineSeq ?? (beforeLog.events.at(-1)?.seq ?? -1)
      const beforeStartIds = new Set(beforeLog.events.filter(event => event.type === 'compaction/start').map(event => event.data.compactionId))
      await writeMaintenanceJournal(bot.workspacePath, {
        kind: 'compact',
        phase: 'running',
        maintenanceId,
        botId: bot.botId,
        sessionId: agent.id,
        memoryCommit,
        knowledgeVersion: knowledge.version,
        baselineSeq,
      })
      cell.activeMaintenanceCompaction = {
        maintenanceId,
        workspace: bot.workspacePath,
        memoryCommit,
        knowledgeVersion: knowledge.version,
      }
      let result = null
      try {
        result = await compactor.compactNow(agent, signal, options.sourceCommandId)
      } finally {
        cell.activeMaintenanceCompaction = undefined
      }
      await runtime.ctx.sessions.flush(agent.session)
      const afterLog = await runtime.ctx.sessionQuery.readSession(agent.id)
      const slice = afterLog.events.filter(event => event.seq > baselineSeq)
      const meta = { run_id: maintenanceId, base_head: memoryCommit, runtime: { bot_id: bot.botId, session_id: agent.id, turn: null } }
      const proofs = sealCompactionAudit(meta, slice, { standalone: true }) ?? []
      const trusted = new Map(state.compactionCatalog)
      for (const proof of proofs) {
        verifyCompactionSources(proof, afterLog.events, trusted)
        trusted.set(proof.compactionId, proof)
        state.compactionCatalog.set(proof.compactionId, proof)
      }
      await writeMaintenanceJournal(bot.workspacePath, {
        kind: 'compact',
        phase: 'flushed',
        maintenanceId,
        botId: bot.botId,
        sessionId: agent.id,
        memoryCommit,
        knowledgeVersion: knowledge.version,
        baselineSeq,
        compactionId: result?.compactionId ?? null,
      })
      void beforeStartIds
      await restoreContext(state)
      await clearMaintenanceJournal(bot.workspacePath)
      return {
        kind: 'compacted',
        maintenanceId,
        compacted: result !== null,
        memoryCommit,
        knowledgeVersion: knowledge.version,
        ...(result ? { compactionId: result.compactionId, shadowedCount: result.shadowedSeqs.length, shadowedTokenCount: result.shadowedTokenCount, summarySeq: result.summarySeq } : {}),
        proofs,
      }
    })
  } finally {
    barrier.release()
  }
}

/**
 * Cold-recover an interrupted standalone compaction maintenance journal:
 * verifies native start/summary/replacement/end brackets, closes an unmatched
 * compaction/start if crashed mid-flight, re-verifies any completed summary
 * against original native sources, flushes, and clears the journal.
 */
export async function recoverMaintenanceCompaction(runtime, bot, options = {}) {
  const existing = await readMaintenanceJournal(bot.workspacePath)
  if (!existing || existing.record.kind !== 'compact') return null
  const record = existing.record
  if (await isMaintenanceOwnerLive(record)) throw new Error('Manual compaction owner is still alive; wait for it to finish')
  let agent = runtime.ctx.agents.get(record.sessionId)
  if (!agent) {
    const controller = runtime.ctx.get('sessionController')
    if (!controller) throw new Error('Compaction maintenance recovery requires native Session Controller')
    const resolved = await controller.resolveAgent(record.sessionId)
    if ('error' in resolved) throw resolved.error
    agent = resolved.agent
  }
  const state = runtime.states.get(agent)
  if (!state) throw new Error('Compaction maintenance recovery requires a managed Session')
  const barrier = await runtime.coordinator.acquireBarrier(bot.botId, 'compact-recover', options)
  try {
    return await withBotDataLock(runtime, bot.workspacePath, options.signal, async () => {
      await runtime.ctx.sessions.flush(agent.session)
      const log = await runtime.ctx.sessionQuery.readSession(agent.id)
      const slice = log.events.filter(event => event.seq > record.baselineSeq)
      const starts = slice.filter(event => event.type === 'compaction/start' && event.data.turn === null)
      for (const start of starts) {
        const hasEnd = slice.some(event => event.type === 'compaction/end' && event.data.compactionId === start.data.compactionId)
        if (!hasEnd) {
          const hasSummary = slice.some(event => event.type === 'compaction/summary' && event.data.compactionId === start.data.compactionId)
          const hasReplacement = hasSummary && slice.some(event => event.type === 'user/message'
            && event.data.source?.kind === 'compact-checkpoint' && event.data.source.compactionId === start.data.compactionId)
          if (hasSummary && !hasReplacement) {
            throw new Error('Interrupted manual compaction has summary without native replacement; review manually')
          }
          agent.session.append('compaction/end', {
            compactionId: start.data.compactionId,
            turn: null,
            ...(hasReplacement ? {} : { error: { name: 'Error', message: 'Manual compaction interrupted before completion; recovered' } }),
          })
        }
      }
      await runtime.ctx.sessions.flush(agent.session)
      const settledLog = await runtime.ctx.sessionQuery.readSession(agent.id)
      const settledSlice = settledLog.events.filter(event => event.seq > record.baselineSeq)
      const meta = { run_id: record.maintenanceId, base_head: record.memoryCommit, runtime: { bot_id: bot.botId, session_id: agent.id, turn: null } }
      const proofs = sealCompactionAudit(meta, settledSlice, { standalone: true }) ?? []
      const trusted = new Map(state.compactionCatalog)
      for (const proof of proofs) {
        verifyCompactionSources(proof, settledLog.events, trusted)
        trusted.set(proof.compactionId, proof)
        state.compactionCatalog.set(proof.compactionId, proof)
      }
      await restoreContext(state)
      await clearMaintenanceJournal(bot.workspacePath)
      return { kind: 'recovered', needed: true, maintenanceRecovered: true, maintenanceId: record.maintenanceId, proofs }
    })
  } finally {
    barrier.release()
  }
}
