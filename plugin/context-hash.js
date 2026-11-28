import { createHash } from 'node:crypto'

// Stable across JSON serialization, persistence and provider object key order.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : canonical(item)).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const contextHash = value => createHash('sha256').update(canonical(value)).digest('hex')
export const contentHash = value => createHash('sha256').update(value).digest('hex')
export function freezeContext(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeContext(item)
    Object.freeze(value)
  }
  return value
}
