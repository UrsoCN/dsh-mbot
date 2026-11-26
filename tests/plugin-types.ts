import { Context } from '@deepseek-ai/cordis'
import * as plugin from 'dsh-mbot'
import * as tools from 'dsh-mbot/tools'
import * as commands from 'dsh-mbot/commands'
import * as runtime from 'dsh-mbot/runtime'

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
const binding: Promise<plugin.BotRegistration> = ctx.mbot.ensureBinding('example', { revision: registry.revision })
void binding
ctx.mbot.resolveMainSession('example', { revision: registry.revision })
const turn: Promise<plugin.TurnLease> = ctx.mbot.beginTurn({ botId: 'example', sessionId: 'session', turn: 1, request: 'hello' })
void turn
const recovery: Promise<plugin.RecoverTurnResult> = ctx.mbot.recoverTurn({ botId: 'example' })
void recovery
ctx.plugin(runtime)
declare const managedAgent: import('@deepseek-ai/dsh-agent').Agent
ctx.mbotRuntime.attach(managedAgent, { botId: 'example' })
ctx.mbotRuntime.settled(managedAgent)
const runtimeStatus: Promise<runtime.RuntimeStatus> = ctx.mbotRuntime.status(managedAgent)
const stopped: Promise<runtime.RuntimeStopResult> = ctx.mbotRuntime.stop(managedAgent, { signal: new AbortController().signal })
void runtimeStatus
void stopped
