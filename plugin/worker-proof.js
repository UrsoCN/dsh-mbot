import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
export const workerAssignmentType = 'plugin:mbot/worker-assignment'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** rc.5 native input accounting and final assistant output, without SDK imports. */
export function workerCompletion(events) {
  let turn, accountedEnd, output, stepped = false, claimed = false, droppedUnrun = false
  const partial = []
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data.turn; stepped = claimed = false }
    if (event.type === 'step/start') stepped = true
    if (event.type === 'agent/inbox/spliced' && event.data.removedCount !== undefined) {
      if (event.data.outcome === 'canceled') droppedUnrun ||= event.data.inserted.length === 0
      else if (turn !== undefined) claimed = true
    }
    if (event.type === 'assistant/message' && event.data.message?.content?.length) output = event.data.message.content
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      for (const record of event.data.stream ?? []) {
        if (record.type === 'text-chunks') partial.push(record.texts.join(''))
        else if (record.type === 'chunk' && record.chunk.type === 'text-delta') partial.push(record.chunk.text)
      }
    }
    if (event.type === 'turn/end') {
      if (stepped || claimed && event.data.reason.kind !== 'completed') { accountedEnd = event; droppedUnrun = false }
      turn = undefined
    }
  }
  const reason = accountedEnd?.data.reason.kind
  return { output: output ?? (partial.length ? [{ type: 'text', text: partial.join('') }] : []),
    stopReason: ({ 'max-tokens': 'max-tokens', aborted: 'aborted', interrupted: 'aborted', error: 'error', blocked: 'refusal' })[reason]
      ?? (reason === undefined || reason === 'completed' ? droppedUnrun ? 'aborted' : 'completed' : 'error') }
}

