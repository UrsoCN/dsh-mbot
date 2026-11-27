import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const readonlyActions = new Set(['boot', 'status', 'lint', 'board_show', 'task_show'])
const fields = new Set(['action', 'bot', 'task_id', 'text', 'state', 'owner', 'reason', 'as'])

/** Only completed core read operations can replace a missing old writer contract. */
export function readonlyLegacy(journal, input) {
  if (journal.runtimeOwnership !== undefined || journal.writerScope !== 'agent-runtime' || input.finish.reason.kind !== 'completed') throw new Error('Readonly legacy migration requires a completed turn without a writer contract')
  const calls = new Map(), results = new Map()
  for (const event of input.events) {
    if (event.data?.turn !== undefined && event.data.turn !== journal.turn) throw new Error('Readonly migration has an inconsistent native turn boundary')
    if (event.type === 'tool/call') {
      const call = event.data
      let args
      try { args = JSON.parse(call.arguments) } catch { throw new Error('Legacy tool arguments cannot prove readonly execution') }
      if (call.name !== 'botctl' || !args || Array.isArray(args) || !readonlyActions.has(args.action)
        || Object.keys(args).some(key => !fields.has(key)) || typeof call.callId !== 'string' || calls.has(call.callId)) throw new Error('Legacy turn contains a writer or unknown tool; preserve its original recovery evidence')
      const header = input.events.findLast(row => row.type === 'request/header' && row.seq < event.seq)?.data.header
      const definitions = header?.tools?.filter(tool => tool.name === 'botctl') ?? []
      const core = definitions[0]?.parameters
      const expectedActions = ['boot', 'status', 'lint', 'board_show', 'board_add', 'board_set', 'task_show', 'task_result', 'remember'].sort()
      if (definitions.length !== 1 || core?.type !== 'object' || !core.required?.includes('action')
        || JSON.stringify([...(core.properties?.action?.enum ?? [])].sort()) !== JSON.stringify(expectedActions)
        || Object.keys(core.properties ?? {}).some(key => !fields.has(key))) throw new Error('Native request header does not identify the core botctl contract')
      calls.set(call.callId, { callId: call.callId, action: args.action, callSeq: event.seq })
    }
    if (event.type === 'tool/result') {
      const message = event.data.message
      if (message?.source?.kind !== 'tool' || typeof message.source.callId !== 'string' || message.isError
        || results.has(message.source.callId)) throw new Error('Legacy readonly tool result is missing, failed or ambiguous')
      results.set(message.source.callId, event.seq)
    }
  }
  if (calls.size !== results.size || [...calls].some(([id, call]) => !results.has(id) || results.get(id) <= call.callSeq)) throw new Error('Legacy readonly tools have not all completed')
  for (const event of input.events) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data.message.content) {
      if (block.type === 'tool-call' && (!calls.has(block.id) || block.name !== 'botctl')) throw new Error('Legacy assistant has an unaccounted tool dispatch')
    }
  }
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  return { schemaVersion: 1, mode: 'legacy-readonly', startEventSeq: input.events[0].seq, endEventSeq: input.events.at(-1).seq,
    nativeTextHash: createHash('sha256').update(input.finish.text).digest('hex'), eventsHash: createHash('sha256').update(JSON.stringify(canonical(input.events))).digest('hex'),
    tools: [...calls.values()].map(call => ({ callIdHash: createHash('sha256').update(call.callId).digest('hex'),
      action: call.action, callSeq: call.callSeq, resultSeq: results.get(call.callId) })) }
}

/** Inspect again under both bridge locks before fencing or writing anything. */
export function readonlyDataCut(journal) {
  if (!/^\d{8}T\d{6}Z-turn-[a-f0-9]{16}$/u.test(journal.runId ?? '')) throw new Error('Invalid readonly migration run identity')
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', journal.workspace, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  let ref = ''
  try { ref = git('symbolic-ref', '-q', 'HEAD').trim() } catch (error) { if (error.status !== 1) throw error }
  const head = git('rev-parse', 'HEAD').trim()
  const intentFile = join(journal.scratch, 'commit-intent.json')
  let intent
  if (existsSync(intentFile)) {
    if (!lstatSync(intentFile).isFile() || lstatSync(intentFile).isSymbolicLink()) throw new Error('Unsafe readonly migration commit intent')
    intent = JSON.parse(readFileSync(intentFile, 'utf8'))
    const expected = new RegExp(`^transcripts/\\d{4}-\\d{2}-\\d{2}/${journal.runId}\\.meta\\.json$`, 'u')
    if (intent.parent !== journal.baseHead || intent.ref !== journal.baseRef || !expected.test(intent.meta ?? '')
      || intent.transcript !== intent.meta.replace(/\.meta\.json$/u, '.md')) throw new Error('Readonly migration commit intent does not match its baseline')
  }
  if (ref !== journal.baseRef) throw new Error('Readonly migration Git branch changed')
  if (head !== journal.baseHead) {
    if (!intent || !['committing', 'committed'].includes(journal.phase) || git('status', '--porcelain').trim()
      || git('show', '-s', '--format=%P', 'HEAD').trim() !== journal.baseHead || git('rev-parse', 'HEAD^{tree}').trim() !== intent.tree
      || git('show', '-s', '--format=%B', 'HEAD').trim() !== intent.message) throw new Error('Readonly migration Git baseline changed')
  }
  const paths = new Set([...git('diff', '--name-only', '-z', journal.baseHead).split('\0'), ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0')].filter(Boolean))
  for (const path of paths) {
    const source = intent && (path === intent.meta ? 'meta.json' : path === intent.transcript ? 'transcript.md' : undefined)
    if (!source || !lstatSync(join(journal.workspace, path)).isFile() || lstatSync(join(journal.workspace, path)).isSymbolicLink()
      || !readFileSync(join(journal.workspace, path)).equals(readFileSync(join(journal.scratch, source)))) throw new Error('Readonly legacy migration requires an unchanged baseline; unrelated worktree edits remain untouched')
  }
}
