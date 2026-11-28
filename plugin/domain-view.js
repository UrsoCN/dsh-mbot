// Committed, explicitly published knowledge for an extra conversation domain.
// This reader grants no execution capability and never reads the working tree.
import { isDeepStrictEqual } from 'node:util'
import { contextGit } from './context-git.js'
import { contentHash, contextHash, freezeContext } from './context-hash.js'
import { validateDomainScope, domainPath } from './domain-contract.js'

export const conversationViewLimits = Object.freeze({ policyBytes: 32768, documentBytes: 65536, totalBytes: 262144, documents: 64 })
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const roleName = /^[a-z][a-z0-9_-]{0,31}$/u

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new Error(`Invalid conversation ${label} fields`)
}

export function policyAtScope(input, scope, role) {
  if (typeof role !== 'string' || !roleName.test(role) || role === 'human') throw new Error('Invalid conversation role')
  exactFields(input, ['schemaVersion', 'botId', 'conversationId', 'conversationKey', 'role', 'protocol', 'soul', 'memory', 'references'], 'view policy')
  if (input.schemaVersion !== 1 || input.botId !== scope.botId || input.conversationId !== scope.conversationId
    || input.conversationKey !== scope.conversationKey || input.role !== role) throw new Error('Conversation view policy does not match its Bot, domain or role')
  const { protocol, soul, memory, references } = input
  if (!Array.isArray(memory) || !Array.isArray(references)
    || memory.length + references.length + 2 > conversationViewLimits.documents) throw new Error('Invalid conversation document lists')
  const paths = [protocol, soul, ...memory, ...references].map(path => domainPath(path, scope))
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate conversation document')
  return { schemaVersion: 1, botId: scope.botId, conversationId: scope.conversationId, conversationKey: scope.conversationKey,
    role, protocol, soul, memory: [...memory], references: [...references] }
}

function entries(policy) {
  return [{ kind: 'protocol', path: policy.protocol }, { kind: 'soul', path: policy.soul },
    ...policy.memory.map(path => ({ kind: 'memory', path })), ...policy.references.map(path => ({ kind: 'reference', path }))]
}

function textBytes(bytes, label) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new Error(`Conversation ${label} must be valid UTF-8`) }
  if (text.includes('\0')) throw new Error(`Conversation ${label} cannot contain NUL bytes`)
  return text
}

function git(workspace, ...args) {
  try { return contextGit(workspace, '--no-replace-objects', '--literal-pathspecs', ...args) }
  catch { throw new Error('Cannot read committed conversation view; verify repository and Git objects') }
}

/** ls-tree checks mode and size before any contents are read; symlinks are never followed. */
function documentsAt(workspace, head, paths, perFileLimit, totalLimit) {
  const rows = git(workspace, 'ls-tree', '-lz', '--full-tree', head, '--', ...paths).toString('utf8').split('\0').filter(Boolean)
  const found = new Map()
  for (const row of rows) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/u.exec(row)
    if (!match || !objectId.test(match[2]) || !paths.includes(match[4]) || found.has(match[4])) throw new Error('Conversation view requires regular Git blobs')
    const size = Number(match[3])
    if (!Number.isSafeInteger(size) || size > perFileLimit) throw new Error('Conversation document exceeds its byte limit')
    found.set(match[4], { path: match[4], blob: match[2], bytes: size })
  }
  if (paths.some(path => !found.has(path))) throw new Error('Conversation view is incomplete; every declared file must be committed')
  if ([...found.values()].reduce((sum, item) => sum + item.bytes, 0) > totalLimit) throw new Error('Conversation view exceeds its total byte limit')
  return paths.map(path => {
    const record = found.get(path), bytes = git(workspace, 'cat-file', 'blob', record.blob)
    if (bytes.length !== record.bytes) throw new Error('Conversation document size changed while reading Git')
    return { ...record, contentHash: contentHash(bytes), text: textBytes(bytes, 'document') }
  })
}

/** Runtime/audit readers supply a scope already captured from persistent ownership. */
export function readDomainView(workspace, commit, inputScope, role) {
  const scope = structuredClone(validateDomainScope(inputScope))
  if (typeof workspace !== 'string' || !workspace.startsWith('/') || /[\0\r\n]/u.test(workspace)) throw new Error('Invalid conversation workspace')
  if (commit !== undefined && (typeof commit !== 'string' || !objectId.test(commit))) throw new Error('Conversation view requires an exact Git commit')
  const head = commit ?? git(workspace, 'rev-parse', '--verify', 'HEAD^{commit}').toString('utf8').trim()
  if (!objectId.test(head) || git(workspace, 'cat-file', '-t', head).toString('utf8').trim() !== 'commit') throw new Error('Conversation view requires a Git commit object')
  const path = `memory/conversations/${scope.conversationId}/VIEW.json`
  const [policyFile] = documentsAt(workspace, head, [path], conversationViewLimits.policyBytes, conversationViewLimits.policyBytes)
  let raw
  try { raw = JSON.parse(policyFile.text) } catch { throw new Error('Conversation VIEW.json must contain valid JSON') }
  const policy = policyAtScope(raw, scope, role)
  const selected = entries(policy)
  const files = documentsAt(workspace, head, selected.map(item => item.path), conversationViewLimits.documentBytes, conversationViewLimits.totalBytes)
  const documents = files.map((file, i) => ({ kind: selected[i].kind, ...file }))
  const policyIdentity = { path, blob: policyFile.blob, contentHash: policyFile.contentHash }
  const identity = { scope, role, policy: policyIdentity,
    documents: documents.map(({ kind, path, blob, contentHash }) => ({ kind, path, blob, contentHash })) }
  const knowledge = { schemaVersion: 2, ...identity, version: contextHash(identity) }
  return freezeContext({ schemaVersion: 1, head, policy, knowledge, documents })
}

/** Read tools must use this allowlist against the captured view, never a live path. */
export function conversationViewDocument(view, path) {
  const index = view.knowledge.documents.findIndex(document => document.path === path)
  const file = view.documents[index], expected = view.knowledge.documents[index]
  if (!file || !expected) throw new Error('Document is outside this conversation view')
  const { text, bytes, ...identity } = file
  if (!isDeepStrictEqual(identity, expected) || Buffer.byteLength(text) !== bytes || contentHash(text) !== expected.contentHash) {
    throw new Error('Conversation document contradicts its captured knowledge')
  }
  return text
}

/** Inspection publishes identities and sizes only, never document or policy contents. */
export function inspectConversationView(view) {
  return structuredClone({ schemaVersion: 1, head: view.head, knowledge: view.knowledge,
    documents: view.documents.map(({ text, ...document }) => document) })
}
