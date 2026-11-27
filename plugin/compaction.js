import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { BlockAssembler, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { compactInputType, compactOutputType, summaryPurpose, summaryPolicy, summarySources, summaryRequest,
  validateSummaryItems, renderSummary, sealCompactionAudit, verifyCompactionSources } from './compaction-data.js'
import { contextHash, freezeContext } from './context-state.js'
import { redactionSpans } from './reply-proof.js'

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
  const record = state.current
  if (!record || record.ended || !options.signal) throw new Error('Standalone compact requires the MBot maintenance lifecycle')
  await state.admit(options.signal)
  const done = Promise.withResolvers()
  record.calls.add(done.promise)
  let input, output, assembler, sawFinish = false
  try {
    const log = await state.runtime.ctx.sessionQuery.readSession(state.agent.id)
    const start = log.events.findLast(event => event.type === 'compaction/start' && event.data.turn === record.turn)
    if (!start || log.events.some(event => event.type === 'compaction/end' && event.data.compactionId === start.data.compactionId)) throw new Error('Native compaction is not active in this turn')
    input = { schemaVersion: 1, mode: 'rejected', policyHash: contextHash(summaryPolicy), botId: state.botId, sessionId: state.agent.id,
      turn: record.turn, runId: record.lease.identity.runId, memoryCommit: record.lease.snapshot.head, knowledgeVersion: record.lease.snapshot.knowledge.version,
      compactionId: start.data.compactionId, nativeStartSeq: start.seq }
    try {
      const surface = await state.runtime.ctx.sessionQuery.readSurface(state.agent.id)
      const region = nativeRegion(state.agent, surface, options)
      const prior = await verifyManagedCompactions(state, record, { open: true })
      const trusted = new Map([...state.compactionCatalog, ...prior.map(proof => [proof.compactionId, proof])])
      const data = summarySources(log.events, region.sourceSpan, trusted, input.knowledgeVersion)
      const sourceText = JSON.stringify(data.sources), clean = await record.lease.redactResult(sourceText)
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
      const items = await record.lease.redactResult(validateSummaryItems(raw.items, data.sources))
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
      throw new Error(await record.lease.redactResult(error.message ?? String(error)))
    }
  } finally { record.calls.delete(done.promise); done.resolve() }
}
