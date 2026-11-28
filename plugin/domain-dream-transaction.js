// Runs only inside bin/mbot-maintenance, which owns flock descriptors 8 and 9.
import { mkdir, readFile, lstat, realpath, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { contextHash } from './context-hash.js'
import { resolveStateRoot, atomicWriteSync, syncDir } from './turn-state.js'
import { currentBootId, processStart } from './recovery.js'
import { maintenanceLocation, readMaintenanceJournal, writeMaintenanceJournal, clearMaintenanceJournal, isMaintenanceOwnerLive } from './maintenance-journal.js'
import { captureDomainDream } from './domain-dream-source.js'
import { domainDreamRequest, validateDomainDreamPlan } from './domain-dream-plan.js'
import { restoreDreamCheckpoint, dreamNativeProof, dreamReportPath, dreamCheckpointPath, dreamKnowledge } from './domain-dream-audit.js'
import { baseline, verifyBaseline, applyWrites, rollbackWrites, maintenanceHead, maintenanceMarker, markerMatches, ensureMaintenanceParents } from './maintenance-files.js'

async function privateJson(path, max = 32 * 1024 * 1024) {
  const info = await lstat(path)
  if (!info.isFile() || info.nlink !== 1 || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > max) throw new Error('Unsafe domain maintenance evidence')
  return JSON.parse(await readFile(path, 'utf8'))
}
function git(ws, args, options = {}) {
  return execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-C', ws, ...args], { encoding: 'utf8',
    // Git mutations may outlive a killed helper. Inherit both flock handles so
    // another Host/CLI cannot recover while such a child is still executing.
    stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 8, 9],
    maxBuffer: 32 * 1024 * 1024, ...options }).trim()
}

function deriveResult(state, plan, raw, log) {
  for (const write of plan.writes) {
    const file = state.original.files[write.path]
    if (file?.kind !== 'file' || file.hash !== write.beforeHash) throw new Error('Dreaming worktree bytes differ from their source Git blob')
  }
  const native = dreamNativeProof(state.capture, state.request, plan, log, state.maintenanceId, state.marker.workspace)
  const report = { schemaVersion: 1, maintenanceId: state.maintenanceId, scope: state.scope, baseHead: state.original.head,
    previous: state.previous, capture: state.capture, model: state.model, requestHash: contextHash(state.request), raw, plan, native,
    knowledge: dreamKnowledge(state.capture, plan) }
  const checkpoint = { schemaVersion: 1, scope: state.scope, maintenanceId: state.maintenanceId,
    reportHash: contextHash(report), cursor: state.capture.nextCursor }
  const writes = [...plan.writes.map(write => ({ path: write.path, text: write.text, mode: state.original.files[write.path].mode })),
    { path: dreamReportPath(state.scope, state.maintenanceId), text: JSON.stringify(report) + '\n', mode: 0o600 },
    { path: dreamCheckpointPath(state.scope), text: JSON.stringify(checkpoint) + '\n', mode: 0o600 }]
    .map((write, i) => ({ ...write, tempPath: `${dirname(write.path)}/.${state.maintenanceId}-${i}.tmp` }))
  for (const write of writes) if (state.original.files[write.tempPath]) throw new Error('Maintenance temporary path already exists')
  if (state.original.files[dreamReportPath(state.scope, state.maintenanceId)]) throw new Error('Maintenance report already exists')
  return { plan, report, checkpoint, writes }
}

export class DomainDreamTransaction {
  constructor(workspace, limits) { this.workspace = workspace; this.limits = limits }

  async save(phase, additions = {}) {
    const state = { ...this.state, ...additions, phase }, hash = contextHash(state)
    const path = join(this.directory, `${hash}.json`)
    await atomicWriteSync(path, JSON.stringify(state) + '\n')
    await writeMaintenanceJournal(this.workspace, { schemaVersion: 2, kind: 'domain-dream', phase,
      maintenanceId: state.maintenanceId, botId: state.scope.botId, sessionId: state.scope.sessionId,
      directory: this.directory, stateHash: hash, host: state.host })
    this.state = state
  }

