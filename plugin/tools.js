import { defineTool } from '@deepseek-ai/dsh-tools'
import { approveEscalation } from '@deepseek-ai/dsh-sandbox'

export const name = 'tool-mbot'
export const inject = ['tools', 'mbot', 'sandboxPolicy']
export const actions = ['boot', 'status', 'lint', 'board_show', 'board_add', 'board_set', 'task_show', 'task_result', 'remember']

function required(value, field, singleLine = true) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || (singleLine && /[\r\n]/u.test(value))
    || value === '--help' || value === '-h') throw new Error(`${field} requires nonempty ${singleLine ? 'single-line ' : ''}text`)
  return value
}

/** Convert a fixed operation into argv; user/model text is never evaluated by a shell. */
export function toolCommand(args) {
  const id = () => required(args.task_id, 'task_id')
  const text = () => required(args.text, 'text')
  switch (args.action) {
    case 'status': return { program: 'mbot', argv: ['status'] }
    case 'lint': return { program: 'botctl', argv: ['lint'] }
    case 'boot': return { program: 'botctl', argv: ['boot', required(args.bot, 'bot'), ...(args.task_id ? ['--task', id()] : [])] }
    case 'board_show': return { program: 'botctl', argv: ['board', 'show', ...(args.state ? ['--status', args.state] : [])] }
    case 'board_add': return { program: 'botctl', argv: ['board', 'add', text(), ...(args.owner ? ['--owner', args.owner] : [])] }
    case 'board_set': return { program: 'botctl', argv: ['board', 'set', id(), required(args.state, 'state'),
      ...(args.owner ? ['--owner', args.owner] : []), ...(args.reason ? ['--reason', required(args.reason, 'reason')] : [])] }
    case 'task_show': return { program: 'botctl', argv: ['task', 'show', id()] }
    case 'task_result': return { program: 'botctl', argv: ['task', 'result', id(), ...(args.as ? ['--as', args.as] : [])], input: required(args.text, 'text', false) }
    case 'remember': return { program: 'botctl', argv: ['remember', text(), ...(args.as ? ['--as', args.as] : []), ...(args.task_id ? ['--task', id()] : [])] }
    default: throw new Error('unknown botctl action')
  }
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'botctl',
    timeoutMs: 60000,
    description: 'Inspect and update the configured MBot Markdown/Git task board, task results and memory candidates. boot reads a role, status/lint inspect the workspace; remember only appends to inbox. Never writes MEMORY directly or launches another model. Calls require danger-full-access or approval because the bot data repository is host-managed; approval is for this call and does not change session permissions. Managed Sessions join their current audited turn; legacy headless mbot runs use Bash botctl. Human setup and run/dream controls use /mbot.',
    parameters: {
      action: { type: 'string', required: true, enum: actions, description: 'Workspace operation.' },
      bot: { type: 'string', description: 'Role for boot, such as chief or coder.' },
      task_id: { type: 'string', description: 'Existing task id, for example 001.' },
      text: { type: 'string', description: 'Task title, result or memory candidate; task_result allows multiple lines.' },
      state: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'], description: 'State for board_set or filter for board_show.' },
      owner: { type: 'string', description: 'Task owner role.' },
      reason: { type: 'string', description: 'Required explanation when marking blocked.' },
      as: { type: 'string', description: 'Result/candidate author role.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (process.env.MBOT_RUN_ID !== undefined) throw new Error('Managed runs use Bash botctl under the host guard; native botctl is unavailable here')
      const selection = { sessionId: exec.agent?.id ?? exec.agent?.session?.id }
      const runtime = ctx.get('mbotRuntime')
      const lease = exec.agent && runtime?.managed(exec.agent) ? runtime.dataLease(exec.agent) : undefined
      if (lease && ['task_result', 'remember'].includes(args.action) && args.as !== undefined && args.as !== lease.snapshot.role) {
        throw new Error('Result/candidate author must match the managed role')
      }
      const command = toolCommand(lease && ['task_result', 'remember'].includes(args.action) ? { ...args, as: lease.snapshot.role } : args)
      // Capture the target before approval so another window cannot redirect this call.
      const workspace = lease?.snapshot.workspace ?? ctx.mbot.workspace(selection)
      const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
      await approveEscalation({ requestedMode: 'danger-full-access', effectiveMode: policy.mode,
        subject: 'MBot workspace operation', justification: `botctl ${args.action} on the configured bot repository; updates create audited Git commits.` },
      { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'botctl', signal: exec.signal })
      const result = lease
        ? await lease.execute(command.program, command.argv, { signal: exec.signal, input: command.input })
        : await ctx.mbot.execute(command.program, command.argv, { signal: exec.signal, input: command.input, workspace })
      if (result.exitCode) throw new Error(result.stderr || result.stdout || `botctl failed (${result.exitCode})`)
      return result.stdout + (result.truncated ? '\n[Output truncated]' : '')
    },
    presentCall: args => ({ card: 'generic', title: `botctl ${args.action}`, kind: ['boot', 'status', 'lint', 'board_show', 'task_show'].includes(args.action) ? 'read' : 'write' }),
  }))
}
