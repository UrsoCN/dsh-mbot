import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ConversationRegistration, validateConversation, botSessionIds } from './conversations.js'

const botId = z.string().pattern(/^bot-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u).required()
const name = z.string().pattern(/^[^\0\r\n]{1,80}$/u).required()
const reference = z.union([z.const(null), z.string().min(1).pattern(/^[^\0\r\n]+$/u)]).default(null)
export const BotRegistration = z.object({
  schemaVersion: z.const(1).required(),
  botId,
  name,
  workspacePath: z.string().pattern(/^\/[^\0\r\n]+$/u).required(),
  workspaceId: reference,
  mainSessionId: reference,
  binding: z.union([z.const(null), z.object({
    state: z.union(['provisioning', 'ready', 'failed'].map(value => z.const(value))).required(),
    pendingSessionId: reference,
    error: z.union([z.const(null), z.string().min(1).pattern(/^[^\0]+$/u)]).default(null),
  })]).default(null),
  defaultRole: z.string().pattern(/^(?!human$)[a-z][a-z0-9_-]{0,31}$/u).default('chief'),
  createdAt: z.string().pattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u).required(),
})

const registryFields = {
  revision: z.natural().max(Number.MAX_SAFE_INTEGER).required(),
  selectedBotId: z.union([z.const(null), botId]).default(null),
  bots: z.array(BotRegistration).required(),
}
export const RetiredBot = z.object({
  bot: BotRegistration.required(),
  sessionIds: z.array(z.string().min(1).pattern(/^[^\0\r\n]+$/u)).required(),
  retiredAt: z.string().pattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u).required(),
})
export const emptyRegistry = { schemaVersion: 3, revision: 0, selectedBotId: null, bots: [], retiredBots: [], conversations: [] }
export const BotRegistrySchema = z.union([
  z.object({ schemaVersion: z.const(1).required(), ...registryFields, retiredBots: z.never(), conversations: z.never() }),
  z.object({ schemaVersion: z.const(2).required(), ...registryFields, retiredBots: z.array(RetiredBot).required(), conversations: z.never() }),
  z.object({ schemaVersion: z.const(3).required(), ...registryFields, retiredBots: z.array(RetiredBot).required(), conversations: z.array(ConversationRegistration).required() }),
])

/** One profile-owned document; references never copy the DSH entities or history. */
export function BotRegistry(input) {
  const parsed = BotRegistrySchema(input)
  const registry = { ...parsed, schemaVersion: 3, retiredBots: parsed.retiredBots ?? [],
    conversations: (parsed.conversations ?? []).map(validateConversation) }
  for (const field of ['botId', 'name', 'workspacePath', 'workspaceId', 'mainSessionId']) {
    const values = registry.bots.map(bot => bot[field]).filter(value => value !== null)
    if (new Set(values).size !== values.length) throw new Error(`Duplicate Bot ${field}`)
  }
  const allBots = [...registry.bots, ...registry.retiredBots.map(entry => entry.bot)]
  if (new Set(allBots.map(bot => bot.botId)).size !== allBots.length) throw new Error('Duplicate active/retired Bot identity')
  for (const entry of registry.retiredBots) {
    if (!Number.isFinite(Date.parse(entry.retiredAt)) || new Date(entry.retiredAt).toISOString() !== entry.retiredAt) throw new Error('Invalid Bot retirement time')
    if (botSessionIds(registry, entry.bot).some(id => !entry.sessionIds.includes(id))) throw new Error('Retired Bot must retain every reserved/main/conversation Session')
  }
  for (const bot of allBots) {
    if (bot.name.trim() !== bot.name || !bot.name.trim()) throw new Error('Bot name must be trimmed and nonempty')
    if (!Number.isFinite(Date.parse(bot.createdAt)) || new Date(bot.createdAt).toISOString() !== bot.createdAt) throw new Error('Invalid Bot creation time')
    if (bot.mainSessionId && !bot.workspaceId) throw new Error('Main Session binding requires a DSH workspace binding')
    if (bot.binding?.state === 'ready' && (!bot.workspaceId || !bot.mainSessionId || bot.binding.pendingSessionId || bot.binding.error)) throw new Error('Ready Bot binding requires verified references')
    if (bot.binding?.pendingSessionId && bot.mainSessionId) throw new Error('Bot binding cannot have both pending and main Sessions')
    if (bot.binding?.state === 'provisioning' && !bot.mainSessionId && !bot.binding.pendingSessionId) throw new Error('Provisioning Bot binding requires a reserved Session')
    if (registry.bots.some(other => other.botId !== bot.botId && other.botId === bot.name)) throw new Error('Bot name collides with another Bot id')
  }
  for (const conversation of registry.conversations) {
    if (!allBots.some(bot => bot.botId === conversation.botId)) throw new Error('Conversation belongs to an unknown Bot')
    if (allBots.some(bot => [bot.mainSessionId, bot.binding?.pendingSessionId].includes(conversation.sessionId))) throw new Error('Conversation cannot reuse a private main Session')
  }
  for (const identity of [item => item.conversationId, item => item.sessionId, item => `${item.botId}:${item.conversationKey}`]) {
    const values = registry.conversations.map(identity)
    if (new Set(values).size !== values.length) throw new Error('Duplicate conversation identity or Session')
  }
  const sessions = [...registry.bots.flatMap(bot => botSessionIds(registry, bot)), ...registry.retiredBots.flatMap(entry => entry.sessionIds)]
  if (new Set(sessions).size !== sessions.length) throw new Error('Duplicate Bot reserved Session')
  if (registry.selectedBotId !== null && !registry.bots.some(bot => bot.botId === registry.selectedBotId)) throw new Error('Selected Bot is not registered')
  return registry
}

