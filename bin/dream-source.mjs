#!/usr/bin/env node
// Private Dreaming must not consume domain turns, including old pending inputs.
import { contextGit } from '../plugin/context-git.js'
try {
  const [workspace, commit, path] = process.argv.slice(2)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit ?? '') || typeof path !== 'string') throw new Error('Invalid Dreaming source')
  const git = (...args) => contextGit(workspace, '--no-replace-objects', '--literal-pathspecs', ...args).toString('utf8')
  if (!/^transcripts\/\d{4}-\d{2}-\d{2}\/\d{8}T\d{6}Z-turn-[a-f0-9]{16}\.md$/u.test(path)) {
    process.stdout.write('private\n')
  } else {
    // Classification uses the original addition, so editing/removing the current
    // meta cannot relabel an existing domain transcript as private.
    const added = git('log', '--format=%H', '--diff-filter=A', '--no-renames', commit, '--', path).trim().split('\n')
    if (added.length !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(added[0])) throw new Error('Ambiguous managed transcript origin')
    const metaPath = path.replace(/\.md$/u, '.meta.json')
    const read = at => JSON.parse(git('show', `${at}:${metaPath}`))
    const original = read(added[0]), current = read(commit)
    const domain = meta => {
      if (meta.runtime?.journal_schema_version !== undefined && ![1, 2, 3, 4, 5].includes(meta.runtime.journal_schema_version)) throw new Error('Unknown transcript writer contract')
      return meta.runtime?.conversation !== undefined || [4, 5].includes(meta.runtime?.journal_schema_version)
        || meta.runtime?.context?.snapshot?.schemaVersion === 2 || meta.runtime?.candidates !== undefined
    }
    if (original.run_id !== path.split('/').at(-1).slice(0, -3) || current.run_id !== original.run_id) throw new Error('Managed transcript identity changed')
    process.stdout.write(domain(original) || domain(current) ? 'domain\n' : 'private\n')
  }
} catch {
  process.stderr.write('mbot: Dreaming transcript ownership could not be verified\n')
  process.exitCode = 1
}
