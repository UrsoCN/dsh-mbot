// Persistent domain Dreaming evidence: native markers + exact Git changes.
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { contextHash, contentHash } from './context-hash.js'
import { contextGit } from './context-git.js'
import { captureDomainDream } from './domain-dream-source.js'
import { domainDreamRequest, validateDomainDreamPlan } from './domain-dream-plan.js'
import { readDomainView } from './domain-view.js'

export const dreamInputType = 'plugin:mbot/domain-dream-input'
export const dreamOutputType = 'plugin:mbot/domain-dream-output'
export const dreamResultType = 'plugin:mbot/domain-dream-result'
export const dreamCheckpointPath = scope => `memory/conversations/${scope.conversationId}/DREAMING.json`
export const dreamReportPath = (scope, id) => `memory/conversations/${scope.conversationId}/${id}.dream.json`
const git = (ws, ...args) => contextGit(ws, '--no-replace-objects', '--literal-pathspecs', ...args)

export function dreamUsage(usage) {
  if (usage == null) return null
  const result = {}
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
    if (usage[key] === undefined) continue
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new Error('Invalid domain Dreaming token usage')
    result[key] = usage[key]
  }
  return result
}

export function dreamKnowledge(capture, plan) {
  const { version, schemaVersion, ...identity } = capture.knowledge
  const documents = identity.documents.map(document => {
    const write = plan.writes.find(item => item.path === document.path)
    if (!write) return document
    const bytes = Buffer.from(write.text)
    const blob = createHash(document.blob.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    return { ...document, blob, contentHash: write.afterHash }
  })
  return { before: version, after: contextHash({ ...identity, documents }) }
}

export function dreamNativeProof(capture, request, plan, log, id, workspace) {
  if (log.session.id !== capture.scope.sessionId || log.session.cwd !== workspace
    || log.inheritedEventCount !== 0 || log.events.some((event, i) => event.seq !== i)
    || contextHash(log.events.slice(0, capture.cut.throughSeq + 1)) !== capture.cut.eventsHash) throw new Error('Dreaming native source cut changed')
  const inputs = log.events.filter(event => event.type === dreamInputType && event.data.maintenanceId === id)
  const outputs = log.events.filter(event => event.type === dreamOutputType && event.data.maintenanceId === id)
  const expectedInput = { schemaVersion: 1, maintenanceId: id, scope: capture.scope, head: capture.head,
    captureHash: capture.captureHash, requestHash: contextHash(request) }
  const expectedOutput = { schemaVersion: 1, maintenanceId: id, captureHash: capture.captureHash,
    requestHash: contextHash(request), planHash: plan.planHash, rawOutputHash: plan.rawOutputHash, usage: dreamUsage(outputs[0]?.data.usage) }
  if (inputs.length !== 1 || outputs.length !== 1 || !inputs[0].ignorable || !outputs[0].ignorable
    || inputs[0].seq <= capture.cut.throughSeq || outputs[0].seq <= inputs[0].seq
    || !isDeepStrictEqual(inputs[0].data, expectedInput) || !isDeepStrictEqual(outputs[0].data, expectedOutput)) throw new Error('Dreaming native request/result proof changed')
  return { input: { seq: inputs[0].seq, hash: contextHash(inputs[0]) }, output: { seq: outputs[0].seq, hash: contextHash(outputs[0]) }, usage: expectedOutput.usage }
}

export function gitDreamJson(workspace, head, path) {
  const entry = git(workspace, 'ls-tree', '-lz', head, '--', path).toString()
  if (!entry) return null
  const matched = /^100(?:644|755) blob [a-f0-9]{40,64}\s+(\d+)\t[^\0]+\0$/u.exec(entry)
  if (!matched || Number(matched[1]) > 16 * 1024 * 1024) throw new Error('Invalid Dreaming Git artifact')
  return JSON.parse(git(workspace, 'cat-file', 'blob', `${head}:${path}`).toString())
}

/** Authenticate the entire incremental chain; never accept a naked cursor. */
export async function restoreDreamCheckpoint(workspace, scope, role, log, head, visiting = new Set()) {
  if (visiting.size >= 1024) throw new Error('Dreaming audit chain exceeds its validation budget')
  const path = dreamCheckpointPath(scope), checkpoint = gitDreamJson(workspace, head, path)
  if (!checkpoint) {
    if (git(workspace, 'log', '--format=%H', '--diff-filter=A', head, '--', path).length) throw new Error('Dreaming checkpoint was removed; restore its audit before continuing')
    return null
  }
  if (checkpoint.schemaVersion !== 1 || !isDeepStrictEqual(checkpoint.scope, scope)
    || !/^dream-[0-9a-f-]{36}$/u.test(checkpoint.maintenanceId ?? '') || visiting.has(checkpoint.maintenanceId)) throw new Error('Invalid Dreaming checkpoint identity or cycle')
  visiting.add(checkpoint.maintenanceId)
  const reportPath = dreamReportPath(scope, checkpoint.maintenanceId)
  const additions = git(workspace, 'log', '--format=%H', '--diff-filter=A', '--no-renames', head, '--', reportPath).toString().trim().split('\n')
  if (additions.length !== 1 || !/^[a-f0-9]{40,64}$/u.test(additions[0])) throw new Error('Dreaming report has no unique Git origin')
  const commit = additions[0], report = gitDreamJson(workspace, commit, reportPath)
  if (!report || report.schemaVersion !== 1 || !Number.isSafeInteger(report.capture?.cut?.throughSeq)
    || report.capture.cut.throughSeq < 0 || !/^[a-f0-9]{40,64}$/u.test(report.baseHead ?? '')) throw new Error('Invalid Dreaming report format')
  if (git(workspace, 'log', '-1', '--format=%H', head, '--', path).toString().trim() !== commit
    || !isDeepStrictEqual(gitDreamJson(workspace, head, reportPath), report)) throw new Error('Dreaming artifacts changed after their audited commit')
  if (checkpoint.reportHash !== contextHash(report) || !isDeepStrictEqual(checkpoint, gitDreamJson(workspace, commit, path))
    || !isDeepStrictEqual(report.scope, scope) || report.maintenanceId !== checkpoint.maintenanceId
    || git(workspace, 'show', '-s', '--format=%P', commit).toString().trim() !== report.baseHead
    || git(workspace, 'show', '-s', '--format=%s', commit).toString().trim() !== `dream(${scope.conversationId}): ${checkpoint.maintenanceId}`) throw new Error('Dreaming checkpoint contradicts its Git report')
  const previous = await restoreDreamCheckpoint(workspace, scope, role, log, report.baseHead, visiting)
  if (!isDeepStrictEqual(report.previous, previous) || !isDeepStrictEqual(checkpoint.cursor, report.capture.nextCursor)) throw new Error('Dreaming incremental chain changed')
  const prefix = { ...log, events: log.events.slice(0, report.capture.cut.throughSeq + 1) }
  const capture = await captureDomainDream(workspace, { scope, role, log: prefix, head: report.baseHead,
    after: previous?.cursor ?? null, limits: report.capture.limits })
  if (!isDeepStrictEqual(capture, report.capture)) throw new Error('Dreaming input cannot be reconstructed from native/Git sources')
  const request = domainDreamRequest(capture, report.model)
  const plan = await validateDomainDreamPlan(workspace, capture, report.raw)
  if (!isDeepStrictEqual(report.knowledge, dreamKnowledge(capture, plan))
    || readDomainView(workspace, commit, scope, role).knowledge.version !== report.knowledge.after) throw new Error('Dreaming knowledge transition changed')
  if (!isDeepStrictEqual(plan, report.plan) || report.requestHash !== contextHash(request)
    || !isDeepStrictEqual(dreamNativeProof(capture, request, plan, log, report.maintenanceId, workspace), report.native)) throw new Error('Dreaming model result proof changed')
  const paths = git(workspace, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit).toString().split('\0').filter(Boolean).sort()
  if (!isDeepStrictEqual(paths, [path, reportPath, ...plan.writes.map(write => write.path)].sort())) throw new Error('Dreaming commit changed files outside its audited write set')
  for (const write of plan.writes) {
    const mode = head => git(workspace, 'ls-tree', '-z', head, '--', write.path).toString().slice(0, 6)
    if (!['100644', '100755'].includes(mode(report.baseHead)) || mode(commit) !== mode(report.baseHead)) throw new Error('Dreaming changed a memory file mode')
    if (contentHash(git(workspace, 'cat-file', 'blob', `${commit}:${write.path}`)) !== write.afterHash
      || contentHash(git(workspace, 'cat-file', 'blob', `${report.baseHead}:${write.path}`)) !== write.beforeHash) throw new Error('Dreaming committed memory differs from the approved plan')
  }
  for (const artifact of [path, reportPath]) {
    if (git(workspace, 'ls-tree', '-z', commit, '--', artifact).toString().slice(0, 6) !== '100644') throw new Error('Dreaming artifact has an invalid file mode')
  }
  return checkpoint
}
