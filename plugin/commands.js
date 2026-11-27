import { redact } from './redact.js'
import { nativeBindingAvailable, sessionResult } from './binding.js'

export const name = 'command-mbot'
export const inject = ['commands', 'mbot']
export const usage = '/mbot init [directory] | import <directory> | list | overview | removed | remove <botId or name> | select <botId or name> | open [botId or name] | repair [botId or name] | runtime [botId or name] | stop [botId or name] | compact [botId or name] | sleep [botId or name] | wake [botId or name] | recover [Bot ID or name] | status | lint | board | run <request> | tick | archive | dream | pause [reason] | resume'

/** Human grammar: everything after run/pause is literal text, without shell quote parsing. */
export function commandArgs(raw) {
  const input = raw.trim()
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(input)
  const action = match?.[1] ?? 'status'
  const rest = match?.[2] ?? ''
  if (action === 'help') return null
  if (['list', 'removed', 'overview'].includes(action) && !rest) return { program: 'host', argv: [action] }
  if (action === 'recover') return { program: 'host', argv: ['recover', ...(rest ? [rest] : [])] }
  if (['open', 'repair', 'runtime', 'stop', 'compact', 'sleep', 'wake'].includes(action)) return { program: 'host', argv: [action, ...(rest ? [rest] : [])] }
  if (['import', 'select', 'remove'].includes(action)) {
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
          if (['runtime', 'stop', 'compact'].includes(command.argv[0])) {
            const runtime = ctx.get('mbotRuntime')
            if (!runtime) throw new Error('MBot Runtime is unavailable')
            let agent = invocation.agent
            const retiredHere = command.argv[0] === 'runtime' && ctx.mbot.registry().retiredBots.some(item => item.sessionIds.includes(agent?.id))
            if (command.argv[1] || !runtime.managed(agent) && !retiredHere) {
              const bot = command.argv[1] ? ctx.mbot.bot({ botId: command.argv[1] }) : ctx.mbot.bot(options)
              if (!bot?.mainSessionId) throw new Error('Bot has no main Session. Use /mbot open or /mbot repair.')
              const controller = ctx.get('sessionController')
              if (!controller) throw new Error('DSH Session Controller is unavailable')
              const resolved = await controller.resolveAgent(bot.mainSessionId)
              if ('error' in resolved) throw resolved.error
              agent = resolved.agent
            }
            if (command.argv[0] === 'compact') {
              const compacted = await runtime.compact(agent, { signal: options.signal, sourceCommandId: invocation.commandId })
              return { kind: 'success', text: await redact(compacted.compacted
                ? `Compacted ${compacted.shadowedCount} history items (~${compacted.shadowedTokenCount} tokens).\nCompaction ID: ${compacted.compactionId}\nKnowledge version: ${compacted.knowledgeVersion.slice(0, 12)}\n`
                : 'No compactable history yet.\n') }
            }
            const status = command.argv[0] === 'stop' ? await runtime.stop(agent, options) : await runtime.status(agent)
            const receipt = command.argv[0] === 'stop' ? status.receipt ?? status.lastReceipt : status.lastReceipt
            return { kind: status.state === 'failed' ? 'error' : 'success', text: await redact(
              `${command.argv[0] === 'stop' ? 'Stop completed; queued inputs retained.\n' : ''}MBot Runtime: ${status.state}\nBot: ${status.botId}\nSession: ${status.sessionId}\nQueued: ${status.queued.nextTurn} next-turn, ${status.queued.nextStep} next-step\n`
              + (receipt ? `Last audit: turn ${receipt.turn}, ${receipt.outcome ?? receipt.phase}${receipt.head ? `, commit ${receipt.head}` : ''}\n` : 'No managed audit yet.\n')
              + (status.error ? `${status.error}\n` : '')) }
          }
          if (command.argv[0] === 'overview') {
            const runtime = ctx.get('mbotRuntime')
            if (!runtime) throw new Error('MBot Runtime is unavailable')
            const snap = await runtime.overview()
            if (!snap.bots.length && !snap.retiredBots.length) return { kind: 'success', text: 'No registered Bots. Use /mbot init <directory> or /mbot import <directory>.\n' }
            const lines = [`MBot overview (revision ${snap.revision}, active ${snap.bots.length}, retired ${snap.retiredBots.length})`]
            for (const item of snap.bots) {
              const mark = item.botId === snap.selectedBotId ? '* ' : '  '
              lines.push(`${mark}${item.name} (${item.botId}) [${item.runtimeState}]`)
              lines.push(`    Workspace: ${item.workspacePath}${item.workspaceExists ? '' : ' (MISSING)'}`)
              lines.push(`    Main Session: ${item.mainSessionId ?? 'not bound'} · Binding: ${item.bindingState}${item.bindingError ? ` (${item.bindingError})` : ''}`)
              lines.push(`    Queued: ${item.queued.nextTurn} next-turn, ${item.queued.nextStep} next-step · Failures: ${item.failures}${item.paused ? ` · PAUSED: ${item.paused}` : ''}`)
              lines.push(`    Knowledge: ${item.knowledgeVersion ? item.knowledgeVersion.slice(0, 12) : 'n/a'} · HEAD: ${item.head ? item.head.slice(0, 12) : 'n/a'}${item.maintenancePhase ? ` · Maintenance: ${item.maintenancePhase}` : ''}`)
              lines.push(`    Board: todo=${item.board.todo} doing=${item.board.doing} blocked=${item.board.blocked} done=${item.board.done} · Memory: ${item.memory.lines}/${item.budgets?.memoryLines.limit ?? '?'} lines, ${item.memory.chars}/${item.budgets?.memoryChars.limit ?? '?'} chars`)
              if (item.hasTurnJournal || item.needsRepair) lines.push(`    Attention: ${item.hasTurnJournal ? 'pending turn journal (run /mbot recover)' : 'needs repair/resume'}`)
            }
            return { kind: 'success', text: await redact(lines.join('\n') + '\n') }
          }
          if (['sleep', 'wake'].includes(command.argv[0])) {
            const runtime = ctx.get('mbotRuntime')
            if (!runtime) throw new Error('MBot Runtime is unavailable')
            const bot = command.argv[1] ? ctx.mbot.bot({ botId: command.argv[1] }) : ctx.mbot.bot(options)
            if (!bot) throw new Error('No Bot selected. Use /mbot list.')
            if (command.argv[0] === 'sleep') {
              const slept = await runtime.sleep(bot.botId, { signal: options.signal })
              return { kind: 'success', text: await redact(
                `${slept.alreadySleeping ? 'Bot is already sleeping.' : 'Bot entered sleep.'}\nBot: ${bot.name} (${bot.botId})\nSession: ${slept.sessionId ?? 'not bound'}\nKnowledge version: ${slept.knowledgeVersion.slice(0, 12)}\nDreaming commit: ${slept.dreamCommit ? slept.dreamCommit.slice(0, 12) : 'none'}\nNative Inbox stays open; use /mbot wake ${bot.botId} to resume.\n`, bot.workspacePath) }
            }
            const woken = await runtime.wake(bot.botId, { signal: options.signal })
            return { kind: 'success', text: await redact(
              `${woken.wasSleeping ? 'Bot woke up.' : 'Bot was already awake.'}\nBot: ${bot.name} (${bot.botId})\nSession: ${woken.sessionId ?? 'not bound'}\nKnowledge version: ${woken.knowledgeVersion.slice(0, 12)}\nQueued: ${woken.queued.nextTurn} next-turn, ${woken.queued.nextStep} next-step\n`, bot.workspacePath) }
          }
          if (command.argv[0] === 'list') return { kind: 'success', text: await ctx.mbot.describeBots() }
          if (command.argv[0] === 'removed') return { kind: 'success', text: await ctx.mbot.describeRemovedBots() }
          if (command.argv[0] === 'remove') {
            const result = await ctx.mbot.removeBot(command.argv[1], options)
            return { kind: 'success', text: await redact(`Bot removed from active registry: ${result.bot.name} (${result.bot.botId})\nData preserved: ${result.bot.workspacePath}\nRetired Sessions: ${result.sessionIds.join(', ') || 'none'}\nView: /mbot removed\n`, result.bot.workspacePath) }
          }
          if (command.argv[0] === 'recover') {
            const result = await ctx.mbot.recoverTurn({ ...options, ...(command.argv[1] ? { botId: command.argv[1] } : {}) })
            return { kind: 'success', text: result.receiptRepaired ? 'Native audit receipt repaired; no new Git commit. Review /mbot runtime.'
              : result.sleepRecovered ? 'Interrupted sleep maintenance recovered and verified. Review /mbot runtime.'
              : result.maintenanceRecovered ? 'Interrupted maintenance compaction recovered and verified. Review /mbot runtime.'
              : result.needed === false ? 'No managed turn needs recovery.' : 'Turn recovered and audited. Review /mbot status, then /mbot resume.' }
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
        const bot = command.argv[0] === 'init' ? undefined : ctx.mbot.bot(options)
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
