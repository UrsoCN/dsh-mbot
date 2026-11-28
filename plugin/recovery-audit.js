import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { nativeReply } from './native-reply.js'
import { applyRedactions } from './reply-proof.js'
import { sealContextAudit } from './context-audit.js'
import { sealCompactionAudit, compactInputType, compactOutputType } from './compaction-data.js'
import { validateDomainScope } from './domain-contract.js'
import { verifyCandidateAudit } from './domain-candidates.js'
const root = fileURLToPath(new URL('../', import.meta.url))
const digest = text => createHash('sha256').update(text).digest('hex')

/** Pure-JS equivalent of lib/turn-outcome.jq for fast in-process verification. */
const cancellationCodes = new Set(['ABORTED', 'ABORTED_BEFORE_DISPATCH', 'APPROVAL_CANCELLED'])

export function computeExecutionFault(events) {
  for (const event of events) {
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const stream = event.data?.stream
      if (Array.isArray(stream)) {
        for (const item of stream) {
          const reason = item?.chunk?.type === 'finish' ? item.chunk.reason : null
          if (!reason) continue
          if (reason.kind === 'max-tokens') return true
          if (reason.kind === 'error' && !cancellationCodes.has(reason.failure?.code)) return true
        }
      }
    } else if (event.type === 'tool/result') {
      if (event.data?.message?.isError === true && !cancellationCodes.has(event.data?.error?.code)) return true
    }
  }
  return false
}

export function computeManagedOutcome(meta, events, version) {
  const actorFault = Array.isArray(meta.runtime?.actors) && meta.runtime.actors.some(actor => actor?.native?.executionFault === true)
  const expectedFault = computeExecutionFault(events) || actorFault
  if (typeof meta.success !== 'boolean') throw new Error('invalid success')
  if ([2, 3, 4, 5].includes(version) && meta.runtime?.outcome_schema_version !== 1) throw new Error('versioned journal requires versioned outcome')
  if ('outcome' in meta || 'failure_count_effect' in meta || meta.runtime?.outcome_schema_version != null) {
    if (meta.runtime?.outcome_schema_version !== 1 || typeof meta.runtime?.execution_fault !== 'boolean' || !Array.isArray(meta.violations)) {
      throw new Error('invalid outcome version')
    }
    if (meta.runtime.execution_fault !== expectedFault) throw new Error('native execution fault mismatch')
    if (meta.outcome === 'completed' && meta.success === true && meta.failure_count_effect === 'reset' && meta.violations.length === 0) return 'completed'
    if (meta.outcome === 'cancelled' && meta.success === false && meta.failure_count_effect === 'preserve'
      && [2, 3, 4, 5].includes(version) && meta.reason?.kind === 'aborted' && meta.reason?.reason?.kind === 'user'
      && meta.violations.length === 0 && meta.runtime.execution_fault === false) return 'cancelled'
    if (meta.outcome === 'failed' && meta.success === false && meta.failure_count_effect === 'increment') return 'failed'
    throw new Error('invalid outcome effect')
  }
  if (meta.runtime?.execution_fault !== expectedFault) throw new Error('native execution fault mismatch')
  return meta.success ? 'completed' : 'failed'
}

