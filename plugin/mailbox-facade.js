// Trusted Host mailboxes over the single authoritative DSH Inbox.
import { ownerBinding, ownerMessage, requestIdentity, deliveryReceipt } from './messages.js'
import { messageReceipt } from './receipts.js'
import { conversationForSession } from './conversations.js'
import { conversationMessageBinding, conversationMessage } from './conversation-messages.js'
import { isDeepStrictEqual } from 'node:util'
import { domainMessageScope } from './domain-message.js'

export function createOwnerMailbox(runtime, agent, options) {
  const state = runtime.states.get(agent)
  if (!state || runtime.closed || !runtime.ready || state.closing || state.initializing) throw new Error('Session is not managed by the active MBot Runtime')
  if (state.earlyEvents) throw new Error('Managed Session attachment is still initializing')
  const bot = runtime.ctx.mbot.bot({ botId: state.botId })
  if (bot.mainSessionId !== agent.id || bot.binding?.state !== 'ready') throw new Error('Owner mailbox requires a ready Bot main Session')
  const binding = ownerBinding(options, state.botId)
  return createMailbox(runtime, agent, state, binding, ownerMessage, () => {
    const current = runtime.ctx.mbot.bot({ botId: state.botId })
    if (current.mainSessionId !== agent.id || current.binding?.state !== 'ready') throw new Error('Bot main Session binding changed; reopen the mailbox')
  })
}

/** Receive into an already materialized reserved domain; does not activate it. */
export function createConversationMailbox(runtime, agent, attestation) {
  const state = runtime.states.get(agent)
  if (!state?.domainScope || runtime.closed || !runtime.ready || state.closing || state.initializing || state.earlyEvents) throw new Error('Conversation mailbox requires an attached domain Session')
  const captured = structuredClone(attestation)
  const currentBinding = () => {
    runtime.ctx.mbot.bot({ botId: state.botId }) // Retired ownership cannot issue capabilities.
    const record = conversationForSession(runtime.ctx.mbot.registry(), agent.id)
    if (!record || record.botId !== state.botId) throw new Error('Conversation mailbox ownership changed')
    const binding = conversationMessageBinding(record, captured)
    if (!isDeepStrictEqual(domainMessageScope(binding), state.domainScope)) throw new Error('Conversation mailbox no longer matches its Runtime scope')
    return binding
  }
  const binding = currentBinding()
  return createMailbox(runtime, agent, state, binding, conversationMessage, () => {
    if (!isDeepStrictEqual(binding, currentBinding())) throw new Error('Conversation mailbox permission changed')
  })
}

function createMailbox(runtime, agent, state, binding, createMessage, checkBinding) {
  let revoked = false
  const check = () => {
    if (revoked || runtime.closed || state.closing || state.retiring || runtime.states.get(agent) !== state || runtime.ctx.mbot.closed) throw new Error('MBot mailbox is unavailable')
    checkBinding()
  }
  const operation = run => {
    try { check() } catch (error) { return Promise.reject(error) }
    const pending = state.messageOperations.then(() => { check(); return run() })
    state.messageOperations = pending.catch(() => {})
    return pending
  }
  return Object.freeze({
    binding,
    send: input => {
      // Own caller bytes before the first await, including duplicate retries.
      let message
      try { check(); message = createMessage(binding, input) }
      catch (error) { return Promise.reject(error) }
      return operation(async () => {
        let record = state.messageIndex.requests.get(requestIdentity(message))
        if (record) {
          if (record.conflict || record.message.source.mbot?.fingerprint !== message.source.mbot.fingerprint) throw new Error('Request identity was reused with changed content or reply route')
        } else {
          agent.followup(message)
          record = state.messageIndex.requests.get(requestIdentity(message))
        }
        try {
          await runtime.ctx.sessions.flush(agent.session)
          check()
          return deliveryReceipt(record, 'confirmed')
        } catch {
          // Append may already be durable, claimed, or executing. Same-ID
          // retry inspects native history; it never inserts a replacement.
          return deliveryReceipt(record, 'unconfirmed')
        }
      })
    },
    receipt: requestId => operation(async () => {
      check()
      const probe = createMessage(binding, { requestId, text: 'receipt lookup' })
      const record = state.messageIndex.requests.get(requestIdentity(probe))
      if (!record) return undefined
      if (record.conflict) throw new Error('Request identity was reused with changed content or duplicate native input')
      const source = record.message.source.mbot
      if (!source || Object.keys(binding).some(key => source[key] !== binding[key])) throw new Error(`Request belongs to a different ${binding.schemaVersion === 2 ? 'conversation' : 'owner'} route`)
      let confirmation = 'confirmed'
      try { await runtime.ctx.sessions.flush(agent.session); check() }
      catch { confirmation = 'unconfirmed' }
      check()
      const receipt = await messageReceipt(runtime, agent, state.botId, record.rpcId, binding, confirmation)
      check()
      return receipt
    }),
    dispose: () => { revoked = true },
  })
}
