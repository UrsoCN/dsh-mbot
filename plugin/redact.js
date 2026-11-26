import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Keep host credentials out of native tool and slash-command transcript results. */
export async function redact(text, workspace = '') {
  const secrets = Object.entries(process.env).filter(([key]) => /(API_KEY|TOKEN|PASSWORD|SECRET)$/u.test(key)).map(([, value]) => value)
  const files = [join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.env')]
  let target = workspace || process.env.MBOT_WS
  if (!target) {
    try {
      const config = await readFile(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'mbot', 'config'), 'utf8')
      const match = /^MBOT_WS=(.*)$/mu.exec(config)
      target = match?.[1].replace(/^(['"])(.*)\1$/u, '$2')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  target ||= join(homedir(), '.mbot-ws')
  if (target === '~' || target.startsWith('~/')) target = join(homedir(), target.slice(2))
  files.push(join(target, '.env'))
  for (const file of files) {
    let contents
    try { contents = await readFile(file, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const line of contents.split('\n')) {
      const match = /^(?:export\s+)?[A-Z_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)=(.*)$/u.exec(line)
      if (match) secrets.push(match[1].replace(/^(['"])(.*)\1$/u, '$2'))
    }
  }
  for (const secret of secrets) if (secret?.length >= 8) text = text.split(secret).join('[REDACTED]')
  return text.replace(/sk-[A-Za-z0-9_-]{12,}/gu, '[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+@/gu, '$1[REDACTED]@')
    .replace(/Bearer [A-Za-z0-9._~+/-]{8,}/gu, 'Bearer [REDACTED]')
}
