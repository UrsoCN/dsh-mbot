// Durable maintenance journal for R3 (manual compact) & R4 (sleep/wake).
// Lives under <stateRoot>/maintenance/<workspaceHash>/current.json outside
// the Bot data worktree, using atomic write + fsync and boot_id binding.
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteSync, resolveStateRoot, syncDir, workspaceKey } from './turn-state.js'
import { currentBootId, processStart, validBootId } from './recovery.js'

export const maintenanceSchemaVersion = 1

async function ensurePrivateDir(path) {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
    throw new Error('Unsafe durable maintenance state directory')
  }
}

export async function maintenanceLocation(workspace, env = process.env) {
  const realWs = await realpath(workspace)
  if (realWs !== workspace) throw new Error('Bot workspace must be canonical')
  const root = resolveStateRoot(env)
  await mkdir(root, { recursive: true, mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const realRoot = await realpath(root)
  if (realRoot === realWs || realRoot.startsWith(`${realWs}/`) || realWs.startsWith(`${realRoot}/`)) {
    throw new Error('Durable maintenance state root must be outside Bot data worktree')
  }
  await ensurePrivateDir(realRoot)
  const base = join(realRoot, 'maintenance')
  const bucket = join(base, workspaceKey(realWs))
  await ensurePrivateDir(base)
  await ensurePrivateDir(bucket)
  return { root: realRoot, base, bucket, file: join(bucket, 'current.json') }
}

export async function readMaintenanceJournal(workspace, env = process.env) {
  const root = resolveStateRoot(env)
  let realRoot
  try { realRoot = await realpath(root) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const file = join(realRoot, 'maintenance', workspaceKey(workspace), 'current.json')
  let info
  try { info = await lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > 1024 * 1024) {
    throw new Error('Unsafe maintenance journal file')
  }
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  const domain = parsed?.schemaVersion === 2 && parsed.kind === 'domain-dream'
  if (!parsed || (!domain && parsed.schemaVersion !== maintenanceSchemaVersion) || parsed.workspace !== workspace
    || !(domain || ['compact', 'sleep'].includes(parsed.kind))
    || (parsed.bootId !== undefined && !validBootId(parsed.bootId))) {
    throw new Error('Invalid maintenance journal record')
  }
  if (domain && (!['prepared', 'running', 'planned', 'applying', 'committing', 'committed', 'aborting', 'aborted', 'settled'].includes(parsed.phase)
    || !/^dream-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(parsed.maintenanceId ?? '')
    || !/^[a-f0-9]{64}$/u.test(parsed.stateHash ?? '') || typeof parsed.directory !== 'string'
    || typeof parsed.botId !== 'string' || !parsed.botId || typeof parsed.sessionId !== 'string' || !parsed.sessionId
    || !Number.isSafeInteger(parsed.ownerPid) || parsed.ownerPid < 1 || !/^[0-9]+$/u.test(parsed.ownerStart ?? '') || !validBootId(parsed.bootId)
    || !Number.isSafeInteger(parsed.host?.pid) || parsed.host.pid < 1 || !/^[0-9]+$/u.test(parsed.host.start ?? '') || !validBootId(parsed.host.bootId))) {
    throw new Error('Invalid domain maintenance journal record')
  }
  return { file, record: parsed }
}

export async function writeMaintenanceJournal(workspace, record, env = process.env) {
  const loc = await maintenanceLocation(workspace, env)
  const payload = {
    schemaVersion: maintenanceSchemaVersion,
    ...record,
    workspace,
    ownerPid: process.pid,
    ownerStart: await processStart(),
    bootId: await currentBootId(),
    updatedAt: new Date().toISOString(),
  }
  await atomicWriteSync(loc.file, JSON.stringify(payload, null, 2) + '\n', 0o600)
  return { file: loc.file, record: payload }
}

export async function clearMaintenanceJournal(workspace, env = process.env) {
  const existing = await readMaintenanceJournal(workspace, env)
  if (!existing) return
  await rm(existing.file, { force: true })
  await syncDir(join(existing.file, '..'))
}

/** Check whether a previous maintenance journal's owning process is still live in the same boot. */
export async function isMaintenanceOwnerLive(record) {
  if (!record?.ownerPid || !record.ownerStart) return false
  if (record.bootId && record.bootId !== await currentBootId()) return false
  try {
    const stat = await readFile(`/proc/${record.ownerPid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
    return fields[0] !== 'Z' && fields[19] === record.ownerStart
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false
    throw error
  }
}
