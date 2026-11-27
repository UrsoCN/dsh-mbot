import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// mtime+inode+size cache for .env / user config secret extraction so hot paths
// (tool results, status queries, IPC responses) do not re-read unchanged files.
const fileCache = new Map()
const registeredSecrets = new Set()

/** Register a dynamic runtime secret fingerprint (e.g., short-lived tokens). */
export function registerSecret(secret) {
  if (typeof secret === 'string' && secret.length >= 8) registeredSecrets.add(secret)
  return () => { registeredSecrets.delete(secret) }
}

async function readCachedFile(path) {
  let info
  try { info = await stat(path) } catch (error) {
    if (error.code === 'ENOENT') { fileCache.delete(path); return null }
    throw error
  }
  const hit = fileCache.get(path)
  if (hit && hit.ino === info.ino && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.content
  const content = await readFile(path, 'utf8')
  fileCache.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size, content })
  return content
}

function extractEnvSecrets(contents) {
  const found = []
  for (const line of contents.split('\n')) {
    const match = /^(?:export\s+)?[A-Z_]*(?:API_KEY|TOKEN|PASSWORD|SECRET|COOKIE|PRIVATE_KEY)=(.*)$/u.exec(line)
    if (match) found.push(match[1].replace(/^(['"])(.*)\1$/u, '$2'))
  }
  return found
}

/** Keep host credentials out of native tool and slash-command transcript results. */
async function redactor(workspace = '', extra = []) {
  const secrets = [
    ...extra,
    ...registeredSecrets,
    ...Object.entries(process.env).filter(([key]) => /(API_KEY|TOKEN|PASSWORD|SECRET|COOKIE|PRIVATE_KEY)$/u.test(key)).map(([, value]) => value),
  ]
  const files = [join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.env')]
  let target = workspace || process.env.MBOT_WS
  if (!target) {
    const config = await readCachedFile(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'mbot', 'config'))
    if (config) {
      const match = /^MBOT_WS=(.*)$/mu.exec(config)
      target = match?.[1].replace(/^(['"])(.*)\1$/u, '$2')
    }
  }
  target ||= join(homedir(), '.mbot-ws')
  if (target === '~' || target.startsWith('~/')) target = join(homedir(), target.slice(2))
  files.push(join(target, '.env'))
  for (const file of files) {
    const contents = await readCachedFile(file)
    if (contents) secrets.push(...extractEnvSecrets(contents))
  }
  return text => {
    for (const secret of secrets) if (secret?.length >= 8) text = text.split(secret).join('[REDACTED]')
    return text
      .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu, '[REDACTED_PRIVATE_KEY]')
      .replace(/sk-[A-Za-z0-9_-]{12,}/gu, '[REDACTED]')
      .replace(/(https?:\/\/)[^/@\s]+@/gu, '$1[REDACTED]@')
      .replace(/([?&](?:token|access_token|api_key|apikey|secret|key|auth)=)[^&\s#]+/giu, '$1[REDACTED]')
      .replace(/Bearer [A-Za-z0-9._~+/-]{8,}/gu, 'Bearer [REDACTED]')
  }
}

export async function redact(text, workspace = '') { return (await redactor(workspace))(text) }

/** Keep the JSON shape while redacting string values and keys before logging. */
export async function redactValue(value, workspace = '', extra = []) {
  const filter = await redactor(workspace, extra)
  const walk = input => {
    if (typeof input === 'string') return filter(input)
    if (Array.isArray(input)) {
      const next = input.map(walk)
      return next.some((value, index) => value !== input[index]) ? next : input
    }
    if (input && typeof input === 'object') {
      let changed = false
      const next = Object.entries(input).map(([key, value]) => {
        const name = filter(key), item = walk(value)
        changed ||= name !== key || item !== value
        return [name, item]
      })
      return changed ? Object.fromEntries(next) : input
    }
    return input
  }
  return walk(value)
}
