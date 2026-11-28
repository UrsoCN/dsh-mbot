#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { validateDomainHeader, validateDomainJournal, validateDomainKnowledge } from '../plugin/domain-contract.js'
import { readDomainView } from '../plugin/domain-view.js'
import { contentHash } from '../plugin/context-hash.js'
import { redactValue } from '../plugin/redact.js'

async function json(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.size > 2 * 1024 * 1024) throw new Error('Unsafe domain transaction input')
  return JSON.parse(await readFile(path, 'utf8'))
}
try {
  const [mode, file, workspace, ...args] = process.argv.slice(2)
  if (mode === '--validate-header') {
    const header = await json(file)
    if (header.conversation !== undefined) validateDomainHeader(header)
    else if (header.runtimeOwnership?.schemaVersion === 3) throw new Error('Domain writer contract requires conversation identity')
  } else if (mode === '--snapshot') {
    const header = await json(file), scope = validateDomainHeader(header)
    const [commit, role, ...values] = args
    if (values.length !== 4 || values.some(value => !/^[1-9][0-9]{0,8}$/u.test(value))) throw new Error('Invalid domain context budgets')
    const [memoryLines, memoryChars, soulChars, wikiLines] = values.map(Number)
    const view = readDomainView(workspace, commit, scope, role)
    const memory = view.documents.filter(document => document.kind === 'memory').map(document => document.text).join('\n\n')
    if ([...memory].length > memoryChars || memory.split('\n').length - (memory.endsWith('\n') ? 1 : 0) > memoryLines) {
      throw new Error('Domain knowledge exceeds its configured budget')
    }
    for (const document of view.documents) {
      const lines = document.text.split('\n').length - (document.text.endsWith('\n') ? 1 : 0)
      const chars = [...document.text].length
      if (document.kind === 'memory' && (lines > memoryLines || chars > memoryChars)
        || document.kind === 'soul' && chars > soulChars || document.kind === 'reference' && lines > wikiLines) {
        throw new Error('Domain knowledge exceeds its configured budget')
      }
    }
    // Redact bodies only; knowledge and routing identities remain exact for recovery.
    const texts = await redactValue(view.documents.map(document => document.text), workspace)
    const documents = view.documents.map(({ bytes, text, ...document }, i) => ({ ...document, text: texts[i] }))
    const snapshot = { head: commit, workspace, role, conversation: scope, knowledge: view.knowledge, documents,
      protocol: documents[0].text, soul: documents[1].text,
      memory: documents.filter(document => document.kind === 'memory').map(document => document.text).join('\n\n'), roleMemory: '', board: '' }
    process.stdout.write(JSON.stringify(snapshot) + '\n')
  } else if (mode === '--command') {
    const journal = validateDomainJournal(await json(join(file, 'ledger.json')))
    if (journal.workspace !== workspace || journal.phase !== 'active') throw new Error('Domain data identity changed')
    const snapshotBytes = await readFile(join(file, 'context.json'))
    const snapshot = await json(join(file, 'context.json'))
    if (contentHash(snapshotBytes) !== journal.contextHash || snapshot.workspace !== workspace || snapshot.head !== journal.baseHead
      || snapshot.role !== journal.role || !isDeepStrictEqual(snapshot.conversation, journal.conversation)) throw new Error('Domain snapshot contradicts its journal')
    validateDomainKnowledge(snapshot.knowledge, journal.role)
    const [command, value] = args
    if (command === 'boot' && args.length === 2 && value === journal.role) {
      process.stdout.write(JSON.stringify({ role: snapshot.role, documents: snapshot.documents.filter(item => item.kind !== 'reference'),
        references: snapshot.documents.filter(item => item.kind === 'reference').map(item => item.path) }) + '\n')
    } else if (command === 'view' && args.length === 2) {
      const document = snapshot.documents.find(item => item.path === value)
      if (!document) throw new Error('Document is outside this conversation view')
      process.stdout.write(JSON.stringify(document) + '\n')
    } else throw new Error('Operation is outside the domain data scope')
  } else throw new Error('Invalid domain transaction operation')
} catch (error) {
  process.stderr.write(`mbot: ${error.code ? 'Domain transaction input could not be verified' : error.message}\n`)
  process.exitCode = 1
}
