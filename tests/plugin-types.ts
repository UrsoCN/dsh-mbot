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