/** Native child events stay in their own sequence domain, never the root log. */
export function workerProof(actor, snapshot, events, input, ownership) {
  if (!input || input.quiescent !== true || !['completed', 'aborted', 'error', 'max-tokens', 'refusal'].includes(input.result?.stopReason)) throw new Error('Worker completion lacks its native quiescence contract')
  if (input.startupFailed && events.length === 0) {
    if (!['error', 'aborted'].includes(input.result.stopReason)) throw new Error('Invalid failed Worker startup')
    return { schemaVersion: 1, kind: 'native-worker', started: false, eventCount: 0, eventsHash: hash(events),
      stopReason: input.result.stopReason, executionFault: input.result.stopReason === 'error', outputHash: hash([]), usage: { scope: 'worker', total_tokens: 0 } }
  }
  const session = input.session
  if (!session || session.id !== actor.sessionId || session.parentSession !== input.parentSessionId || session.cwd !== snapshot.workspace
    || session.origin !== 'subagent' || session.delegationDepth !== 1 || session.isSeeded === true || input.inheritedEventCount !== 0) throw new Error('Worker native Session identity or inheritance changed')
  const assignment = events.find(event => event.type === workerAssignmentType && event.ignorable === true)?.data
  if (!assignment || assignment.schemaVersion !== 1 || assignment.actorId !== actor.actorId || assignment.runId !== input.runId
    || assignment.role !== actor.role || assignment.taskId !== actor.taskId || assignment.parentSessionId !== input.parentSessionId
    || assignment.memoryCommit !== snapshot.head || assignment.snapshotHash !== actor.snapshotHash) throw new Error('Worker assignment does not match its immutable snapshot')
  // Keep the standalone bridge free of Host SDK imports: DSH resolves peers
  // through its loader, whereas these scripts run in a plain Node process.
  // Fold the rc.5 native input accounting and final-output event contracts.
  let turn, lastEnd, initial = false, accepted = false, bootCall, booted = false
  const calls = new Map(), requests = new Map(), results = new Set(), ids = new Set(), turns = []
  for (const [seq, event] of events.entries()) {
    if (event.seq !== seq || typeof event.type !== 'string' || !event.data) throw new Error('Worker native events are incomplete')
    if (event.type === 'turn/start') { if (turn !== undefined) throw new Error('Worker turns overlap'); turn = event.data.turn; turns.push(turn) }
    if (event.data.turn !== undefined && event.data.turn !== turn && event.type !== 'turn/start') throw new Error('Worker event has an inconsistent turn')
    if (event.type === 'user/message' && event.data.source?.kind === 'user') {
      if (event.data.id !== input.initialMessageId || initial) throw new Error('Worker received unbound user input')
      initial = true
    }
    if (event.type === 'agent/inbox/spliced' && event.data.inserted?.some(message => message.id === input.initialMessageId && message.source.kind === 'user')) accepted = true
    if (event.type === 'user/message' && event.data.source?.kind === 'agent-message'
      && event.data.source.senderSessionId !== input.parentSessionId) throw new Error('Worker input came from outside its creator')
    if (event.type === 'assistant/message') {
      for (const call of event.data.message.content.filter(block => block.type === 'tool-call')) {
        if (requests.has(call.id) || results.has(call.id)) throw new Error('Worker repeats an unanswered tool request')
        requests.set(call.id, call)
      }
    }
    if (event.type === 'tool/call') {
      const data = event.data
      if (typeof data.callId !== 'string' || ids.has(data.callId) || !ownership.workerTools.includes(data.name)) throw new Error('Worker tool dispatch escaped its captured contract')
      ids.add(data.callId); calls.set(data.callId, data)
      if (!bootCall) {
        let args
        try { args = JSON.parse(data.arguments) } catch { /* Native invalid-JSON failure remains auditable. */ }
        if (data.name === 'botctl' && args?.action === 'boot' && args.bot === actor.role && args.task_id === actor.taskId) bootCall = data.callId
      }
    }
    if (event.type === 'tool/result') {
      const id = event.data.message.toolCallId
      if (results.has(id)) throw new Error('Worker repeats a tool result')
      const dispatched = calls.delete(id)
      if (!dispatched && !(requests.has(id) && event.data.message.isError === true && event.data.error?.code === 'TOOL_NOT_STARTED')) throw new Error('Worker tool result has no matching dispatch')
      requests.delete(id); results.add(id)
      if (id === bootCall && event.data.message.isError !== true) booted = true
    }
    if (event.type === 'turn/end') {
      if (calls.size || requests.size || turn === undefined) throw new Error('Worker ended before tools settled')
      lastEnd = event; turn = undefined
    }
  }
  const { output, stopReason } = workerCompletion(events)
  if (turn !== undefined || calls.size || !isDeepStrictEqual(output, input.result.output ?? [])) throw new Error('Worker output or tool lifetime does not match native completion')
  if (!input.startupFailed && (!accepted || input.result.stopReason === 'completed' && (!lastEnd || !initial))) throw new Error('Worker did not consume or cancel its admitted task')
  if (!input.startupFailed) {
    if (input.result.stopReason !== stopReason) throw new Error('Worker stop reason contradicts its native input accounting')
  }
  const outcome = execFileSync('jq', ['-L', join(root, 'lib'), '-r', 'include "turn-outcome"; . as $events | mbot_execution_fault($events)'],
    { input: JSON.stringify(events), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim() === 'true'
  const usage = { scope: 'worker', input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
  for (const event of events.filter(event => event.type === 'assistant/message' && event.data.usage)) {
    for (const [field, key] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['total_tokens', 'totalTokens'],
      ['cache_read_tokens', 'cacheReadTokens'], ['cache_write_tokens', 'cacheWriteTokens']]) usage[field] += event.data.usage[key] ?? 0
  }
  return { schemaVersion: 1, kind: 'native-worker', started: !input.startupFailed, eventCount: events.length, eventsHash: hash(events),
    turns, stopReason: input.result.stopReason, executionFault: outcome || ['error', 'max-tokens', 'refusal'].includes(input.result.stopReason)
      || input.result.stopReason === 'completed' && !booted, outputHash: hash(output), usage }
}
