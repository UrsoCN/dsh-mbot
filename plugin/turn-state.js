import { createHash } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const stateFormatVersion = 1
export const runIdPattern = /^[0-9]{8}T[0-9]{6}Z-turn-[a-f0-9]{16}$/u
export const legacyScratchPattern = /^\/tmp\/mbot-turn\.[A-Za-z0-9]+$/u
export const bootIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Shared durable Host/CLI private state root, outside any Bot data worktree.
 * Priority: MBOT_STATE_DIR > XDG_STATE_HOME/mbot > ~/.local/state/mbot.
 * When DSH_HOME is isolated in a test/profile environment and neither
 * MBOT_STATE_DIR nor XDG_STATE_HOME is set, derive under $DSH_HOME/mbot-state
 * so tests and isolated profiles never touch real ~/.local/state.
 */
export function resolveStateRoot(env = process.env) {
  let root
  if (env.MBOT_STATE_DIR?.trim()) {
    root = expandHome(env.MBOT_STATE_DIR.trim())
  } else if (env.XDG_STATE_HOME?.trim()) {
    root = join(expandHome(env.XDG_STATE_HOME.trim()), 'mbot')
  } else if (env.DSH_HOME?.trim()) {
    root = join(expandHome(env.DSH_HOME.trim()), 'mbot-state')
  } else {
    root = join(homedir(), '.local', 'state', 'mbot')
  }
  if (!isAbsolute(root) || /[\0\r\n]/u.test(root)) throw new Error('MBot durable state root must be an absolute single-line path')
  return resolve(root)
}

export function workspaceKey(workspace) {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 32)
}

export function durableTurnLocation(workspace, runId, env = process.env) {
  if (!isAbsolute(workspace) || /[\0\r\n]/u.test(workspace)) throw new Error('Invalid Bot workspace path')
  if (!runIdPattern.test(runId ?? '')) throw new Error('Invalid managed turn runId')
  const root = resolveStateRoot(env)
  const turnsRoot = join(root, 'turns')
  const key = workspaceKey(workspace)
  const bucket = join(turnsRoot, key)
  const dir = join(bucket, runId)
  return { root, turnsRoot, key, bucket, dir }
}

/** Verify no symlink anywhere from stateRoot down to dir, and private 0700 dirs owned by current UID. */
async function ensurePrivateDir(path) {
  await mkdir(path, { mode: 0o700 })
    .catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
    throw new Error('Unsafe durable turn state directory')
  }
  return info
}

async function ensureAncestors(root) {
  // Create root and its missing ancestors privately if needed; verify root itself is private 0700 non-symlink.
  await mkdir(dirname(root), { recursive: true })
  // Check the canonical path of the parent doesn't traverse a symlink into workspace later.
  return ensurePrivateDir(root)
}

export async function createDurableTurnDir(workspace, runId, env = process.env) {
  const realWs = await realpath(workspace)
  if (realWs !== workspace) throw new Error('Bot workspace must be canonical')
  const loc = durableTurnLocation(workspace, runId, env)
  await ensureAncestors(loc.root)
  const realRoot = await realpath(loc.root)
  if (realRoot === realWs || realRoot.startsWith(`${realWs}/`) || realWs.startsWith(`${realRoot}/`)) {
    throw new Error('Durable turn state root must be outside the Bot data worktree')
  }
  const turnsRoot = join(realRoot, 'turns')
  const bucket = join(turnsRoot, loc.key)
  const dir = join(bucket, runId)
  await ensurePrivateDir(turnsRoot)
  await ensurePrivateDir(bucket)
  await mkdir(dir, { mode: 0o700 })
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
    throw new Error('Unsafe durable turn state directory')
  }
  await syncDir(bucket)
  return { root: realRoot, turnsRoot, bucket, dir }
}

/**
 * Validate a journal's scratch path: accepts either a legacy /tmp/mbot-turn.XXXXXX
 * directory (for backward-compatible read/recovery of pre-R1 journals) or a
 * durable turn state directory matching the current state root + workspace + runId.
 */
export async function validateTurnScratch(journal, env = process.env) {
  const scratch = journal?.scratch
  if (typeof scratch !== 'string' || !scratch || /[\0\r\n]/u.test(scratch)) {
    throw new Error('Invalid turn snapshot location')
  }
  if (legacyScratchPattern.test(scratch)) {
    if (journal.scratchFormatVersion !== undefined) throw new Error('Legacy /tmp snapshot must not declare durable format version')
    const info = await lstat(scratch)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
      throw new Error('Unsafe legacy turn snapshot')
    }
    return { mode: 'legacy', path: scratch }
  }
  if (journal.scratchFormatVersion !== stateFormatVersion) {
    throw new Error('Unsupported or missing durable turn snapshot format version')
  }
  const workspace = journal.workspace
  const runId = journal.runId
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || !runIdPattern.test(runId ?? '')) {
    throw new Error('Invalid durable turn journal identity')
  }
  const loc = durableTurnLocation(workspace, runId, env)
  const realRoot = await realpath(loc.root)
  if (realRoot === workspace || realRoot.startsWith(`${workspace}/`) || workspace.startsWith(`${realRoot}/`)) {
    throw new Error('Durable turn state root overlaps Bot data worktree')
  }
  const expectedTurns = join(realRoot, 'turns')
  const expectedBucket = join(expectedTurns, loc.key)
  const expectedDir = join(expectedBucket, runId)
  if (scratch !== expectedDir) throw new Error('Durable turn snapshot path does not match workspace/run identity')
  for (const dir of [realRoot, expectedTurns, expectedBucket, expectedDir]) {
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
      throw new Error('Unsafe durable turn state path')
    }
  }
  if (basename(expectedDir) !== runId) throw new Error('Durable turn snapshot directory name mismatch')
  return { mode: 'durable', path: expectedDir }
}

export async function syncFile(path) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

export async function syncDir(path) {
  const handle = await open(path, 'r')
  try { await handle.sync() } catch (error) {
    if (!['EINVAL', 'EBADF', 'EROFS'].includes(error.code)) throw error
  } finally { await handle.close() }
}

/** Atomic private file write + fsync(file) + rename + fsync(parentDir). */
export async function atomicWriteSync(targetPath, data, mode = 0o600) {
  const parent = dirname(targetPath)
  const temp = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}.tmp`
  const handle = await open(temp, 'wx', mode)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
  await handle.close()
  await rename(temp, targetPath)
  await syncDir(parent)
}
