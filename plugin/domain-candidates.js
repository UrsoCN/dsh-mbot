// Domain candidates are untrusted suggestions, never live memory. Their bytes
// and native tool provenance are sealed by the parent turn's Git audit.
import { isDeepStrictEqual } from 'node:util'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { contentHash } from './context-hash.js'
import { contextGit } from './context-git.js'
import { validateDomainScope } from './domain-contract.js'
import { applyRedactions, redactionSpans } from './reply-proof.js'
import { atomicWriteSync, syncDir } from './turn-state.js'

export const candidateLimits = Object.freeze({ textBytes: 16384, fileBytes: 262144, count: 64 })

export function candidatePath(scope, runId) {
  validateDomainScope(scope)
  if (!/^\d{8}T\d{6}Z-turn-[a-f0-9]{16}$/u.test(runId)) throw new Error('Invalid candidate turn identity')
  return `memory/conversations/${scope.conversationId}/candidates/${runId}.jsonl`
}

export function candidateText(text) {
  if (typeof text !== 'string' || !text.trim() || text.includes('\0') || Buffer.byteLength(text) > candidateLimits.textBytes) {
    throw new Error('Candidate text must contain 1–16384 UTF-8 bytes')
  }
  return text
}

export function parseCandidates(bytes) {
  if (!bytes) return []
  if (bytes.length > candidateLimits.fileBytes) throw new Error('Domain candidate byte budget exceeded')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (!text.endsWith('\n')) throw new Error('Incomplete domain candidate record')
  const rows = text.slice(0, -1).split('\n').map(line => JSON.parse(line))
  if (!rows.length || rows.length > candidateLimits.count || rows.map(row => JSON.stringify(row) + '\n').join('') !== text) {
    throw new Error('Invalid domain candidate serialization or count')
  }
  return rows
}

/** No symlinks, special files, ignored replacements or arbitrary caller paths. */
export async function readCandidateFile(workspace, relative) {
  if (typeof relative !== 'string' || !/^memory\/conversations\/conversation-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/candidates\/\d{8}T\d{6}Z-turn-[a-f0-9]{16}\.jsonl$/u.test(relative)) throw new Error('Unsafe domain candidate path')
  let path = workspace
  const parts = relative.split('/')
  for (const [index, part] of parts.entries()) {
    path = join(path, part)
    let info
    try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || (info.mode & 0o111) !== 0 || info.size > candidateLimits.fileBytes)) {
      throw new Error('Unsafe domain candidate path')
    }
  }
  return readFile(path)
}

export async function appendCandidate(workspace, journal, snapshot, callId, raw, clean) {
  if (journal.schemaVersion !== 5 || snapshot.candidateVersion !== 1) throw new Error('This domain contract cannot write candidates')
  candidateText(raw); candidateText(clean)
  if (typeof callId !== 'string' || !/^[^\x00-\x1f\x7f]{1,256}$/u.test(callId)) throw new Error('Invalid candidate tool call identity')
  const path = candidatePath(journal.conversation, journal.runId)
  if (contextGit(workspace, '--no-replace-objects', '--literal-pathspecs', 'ls-tree', '-z', journal.baseHead, '--', path).length) {
    throw new Error('Domain candidate path already belongs to an earlier commit')
  }
  const bytes = await readCandidateFile(workspace, path), rows = parseCandidates(bytes)
  const row = { schemaVersion: 1, scope: journal.conversation, runId: journal.runId, role: journal.role,
    knowledgeVersion: snapshot.knowledge.version, callId, nativeTextHash: contentHash(raw), text: clean, redactions: redactionSpans(raw, clean) }
  const previous = rows.find(item => item.callId === callId)
  if (previous && !isDeepStrictEqual(previous, row)) throw new Error('Candidate call was retried with different content')
  if (!previous) rows.push(row)
  const output = Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''))
  parseCandidates(output)
  let parent = workspace
  for (const part of path.split('/').slice(0, -1)) {
    const child = join(parent, part)
    try { await mkdir(child); await syncDir(parent) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const info = await lstat(child)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe domain candidate directory')
    parent = child
  }
  await atomicWriteSync(join(workspace, path), output)
  return { schemaVersion: 1, path, callId, textHash: contentHash(clean) }
}

