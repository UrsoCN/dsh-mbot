import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export function nativeReply(header, events, finish) {
  const end = events.findLast(event => event.type === 'turn/end' && event.data.turn === header.turn)
  const assistant = events.findLast(event => event.type === 'assistant/message' && event.data.turn === header.turn && event.seq < end?.seq)
  const text = assistant?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
  if (!Number.isSafeInteger(end?.seq) || end.seq < 0 || !isDeepStrictEqual(end.data.reason, finish.reason)
    || text !== finish.text || (assistant && (!Number.isSafeInteger(assistant.seq) || assistant.data.message.source.kind !== 'model'))
    ) throw new Error('Native reply does not match the recorded turn completion')
  const targets = new Map()
  for (const message of [...header.messages, ...events.filter(event => event.type === 'user/message' && event.seq < end.seq).map(event => event.data)]) {
    const source = message.source
    if (source?.kind !== 'user' || !source.mbot) continue
    if (header.conversation) throw new Error('Domain reply targets require domain message admission')
    if (source.mbot.schemaVersion !== 1 || source.mbot.botId !== header.botId || source.mbot.visibility !== 'owner-private'
      || typeof source.rpcId !== 'string' || typeof message.id !== 'string') throw new Error('Invalid native reply target')
    const target = { rpcId: source.rpcId, messageId: message.id, ...source.mbot }
    if (targets.has(source.rpcId) && !isDeepStrictEqual(targets.get(source.rpcId), target)) throw new Error('Native reply target changed during execution')
    targets.set(source.rpcId, target)
  }
  return { schemaVersion: 1, assistantEventSeq: assistant?.seq ?? null, endEventSeq: end.seq,
    nativeTextHash: createHash('sha256').update(text).digest('hex'), text, targets: [...targets.values()] }
}
