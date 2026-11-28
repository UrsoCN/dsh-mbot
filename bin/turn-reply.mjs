#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { nativeReply } from '../plugin/native-reply.js'
import { redactionSpans } from '../plugin/reply-proof.js'
import { sealContextAudit } from '../plugin/context-audit.js'
import { sealCompactionAudit, compactInputType, compactOutputType } from '../plugin/compaction-data.js'
import { validateDomainHeader, domainJournalVersion } from '../plugin/domain-contract.js'
import { candidatePath, readCandidateFile, sealDomainCandidates } from '../plugin/domain-candidates.js'

const [headerFile, eventsFile, finishFile] = process.argv.slice(2)
if (headerFile === '--seal-meta') {
  const raw = JSON.parse(await readFile(eventsFile, 'utf8'))
  const meta = JSON.parse(await readFile(finishFile, 'utf8'))
  if (raw && meta.runtime.reply) {
    meta.runtime.reply.redactions = redactionSpans(raw.text, meta.runtime.reply.text)
    meta.runtime.reply.textHash = createHash('sha256').update(meta.runtime.reply.text).digest('hex')
  }
  if (process.argv[5] && process.argv[6]) {
    const events = (await readFile(process.argv[5], 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const header = process.argv[7] ? JSON.parse(await readFile(process.argv[7], 'utf8')) : {}
    if (header.conversation) {
      validateDomainHeader(header)
      if (meta.runtime.journal_schema_version !== domainJournalVersion(header.runtimeOwnership)) throw new Error('Domain journal cannot be downgraded')
      meta.runtime.conversation = header.conversation
    }
    if (header.compactionPolicyVersion !== undefined) meta.runtime.compaction_policy_version = header.compactionPolicyVersion
    const context = sealContextAudit(meta, events, process.argv[6])
    if (context) meta.runtime.context = context
    if (meta.runtime.journal_schema_version === 5) {
      const bytes = await readCandidateFile(process.argv[6], candidatePath(header.conversation, meta.run_id))
      meta.runtime.candidates = sealDomainCandidates(meta, events, bytes)
    }
    const compactions = header.compactionPolicyVersion === 1 || events.some(event => [compactInputType, compactOutputType].includes(event.type))
      ? sealCompactionAudit(meta, events) : undefined
    if (compactions) meta.runtime.compactions = compactions
  }
  process.stdout.write(JSON.stringify(meta) + '\n')
} else {
  const header = JSON.parse(await readFile(headerFile, 'utf8'))
  if (header.writerScope !== 'agent-runtime' || !Array.isArray(header.messages)) {
    process.stdout.write('null\n')
  } else {
    const events = (await readFile(eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const finish = JSON.parse(await readFile(finishFile, 'utf8'))
    process.stdout.write(JSON.stringify(nativeReply(header, events, finish)) + '\n')
  }
}
