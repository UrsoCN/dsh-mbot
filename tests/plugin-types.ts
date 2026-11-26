import { Context } from '@deepseek-ai/cordis'
import * as plugin from 'dsh-mbot'
import * as tools from 'dsh-mbot/tools'
import * as commands from 'dsh-mbot/commands'

const ctx = new Context()
ctx.plugin(plugin, { workspace: '/tmp/mbot-types' })
ctx.plugin(tools)
ctx.plugin(commands)
const result: Promise<plugin.ExecuteResult> = ctx.mbot.execute('botctl', ['lint'], { signal: new AbortController().signal })
void result
tools.toolCommand({ action: 'board_add', text: 'typed command' })
commands.commandArgs('status')
const registry: plugin.BotRegistrySnapshot = ctx.mbot.registry()
const bot: Promise<plugin.BotRegistration> = ctx.mbot.importBot('/tmp/mbot-types', { name: 'example', revision: registry.revision })
void bot
ctx.mbot.workspace({ sessionId: 'main-session' })
ctx.mbot.selectBot('example', { revision: registry.revision })
const turn: Promise<plugin.TurnLease> = ctx.mbot.beginTurn({ botId: 'example', sessionId: 'session', turn: 1, request: 'hello' })
void turn
