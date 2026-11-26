import { redact } from './redact.js'
import { nativeBindingAvailable, sessionResult } from './binding.js'

export const name = 'command-mbot'
export const inject = ['commands', 'mbot']
export const usage = '/mbot init [directory] | import <directory> | list | select <botId or name> | open [botId or name] | repair [botId or name] | recover | status | lint | board | run <request> | tick | archive | dream | pause [reason] | resume'

/** Human grammar: everything after run/pause is literal text, without shell quote parsing. */
export function commandArgs(raw) {
  const input = raw.trim()
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(input)
  const action = match?.[1] ?? 'status'
  const rest = match?.[2] ?? ''
  if (action === 'help') return null
  if (action === 'list' && !rest) return { program: 'host', argv: ['list'] }
  if (action === 'recover' && !rest) return { program: 'host', argv: ['recover'] }
  if (['open', 'repair'].includes(action)) return { program: 'host', argv: [action, ...(rest ? [rest] : [])] }
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
            let bot = await ctx.mbot.importBot(command.argv[1], options)
            if (!nativeBindingAvailable(ctx.mbot)) {
              return { kind: 'success', text: await redact(`Imported Bot: ${bot.name} (${bot.botId})\nNative main Session is unavailable in this Host.\nNext: /mbot select ${bot.botId}\n`, bot.workspacePath) }
            }
            try { bot = await ctx.mbot.ensureBinding(bot.botId, options) }
            catch (error) { throw new Error(`Bot identity saved: ${bot.name} (${bot.botId})\n${error.message}\nRetry: /mbot repair ${bot.botId}`, { cause: error }) }
            return { kind: 'success', text: await redact(`Imported Bot: ${bot.name} (${bot.botId})\n${sessionResult(bot)}Next: /mbot open ${bot.botId}\n`, bot.workspacePath) }
          }
          if (['open', 'repair'].includes(command.argv[0])) {
            const selected = command.argv[1] ? ctx.mbot.bot({ botId: command.argv[1] }) : ctx.mbot.bot(options)
            if (!selected) throw new Error('No Bot selected. Use /mbot list.')
            const bot = command.argv[0] === 'open'
              ? await ctx.mbot.resolveMainSession(selected.botId, options)
              : await ctx.mbot.ensureBinding(selected.botId, options)
            return { kind: 'success', text: await redact(`Bot: ${bot.name} (${bot.botId})\n${sessionResult(bot, command.argv[0] === 'open')}`, bot.workspacePath) }
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
        const text = (command.argv[0] === 'status' && bot ? `Bot: ${bot.name} (${bot.botId})\nMain Session: ${bot.mainSessionId ?? 'not bound'}\nBinding: ${bot.binding?.state ?? 'unbound'}\n` : '') + (output || (result.exitCode ? `mbot failed (${result.exitCode})` : 'Completed.'))
          + (result.truncated ? '\n[Output truncated]' : '')
        return { kind: result.exitCode ? 'error' : 'success', text: await redact(text, bot?.workspacePath) }
      } catch (error) {
        return { kind: 'error', text: await redact(invocation.signal.aborted ? 'Cancelled: /mbot operation stopped.' : error.message ?? String(error)) }
      }
    },
  })
}
