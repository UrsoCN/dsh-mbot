import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const operationalSources = new Set(['runtime-context', 'time-context', 'user-question-reply', 'agent-instructions',
  'tmux-context', 'repeat-tool-reminder', 'plan-mode', 'skill-catalog', 'skill-invocation', 'session-reference'])
export const operationalSource = message => operationalSources.has(message.source.kind)
const identifier = (value, name) => {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\0\r\n]/u.test(value)) throw new Error(`Invalid ${name}`)
  return value
}

export function requestIdentity(message) {
  const source = message.source
  return (source.kind === 'user' || source.kind === 'retry') ? source.rpcId ?? source.requestId : undefined
}

export function ownerBinding(options, botId) {
  if (!options || options.visibility !== 'owner-private') throw new Error('Only verified owner-private main conversations are supported')
  return Object.freeze({ schemaVersion: 1, botId, visibility: 'owner-private',
    adapterId: identifier(options.adapterId, 'adapterId'), ownerId: identifier(options.ownerId, 'ownerId'),
    conversationKey: identifier(options.conversationKey, 'conversationKey'), replyRoute: identifier(options.replyRoute, 'replyRoute') })
}

export function ownerMessage(binding, input) {
  if (!input || Object.keys(input).some(key => !['requestId', 'text', 'correlationId'].includes(key))) throw new Error('Invalid owner message fields')
  const requestId = identifier(input.requestId, 'requestId')
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0') || Buffer.byteLength(input.text) > 262144) throw new Error('Message text must contain 1–262144 bytes')
  const correlationId = input.correlationId === undefined ? undefined : identifier(input.correlationId, 'correlationId')
  // Identity is independent of payload and reply destination. Changing either
  // on retry is a conflict, rather than a second request.
  const rpcId = `mbot:${hash([binding.botId, binding.adapterId, binding.ownerId, binding.conversationKey, requestId])}`
  const envelope = { ...binding, requestId, ...(correlationId === undefined ? {} : { correlationId }) }
  const content = [{ type: 'text', text: input.text }]
  const fingerprint = hash([envelope, content])
  return createUserMessage({ source: { kind: 'user', rpcId, mbot: { ...envelope, fingerprint } }, content })
}

function fingerprint(message) {
  return hash([message.source, message.content])
}

/** A read projection of native events, never a queue or consumption authority. */
export class MessageIndex {
  constructor() {
    this.requests = new Map()
    this.pending = { 'next-turn': [], 'next-step': [] }
    this.offset = 0
    this.claimed = new Set()
    this.inheritedMessages = new Set()
  }

  apply(event, inheritedEventCount = 0) {
    if (event.seq < this.offset) return
    if (event.seq !== this.offset) throw new Error('MBot message index requires contiguous native events')
    this.offset++
    if (event.seq < inheritedEventCount) {
      for (const message of event.type === 'agent/inbox/spliced' ? event.data.inserted : event.type === 'user/message' ? [event.data] : []) this.inheritedMessages.add(message.id)
    }
    if (event.type === 'turn/start') { this.turn = event.data.turn; this.claimed = new Set() }
    if (event.type === 'agent/inbox/spliced') {
      const data = event.data
      const removed = this.pending[data.target].splice(data.start, data.removedCount ?? 0, ...data.inserted)
      const editable = new Set(removed.filter(message => !message.source.mbot && this.requests.get(requestIdentity(message))?.delivery === 'queued').map(message => message.id))
      for (const message of removed) {
        const record = this.requests.get(requestIdentity(message))
        if (!record) continue
        if (data.outcome === 'canceled') record.delivery = 'cancelled'
        else { record.delivery = 'claimed'; record.turn = this.turn; this.claimed.add(record) }
      }
      for (const message of data.inserted) {
        const previous = this.requests.get(requestIdentity(message))
        // Official Web queue edits retain the pending MessageId. Adapter
        // envelopes remain immutable, and a claimed request cannot be edited.
        if (data.outcome === 'canceled' && editable.has(message.id) && previous?.message.id === message.id
          && !previous.conflict && JSON.stringify(previous.message.source) === JSON.stringify(message.source)) {
          previous.message = message
          previous.fingerprint = fingerprint(message)
        }
        const record = this.remember(message)
        if (record) { record.delivery = 'queued'; delete record.reason; delete record.turn }
      }
    }
    if (event.type === 'user/message') {
      const record = this.remember(event.data, true)
      if (record) { record.delivery = 'claimed'; record.turn = this.turn; this.claimed.add(record) }
    }
    if (event.type === 'turn/end') {
      for (const record of this.claimed) {
        // Admission can return an unexecuted claim to the native Inbox.
        if (record.delivery !== 'claimed') continue
        record.delivery = 'ended'; record.reason = event.data.reason.kind
      }
      this.turn = undefined
      this.claimed = new Set()
    }
  }

