import { readFile } from 'node:fs/promises'
import { bootIdPattern } from './turn-state.js'

export async function processStart(pid = process.pid) {
  const value = await readFile(`/proc/${pid}/stat`, 'utf8')
  return value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u)[19]
}

export async function currentBootId() {
  const raw = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase()
  if (!bootIdPattern.test(raw)) throw new Error('Invalid kernel boot identity')
  return raw
}

export function validBootId(value) {
  return typeof value === 'string' && bootIdPattern.test(value)
}
