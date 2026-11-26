export const name = 'command-mbot'
export const inject = ['commands', 'mbot']
export const usage = '/mbot init [directory] | status | lint | board | run <request> | tick | archive | dream | pause [reason] | resume'

/** Human grammar: everything after run/pause is literal text, without shell quote parsing. */
export function commandArgs(raw) {
  const input = raw.trim()
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(input)
  const action = match?.[1] ?? 'status'
  const rest = match?.[2] ?? ''
  if (action === 'help') return null
  if (action === 'run') {
    if (!rest.trim()) throw new Error(usage)
    return { program: 'mbot', argv: ['run', 'chief', rest] }
  }
  if (action === 'init' || action === 'pause') return { program: 'mbot', argv: [action, ...(rest ? [rest] : [])] }
  if (rest || !['status', 'lint', 'board', 'tick', 'archive', 'dream', 'resume'].includes(action)) throw new Error(usage)
  return { program: ['lint', 'board'].includes(action) ? 'botctl' : 'mbot', argv: action === 'board' ? ['board', 'show'] : [action] }
}

export function apply(ctx) {
  ctx.commands.register({ name: 'mbot', description: 'Manage the bot workspace and launch audited Chief/Dreaming runs.',
    input: { hint: usage }, recordInput: false,
    async handler(invocation) {
      try {
        if (process.env.MBOT_RUN_ID !== undefined) throw new Error('Managed Bots must not invoke /mbot host controls')
        const command = commandArgs(invocation.rawInput)
        if (!command) return { kind: 'success', text: usage }
        const result = command.argv[0] === 'init'
          ? await ctx.mbot.initialize(command.argv[1], { signal: invocation.signal })
          : await ctx.mbot.execute(command.program, command.argv, { signal: invocation.signal })
        const output = result.stdout + result.stderr
        return { kind: result.exitCode ? 'error' : 'success', text: (output || (result.exitCode ? `mbot failed (${result.exitCode})` : 'Completed.'))
          + (result.truncated ? '\n[Output truncated]' : '') }
      } catch (error) {
        return { kind: 'error', text: invocation.signal.aborted ? 'Cancelled: /mbot operation stopped.' : error.message }
      }
    },
  })
}
