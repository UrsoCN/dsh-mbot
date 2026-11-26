import { redact } from './redact.js'

export const name = 'command-mbot'
export const inject = ['commands', 'mbot']
export const usage = '/mbot init [directory] | import <directory> | list | select <botId or name> | recover | status | lint | board | run <request> | tick | archive | dream | pause [reason] | resume'

/** Human grammar: everything after run/pause is literal text, without shell quote parsing. */
export function commandArgs(raw) {
  const input = raw.trim()
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(input)
  const action = match?.[1] ?? 'status'
  const rest = match?.[2] ?? ''
  if (action === 'help') return null
  if (action === 'list' && !rest) return { program: 'host', argv: ['list'] }
  if (action === 'recover' && !rest) return { program: 'host', argv: ['recover'] }
  if (['import', 'select'].includes(action)) {
    if (!rest) throw new Error(usage)
    return { program: 'host', argv: [action, rest] }
  }
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
        const options = { signal: invocation.signal, sessionId: invocation.agent?.id ?? invocation.agent?.session?.id }
        if (command.program === 'host') {
          if (command.argv[0] === 'list') return { kind: 'success', text: await ctx.mbot.describeBots() }
          if (command.argv[0] === 'recover') {
            const result = await ctx.mbot.recoverTurn(options)
            return { kind: 'success', text: result.needed === false ? 'No managed turn needs recovery.' : 'Turn recovered and audited. Review /mbot status, then /mbot resume.' }
          }
          if (command.argv[0] === 'import') {
            const bot = await ctx.mbot.importBot(command.argv[1], options)
            return { kind: 'success', text: await redact(`Imported Bot: ${bot.name} (${bot.botId})\nNext: /mbot select ${bot.botId}\n`, bot.workspacePath) }
          }
          const bot = await ctx.mbot.selectBot(command.argv[1], options)
          return { kind: 'success', text: await redact(`Selected Bot: ${bot.name} (${bot.botId})\nWorkspace: ${bot.workspacePath}\nBound Bot sessions keep their own selection.\n`, bot.workspacePath) }
        }
        const bot = ctx.mbot.bot(options)
        if (command.argv[0] === 'run' && bot) command.argv[1] = bot.defaultRole
        const result = command.argv[0] === 'init'
          ? await ctx.mbot.initialize(command.argv[1], options)
          : await ctx.mbot.execute(command.program, command.argv, options)
        const output = result.stdout + result.stderr
        const text = (command.argv[0] === 'status' && bot ? `Bot: ${bot.name} (${bot.botId})\n` : '') + (output || (result.exitCode ? `mbot failed (${result.exitCode})` : 'Completed.'))
          + (result.truncated ? '\n[Output truncated]' : '')
        return { kind: result.exitCode ? 'error' : 'success', text: await redact(text, bot?.workspacePath) }
      } catch (error) {
        return { kind: 'error', text: await redact(invocation.signal.aborted ? 'Cancelled: /mbot operation stopped.' : error.message ?? String(error)) }
      }
    },
  })
}