  remember(message, projected = false) {
    if (this.inheritedMessages.has(message.id)) return
    const id = requestIdentity(message)
    if (id === undefined) return
    identifier(id, 'native request identity')
    const previous = this.requests.get(id)
    const digest = fingerprint(message)
    if (previous) {
      // Native Session-reference preparation can transform model-facing text
      // while preserving its MessageId/source. The accepted Inbox bytes stay
      // the retry authority, not this derived presentation.
      if (projected && previous.message.id === message.id && JSON.stringify(previous.message.source) === JSON.stringify(message.source)) return previous
      if (previous.fingerprint !== digest || previous.message.id !== message.id) previous.conflict = true
      return previous
    }
    const record = { rpcId: id, fingerprint: digest, message, delivery: 'claimed' }
    this.requests.set(id, record)
    return record
  }

  match(message) {
    const record = this.requests.get(requestIdentity(message))
    if (record && (record.conflict || record.fingerprint !== fingerprint(message))) throw new Error('Request identity was reused with changed content or duplicate native input')
    return record
  }
}

export function validateSource(message, botId) {
  const source = message.source
  if (['user', 'retry'].includes(source.kind)) {
    if (source.principal !== undefined) throw new Error('Non-owner input requires an isolated conversation')
    if (source.mbot !== undefined) {
      if (!source.mbot || source.mbot.schemaVersion !== 1 || Object.keys(source.mbot).some(key =>
        !['schemaVersion', 'botId', 'visibility', 'adapterId', 'ownerId', 'conversationKey', 'replyRoute', 'requestId', 'correlationId', 'fingerprint'].includes(key))) throw new Error('Invalid MBot envelope version or fields')
      const { fingerprint: digest, ...envelope } = source.mbot
      const binding = ownerBinding(envelope, botId)
      const reconstructed = ownerMessage(binding, { requestId: envelope.requestId, text: message.content.length === 1 && message.content[0].type === 'text' ? message.content[0].text : '',
        ...(envelope.correlationId === undefined ? {} : { correlationId: envelope.correlationId }) })
      if (source.kind !== 'user' || envelope.botId !== botId || digest !== reconstructed.source.mbot.fingerprint || source.rpcId !== reconstructed.source.rpcId) throw new Error('Invalid MBot owner envelope')
    }
    return
  }
  // Native operational producers retain their own source and authority. Jobs,
  // goals and peer relays need their own lifecycle/permission integration.
  if (operationalSource(message)) return
  throw new Error(`Message producer ${String(source.kind)} is not admitted to this managed conversation`)
}

export function deliveryReceipt(record, confirmation) {
  return structuredClone({ confirmation, rpcId: record.rpcId, messageId: record.message.id,
    ...(record.message.source.mbot ? { requestId: record.message.source.mbot.requestId, botId: record.message.source.mbot.botId,
      conversationKey: record.message.source.mbot.conversationKey, replyRoute: record.message.source.mbot.replyRoute } : {}),
    delivery: record.delivery, ...(record.turn === undefined ? {} : { turn: record.turn }), ...(record.reason === undefined ? {} : { reason: record.reason }) })
}