export function sealDomainCandidates(meta, events, bytes) {
  const scope = validateDomainScope(meta.runtime.conversation), path = candidatePath(scope, meta.run_id)
  const rows = parseCandidates(bytes), ids = new Set()
  // A guard rejection removes the whole candidate file. Its failed audit must
  // retain the rejected path; it cannot turn a successful tool receipt into an
  // apparently successful empty candidate batch.
  const rejected = bytes === null && meta.success === false && meta.violations?.some(item => item.path === path
    && ['forbidden_change_or_nonappend', 'forbidden_new_file', 'candidate_receipt_mismatch'].includes(item.reason))
  if (!rejected) for (const call of events.filter(event => event.type === 'tool/call' && event.data.name === 'botctl')) {
    let args
    try { args = JSON.parse(call.data.arguments) } catch { continue }
    if (args?.action !== 'remember') continue
    const results = events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
    if (results.length > 1) throw new Error('Candidate tool has multiple native results')
    const result = results[0]
    if (!result || result.data.message.isError) continue // Cancellation can retain a dispatched, unacknowledged candidate.
    const row = rows.find(item => item?.callId === call.data.callId)
    const receipt = JSON.parse(result.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    if (!row || result.seq <= call.seq || result.data.turn !== meta.runtime.turn || result.data.step !== call.data.step
      || !isDeepStrictEqual(receipt, { schemaVersion: 1, path, callId: row.callId, textHash: contentHash(row.text) })) throw new Error('Candidate file contradicts its successful native receipt')
  }
  for (const row of rows) {
    const fields = ['schemaVersion', 'scope', 'runId', 'role', 'knowledgeVersion', 'callId', 'nativeTextHash', 'text', 'redactions']
    if (!row || Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))
      || row.schemaVersion !== 1 || !isDeepStrictEqual(row.scope, scope) || row.runId !== meta.run_id || row.role !== meta.bot
      || row.knowledgeVersion !== meta.runtime.context?.snapshot.knowledge.version || ids.has(row.callId)) throw new Error('Candidate identity changed')
    ids.add(row.callId); candidateText(row.text)
    const calls = events.filter(event => event.type === 'tool/call' && event.data.callId === row.callId)
    const requests = events.filter(event => event.type === 'assistant/message').flatMap(event => (event.data.message?.content ?? [])
      .filter(block => block.type === 'tool-call' && block.id === row.callId).map(block => ({ event, block })))
    if (calls.length !== 1 || requests.length !== 1 || calls[0].data.name !== 'botctl' || requests[0].block.name !== 'botctl'
      || calls[0].data.turn !== meta.runtime.turn || requests[0].event.data.turn !== meta.runtime.turn
      || calls[0].data.step !== requests[0].event.data.step || calls[0].seq <= requests[0].event.seq
      || calls[0].data.arguments !== requests[0].block.arguments) throw new Error('Candidate has no unique native tool dispatch')
    const args = JSON.parse(calls[0].data.arguments)
    if (Object.keys(args).sort().join() !== 'action,text' || args.action !== 'remember'
      || contentHash(candidateText(args.text)) !== row.nativeTextHash || applyRedactions(args.text, row.redactions) !== row.text) {
      throw new Error('Candidate text contradicts its native tool request')
    }
  }
  return { schemaVersion: 1, path, contentHash: bytes ? contentHash(bytes) : null, bytes: bytes?.length ?? 0, count: rows.length, callIds: [...ids] }
}

/** Independent read proof uses the original audit commit, never current files. */
export function verifyCandidateAudit(workspace, commit, meta, events) {
  const version = meta.runtime.journal_schema_version
  if (version !== 5) {
    if (meta.runtime.candidates !== undefined) throw new Error('Candidate audit cannot be downgraded')
    return
  }
  const path = candidatePath(meta.runtime.conversation, meta.run_id)
  const git = (...args) => contextGit(workspace, '--no-replace-objects', '--literal-pathspecs', ...args)
  if (git('ls-tree', '-z', meta.base_head, '--', path).length) throw new Error('Candidate audit overwrote an earlier candidate file')
  const entry = git('ls-tree', '-lz', commit, '--', path).toString('utf8')
  if (entry && !/^100644 blob [a-f0-9]{40,64}\s+\d+\t[^\0]+\0$/u.test(entry)) throw new Error('Candidate audit requires a regular Git blob')
  const size = entry ? Number(/ blob [a-f0-9]+\s+(\d+)\t/u.exec(entry)[1]) : 0
  if (size > candidateLimits.fileBytes) throw new Error('Candidate audit byte budget exceeded')
  const bytes = entry ? git('cat-file', 'blob', `${commit}:${path}`) : null
  if (!isDeepStrictEqual(meta.runtime.candidates, sealDomainCandidates(meta, events, bytes))) throw new Error('Candidate audit contradicts native/Git evidence')
}
