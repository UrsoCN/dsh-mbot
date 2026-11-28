import { defineTool, projectToolSchema } from '@deepseek-ai/dsh-tools'
import { approveEscalation } from '@deepseek-ai/dsh-sandbox'
import { isDeepStrictEqual } from 'node:util'
import { conversationForSession } from './conversations.js'
import { conversationViewScope } from './conversation-view.js'
import { validateDomainScope } from './domain-contract.js'
import { freezeContext } from './context-hash.js'

const definition = execute => defineTool({
  name: 'botctl', timeoutMs: 60000,
  description: 'Read this conversation\'s explicitly published documents from its fixed Git snapshot. boot reads the current role and lists available references; view reads one listed path. The Host binds the Bot, conversation, role and snapshot. Only these read operations are available.',
  parameters: {
    action: { type: 'string', required: true, enum: ['boot', 'view'], description: 'Read the domain role or one published document.' },
    bot: { type: 'string', description: 'The current role, required only for boot.' },
    path: { type: 'string', description: 'Exact published document path, required only for view.' },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute,
  presentCall: args => ({ card: 'generic', title: `botctl ${args.action}`, kind: 'read' }),
})

// Compare the actual native model declaration, not just the tool's name.
export const domainToolSchema = freezeContext(projectToolSchema(definition(async () => { throw new Error('Schema only') }), false))

export function domainToolCommand(args, snapshot) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid domain tool arguments')
  validateDomainScope(snapshot.conversation)
  if (args.action === 'boot' && Object.keys(args).sort().join() === 'action,bot' && args.bot === snapshot.role) return ['boot', snapshot.role]
  if (args.action === 'view' && Object.keys(args).sort().join() === 'action,path'
    && typeof args.path === 'string' && snapshot.documents?.some(item => item.path === args.path)) return ['view', args.path]
  throw new Error('Operation is outside the published conversation view')
}

/** Agent-scoped read capability; the native gate must first own a domain lease. */
export function registerDomainBotctl(ctx, capturedScope) {
  const scope = freezeContext(structuredClone(validateDomainScope(capturedScope)))
  return ctx.tools.register(definition(async (args, exec) => {
    if (process.env.MBOT_RUN_ID !== undefined) throw new Error('Nested native domain tools are unavailable')
    const runtime = ctx.get('mbotRuntime')
    if (!exec.agent || !runtime?.managed(exec.agent)) throw new Error('Domain tool requires its managed Agent')
    const registration = conversationForSession(ctx.mbot.registry(), exec.agent.id)
    if (!registration || !isDeepStrictEqual(conversationViewScope(registration), scope)) throw new Error('Domain tool ownership changed')
    const lease = runtime.dataLease(exec.agent)
    if (lease.identity.botId !== scope.botId || lease.identity.sessionId !== scope.sessionId
      || !isDeepStrictEqual(lease.snapshot.conversation, scope)) throw new Error('Domain tool does not own this turn')
    const argv = domainToolCommand(args, lease.snapshot)
    const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session })
    await approveEscalation({ requestedMode: 'danger-full-access', effectiveMode: policy.mode,
      subject: 'MBot published conversation documents', justification: 'Read the fixed, explicitly published document view for this conversation.' },
    { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'botctl', signal: exec.signal })
    const result = await lease.execute('botctl', argv, { signal: exec.signal })
    if (result.exitCode) throw new Error(result.stderr || result.stdout || 'Domain document read failed')
    return result.stdout + (result.truncated ? '\n[Output truncated]' : '')
  }))
}
