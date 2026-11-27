#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { redactionSpans } from '../plugin/reply-proof.js'

const [headerFile, eventsFile, finishFile] = process.argv.slice(2)
if (headerFile === '--seal-meta') {
  const raw = JSON.parse(await readFile(eventsFile, 'utf8'))
  const meta = JSON.parse(await readFile(finishFile, 'utf8'))
  if (raw && meta.runtime.reply) {
    meta.runtime.reply.redactions = redactionSpans(raw.text, meta.runtime.reply.text)
    meta.runtime.reply.textHash = createHash('sha256').update(meta.runtime.reply.text).digest('hex')
  }
  process.stdout.write(JSON.stringify(meta) + '\n')
} else {
  const header = JSON.parse(await readFile(headerFile, 'utf8'))
  if (header.writerScope !== 'agent-runtime' || !Array.isArray(header.messages)) {
    process.stdout.write('null\n')
  } else {
    const events = (await readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const finish = JSON.parse(await readFile(finishFile, 'utf8'))
    const end = events.findLast(event => event.type === 'turn/end' && event.data.turn === header.turn)
    const assistant = events.findLast(event => event.type === 'assistant/message' && event.data.turn === header.turn && event.seq < end?.seq)
    const text = assistant?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    if (!Number.isSafeInteger(end?.seq) || end.seq < 0 || !isDeepStrictEqual(end.data.reason, finish.reason)
      || text !== finish.text || (assistant && (!Number.isSafeInteger(assistant.seq) || assistant.data.message.source.kind !== 'model'))
      ) throw new Error('Native reply does not match the recorded turn completion')
    const targets = new Map()
    for (const message of [...header.messages, ...events.filter(event => event.type === 'user/message' && event.seq < end.seq).map(event => event.data)]) {
      const source = message.source
      if (source?.kind !== 'user' || !source.mbot) continue
      if (source.mbot.schemaVersion !== 1 || source.mbot.botId !== header.botId || source.mbot.visibility !== 'owner-private'
        || typeof source.rpcId !== 'string' || typeof message.id !== 'string') throw new Error('Invalid native reply target')
      const target = { rpcId: source.rpcId, messageId: message.id, ...source.mbot }
      if (targets.has(source.rpcId) && !isDeepStrictEqual(targets.get(source.rpcId), target)) throw new Error('Native reply target changed during execution')
      targets.set(source.rpcId, target)
    }
    process.stdout.write(JSON.stringify({ schemaVersion: 1, assistantEventSeq: assistant?.seq ?? null, endEventSeq: end.seq,
      nativeTextHash: createHash('sha256').update(text).digest('hex'), text, targets: [...targets.values()] }) + '\n')
  }
}
