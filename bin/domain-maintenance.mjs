#!/usr/bin/env node
import { DomainDreamTransaction } from '../plugin/domain-dream-transaction.js'
import { redact } from '../plugin/redact.js'

const [workspace, mode, inputBytes, memoryLines, memoryChars, soulChars, wikiLines, timeout] = process.argv.slice(2)
const transaction = new DomainDreamTransaction(workspace, Object.fromEntries(Object.entries({ inputBytes, memoryLines, memoryChars, soulChars, wikiLines }).map(([key, value]) => [key, Number(value)])))
let pending = '', first = true
const output = value => process.stdout.write(JSON.stringify(value) + '\n')
const timer = setTimeout(() => process.exit(1), (Number(timeout) + 60) * 1000)
timer.unref()
process.stdin.setEncoding('utf8')
try {
  for await (const chunk of process.stdin) {
    pending += chunk
    if (Buffer.byteLength(pending) > 32 * 1024 * 1024) throw new Error('Maintenance protocol input budget exceeded')
    let newline
    while ((newline = pending.indexOf('\n')) !== -1) {
      const frame = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1)
      try {
        let result
        if (first) {
          if (frame.kind !== mode) throw new Error('Invalid initial maintenance operation')
          first = false
          result = await transaction[mode](frame)
        } else {
          if (!['start', 'plan', 'commit', 'abort', 'finish'].includes(frame.kind)) throw new Error('Invalid maintenance operation')
          result = await transaction[frame.kind](frame)
        }
        output({ ok: true, result })
      } catch (error) {
        // Keep the connection available for a verified no-write abort; ambiguous
        // commit failures are left to the next recovery owner.
        output({ ok: false, error: await redact(error.message ?? String(error), workspace) })
      }
    }
  }
  if (pending.trim()) throw new Error('Truncated maintenance protocol frame')
} catch (error) {
  process.stderr.write(await redact(error.message ?? String(error), workspace) + '\n')
  process.exitCode = 1
} finally { clearTimeout(timer) }
