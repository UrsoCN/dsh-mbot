// Exact worktree inventory and bounded, attributed writes for the maintenance
// subprocess. Unknown changes are preserved for inspection, never overwritten.
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, readdirSync, readlinkSync,
  readFileSync, writeFileSync, fsyncSync, fchmodSync, renameSync, unlinkSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { execFileSync } from 'node:child_process'
import { contentHash } from './context-hash.js'

export const maintenanceMarker = '.mbot/runs/maintenance.json'
const excluded = new Set(['.git', '.mbot/lock', '.mbot/botctl.lock', '.mbot/PAUSED', maintenanceMarker])
// Even baseline write-tree/status can write the index. Keep the lock ownership
// with every child, including one that outlives a killed maintenance helper.
const git = (ws, ...args) => execFileSync('git', ['--no-replace-objects', '--literal-pathspecs',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', ws, ...args], {
  stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 8, 9], maxBuffer: 32 * 1024 * 1024,
})
export const maintenanceHead = ws => git(ws, 'rev-parse', 'HEAD').toString().trim()
const maintenanceRef = ws => git(ws, 'rev-parse', '--symbolic-full-name', 'HEAD').toString().trim()

function safeParent(ws, relative) {
  if (!relative || relative.startsWith('/') || /[\0\r\n\\]/u.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe maintenance data path')
  let current = ws
  for (const part of relative.split('/').slice(0, -1)) {
    current = join(current, part)
    const info = lstatSync(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Maintenance ancestor is not a directory')
  }
  return join(ws, relative)
}

function inspect(path) {
  const info = lstatSync(path), mode = info.mode & 0o777
  if (info.isDirectory()) return { kind: 'directory', mode }
  if (info.isSymbolicLink()) return { kind: 'symlink', mode, target: readlinkSync(path) }
  if (!info.isFile() || info.nlink !== 1) throw new Error('Maintenance refuses special files or hard links')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd), hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    if (before.dev !== info.dev || before.ino !== info.ino) throw new Error('Maintenance file identity changed')
    let count = 0, n
    while ((n = readSync(fd, buffer, 0, buffer.length, null))) { hash.update(buffer.subarray(0, n)); count += n }
    const after = fstatSync(fd)
    if (before.size !== count || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Maintenance file changed during inspection')
    return { kind: 'file', mode, bytes: count, hash: hash.digest('hex') }
  } finally { closeSync(fd) }
}

export function inventory(workspace) {
  if (realpathSync(workspace) !== workspace) throw new Error('Maintenance workspace is not canonical')
  const result = {}
  const walk = relative => {
    for (const name of readdirSync(join(workspace, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name
      if (excluded.has(path)) continue
      const entry = inspect(safeParent(workspace, path))
      Object.defineProperty(result, path, { value: entry, enumerable: true, writable: true, configurable: true })
      if (entry.kind === 'directory') walk(path)
    }
  }
  walk(''); return result
}

export function lockIdentity(workspace) {
  return [8, 9].map((fd, index) => {
    const path = join(workspace, index === 0 ? '.mbot/lock' : '.mbot/botctl.lock')
    const held = fstatSync(fd), actual = lstatSync(path)
    if (!actual.isFile() || actual.isSymbolicLink() || actual.dev !== held.dev || actual.ino !== held.ino) throw new Error('Maintenance data lock was replaced')
    return { dev: actual.dev, ino: actual.ino }
  })
}

export function baseline(workspace) {
  if (git(workspace, 'status', '--porcelain=v1', '-uall').length) throw new Error('Maintenance requires a clean worktree and index')
  const gitDir = git(workspace, 'rev-parse', '--absolute-git-dir').toString().trim(), info = lstatSync(gitDir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe maintenance Git directory')
  const ref = maintenanceRef(workspace)
  return { head: maintenanceHead(workspace), ref, gitDir, gitInode: { dev: info.dev, ino: info.ino },
    indexTree: git(workspace, 'write-tree').toString().trim(), locks: lockIdentity(workspace), files: inventory(workspace) }
}

export function verifyBaseline(workspace, original, writes = [], partial = false, head = original.head) {
  if (maintenanceHead(workspace) !== head || maintenanceRef(workspace) !== original.ref
    || git(workspace, 'rev-parse', '--absolute-git-dir').toString().trim() !== original.gitDir) throw new Error('Maintenance Git HEAD or directory changed')
  const info = lstatSync(original.gitDir)
  if (info.dev !== original.gitInode.dev || info.ino !== original.gitInode.ino || !isDeepStrictEqual(lockIdentity(workspace), original.locks)) throw new Error('Maintenance Git or lock identity changed')
  // All commits use a private index, so the normal index remains at baseline
  // until a confirmed commit is synchronized explicitly at settlement.
  const tree = git(workspace, 'write-tree').toString().trim()
  const headTree = git(workspace, 'rev-parse', `${head}^{tree}`).toString().trim()
  if (original.indexTree !== git(workspace, 'rev-parse', `${original.head}^{tree}`).toString().trim()
    || tree !== original.indexTree && !(head !== original.head && tree === headTree)) throw new Error('Maintenance index changed')
  const actual = inventory(workspace), expected = { ...original.files }
  for (const write of writes) {
    if (write.tempPath && actual[write.tempPath]) {
      const temporary = actual[write.tempPath], bytes = Buffer.from(write.text)
      const before = original.files[write.path]
      const rollback = before?.kind === 'file' ? git(workspace, 'cat-file', 'blob', `${original.head}:${write.path}`) : null
      const prefix = value => value && temporary.bytes <= value.length && temporary.hash === contentHash(value.subarray(0, temporary.bytes))
      if (!partial || temporary.kind !== 'file' || temporary.mode !== write.mode || !(prefix(bytes) || prefix(rollback))) throw new Error('Maintenance temporary file changed')
      delete actual[write.tempPath]
    }
    const before = original.files[write.path], after = { kind: 'file', mode: write.mode, bytes: Buffer.byteLength(write.text), hash: contentHash(write.text) }
    if (partial && (isDeepStrictEqual(actual[write.path], before) || (!actual[write.path] && !before))) continue
    expected[write.path] = after
  }
  if (!isDeepStrictEqual(actual, expected)) throw new Error('Maintenance worktree differs from its recorded write set; preserve it for inspection')
}

function syncParent(path) { const fd = openSync(dirname(path), 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }

/** Each exact same-directory temp name is persisted before any write begins. */
export function applyWrites(workspace, writes) {
  for (const write of writes) {
    const destination = safeParent(workspace, write.path)
    const temp = safeParent(workspace, write.tempPath)
    // Caller verifies any interrupted temp against the sealed expected bytes.
    if (existsSync(temp)) unlinkSync(temp)
    const fd = openSync(temp, 'wx', write.mode)
    try { fchmodSync(fd, write.mode); writeFileSync(fd, write.text); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, destination); syncParent(destination)
  }
}

export function rollbackWrites(workspace, original, writes) {
  verifyBaseline(workspace, original, writes, true)
  const old = []
  for (const write of writes) {
    const before = original.files[write.path]
    if (before) {
      const bytes = git(workspace, 'cat-file', 'blob', `${original.head}:${write.path}`)
      if (before.kind !== 'file' || contentHash(bytes) !== before.hash) throw new Error('Maintenance rollback base is not its original Git blob')
      old.push({ path: write.path, text: bytes, mode: before.mode, tempPath: write.tempPath })
    } else {
      const path = safeParent(workspace, write.path)
      if (existsSync(path)) { unlinkSync(path); syncParent(path) }
    }
    const temp = safeParent(workspace, write.tempPath)
    if (existsSync(temp)) { unlinkSync(temp); syncParent(temp) }
  }
  applyWrites(workspace, old)
  verifyBaseline(workspace, original)
}

export function ensureMaintenanceParents(workspace, scope) {
  // Keep all generated artifacts in the existing explicit domain directory:
  // no unrecorded mkdir side effects during apply or rollback.
  safeParent(workspace, `memory/conversations/${scope.conversationId}/checkpoint.json`)
  const runs = join(workspace, '.mbot/runs')
  if (!existsSync(runs)) mkdirSync(runs, { mode: 0o700 })
  safeParent(workspace, maintenanceMarker)
}

export function markerMatches(workspace, marker) {
  const path = safeParent(workspace, maintenanceMarker), info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600
    || readFileSync(path, 'utf8') !== JSON.stringify(marker) + '\n') throw new Error('Maintenance ownership marker changed')
}
