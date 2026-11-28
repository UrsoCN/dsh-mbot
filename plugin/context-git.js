import { execFileSync } from 'node:child_process'

export function contextGit(workspace, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', workspace, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
}
