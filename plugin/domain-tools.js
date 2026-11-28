import { defineTool, projectToolSchema } from '@deepseek-ai/dsh-tools'
import { approveEscalation } from '@deepseek-ai/dsh-sandbox'
import { isDeepStrictEqual } from 'node:util'
import { conversationForSession } from './conversations.js'
import { conversationViewScope } from './conversation-view.js'
import { validateDomainScope } from './domain-contract.js'
import { freezeContext } from './context-hash.js'
import { candidateText } from './domain-candidates.js'

const definition = (execute, candidates = false) => defineTool({
  name: 'botctl', timeoutMs: 60000,
  description: 'Read this conversation\'s explicitly published documents from its fixed Git snapshot. boot reads the current role and lists available references; view reads one listed path. The Host binds the Bot, conversation, role and snapshot. ' + (candidates ? 'remember submits an untrusted candidate for this domain only; it does not change long-term memory.' : 'Only these read operations are available.'),
  parameters: {
    action: { type: 'string', required: true, enum: ['boot', 'view', ...(candidates ? ['remember'] : [])], description: candidates ? 'Read the domain view or submit a domain memory candidate.' : 'Read the domain role or one published document.' },
    bot: { type: 'string', description: 'The current role, required only for boot.' },
    path: { type: 'string', description: 'Exact published document path, required only for view.' },
    ...(candidates ? { text: { type: 'string', description: 'Candidate text (1–16384 UTF-8 bytes), required only for remember.' } } : {}),
  },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute,
  presentCall: args => ({ card: 'generic', title: `botctl ${args.action}`, kind: args.action === 'remember' ? 'write' : 'read' }),
})

// Compare the actual native model declaration, not just the tool's name.
export const domainToolSchema = freezeContext(projectToolSchema(definition(async () => { throw new Error('Schema only') }), false))
export const domainCandidateToolSchema = freezeContext(projectToolSchema(definition(async () => { throw new Error('Schema only') }, true), false))
export function domainSchema(snapshot) {
  if (snapshot.candidateVersion !== undefined && snapshot.candidateVersion !== 1) throw new Error('Unsupported domain candidate version')
  return snapshot.candidateVersion === 1 ? domainCandidateToolSchema : domainToolSchema
}

export function domainToolCommand(args, snapshot, callId) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid domain tool arguments')
  validateDomainScope(snapshot.conversation)
  if (args.action === 'boot' && Object.keys(args).sort().join() === 'action,bot' && args.bot === snapshot.role) return ['boot', snapshot.role]
  if (args.action === 'view' && Object.keys(args).sort().join() === 'action,path'
    && typeof args.path === 'string' && snapshot.documents?.some(item => item.path === args.path)) return ['view', args.path]
  if (snapshot.candidateVersion === 1 && args.action === 'remember' && Object.keys(args).sort().join() === 'action,text'
    && typeof callId === 'string' && callId.length) return ['remember', candidateText(args.text), '--call', callId]
  throw new Error('Operation is outside the published conversation view')
}

/** Agent-scoped domain capability; the native gate must first own a matching lease. */
export function registerDomainBotctl(ctx, capturedScope, candidates = true) {
  const scope = freezeContext(structuredClone(validateDomainScope(capturedScope)))
  return ctx.tools.register(definition(async (args, exec) => {
    if (process.env.MBOT_RUN_ID !== undefined) throw new Error('Nested native domain tools are unavailable')
    const runtime = ctx.get('mbotRuntime')
    if (!exec.agent || !runtime?.managed(exec.agent)) throw new Error('Domain tool requires its managed Agent')
    const registration = conversationForSession(ctx.mbot.registry(), exec.agent.id)
    if (!registration || !isDeepStrictEqual(conversationViewScope(registration), scope)) throw new Error('Domain tool ownership changed')
    const lease = runtime.dataLease(exec.agent)
    if (lease.identity.botId !== scope.botId || lease.identity.sessionId !== scope.sessionId
      || !isDeepStrictEqual(lease.snapshot.conversation, scope)
      || (lease.snapshot.candidateVersion === 1) !== candidates) throw new Error('Domain tool does not own this turn')
    const argv = domainToolCommand(args, lease.snapshot, exec.callId)
    const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session })
    await approveEscalation({ requestedMode: 'danger-full-access', effectiveMode: policy.mode,
      subject: args.action === 'remember' ? 'MBot conversation candidate' : 'MBot published conversation documents',
      justification: args.action === 'remember' ? 'Submit an untrusted memory candidate to this conversation domain.' : 'Read the fixed, explicitly published document view for this conversation.' },
    { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'botctl', signal: exec.signal })
    const result = await lease.execute('botctl', argv, { signal: exec.signal })
    if (result.exitCode) throw new Error(result.stderr || result.stdout || 'Domain data operation failed')
    return result.stdout + (result.truncated ? '\n[Output truncated]' : '')
  }, candidates))
}
