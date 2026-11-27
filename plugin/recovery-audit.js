import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { nativeReply } from './native-reply.js'
import { applyRedactions } from './reply-proof.js'
import { sealContextAudit } from './context-audit.js'
import { sealCompactionAudit, compactInputType, compactOutputType } from './compaction-data.js'
const root = fileURLToPath(new URL('../', import.meta.url))
const digest = text => createHash('sha256').update(text).digest('hex')

/** Git/turn proof independent of display cards, for recovery acknowledgement. */
export function verifyRecoveryAudit(workspace, header, events, result, actors) {
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', workspace, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result.head ?? '')
    || !new RegExp(`^transcripts/\\d{4}-\\d{2}-\\d{2}/${result.runId}\\.meta\\.json$`, 'u').test(result.meta ?? '')
    || !/^\d{8}T\d{6}Z-turn-[a-f0-9]{16}$/u.test(result.runId ?? '')) throw new Error('Invalid recovered Git audit identity')
  git('merge-base', '--is-ancestor', result.head, 'HEAD')
  const meta = JSON.parse(git('show', `${result.head}:${result.meta}`))
  const end = events.findLast(event => event.type === 'turn/end' && event.data.turn === header.turn)
  const assistant = events.findLast(event => event.type === 'assistant/message' && event.data.turn === header.turn && event.seq < end?.seq)
  const text = assistant?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
  if (!end || meta.runtime?.kind !== 'managed-turn' || meta.runtime.bot_id !== header.botId || meta.runtime.session_id !== header.sessionId
    || meta.runtime.turn !== header.turn || meta.run_id !== result.runId || meta.success !== result.success
    || meta.base_head !== git('show', '-s', '--format=%P', result.head).trim()
    || git('show', '-s', '--format=%B', result.head).replace(/\n$/u, '') !== `run(${meta.bot}): ${meta.run_id} ${meta.summary}\n`
    || meta.reason?.kind !== end.data.reason.kind || (meta.reason.kind === 'aborted' && meta.reason.reason?.kind !== end.data.reason.reason?.kind)) throw new Error('Recovered Git audit contradicts its native turn')
  if (Array.isArray(header.messages)) {
    const native = nativeReply(header, events, { reason: end.data.reason, text })
    const reply = meta.runtime.reply
    if (!reply || reply.schemaVersion !== native.schemaVersion || reply.endEventSeq !== native.endEventSeq || reply.assistantEventSeq !== native.assistantEventSeq
      || reply.nativeTextHash !== native.nativeTextHash || !isDeepStrictEqual(reply.targets, native.targets)
      || applyRedactions(text, reply.redactions) !== reply.text || reply.textHash !== digest(reply.text)) throw new Error('Recovered audit reply does not match native evidence')
  }
  const version = meta.runtime.journal_schema_version ?? 2
  if (meta.runtime.context && !isDeepStrictEqual(meta.runtime.context, sealContextAudit(meta, events, workspace))) throw new Error('Recovered context does not match its native/Git evidence')
  if ((meta.runtime.compaction_policy_version === 1 || events.some(event => [compactInputType, compactOutputType].includes(event.type)))
    && !isDeepStrictEqual(meta.runtime.compactions, sealCompactionAudit(meta, events))) throw new Error('Recovered compaction does not match native evidence')
  if (version !== 3 && meta.runtime.actors !== undefined) throw new Error('Foreground audit unexpectedly contains Worker ownership')
  if (version === 3 && !isDeepStrictEqual(meta.runtime.actors, actors)) throw new Error('Recovered Worker audit lacks matching child proof')
  const outcome = execFileSync('jq', ['-L', join(root, 'lib'), '-er', 'include "turn-outcome"; . as $x | $x.meta | mbot_outcome($x.version) as $outcome | if .runtime.execution_fault != (mbot_execution_fault($x.events) or any($x.meta.runtime.actors[]?; .native.executionFault==true)) then error("native execution fault mismatch") else $outcome end'],
    { input: JSON.stringify({ meta, events, version }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim()
  if (result.outcome !== outcome || result.failureCountEffect !== meta.failure_count_effect) throw new Error('Recovered outcome does not match its Git audit')
  return meta
}