export function registration(workspacePath, options = {}) {
  const name = options.name ?? (Array.from(basename(workspacePath)).slice(0, 80).join('').trim() || 'Bot')
  if (typeof name !== 'string' || name.trim() !== name || !name) throw new Error('Bot name must be trimmed and nonempty')
  return BotRegistration({ schemaVersion: 1, botId: `bot-${randomUUID()}`, name,
    workspacePath, workspaceId: null, mainSessionId: null, defaultRole: options.defaultRole ?? 'chief', createdAt: new Date().toISOString() })
}

/** Default directory names may repeat; explicit names instead fail on collision. */
export function uniqueName(registry, candidate, explicit = false) {
  if (explicit) return candidate
  let name = candidate.name
  for (let index = 2; registry.bots.some(bot => bot.name === name || bot.botId === name); index++) {
    const suffix = ` (${index})`
    name = Array.from(candidate.name).slice(0, 80 - suffix.length).join('') + suffix
  }
  return { ...candidate, name }
}

export function findBot(registry, identity) {
  const bot = registry.bots.find(bot => bot.botId === identity || bot.name === identity)
  if (!bot) throw new Error(registry.retiredBots?.some(entry => entry.bot.botId === identity) ? `Bot was removed: ${identity}. Import its data as a new Bot to continue.` : `Unknown Bot: ${identity}`)
  return bot
}

/** Tombstones cannot disappear through config resets or schema downgrade. */
export function registryTransition(previous, next) {
  const before = BotRegistry(previous), after = BotRegistry(next)
  for (const conversation of before.conversations) {
    if (!isDeepStrictEqual(after.conversations.find(item => item.conversationId === conversation.conversationId), conversation)) {
      throw new Error('Conversation source, permission and Session ownership are immutable; do not reset or downgrade the registry')
    }
  }
  for (const conversation of after.conversations) {
    if (!before.conversations.some(item => item.conversationId === conversation.conversationId)
      && !after.bots.some(bot => bot.botId === conversation.botId)) throw new Error('Cannot add a conversation to a retired Bot')
  }
  for (const retired of before.retiredBots) {
    const retained = after.retiredBots.find(entry => entry.bot.botId === retired.bot.botId)
    if (!isDeepStrictEqual(retained, retired)) throw new Error('Retired Bot references must remain intact; do not reset or downgrade the registry')
  }
  for (const bot of before.bots) {
    const active = after.bots.find(item => item.botId === bot.botId)
    const retired = after.retiredBots.find(entry => entry.bot.botId === bot.botId)
    if (!active && !isDeepStrictEqual(retired?.bot, bot)) throw new Error('Remove Bots through /mbot remove; registry edits must retain their Session ownership')
    if (active && active.workspacePath !== bot.workspacePath) throw new Error('Registered Bot data directory is immutable; import another directory as a new Bot')
    if (active && [bot.mainSessionId, bot.binding?.pendingSessionId].filter(Boolean).some(id => id !== active.mainSessionId && id !== active.binding?.pendingSessionId)) throw new Error('Existing managed Session ownership cannot be discarded by editing the registry')
  }
  return after
}

export function revise(registry, change) {
  if (registry.revision === Number.MAX_SAFE_INTEGER) throw new Error('Bot registry revision is exhausted')
  return BotRegistry({ ...registry, ...change, revision: registry.revision + 1 })
}
