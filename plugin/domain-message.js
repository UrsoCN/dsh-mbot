// Pure envelope proof shared by Host admission and standalone audit helpers.
// Platform authentication and registry permission checks belong to the caller.
import { isDeepStrictEqual } from 'node:util'
import { contextHash } from './context-hash.js'
import { validateDomainScope } from './domain-contract.js'

const scopeKeys = ['botId', 'conversationId', 'conversationKey', 'sessionId', 'visibility', 'accessHash']
const bindingKeys = ['schemaVersion', ...scopeKeys, 'adapterId', 'senderId', 'replyRoute']
const identifier = (value, label) => {
  if (typeof value !== 'string' || !/^[^\x00-\x1f\x7f]{1,1024}$/u.test(value) || value.trim() !== value) throw new Error(`Invalid domain ${label}`)
  return value
}
const object = value => value && typeof value === 'object' && !Array.isArray(value)

export function domainMessageScope(binding) {
  return validateDomainScope(Object.fromEntries(scopeKeys.map(key => [key, binding?.[key]])))
}

export function domainMessageBinding(scope, options) {
  validateDomainScope(scope)
  if (!object(options) || Object.keys(options).sort().join() !== 'adapterId,replyRoute,senderId') throw new Error('Invalid domain binding fields')
  return Object.freeze({ schemaVersion: 2, ...scope, adapterId: identifier(options.adapterId, 'adapterId'),
    senderId: identifier(options.senderId, 'senderId'), replyRoute: identifier(options.replyRoute, 'replyRoute') })
}

/** Returns native source/content; the Host adds MessageId using the official SDK. */
export function domainEnvelope(binding, input) {
  if (!object(binding) || Object.keys(binding).length !== bindingKeys.length || bindingKeys.some(key => !Object.hasOwn(binding, key))
    || binding.schemaVersion !== 2) throw new Error('Invalid domain envelope binding')
  const normalized = domainMessageBinding(domainMessageScope(binding), { adapterId: binding.adapterId, senderId: binding.senderId, replyRoute: binding.replyRoute })
  if (!object(input) || Object.keys(input).some(key => !['requestId', 'text', 'correlationId'].includes(key))) throw new Error('Invalid domain message fields')
  const requestId = identifier(input.requestId, 'requestId')
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0') || Buffer.byteLength(input.text) > 262144) throw new Error('Domain text must contain 1–262144 bytes')
  const correlationId = input.correlationId === undefined ? undefined : identifier(input.correlationId, 'correlationId')
  // Payload, ACL version and reply route are conflicts on retry, not new requests.
  const rpcId = `mbot-domain:${contextHash([binding.botId, binding.conversationId, binding.adapterId, binding.senderId, requestId])}`
  const envelope = { ...normalized, requestId, ...(correlationId === undefined ? {} : { correlationId }) }
  const content = [{ type: 'text', text: input.text }]
  return { source: { kind: 'user', rpcId, mbot: { ...envelope, fingerprint: contextHash([envelope, content]) } }, content }
}

export function validateDomainMessage(message, scope) {
  validateDomainScope(scope)
  const source = message?.source, envelope = source?.mbot
  if (message?.role !== 'user' || typeof message.id !== 'string' || !message.id
    || !object(source) || Object.keys(source).sort().join() !== 'kind,mbot,rpcId' || !object(envelope)
    || Object.keys(envelope).some(key => ![...bindingKeys, 'requestId', 'correlationId', 'fingerprint'].includes(key))
    || !Array.isArray(message.content) || message.content.length !== 1 || message.content[0]?.type !== 'text') throw new Error('Invalid domain message source or content')
  const binding = Object.fromEntries(bindingKeys.map(key => [key, envelope[key]]))
  const expected = domainEnvelope(binding, { requestId: envelope.requestId, text: message.content[0].text,
    ...(envelope.correlationId === undefined ? {} : { correlationId: envelope.correlationId }) })
  if (!isDeepStrictEqual(domainMessageScope(binding), scope) || !isDeepStrictEqual(source, expected.source)
    || !isDeepStrictEqual(message.content, expected.content)) throw new Error('Domain message contradicts its scope or fingerprint')
  return binding
}
