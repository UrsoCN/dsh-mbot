#!/usr/bin/env node
// Recovery observes current processes; a pid written in a journal is not liveness proof.
import { readFile, readdir, stat } from 'node:fs/promises'

async function start(pid) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u)
    return fields[0] === 'Z' ? undefined : fields[19]
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return; throw error }
}

try {
  let record
  try { record = JSON.parse(await readFile(process.argv[2], 'utf8')) }
  catch { throw new Error('Invalid turn journal process metadata') }
  for (const [pid, expected, label] of [[record.pid, record.pidStart, 'turn writer'], [record.ownerPid, record.ownerStart, 'owning Host']]) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const live = await start(pid)
    if (!live || (expected && expected !== live)) continue
    const confirmed = label === 'owning Host' && String(pid) === process.argv[3] && live === process.argv[4]
    if (!confirmed) throw new Error(`${label} is still present; stop or settle it before recovery (pid ${pid})`)
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
      // This journal covers fresh subprocesses launched by the data bridge only.
      // A protected daemon predating the helper cannot be one of those writers.
      // The older owning Host is checked explicitly above. Agent/Worker/IPC
      // writers require a stronger ownership protocol before changing this scope.
      if (record.writerScope === 'data-subprocesses' && BigInt(birth) < BigInt(record.pidStart)) continue
      // A newly launched inaccessible process could still hold the permit.
      throw new Error(`Cannot inspect possible writer pid ${name}`)
    }
    if (env.some(value => value === `MBOT_PERMIT_TOKEN=${record.token}` || value === `DSH_MBOT_PERMIT_TOKEN=${record.token}`)) {
      throw new Error(`A permit-bearing process is still present (pid ${name}); settle it before recovery`)
    }
  }
  process.stdout.write('{"kind":"quiescent","writerScope":"data-subprocesses"}\n')
} catch (error) {
  process.stderr.write(`mbot: ${error.message}\n`)
  process.exitCode = 1
}
