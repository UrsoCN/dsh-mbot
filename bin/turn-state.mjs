#!/usr/bin/env node
// Shared CLI helper for durable turn state directory management, validation, and fsync.
import { lstat, readFile, realpath } from 'node:fs/promises'
import { createDurableTurnDir, resolveStateRoot, validateTurnScratch, atomicWriteSync, syncFile, syncDir, stateFormatVersion } from '../plugin/turn-state.js'
import { currentBootId } from '../plugin/recovery.js'

try {
  const [command, ...args] = process.argv.slice(2)
  if (command === '--create') {
    const [workspace, runId] = args
    const created = await createDurableTurnDir(workspace, runId)
    process.stdout.write(JSON.stringify({ formatVersion: stateFormatVersion, dir: created.dir, root: created.root }) + '\n')
  } else if (command === '--validate') {
    const [ledgerPath] = args
    const info = await lstat(ledgerPath)
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.size > 65536) {
      throw new Error('Invalid turn journal file')
    }
    const journal = JSON.parse(await readFile(ledgerPath, 'utf8'))
    const verified = await validateTurnScratch(journal)
    process.stdout.write(JSON.stringify(verified) + '\n')
  } else if (command === '--validate-path') {
    const [scratch, workspace, runId, formatVersionRaw] = args
    const formatVersion = formatVersionRaw === '' || formatVersionRaw === undefined ? undefined : Number(formatVersionRaw)
    const verified = await validateTurnScratch({ scratch, workspace: await realpath(workspace), runId, ...(formatVersion === undefined ? {} : { scratchFormatVersion: formatVersion }) })
    process.stdout.write(JSON.stringify(verified) + '\n')
  } else if (command === '--boot-id') {
    process.stdout.write((await currentBootId()) + '\n')
  } else if (command === '--state-root') {
    process.stdout.write(resolveStateRoot() + '\n')
  } else if (command === '--sync') {
    for (const target of args) {
      const info = await lstat(target)
      if (info.isDirectory()) await syncDir(target)
      else if (info.isFile()) await syncFile(target)
    }
  } else if (command === '--atomic-write') {
    const [target] = args
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    await atomicWriteSync(target, Buffer.concat(chunks), 0o600)
  } else {
    throw new Error('Unknown turn-state command')
  }
} catch (error) {
  process.stderr.write(`mbot: ${error.message}\n`)
  process.exitCode = 1
}
