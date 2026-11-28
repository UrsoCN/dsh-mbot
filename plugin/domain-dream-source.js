// Host-only Dreaming input capture. No model, worktree mutation or cursor write.
import { isDeepStrictEqual } from 'node:util'
import { foldSurface } from '@deepseek-ai/dsh-session'
import { readContextEvidence } from './context-restore.js'
import { contextSnapshotType, verifyContextCut } from './context-state.js'
import { contextHash, contentHash, freezeContext } from './context-hash.js'
import { contextGit } from './context-git.js'
import { readDomainView } from './domain-view.js'
import { validateDomainScope } from './domain-contract.js'
import { parseCandidates } from './domain-candidates.js'
import { redactValue } from './redact.js'
import { validateDomainBudgets } from './domain-budget.js'

export const domainDreamLimits = Object.freeze({ inputBytes: 64000, outputBytes: 131072,
  memoryLines: 150, memoryChars: 3000, soulChars: 5000, wikiLines: 200 })

export function dreamLimits(options = {}) {
  const value = { ...domainDreamLimits, ...options }
  if (Object.keys(value).some(key => !Object.hasOwn(domainDreamLimits, key))
    || Object.values(value).some(n => !Number.isSafeInteger(n) || n < 1 || n > 999999999)
    || value.inputBytes > 1024 * 1024 || value.outputBytes > 1024 * 1024) throw new Error('Invalid domain Dreaming budgets')
  return value
}

/** Freeze the observed native prefix; a caller must hold maintenance admission. */
function nativeCut(log, workspace, scope) {
  if (log?.session?.id !== scope.sessionId || log.session.cwd !== workspace || log.inheritedEventCount !== 0
    || !Array.isArray(log.events) || log.events.some((event, index) => event.seq !== index)) {
    throw new Error('Domain Dreaming requires its complete ordered native Session')
  }
  let active = null
  const turns = new Set()
  for (const event of log.events) {
    if (event.type === 'turn/start') {
      if (active !== null || turns.has(event.data.turn)) throw new Error('Ambiguous native Dreaming turn')
      active = event.data.turn; turns.add(active)
    } else if (event.type === 'turn/end') {
      if (active !== event.data.turn) throw new Error('Unmatched native Dreaming turn end')
      active = null
    }
  }
  if (active !== null) throw new Error('Domain Dreaming cannot capture an active native turn')
  return { throughSeq: log.events.at(-1)?.seq ?? -1, eventsHash: contextHash(log.events) }
}

/**
 * Cursor is an exact position in verified successful candidates, not a receipt
 * of consumption. The maintenance transaction must authenticate its prior Git
 * checkpoint before passing `after`, and commit the returned next cursor only
 * together with accepted memory/report bytes. Never persist it during capture.
 */