  async begin({ scope, role, log, model, host, maintenanceId: id }) {
    if (!/^dream-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id ?? '')) throw new Error('Invalid maintenance identity')
    if (await readMaintenanceJournal(this.workspace)) throw new Error('Existing maintenance requires recovery')
    if (host.pid !== process.ppid || host.start !== await processStart(host.pid) || host.bootId !== await currentBootId()) throw new Error('Maintenance Host birth identity changed')
    const loc = await maintenanceLocation(this.workspace)
    if (await realpath(resolveStateRoot()) !== resolveStateRoot()) throw new Error('Maintenance state root cannot traverse a symlink')
    ensureMaintenanceParents(this.workspace, scope)
    const original = baseline(this.workspace)
    const previous = await restoreDreamCheckpoint(this.workspace, scope, role, log, original.head)
    const capture = await captureDomainDream(this.workspace, { scope, role, log, head: original.head, after: previous?.cursor ?? null, limits: this.limits })
    if (!capture.input.sources.length) return { kind: 'empty', more: false, cursor: previous?.cursor ?? null }
    const request = domainDreamRequest(capture, model)
    this.directory = join(loc.bucket, id)
    await mkdir(this.directory, { mode: 0o700 }); await syncDir(loc.bucket)
    const marker = { schemaVersion: 1, kind: 'domain-dream', maintenanceId: id, workspace: this.workspace, scope, directory: this.directory }
    this.state = { schemaVersion: 1, maintenanceId: id, scope, role, host, original, previous, capture, request, model, marker }
    await this.save('prepared')
    await atomicWriteSync(join(this.workspace, maintenanceMarker), JSON.stringify(marker) + '\n')
    markerMatches(this.workspace, marker); verifyBaseline(this.workspace, original)
    return { kind: 'prepared', maintenanceId: id, capture, request }
  }

  async start() {
    if (this.state.phase !== 'prepared') throw new Error('Domain Dreaming request already started')
    markerMatches(this.workspace, this.state.marker); verifyBaseline(this.workspace, this.state.original)
    await this.save('running')
    return { kind: 'running' }
  }

  async plan({ raw, log }) {
    const state = this.state
    if (state.phase !== 'running') throw new Error('Domain Dreaming is not waiting for its model result')
    markerMatches(this.workspace, state.marker); verifyBaseline(this.workspace, state.original)
    const plan = await validateDomainDreamPlan(this.workspace, state.capture, raw)
    await this.save('planned', deriveResult(state, plan, raw, log))
    return { kind: 'planned', planHash: plan.planHash }
  }

  async commit() {
    let state = this.state
    if (!['planned', 'applying', 'committing'].includes(state.phase)) throw new Error('Domain Dreaming has no durable model result to commit')
    markerMatches(this.workspace, state.marker)
    verifyBaseline(this.workspace, state.original, state.phase === 'planned' ? [] : state.writes, state.phase !== 'planned')
    await this.save('applying')
    applyWrites(this.workspace, state.writes)
    verifyBaseline(this.workspace, state.original, state.writes)
    const index = join(this.directory, 'index'), env = { ...process.env, GIT_INDEX_FILE: index }
    await rm(index, { force: true })
    git(this.workspace, ['read-tree', state.original.head], { env })
    for (const write of state.writes) {
      const blob = git(this.workspace, ['hash-object', '-w', '--stdin'], { input: write.text })
      git(this.workspace, ['update-index', '--add', '--cacheinfo', write.mode & 0o111 ? '100755' : '100644', blob, write.path], { env })
    }
    const tree = git(this.workspace, ['write-tree'], { env })
    const message = `dream(${state.scope.conversationId}): ${state.maintenanceId}`
    const commit = git(this.workspace, ['commit-tree', tree, '-p', state.original.head], { env, input: message + '\n' })
    await this.save('committing', { commit, tree })
    state = this.state
    verifyBaseline(this.workspace, state.original, state.writes)
    git(this.workspace, ['update-ref', state.original.ref, commit, state.original.head])
    // Do not reset arbitrary staging. Baseline verification proved this exact index.
    git(this.workspace, ['read-tree', commit])
    await this.save('committed')
    verifyBaseline(this.workspace, state.original, state.writes, false, commit)
    return { kind: 'committed', maintenanceId: state.maintenanceId, commit, checkpoint: state.checkpoint, more: state.capture.more }
  }

  async finish() {
    const state = this.state
    if (!['committed', 'aborted'].includes(state.phase)) throw new Error('Maintenance is not ready for settlement')
    markerMatches(this.workspace, state.marker)
    verifyBaseline(this.workspace, state.original, state.phase === 'committed' ? state.writes : [], false,
      state.phase === 'committed' ? state.commit : state.original.head)
    await this.save('settled', { settledFrom: state.phase })
    await rm(join(this.workspace, maintenanceMarker)); await syncDir(join(this.workspace, '.mbot/runs'))
    await clearMaintenanceJournal(this.workspace)
    return { kind: 'settled' }
  }

  async abort() {
    const state = this.state
    if (['committed', 'settled'].includes(state.phase) || state.commit && maintenanceHead(this.workspace) === state.commit) throw new Error('Committed Dreaming must settle; it cannot roll back')
    markerMatches(this.workspace, state.marker)
    await this.save('aborting')
    if (state.writes) rollbackWrites(this.workspace, state.original, state.writes)
    else verifyBaseline(this.workspace, state.original)
    await this.save('aborted')
    return { kind: 'aborted', maintenanceId: state.maintenanceId }
  }

  async recover({ scope, role, log, captured = false, host }) {
    if (host.pid !== process.ppid || host.start !== await processStart(host.pid) || host.bootId !== await currentBootId()) throw new Error('Recovery Host birth identity changed')
    const journal = await readMaintenanceJournal(this.workspace), record = journal?.record
    if (!record || record.schemaVersion !== 2 || record.kind !== 'domain-dream') throw new Error('No supported domain maintenance journal')
    if (await isMaintenanceOwnerLive(record)) throw new Error('Original maintenance writer is still alive')
    if (await isMaintenanceOwnerLive({ ownerPid: record.host?.pid, ownerStart: record.host?.start, bootId: record.host?.bootId })
      && !(captured && record.host.pid === host.pid && record.host.start === host.start && record.host.bootId === host.bootId)) throw new Error('Original maintenance Host has no drained ownership proof')
    const loc = await maintenanceLocation(this.workspace)
    if (await realpath(resolveStateRoot()) !== resolveStateRoot()) throw new Error('Maintenance state root cannot traverse a symlink')
    if (!/^dream-[0-9a-f-]{36}$/u.test(record.maintenanceId) || !/^[a-f0-9]{64}$/u.test(record.stateHash)
      || record.directory !== join(loc.bucket, record.maintenanceId)) throw new Error('Invalid maintenance snapshot identity')
    for (const path of [loc.root, loc.base, loc.bucket, record.directory]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('Unsafe maintenance snapshot directory')
    }
    this.directory = record.directory
    const state = await privateJson(join(this.directory, `${record.stateHash}.json`))
    if (state.schemaVersion !== 1 || contextHash(state) !== record.stateHash || state.maintenanceId !== record.maintenanceId || state.phase !== record.phase
      || record.botId !== scope.botId || record.sessionId !== scope.sessionId || state.original?.head !== state.capture?.head
      || !isDeepStrictEqual(state.scope, scope) || state.role !== role || !isDeepStrictEqual(state.host, record.host)) throw new Error('Maintenance snapshot contradicts its journal or registration')
    const expectedMarker = { schemaVersion: 1, kind: 'domain-dream', maintenanceId: state.maintenanceId, workspace: this.workspace, scope, directory: this.directory }
    if (!isDeepStrictEqual(state.marker, expectedMarker)
      || ['planned', 'applying', 'committing', 'committed'].includes(state.phase) && !state.plan
      || ['prepared', 'running'].includes(state.phase) && (state.plan || state.writes || state.commit)
      || ['committing', 'committed'].includes(state.phase) && (!/^[a-f0-9]{40,64}$/u.test(state.commit ?? '') || !/^[a-f0-9]{40,64}$/u.test(state.tree ?? ''))
      || state.phase === 'settled' && !['committed', 'aborted'].includes(state.settledFrom)) throw new Error('Invalid maintenance phase evidence')
    this.state = state
    try { markerMatches(this.workspace, state.marker) }
    catch (error) {
      if (error.code !== 'ENOENT' || !['prepared', 'settled'].includes(state.phase)) throw error
      const committed = state.phase === 'settled' && state.settledFrom === 'committed'
      verifyBaseline(this.workspace, state.original, committed ? state.writes : [], false, committed ? state.commit : state.original.head)
      await atomicWriteSync(join(this.workspace, maintenanceMarker), JSON.stringify(state.marker) + '\n')
    }
    const previous = await restoreDreamCheckpoint(this.workspace, scope, role, log, state.original.head)
    const capture = await captureDomainDream(this.workspace, { scope, role, log: { ...log, events: log.events.slice(0, state.capture.cut.throughSeq + 1) },
      head: state.original.head, after: previous?.cursor ?? null, limits: state.capture.limits })
    if (!isDeepStrictEqual(capture, state.capture) || !isDeepStrictEqual(previous, state.previous)
      || !isDeepStrictEqual(domainDreamRequest(capture, state.model), state.request)) throw new Error('Maintenance source proof changed')
    if (state.plan) {
      const plan = await validateDomainDreamPlan(this.workspace, capture, state.report.raw)
      const derived = deriveResult(state, plan, state.report.raw, log)
      for (const key of ['plan', 'report', 'checkpoint', 'writes']) {
        if (!isDeepStrictEqual(derived[key], state[key])) throw new Error('Maintenance result or derived write set changed')
      }
    }
    if (state.commit && maintenanceHead(this.workspace) === state.commit) {
      verifyBaseline(this.workspace, state.original, state.writes, false, state.commit)
      const checkpoint = await restoreDreamCheckpoint(this.workspace, scope, role, log, state.commit)
      if (!isDeepStrictEqual(checkpoint, state.checkpoint)) throw new Error('Committed maintenance checkpoint changed')
      git(this.workspace, ['read-tree', state.commit])
      await this.save('committed')
      return { kind: 'committed', maintenanceId: state.maintenanceId, commit: state.commit, checkpoint, more: capture.more }
    }
    if (state.phase === 'committed' || state.phase === 'settled' && state.settledFrom === 'committed') throw new Error('Committed maintenance HEAD changed')
    if (state.phase === 'settled') {
      verifyBaseline(this.workspace, state.original)
      await this.save('aborted')
      return { kind: 'aborted', maintenanceId: state.maintenanceId }
    }
    if (state.plan && !['aborting', 'aborted'].includes(state.phase)) return this.commit()
    await this.abort()
    return { kind: 'aborted', maintenanceId: state.maintenanceId }
  }
}