/** Git/turn proof independent of display cards, for recovery acknowledgement. */
export function verifyRecoveryAudit(workspace, header, events, result, actors, preloaded) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result.head ?? '')
    || !new RegExp(`^transcripts/\\d{4}-\\d{2}-\\d{2}/${result.runId}\\.meta\\.json$`, 'u').test(result.meta ?? '')
    || !/^\d{8}T\d{6}Z-turn-[a-f0-9]{16}$/u.test(result.runId ?? '')) throw new Error('Invalid recovered Git audit identity')
  let meta, parentHash, commitBody
  if (preloaded) {
    meta = preloaded.meta
    parentHash = preloaded.parentHash
    commitBody = preloaded.commitBody
  } else {
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', workspace, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
    git('merge-base', '--is-ancestor', result.head, 'HEAD')
    meta = JSON.parse(git('show', `${result.head}:${result.meta}`))
    parentHash = git('show', '-s', '--format=%P', result.head).trim()
    commitBody = git('show', '-s', '--format=%B', result.head)
  }
  const end = events.findLast(event => event.type === 'turn/end' && event.data.turn === header.turn)
  const assistant = events.findLast(event => event.type === 'assistant/message' && event.data.turn === header.turn && event.seq < end?.seq)
  const text = assistant?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
  if (!end || meta.runtime?.kind !== 'managed-turn' || meta.runtime.bot_id !== header.botId || meta.runtime.session_id !== header.sessionId
    || meta.runtime.turn !== header.turn || meta.run_id !== result.runId || meta.success !== result.success
    || meta.base_head !== parentHash
    || commitBody.replace(/\n$/u, '') !== `run(${meta.bot}): ${meta.run_id} ${meta.summary}\n`
    || meta.reason?.kind !== end.data.reason.kind || (meta.reason.kind === 'aborted' && meta.reason.reason?.kind !== end.data.reason.reason?.kind)) throw new Error('Recovered Git audit contradicts its native turn')
  if (Array.isArray(header.messages)) {
    const native = nativeReply(header, events, { reason: end.data.reason, text })
    const reply = meta.runtime.reply
    if (!reply || reply.schemaVersion !== native.schemaVersion || reply.endEventSeq !== native.endEventSeq || reply.assistantEventSeq !== native.assistantEventSeq
      || reply.nativeTextHash !== native.nativeTextHash || !isDeepStrictEqual(reply.targets, native.targets)
      || applyRedactions(text, reply.redactions) !== reply.text || reply.textHash !== digest(reply.text)) throw new Error('Recovered audit reply does not match native evidence')
  }
  const version = meta.runtime.journal_schema_version ?? 2
  if ([4, 5].includes(version) || meta.runtime.conversation || header.conversation) {
    validateDomainScope(meta.runtime.conversation)
    if (![4, 5].includes(version) || !isDeepStrictEqual(meta.runtime.conversation, header.conversation)) throw new Error('Recovered audit changed its domain ownership')
  }
  const sealedContext = preloaded?.sealedContext ?? ([4, 5].includes(version) || meta.runtime.context ? sealContextAudit(meta, events, workspace, preloaded?.knowledge) : undefined)
  if (([4, 5].includes(version) || meta.runtime.context) && !isDeepStrictEqual(meta.runtime.context, sealedContext)) throw new Error('Recovered context does not match its native/Git evidence')
  if ((meta.runtime.compaction_policy_version === 1 || events.some(event => [compactInputType, compactOutputType].includes(event.type)))
    && !isDeepStrictEqual(meta.runtime.compactions, sealCompactionAudit(meta, events))) throw new Error('Recovered compaction does not match native evidence')
  if (version !== 3 && meta.runtime.actors !== undefined) throw new Error('Foreground audit unexpectedly contains Worker ownership')
  verifyCandidateAudit(workspace, result.head, meta, events)
  if (version === 3 && !isDeepStrictEqual(meta.runtime.actors, actors)) throw new Error('Recovered Worker audit lacks matching child proof')
  const outcome = preloaded
    ? computeManagedOutcome(meta, events, version)
    : execFileSync('jq', ['-L', join(root, 'lib'), '-er', 'include "turn-outcome"; . as $x | $x.meta | mbot_outcome($x.version) as $outcome | if .runtime.execution_fault != (mbot_execution_fault($x.events) or any($x.meta.runtime.actors[]?; .native.executionFault==true)) then error("native execution fault mismatch") else $outcome end'],
      { input: JSON.stringify({ meta, events, version }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim()
  if (result.outcome !== outcome || result.failureCountEffect !== meta.failure_count_effect) throw new Error('Recovered outcome does not match its Git audit')
  return meta
}
