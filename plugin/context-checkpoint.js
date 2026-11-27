import { join } from 'node:path'
import { appendPluginRecord, foldSurface } from '@deepseek-ai/dsh-session'
import { packageRoot } from './index.js'
import { contextSnapshotType, contextHash, contextReferences, verifyContextCut, validateKnowledge } from './context-state.js'
import { verifyWorkerAudit } from './worker-recovery-proof.js'
class ContextObservationChanged extends Error {
  name = 'ContextObservationChanged'
  code = 'MBOT_CONTEXT_OBSERVATION_CHANGED'
}

export async function captureContext(state, record) {
  const { agent, botId, runtime } = state, snapshot = record.lease.snapshot
  validateKnowledge(snapshot.knowledge, snapshot.role)
  if (state.checkpoint && state.checkpoint.commit !== snapshot.head) await restoreContext(state)
  const prior = state.checkpoint
  const previous = prior ? { schemaVersion: 1, snapshotHash: prior.snapshotHash, knowledgeVersion: prior.snapshot.knowledge.version,
    contextEpoch: prior.snapshot.contextEpoch, commit: prior.commit } : null
  for (;;) {
    record.signal.throwIfAborted()
    const surface = await runtime.ctx.sessionQuery.readSurface(agent.id)
    const throughSeq = surface.capturedThroughSeq ?? -1
    if (throughSeq !== agent.session.seq - 1) continue
    if (surface.session.id !== agent.id || surface.session.cwd !== snapshot.workspace) throw new Error('Context capture Session identity changed')
    const data = { schemaVersion: 1, kind: 'turn-input', visibility: 'owner-private', botId, sessionId: agent.id, conversationId: agent.id,
      turn: record.turn, runId: record.lease.identity.runId, role: snapshot.role, memoryCommit: snapshot.head, knowledge: snapshot.knowledge,
      contextEpoch: previous === null ? 1 : previous.contextEpoch + (previous.knowledgeVersion === snapshot.knowledge.version ? 0 : 1),
      previous, sourceCut: { throughSeq, events: contextReferences(surface.events) },
      input: record.messages.map(message => ({ messageId: message.id, hash: contextHash(message) })) }
    const seq = appendPluginRecord(agent.session, contextSnapshotType, data)
    record.context = { schemaVersion: 1, snapshotSeq: seq, snapshotHash: contextHash(data), snapshot: data }
    return
  }
}

/** Readers and their native flushes must drain before a Runtime handoff. */
export function restoreContext(state, options = {}) {
  if (state.closing || state.runtime.closed) return Promise.reject(new Error('MBot context owner is unavailable'))
  const operation = state.contextOperations.then(() => restoreContextNow(state, options))
  state.contextOperations = operation.catch(() => {})
  return operation
}

/** Internal mutation only at initialization, admission or recovery boundaries. */
async function restoreContextNow(state, { update = true } = {}, attempt = 0) {
  const { runtime, agent, botId } = state
  if (state.closing || runtime.closed) throw new Error('MBot context owner is unavailable')
  const log = await runtime.ctx.sessionQuery.readSession(agent.id)
  const workspace = runtime.ctx.mbot.bot({ botId }).workspacePath
  if (log.session.id !== agent.id || log.session.cwd !== workspace) throw new Error('Context restore Session identity changed')
  const child = runtime.ctx.subprocess.spawn({ argv: [process.execPath, join(packageRoot, 'bin/context-checkpoint.mjs'), '--restore', workspace],
    cwd: packageRoot, graceMs: 5000, stdio: { stdin: { data: JSON.stringify({ botId, log }) },
      stdout: { maxBytes: 16 * 1024 * 1024 }, stderr: { maxBytes: 8000 } } })
  runtime.ctx.mbot.active.add(child)
  let retry = false
  try {
    const result = await child.done, output = child.collected.stdout.readFrom(0)
    if (result.exitCode === 2 && !output.lossy && JSON.parse(output.text).kind === 'context-observation-changed'
      && agent.session.seq - 1 > (log.events.at(-1)?.seq ?? -1)) {
      throw new ContextObservationChanged('Native/Git observations crossed a new context commit')
    }
    if (result.exitCode !== 0 || output.lossy) throw new Error('Context checkpoint does not match native/Git evidence; preserve it for recovery')
    const restored = JSON.parse(output.text), checkpoint = restored.checkpoint
    for (const reference of restored.snapshots) {
      const event = log.events.find(event => event.seq === reference.seq && event.type === contextSnapshotType)
      if (!event || contextHash(event.data) !== reference.hash) throw new Error('Restored context snapshot identity changed')
      const prefix = log.events.filter(item => item.seq <= event.data.sourceCut.throughSeq)
      verifyContextCut(event.data, log.events, foldSurface(prefix).nodes)
    }
    if (checkpoint) {
      if (checkpoint.actors) {
        const start = log.events.find(event => event.type === 'turn/start' && event.data.turn === checkpoint.turn)
        const end = log.events.find(event => event.type === 'turn/end' && event.data.turn === checkpoint.turn)
        const events = log.events.filter(event => event.seq >= start.seq && event.seq <= end.seq)
        const workers = await runtime.workerLogs(events)
        verifyWorkerAudit(checkpoint.actors, workers, { workspace, sessionId: agent.id,
          runId: checkpoint.snapshot.runId, memoryCommit: checkpoint.snapshot.memoryCommit })
      }
    }
    // A restored snapshot becomes effective only after native persistence confirms it.
    await runtime.ctx.sessions.flush(agent.session)
    if (state.closing || runtime.closed) throw new Error('MBot context owner is unavailable')
    const verified = checkpoint ? (({ actors, ...value }) => value)(checkpoint) : null
    if (update) state.checkpoint = verified
    return verified
  } catch (error) {
    if (error instanceof ContextObservationChanged) {
      if (attempt < 2) retry = true
      else throw error
    }
    else {
      if (!state.closing && !runtime.closed) state.error ??= error
      throw error
    }
  } finally {
    child.terminate(); await child.waitForExit(); runtime.ctx.mbot.active.delete(child)
  }
  if (retry) return restoreContextNow(state, { update }, attempt + 1)
}
