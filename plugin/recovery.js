import { readFile } from 'node:fs/promises'

export async function processStart(pid = process.pid) {
  const value = await readFile(`/proc/${pid}/stat`, 'utf8')
  return value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u)[19]
}
