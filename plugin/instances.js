import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

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
  defaultRole: z.string().pattern(/^(?!human$)[a-z][a-z0-9_-]{0,31}$/u).default('chief'),
  createdAt: z.string().pattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u).required(),
})

export const emptyRegistry = { schemaVersion: 1, revision: 0, selectedBotId: null, bots: [] }
export const BotRegistrySchema = z.object({
  schemaVersion: z.const(1).required(),
  revision: z.natural().max(Number.MAX_SAFE_INTEGER).required(),
  selectedBotId: z.union([z.const(null), botId]).default(null),
  bots: z.array(BotRegistration).required(),
})

/** One profile-owned document; references never copy the DSH entities or history. */
export function BotRegistry(input) {
  const registry = BotRegistrySchema(input)
  for (const field of ['botId', 'name', 'workspacePath', 'workspaceId', 'mainSessionId']) {
    const values = registry.bots.map(bot => bot[field]).filter(value => value !== null)
    if (new Set(values).size !== values.length) throw new Error(`Duplicate Bot ${field}`)
  }
  for (const bot of registry.bots) {
    if (bot.name.trim() !== bot.name || !bot.name.trim()) throw new Error('Bot name must be trimmed and nonempty')
    if (!Number.isFinite(Date.parse(bot.createdAt)) || new Date(bot.createdAt).toISOString() !== bot.createdAt) throw new Error('Invalid Bot creation time')
    if (bot.mainSessionId && !bot.workspaceId) throw new Error('Main Session binding requires a DSH workspace binding')
    if (registry.bots.some(other => other.botId !== bot.botId && other.botId === bot.name)) throw new Error('Bot name collides with another Bot id')
  }
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
  if (!bot) throw new Error(`Unknown Bot: ${identity}`)
  return bot
}

export function revise(registry, change) {
  if (registry.revision === Number.MAX_SAFE_INTEGER) throw new Error('Bot registry revision is exhausted')
  return BotRegistry({ ...registry, ...change, revision: registry.revision + 1 })
}
