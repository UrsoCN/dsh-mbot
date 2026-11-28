import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { validateDomainMessage } from './domain-message.js'

export function nativeReply(header, events, finish) {
  const end = events.findLast(event => event.type === 'turn/end' && event.data.turn === header.turn)
  const assistant = events.findLast(event => event.type === 'assistant/message' && event.data.turn === header.turn && event.seq < end?.seq)
  const text = assistant?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
  if (!Number.isSafeInteger(end?.seq) || end.seq < 0 || !isDeepStrictEqual(end.data.reason, finish.reason)
    || text !== finish.text || (assistant && (!Number.isSafeInteger(assistant.seq) || assistant.data.message.source.kind !== 'model'))
    ) throw new Error('Native reply does not match the recorded turn completion')
  const targets = new Map()
  const accepted = new Map(header.messages.map(message => [message.id, message]))
  for (const event of events) if (header.conversation && event.type === 'agent/inbox/spliced' && event.seq < end.seq) {
    for (const message of event.data.inserted) {
      const prior = accepted.get(message.id)
      if (header.conversation && prior && !isDeepStrictEqual(prior, message)) throw new Error('Accepted domain input changed during execution')
      accepted.set(message.id, message)
    }
  }
  for (const message of [...header.messages, ...events.filter(event => event.type === 'user/message' && event.seq < end.seq).map(event => event.data)]) {
    const source = message.source
    if (!source?.mbot) continue
    if (header.conversation) {
      const original = accepted.get(message.id) ?? message
      validateDomainMessage(original, header.conversation)
      if (!isDeepStrictEqual(original.source, source) || typeof message.id !== 'string') throw new Error('Domain reply target changed during execution')
    } else if (source.kind !== 'user') continue
    else if (source.mbot.schemaVersion !== 1 || source.mbot.botId !== header.botId || source.mbot.visibility !== 'owner-private'
      || typeof source.rpcId !== 'string' || typeof message.id !== 'string') throw new Error('Invalid native reply target')
    const target = { rpcId: source.rpcId, messageId: message.id, ...source.mbot }
    if (targets.has(source.rpcId) && !isDeepStrictEqual(targets.get(source.rpcId), target)) throw new Error('Native reply target changed during execution')
    targets.set(source.rpcId, target)
  }
  return { schemaVersion: 1, assistantEventSeq: assistant?.seq ?? null, endEventSeq: end.seq,
    nativeTextHash: createHash('sha256').update(text).digest('hex'), text, targets: [...targets.values()] }
}
