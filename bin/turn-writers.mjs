#!/usr/bin/env node
// Recovery observes current processes; a pid written in a journal is not liveness proof.
import { readFile, readdir, stat } from 'node:fs/promises'
import { validateRecoveryProof } from '../plugin/recovery-proof.js'
import { currentBootId, validBootId } from '../plugin/recovery.js'
import { setTimeout as delay } from 'node:timers/promises'

async function start(pid) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u)
    return fields[0] === 'Z' ? undefined : fields[19]
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return; throw error }
}

async function processInfo(pid) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u)
    return fields[0] === 'Z' ? undefined : { pid, parent: Number(fields[1]), birth: fields[19] }
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return; throw error }
}

// The completed readonly core contract launches fresh data children, never
// delegates permission to existing daemons. An independent branch already
// present before this helper cannot contain one of those children. A dead
// owner, unknown orphan or actual owner descendant remains unconfirmed.
async function unrelatedReadonlyBranch(pid, birth, record) {
  const owner = await processInfo(record.ownerPid)
  const target = await processInfo(pid)
  if (!owner || owner.birth !== record.ownerStart || !target || target.birth !== birth) return false
  const ancestors = new Map()
  let item = owner
  for (let depth = 0; item && depth < 64; depth++) {
    ancestors.set(item.pid, item)
    item = item.parent > 0 ? await processInfo(item.parent) : undefined
  }
  let branch
  item = target
  for (let depth = 0; item && depth < 64; depth++) {
    if (item.pid === owner.pid) return false
    if (ancestors.has(item.pid)) {
      if (!branch || BigInt(branch.birth) >= BigInt(record.pidStart)) return false
      const [nowOwner, nowTarget, nowBranch] = await Promise.all([processInfo(owner.pid), processInfo(pid), processInfo(branch.pid)])
      return nowOwner?.birth === owner.birth && nowOwner.parent === owner.parent && nowTarget?.birth === birth
        && nowTarget.parent === target.parent && nowBranch?.birth === branch.birth && nowBranch.parent === branch.parent
    }
    branch = item
    item = item.parent > 0 ? await processInfo(item.parent) : undefined
  }
  return false
}

try {
  let record
  let runtimeProof
  try { record = JSON.parse(await readFile(process.argv[2], 'utf8')) }
  catch { throw new Error('Invalid turn journal process metadata') }
  if (record.writerScope === 'agent-runtime') {
    const proof = runtimeProof = await validateRecoveryProof(process.argv[5], record)
    if (String(proof.ownerPid) !== process.argv[3] || proof.ownerStart !== process.argv[4]) throw new Error('Runtime recovery proof does not belong to the coordinating Host')
  } else if (record.writerScope !== 'data-subprocesses') throw new Error('Unsupported writer recovery scope')
  if (record.bootId !== undefined && !validBootId(record.bootId)) throw new Error('Invalid turn journal boot identity')
  const bootId = await currentBootId()
  const sameBoot = record.bootId === undefined || record.bootId === bootId
  const permits = new Set([record.token, ...(record.actors ?? []).map(actor => actor.token)])
  const holdsPermit = env => env.some(value => {
    const match = /^(?:MBOT_PERMIT_TOKEN|DSH_MBOT_PERMIT_TOKEN)=(.*)$/u.exec(value)
    return match && permits.has(match[1])
  })
  // If the journal recorded a bootId from a previous kernel boot, the original
  // helper and owning Host processes cannot still be running (PID and /proc
  // starttime ticks reset on reboot). We still scan live same-UID processes for
  // any process carrying the permit token, without falsely treating a reused
  // PID/birth or comparing cross-boot starttime ticks as live original owners.
  if (sameBoot) {
    for (const [pid, expected, label] of [[record.pid, record.pidStart, 'turn writer'], [record.ownerPid, record.ownerStart, 'owning Host']]) {
      if (!Number.isSafeInteger(pid) || pid <= 0) continue
      const live = await start(pid)
      if (!live || (expected && expected !== live)) continue
      const confirmed = label === 'owning Host' && (String(pid) === process.argv[3] && live === process.argv[4]
        || runtimeProof?.mode === 'legacy-readonly')
      if (!confirmed) throw new Error(`${label} is still present; stop or settle it before recovery (pid ${pid})`)
    }
  }
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/u.test(name) || Number(name) === process.pid) continue
    let info
    try { info = await stat(`/proc/${name}`) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (info.uid !== process.getuid()) continue
    // Zombies cannot execute or write, and their environ may already be root-owned.
    // Check executable liveness before demanding access to environment bytes.
    const birth = await start(Number(name))
    if (!birth) continue
    let env
    try { env = (await readFile(`/proc/${name}/environ`, 'utf8')).split('\0') }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue
      if (await start(Number(name)) !== birth) continue
      // Data subprocesses are fresh. For agent-runtime the Host proof also
      // holds the native writer, joins every captured foreground call, and
      // rejects Worker/background/IPC writer contracts. Neither scope grants
      // permits to an already running daemon; the old Host is checked above.
      // After a real reboot (different bootId), no process from the old boot
      // survived, and no new permit was issued before this recovery.
      if (!sameBoot) continue
      if (BigInt(birth) < BigInt(record.pidStart)) continue
      if (runtimeProof?.mode === 'legacy-readonly' && await unrelatedReadonlyBranch(Number(name), birth, record)) continue
      // A freshly exiting subprocess may lose readable environ before its
      // zombie/exit becomes observable. Recheck that exact birth briefly;
      // persistent unreadable live processes still refuse recovery.
      for (let attempt = 0; attempt < 3; attempt++) {
        await delay(25)
        if (await start(Number(name)) !== birth) break
        try { env = (await readFile(`/proc/${name}/environ`, 'utf8')).split('\0'); break }
        catch (retry) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(retry.code)) throw retry }
      }
      if (env) {
        if (holdsPermit(env)) throw new Error(`A permit-bearing process is still present (pid ${name}); settle it before recovery`)
        continue
      }
      if (await start(Number(name)) !== birth) continue
      // A newly launched inaccessible process could still hold the permit.
      throw new Error(`Cannot inspect possible writer pid ${name}`)
    }
    if (holdsPermit(env)) {
      throw new Error(`A permit-bearing process is still present (pid ${name}); settle it before recovery`)
    }
  }
  process.stdout.write(JSON.stringify({ kind: 'quiescent', writerScope: record.writerScope }) + '\n')
} catch (error) {
  process.stderr.write(`mbot: ${error.message}\n`)
  process.exitCode = 1
}
