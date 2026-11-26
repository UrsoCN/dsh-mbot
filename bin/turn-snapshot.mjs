#!/usr/bin/env node
// Validate saved input before recovery reads or overwrites any private path.
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

try {
  const scratch = process.argv[2]
  const required = ['ledger.json', 'header.json', 'token.json', 'ignored.list', 'settings',
    'session-events.jsonl', 'violations.jsonl', 'stderr', 'grants.json', 'secrets.json']
  for (const name of required) {
    if (!(await lstat(join(scratch, name))).isFile()) throw new Error('Incomplete or unsafe turn snapshot')
  }
  if (!(await lstat(join(scratch, 'ignored'))).isDirectory()) throw new Error('Unsafe ignored-file snapshot')
  const manifest = await readFile(join(scratch, 'ignored.list'), 'utf8')
  if (manifest && !manifest.endsWith('\0')) throw new Error('Invalid ignored-file manifest')
  const paths = new Set(manifest.split('\0').filter(Boolean))
  for (const path of paths) {
    const parts = path.split('/')
    if (parts.some(part => !part || part === '.' || part === '..') || /[\r\n]/u.test(path)) throw new Error('Invalid ignored-file path')
    if (['.mbot/lock', '.mbot/botctl.lock', '.mbot/PAUSED'].includes(path)) continue
    let parent = join(scratch, 'ignored')
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part)
      if (!(await lstat(parent)).isDirectory()) throw new Error('Unsafe ignored-file ancestor')
    }
    const leaf = await lstat(join(scratch, 'ignored', path))
    if (!leaf.isFile() && !leaf.isSymbolicLink()) throw new Error('Incomplete ignored-file snapshot')
  }
  async function walk(directory, relative = '') {
    for (const name of await readdir(directory)) {
      const path = relative ? `${relative}/${name}` : name
      const file = join(directory, name)
      const info = await lstat(file)
      if (info.isSymbolicLink()) {
        // Preserve legitimate ignored leaf symlinks without ever following them.
        if (!path.startsWith('ignored/') || !paths.has(path.slice(8))) throw new Error('Unsafe private snapshot link')
      } else if (info.isDirectory()) await walk(file, path)
      else if (!info.isFile()) throw new Error('Unsafe private snapshot node')
    }
  }
  await walk(scratch)
} catch (error) {
  // Filesystem errors can contain private paths; emit only a fixed diagnostic.
  process.stderr.write(`mbot: ${error.code ? 'Incomplete or unsafe turn snapshot' : error.message}; review manually\n`)
  process.exitCode = 1
}
