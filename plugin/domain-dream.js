import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { conversationForSession } from './conversations.js'
import { conversationViewScope } from './conversation-view.js'
import { runtimeCells } from './runtime-cells.js'
import { processStart, currentBootId } from './recovery.js'
import { readMaintenanceJournal } from './maintenance-journal.js'
import { validateDomainDreamPlan } from './domain-dream-plan.js'
import { dreamInputType, dreamOutputType, dreamResultType, dreamUsage } from './domain-dream-audit.js'
import { contextHash, freezeContext } from './context-hash.js'
import { restoreContext } from './context-checkpoint.js'
import { redact } from './redact.js'
const packageRoot = fileURLToPath(new URL('../', import.meta.url))

async function connection(runtime, workspace, mode) {
  const child = runtime.ctx.subprocess.spawn({ argv: [join(packageRoot, 'bin/mbot-maintenance'), '-C', workspace, mode],
    cwd: packageRoot, graceMs: 5000,
    env: { DSH_HOME: process.env.DSH_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, MBOT_STATE_DIR: process.env.MBOT_STATE_DIR,
      PATH: `${join(packageRoot, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}` },
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8000 } } })
  runtime.ctx.mbot.active.add(child)
  child.stdin.on('error', () => {})
  const lines = createInterface({ input: child.stdout }), frames = lines[Symbol.asyncIterator]()
  return {
    child,
    async request(frame) {
      const data = JSON.stringify(frame) + '\n'
      if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new Error('Maintenance protocol input budget exceeded')
      let timer
      const wait = (async () => {
        await new Promise((resolve, reject) => child.stdin.write(data, error => error ? reject(error) : resolve()))
        return frames.next()
      })()
      let item
      try {
        item = await Promise.race([wait, new Promise((_, reject) => {
          timer = setTimeout(() => { child.terminate(); reject(new Error('Maintenance writer deadline exceeded; recover its journal')) }, 60000)
        })])
      } finally { clearTimeout(timer) }
      if (item.done) throw new Error(await redact(child.collected.stderr.readFrom(0).text || 'Domain maintenance writer disconnected; recover its journal', workspace))
      const reply = JSON.parse(item.value)
      if (!reply.ok) throw new Error(reply.error)
      return reply.result
    },
    async close() {
      child.stdin.end(); child.terminate(); await child.waitForExit(); lines.close(); runtime.ctx.mbot.active.delete(child)
    },
  }
}

function owner(runtime, agent) {
  const state = runtime.states.get(agent), registration = conversationForSession(runtime.ctx.mbot.registry(), agent.id)
  if (!state || !state.domainScope || !registration || state.closing || state.initializing || state.retiring
    || runtime.closed || !runtime.ready || state.botId !== registration.botId
    || !isDeepStrictEqual(state.domainScope, conversationViewScope(registration))) throw new Error('Domain Dreaming requires the current registered domain owner')
  const bot = runtime.ctx.mbot.bot({ botId: state.botId })
  if (!bot || bot.workspacePath !== agent.session.header.cwd) throw new Error('Domain Dreaming Bot workspace changed')
  return { state, bot, scope: conversationViewScope(registration), cell: runtimeCells.get(agent) }
}

async function publishResult(runtime, agent, result) {
  const expected = { schemaVersion: 1, maintenanceId: result.maintenanceId, outcome: result.kind,
    ...(result.commit ? { commit: result.commit, checkpointHash: contextHash(result.checkpoint) } : {}) }
  const log = await runtime.ctx.sessionQuery.readSession(agent.id)
  const prior = log.events.filter(event => event.type === dreamResultType && event.data.maintenanceId === result.maintenanceId)
  if (prior.length > 1 || prior.length && (!prior[0].ignorable || !isDeepStrictEqual(prior[0].data, expected))) throw new Error('Native Dreaming settlement contradicts its journal')
  if (!prior.length) appendPluginRecord(agent.session, dreamResultType, expected)
  await runtime.ctx.sessions.flush(agent.session)
}