export async function captureDomainDream(workspace, { scope: inputScope, role, log: nativeLog, head, after = null, limits = {} }) {
  const scope = structuredClone(validateDomainScope(inputScope)), log = structuredClone(nativeLog)
  const previousCursor = structuredClone(after), budget = dreamLimits(limits), cut = nativeCut(log, workspace, scope)
  const view = readDomainView(workspace, head, scope, role)
  contextGit(workspace, '--no-replace-objects', 'merge-base', '--is-ancestor', view.head, 'HEAD')
  validateDomainBudgets(view.documents, budget)
  const restored = await readContextEvidence(workspace, { botId: scope.botId, log, conversation: scope },
    { head: view.head, requireSettled: true, includeAudits: true })
  for (const reference of restored.snapshots) {
    const event = log.events[reference.seq]
    if (event?.type !== contextSnapshotType || contextHash(event.data) !== reference.hash) throw new Error('Dreaming context snapshot changed')
    verifyContextCut(event.data, log.events, foldSurface(log.events.slice(0, event.data.sourceCut.throughSeq + 1)).nodes)
  }
  // Unknown/uncommitted turns cannot disappear behind a later incremental cut.
  const audited = new Set(restored.audits.map(entry => entry.meta.runtime.turn))
  if (log.events.some(event => event.type === 'turn/start' && !audited.has(event.data.turn))) {
    throw new Error('Domain Dreaming has a native turn without a verified context audit')
  }
  const candidates = []
  for (const audit of restored.audits) {
    const meta = audit.meta
    if (meta.runtime.journal_schema_version !== 5 || meta.outcome !== 'completed' || meta.success !== true) continue
    if (meta.bot !== role) throw new Error('Domain Dreaming candidate role changed; migrate explicitly')
    if (!meta.runtime.candidates.count) continue
    // readContextEvidence already checked native dispatch, result, redactions,
    // original Git mode/content and the complete snapshot chain for this audit.
    const bytes = contextGit(workspace, '--no-replace-objects', 'cat-file', 'blob', `${audit.commit}:${meta.runtime.candidates.path}`)
    for (const [index, row] of parseCandidates(bytes).entries()) {
      const turn = restored.domainTurns.find(item => item.turn === meta.runtime.turn)
      const results = log.events.filter(event => event.seq >= turn.startSeq && event.seq <= turn.endSeq
        && event.type === 'tool/result' && event.data.message.toolCallId === row.callId)
      // A completed turn with a merely dispatched/unacknowledged candidate is
      // not eligible for promotion, even if its candidate bytes were retained.
      if (results.length !== 1 || results[0].data.message.isError) throw new Error('Completed Dreaming candidate lacks a successful native receipt')
      const origin = { commit: audit.commit, meta: audit.path, turn: meta.runtime.turn, runId: meta.run_id,
        index, callId: row.callId, knowledgeVersion: row.knowledgeVersion, sourceHash: contextHash(row) }
      const cursor = { schemaVersion: 1, scopeHash: contextHash(scope), ...origin }
      candidates.push({ cursor, source: { id: contextHash(cursor), kind: 'untrusted-candidate', origin, text: row.text } })
    }
  }
  const start = previousCursor === null ? 0 : candidates.findIndex(item => isDeepStrictEqual(item.cursor, previousCursor)) + 1
  if (previousCursor !== null && start === 0) throw new Error('Domain Dreaming cursor has no matching verified source')
  const texts = await redactValue(view.documents.map(item => item.text), workspace)
  const documents = view.documents.map((item, index) => ({ kind: item.kind, path: item.path,
    contentHash: item.contentHash, text: texts[index], textHash: contentHash(texts[index]),
    writable: ['memory', 'reference'].includes(item.kind) && item.path.startsWith(`memory/conversations/${scope.conversationId}/`)
      && texts[index] === item.text }))
  // A redacted document is read-only: applying a full-file rewrite would erase
  // secrets unseen by the model. Human cleanup is required before rewriting it.
  const input = { schemaVersion: 1, scope, role, knowledgeVersion: view.knowledge.version,
    budgets: { memoryLines: budget.memoryLines, memoryChars: budget.memoryChars, wikiLines: budget.wikiLines }, documents, sources: [] }
  const size = () => Buffer.byteLength(JSON.stringify(input))
  if (size() > budget.inputBytes) throw new Error('Domain Dreaming published view exceeds its input byte budget')
  const cleanSources = await redactValue(candidates.slice(start).map(item => item.source.text), workspace)
  let nextCursor = previousCursor, consumed = 0
  for (const [offset, candidate] of candidates.slice(start).entries()) {
    input.sources.push({ ...candidate.source, text: cleanSources[offset] })
    if (size() > budget.inputBytes) { input.sources.pop(); break }
    consumed++; nextCursor = candidate.cursor
  }
  const more = start + consumed < candidates.length
  if (!consumed && more) throw new Error('Next domain Dreaming candidate exceeds the remaining input byte budget')
  // Routing and path identities are not editable redaction text. Refuse unusual
  // identities containing registered credentials instead of leaking/changing them.
  if (!isDeepStrictEqual(await redactValue(input, workspace), input)) throw new Error('Domain Dreaming identity contains sensitive data')
  const data = { schemaVersion: 1, scope, role, head: view.head, knowledge: view.knowledge, cut,
    previousCursor, nextCursor, more, limits: budget, input }
  return freezeContext({ ...data, captureHash: contextHash(data) })
}

export function verifyDreamCapture(capture) {
  const { captureHash, ...data } = capture
  if (captureHash !== contextHash(data) || data.schemaVersion !== 1) throw new Error('Domain Dreaming captured input changed')
  validateDomainScope(data.scope)
  return data
}
