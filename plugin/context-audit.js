// Pure Node/Git proof shared by standalone helpers; no Harness peer imports.
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { contextSnapshotType, contextHash, contentHash, knowledgeFiles, validateContextSnapshot } from './context-state.js'

export function contextGit(workspace, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', workspace, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
}

export function readKnowledge(workspace, commit, role) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new Error('Invalid knowledge Git commit')
  const documents = knowledgeFiles(role).map(path => ({ path,
    blob: contextGit(workspace, 'rev-parse', `${commit}:${path}`).toString('utf8').trim(),
    contentHash: contentHash(contextGit(workspace, 'show', `${commit}:${path}`)),
  }))
  return { schemaVersion: 1, role, documents, version: contextHash({ role, documents }) }
}

/** Seal only a captured native snapshot; older turns retain their old format. */
export function sealContextAudit(meta, events, workspace) {
  const snapshots = events.filter(event => event.type === contextSnapshotType)
  if (!snapshots.length) return undefined
  if (snapshots.length !== 1 || snapshots[0].ignorable !== true) throw new Error('Conflicting context snapshots in one turn')
  const event = snapshots[0], snapshot = validateContextSnapshot(event.data, event.seq)
  const start = events.find(item => item.type === 'turn/start' && item.data.turn === meta.runtime.turn)
  const end = events.findLast(item => item.type === 'turn/end' && item.data.turn === meta.runtime.turn)
  if (!start || !end || event.seq <= start.seq || event.seq >= end.seq
    || snapshot.botId !== meta.runtime.bot_id || snapshot.sessionId !== meta.runtime.session_id || snapshot.turn !== meta.runtime.turn
    || snapshot.runId !== meta.run_id || snapshot.memoryCommit !== meta.base_head || snapshot.role !== meta.bot
    || !isDeepStrictEqual(snapshot.knowledge, readKnowledge(workspace, meta.base_head, meta.bot))) throw new Error('Context snapshot contradicts its Git audit')
  return { schemaVersion: 1, snapshotSeq: event.seq, snapshotHash: contextHash(snapshot), snapshot }
}