/** Explicit owner maintenance; reserved still blocks all business dispatch. */
export async function runDomainDream(runtime, agent, options = {}) {
  options = { ...options }
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 3600000)) throw new Error('Invalid domain maintenance timeout')
  const { state, bot, scope, cell } = owner(runtime, agent)
  const barrier = await runtime.coordinator.acquireBarrier(bot.botId, 'domain-dream', options)
  let transport, prepared, committing = false
  const controller = new AbortController(), maintenanceId = `dream-${randomUUID()}`
  runtime.domainDreamControllers ??= new Set()
  runtime.domainDreamControllers.add(controller)
  try {
    const host = { pid: process.pid, start: await processStart(), bootId: await currentBootId() }
    return await agent.runMaintenance(async nativeSignal => {
      try {
        const signal = AbortSignal.any([nativeSignal, controller.signal, AbortSignal.timeout(options.timeoutMs ?? 300000), ...(options.signal ? [options.signal] : [])])
        signal.throwIfAborted()
        await runtime.ctx.sessions.flush(agent.session)
        const log = await runtime.ctx.sessionQuery.readSession(agent.id), selection = agent.model.current()
        if (!selection?.provider || !selection.model) throw new Error('Domain Dreaming requires an explicit current model selection')
        const model = { provider: selection.provider, model: selection.model, maxTokens: 4096 }
        if (await readMaintenanceJournal(bot.workspacePath)) throw new Error('Existing maintenance requires recovery')
        transport = await connection(runtime, bot.workspacePath, 'begin')
        const lost = new AbortController()
        void transport.child.done.then(() => lost.abort(new Error('Maintenance writer exited')), error => lost.abort(error))
        const activeSignal = AbortSignal.any([signal, lost.signal])
        cell.domainDreamProof = { maintenanceId, host, drained: false }
        prepared = await transport.request({ kind: 'begin', scope, role: bot.defaultRole, log, model, host, maintenanceId })
        if (prepared.kind === 'empty') return { kind: 'empty', more: false }
        appendPluginRecord(agent.session, dreamInputType, { schemaVersion: 1, maintenanceId: prepared.maintenanceId, scope,
          head: prepared.capture.head, captureHash: prepared.capture.captureHash, requestHash: contextHash(prepared.request) })
        await runtime.ctx.sessions.flush(agent.session)
        await transport.request({ kind: 'start' })
        activeSignal.throwIfAborted()
        const request = Object.freeze({ ...prepared.request, messages: freezeContext(prepared.request.messages), signal: activeSignal })
        cell.domainDreamRequests ??= new WeakSet()
        cell.domainDreamRequests.add(request)
        cell.activeDomainDream = prepared.maintenanceId
        const assembler = new BlockAssembler()
        let sawFinish = false, bytes = 0
        try {
          for await (const chunk of agent.ctx.llm.stream(request)) {
            activeSignal.throwIfAborted()
            bytes += Buffer.byteLength(JSON.stringify(chunk))
            if (bytes > 2 * 1024 * 1024) throw new Error('Domain Dreaming stream exceeds its byte budget')
            assembler.push(chunk); if (chunk.type === 'finish') sawFinish = true
          }
        } finally { cell.activeDomainDream = undefined; cell.domainDreamRequests.delete(request) }
        activeSignal.throwIfAborted()
        const blocks = assembler.blocks()
        if (!sawFinish || assembler.finish.kind !== 'stop' || blocks.some(block => !['text', 'reasoning'].includes(block.type))) {
          throw new Error(`Domain Dreaming did not complete a text-only response (${assembler.finish.kind}${assembler.finish.failure?.message ? ': ' + assembler.finish.failure.message : ''})`)
        }
        const raw = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
        const plan = await validateDomainDreamPlan(bot.workspacePath, prepared.capture, raw)
        owner(runtime, agent)
        appendPluginRecord(agent.session, dreamOutputType, { schemaVersion: 1, maintenanceId: prepared.maintenanceId,
          captureHash: prepared.capture.captureHash, requestHash: contextHash(prepared.request), planHash: plan.planHash,
          rawOutputHash: plan.rawOutputHash, usage: dreamUsage(assembler.usage) })
        await runtime.ctx.sessions.flush(agent.session)
        await transport.request({ kind: 'plan', raw, log: await runtime.ctx.sessionQuery.readSession(agent.id) })
        activeSignal.throwIfAborted()
        committing = true
        const result = await transport.request({ kind: 'commit' })
        await publishResult(runtime, agent, result)
        await restoreContext(state)
        await transport.request({ kind: 'finish' })
        return result
      } catch (error) {
        if (prepared?.kind === 'prepared' && !committing) {
          try {
            const result = await transport.request({ kind: 'abort' })
            await publishResult(runtime, agent, result)
            await transport.request({ kind: 'finish' })
          } catch { /* Unknown changes or a lost writer retain durable evidence. */ }
        }
        throw new Error(await redact(error.message ?? String(error), bot.workspacePath))
      } finally {
        await transport?.close(); transport = undefined
        if (cell.domainDreamProof?.maintenanceId === maintenanceId) cell.domainDreamProof.drained = true
      }
    })
  } finally {
    runtime.domainDreamControllers.delete(controller)
    barrier.release()
  }
}

export async function recoverDomainDream(runtime, bot, options = {}) {
  const journal = await readMaintenanceJournal(bot.workspacePath)
  if (journal?.record.kind !== 'domain-dream') return
  let agent = runtime.ctx.agents.get(journal.record.sessionId)
  if (!agent) {
    const controller = runtime.ctx.get('sessionController')
    if (!controller) throw new Error('Cold Dreaming recovery requires the native Session Controller')
    const resolved = await controller.resolveAgent(journal.record.sessionId)
    if ('error' in resolved) throw resolved.error
    agent = resolved.agent
  }
  const owned = owner(runtime, agent)
  const barrier = await runtime.coordinator.acquireBarrier(bot.botId, 'domain-dream', options)
  let transport
  try {
    return await agent.runMaintenance(async nativeSignal => {
      try {
        const signal = AbortSignal.any([nativeSignal, AbortSignal.timeout(60000), ...(options.signal ? [options.signal] : [])])
        signal.throwIfAborted()
        await runtime.ctx.sessions.flush(agent.session)
        const host = { pid: process.pid, start: await processStart(), bootId: await currentBootId() }
        const proof = owned.cell.domainDreamProof
        signal.throwIfAborted()
        transport = await connection(runtime, bot.workspacePath, 'recover')
        const result = await transport.request({ kind: 'recover', scope: owned.scope, role: bot.defaultRole,
          log: await runtime.ctx.sessionQuery.readSession(agent.id), host,
          captured: proof?.maintenanceId === journal.record.maintenanceId && proof.drained && isDeepStrictEqual(proof.host, host) })
        await publishResult(runtime, agent, result)
        await restoreContext(owned.state)
        await transport.request({ kind: 'finish' })
        return { kind: 'recovered', needed: true, maintenanceRecovered: true, domainDreamRecovered: true,
          maintenanceId: result.maintenanceId, ...(result.commit ? { head: result.commit } : {}) }
      } finally { await transport?.close(); transport = undefined }
    })
  } finally { barrier.release() }
}
