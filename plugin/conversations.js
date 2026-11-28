import z from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

// Keep the public schema projectable: Schemastery's string max() counts UTF-16
// units, which cannot be expressed as JSON Schema's code-point maxLength.
const identifier = z.string().pattern(/^[^\x00-\x1f\x7f]{1,1024}$/u).required()
const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
export const ConversationSource = z.object({
  adapterId: identifier,
  platform: identifier,
  accountId: identifier,
  spaceId: identifier,
  threadId: z.union([z.const(null), identifier]),
  visibility: z.union(['user-private', 'group', 'peer'].map(value => z.const(value))).required(),
  principalId: z.union([z.const(null), identifier]),
})
export const ConversationRegistration = z.object({
  schemaVersion: z.const(1).required(),
  conversationId: z.string().pattern(new RegExp(`^conversation-${uuid}$`, 'u')).required(),
  botId: z.string().pattern(new RegExp(`^bot-${uuid}$`, 'u')).required(),
  conversationKey: z.string().pattern(/^domain:[a-f0-9]{64}$/u).required(),
  sessionId: z.string().pattern(new RegExp(`^session-${uuid}$`, 'u')).required(),
  source: ConversationSource.required(),
  allowedSenders: z.array(identifier).min(1).max(256).required(),
  replyRoute: identifier,
  // Publication requires a later version with a verified visibility contract.
  state: z.const('reserved').required(),
  createdAt: z.string().required(),
})

function exactFields(input, fields, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key))) throw new Error(`Invalid ${label} fields`)
}

/** Host-attested identity, never inferred from message text or a shared account. */
export function conversationSource(input) {
  const fields = ['adapterId', 'platform', 'accountId', 'spaceId', 'threadId', 'visibility', 'principalId']
  exactFields(input, fields, 'conversation source')
  if (input.threadId === undefined || input.principalId === undefined) throw new Error('Conversation source requires explicit thread and principal identities (or null)')
  const source = ConversationSource(input)
  for (const value of Object.values(source)) if (typeof value === 'string' && value.trim() !== value) throw new Error('Conversation identifiers must be nonempty and trimmed')
  if (source.visibility === 'group' ? source.principalId !== null : source.principalId === null) throw new Error('Group identity uses an allowlist; private and peer identity require a principal')
  // Explicit property order makes keys independent of caller object order.
  return Object.fromEntries(fields.map(key => [key, source[key]]))
}

export function conversationKey(input) {
  return `domain:${createHash('sha256').update(JSON.stringify(conversationSource(input))).digest('hex')}`
}

export function conversationAccess(input) {
  exactFields(input, ['source', 'allowedSenders', 'replyRoute'], 'conversation access')
  const source = conversationSource(input.source)
  const allowedSenders = z.array(identifier).min(1).max(256).required()(input.allowedSenders)
  const replyRoute = identifier(input.replyRoute)
  if ([...allowedSenders, replyRoute].some(value => value.trim() !== value)
    || new Set(allowedSenders).size !== allowedSenders.length) throw new Error('Conversation access must have distinct trimmed sender identities and a reply route')
  if (source.visibility !== 'group' && (allowedSenders.length !== 1 || allowedSenders[0] !== source.principalId)) throw new Error('Private or peer access is limited to its bound principal')
  return { source, allowedSenders: [...allowedSenders].sort(), replyRoute }
}

export function validateConversation(input) {
  exactFields(input, ['schemaVersion', 'conversationId', 'botId', 'conversationKey', 'sessionId', 'source', 'allowedSenders', 'replyRoute', 'state', 'createdAt'], 'conversation registration')
  const record = ConversationRegistration(input)
  const access = conversationAccess({ source: record.source, allowedSenders: record.allowedSenders, replyRoute: record.replyRoute })
  if (record.conversationKey !== conversationKey(access.source)) throw new Error('Conversation key does not match its source identity')
  if (!Number.isFinite(Date.parse(record.createdAt)) || new Date(record.createdAt).toISOString() !== record.createdAt) throw new Error('Invalid conversation creation time')
  return { ...record, ...access }
}

export function reserveConversationRecord(botId, input) {
  const access = conversationAccess(input)
  return validateConversation({ schemaVersion: 1, conversationId: `conversation-${randomUUID()}`, botId,
    conversationKey: conversationKey(access.source), sessionId: `session-${randomUUID()}`, ...access,
    state: 'reserved', createdAt: new Date().toISOString() })
}

/** Checks an attestation from a trusted adapter; this does not authenticate a platform. */
export function authorizeConversationSource(record, source) {
  exactFields(source, ['adapterId', 'platform', 'accountId', 'spaceId', 'threadId', 'visibility', 'principalId', 'senderId', 'replyRoute'], 'conversation attestation')
  const { senderId, replyRoute, ...identity } = source
  const binding = validateConversation(record)
  if (!isDeepStrictEqual(conversationSource(identity), binding.source)
    || !binding.allowedSenders.includes(senderId) || replyRoute !== binding.replyRoute) throw new Error('Source or reply route is outside this conversation permission')
  return binding
}

export function conversationForSession(registry, sessionId) {
  return registry.conversations?.find(item => item.sessionId === sessionId)
}

export function botSessionIds(registry, bot) {
  return [bot.mainSessionId, bot.binding?.pendingSessionId,
    ...(registry.conversations ?? []).filter(item => item.botId === bot.botId).map(item => item.sessionId)].filter(Boolean)
}
