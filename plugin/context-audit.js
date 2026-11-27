// Pure Node/Git proof shared by standalone helpers; no Harness peer imports.
import { execFileSync, spawn } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { contextSnapshotType, contextHash, contentHash, knowledgeFiles, validateContextSnapshot } from './context-state.js'

export function contextGit(workspace, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', workspace, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
}

/**
 * Batch-load Git objects via a single `git cat-file --batch` subprocess.
 * Avoids spawning thousands of per-commit `git show`/`git rev-parse` processes
 * while preserving exact raw Git object hashes and bytes.
 */
export function createGitBatchReader(workspace) {
  const blobCache = new Map()
  const knowledgeCache = new Map()
  let child = null
  let buffer = Buffer.alloc(0)
  let waiters = []
  let closed = false

  const start = () => {
    if (child) return
    child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', workspace, 'cat-file', '--batch'],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      drain()
    })
    const failAll = err => {
      closed = true
      for (const w of waiters) w.reject(err)
      waiters = []
    }
    child.on('error', failAll)
    child.on('exit', () => {
      if (waiters.length) failAll(new Error('git cat-file exited unexpectedly'))
    })
  }

  const drain = () => {
    while (waiters.length) {
      const nl = buffer.indexOf(10)
      if (nl === -1) return
      const header = buffer.subarray(0, nl).toString('utf8')
      if (header.endsWith(' missing')) {
        buffer = buffer.subarray(nl + 1)
        waiters.shift().reject(new Error(`Git object missing: ${header}`))
        continue
      }
      const parts = header.split(' ')
      const size = Number(parts[2])
      const need = nl + 1 + size + 1
      if (buffer.length < need) return
      const body = buffer.subarray(nl + 1, nl + 1 + size)
      buffer = buffer.subarray(need)
      waiters.shift().resolve({ oid: parts[0], type: parts[1], size, body: Buffer.from(body) })
    }
  }

  const readObject = spec => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('git cat-file reader is closed')); return }
    start()
    waiters.push({ resolve, reject })
    child.stdin.write(`${spec}\n`)
  })

  const readBlob = async spec => {
    const obj = await readObject(spec)
    if (obj.type !== 'blob') throw new Error(`Expected blob for ${spec}, got ${obj.type}`)
    return obj
  }

  const readKnowledgeAsync = async (commit, role) => {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new Error('Invalid knowledge Git commit')
    const cacheKey = `${commit}:${role}`
    if (knowledgeCache.has(cacheKey)) return knowledgeCache.get(cacheKey)
    const files = knowledgeFiles(role)
    const objs = await Promise.all(files.map(path => readBlob(`${commit}:${path}`)))
    const documents = files.map((path, index) => {
      const { oid, body } = objs[index]
      let hash = blobCache.get(oid)
      if (!hash) {
        hash = contentHash(body)
        blobCache.set(oid, hash)
      }
      return { path, blob: oid, contentHash: hash }
    })
    const result = { schemaVersion: 1, role, documents, version: contextHash({ role, documents }) }
    knowledgeCache.set(cacheKey, result)
    return result
  }

  const close = () => {
    if (child && !closed) {
      closed = true
      child.stdin.end()
      child.kill('SIGTERM')
    }
  }

  return { readObject, readBlob, readKnowledge: readKnowledgeAsync, close }
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
export function sealContextAudit(meta, events, workspace, knownKnowledge) {
  const snapshots = events.filter(event => event.type === contextSnapshotType)
  if (!snapshots.length) return undefined
  if (snapshots.length !== 1 || snapshots[0].ignorable !== true) throw new Error('Conflicting context snapshots in one turn')
  const event = snapshots[0], snapshot = validateContextSnapshot(event.data, event.seq)
  const start = events.find(item => item.type === 'turn/start' && item.data.turn === meta.runtime.turn)
  const end = events.findLast(item => item.type === 'turn/end' && item.data.turn === meta.runtime.turn)
  const knowledge = knownKnowledge ?? readKnowledge(workspace, meta.base_head, meta.bot)
  if (!start || !end || event.seq <= start.seq || event.seq >= end.seq
    || snapshot.botId !== meta.runtime.bot_id || snapshot.sessionId !== meta.runtime.session_id || snapshot.turn !== meta.runtime.turn
    || snapshot.runId !== meta.run_id || snapshot.memoryCommit !== meta.base_head || snapshot.role !== meta.bot
    || snapshot.compactionPolicyVersion !== meta.runtime.compaction_policy_version
    || !isDeepStrictEqual(snapshot.knowledge, knowledge)) throw new Error('Context snapshot contradicts its Git audit')
  return { schemaVersion: 1, snapshotSeq: event.seq, snapshotHash: contextHash(snapshot), snapshot }
}
