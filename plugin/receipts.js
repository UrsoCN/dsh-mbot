import { join } from 'node:path'
import { MessageIndex, deliveryReceipt } from './messages.js'
import { packageRoot } from './index.js'
import { redactValue } from './redact.js'

/** Caller has confirmed its bound route; query never trusts presentation cards. */
export async function messageReceipt(runtime, agent, botId, rpcId, binding, confirmation) {
  const bot = runtime.ctx.mbot.bot({ botId })
  const log = await runtime.ctx.sessionQuery.readSession(agent.id)
  if (log.session.id !== agent.id || log.session.cwd !== bot.workspacePath) throw new Error('Native receipt Session identity changed')
  const index = new MessageIndex()
  for (const event of log.events) index.apply(event, log.inheritedEventCount)
  const record = index.requests.get(rpcId)
  if (!record) return
  if (record.conflict || !record.message.source.mbot || Object.keys(binding).some(key => record.message.source.mbot[key] !== binding[key])) throw new Error('Native request conflicts with its owner reply route')
  const receipt = deliveryReceipt(record, confirmation)
  const observedThroughSeq = log.events.at(-1)?.seq ?? -1
  const result = (status, final = false) => ({ ...receipt, result: { schemaVersion: 1, status, final, observedThroughSeq } })
  if (record.delivery === 'queued') return result('queued')
  if (record.delivery === 'claimed') return result('running')
  if (record.delivery === 'cancelled') return result('cancelled', confirmation === 'confirmed')
  const turn = index.turns.get(record.turn)
  if (!turn || turn.endSeq !== record.endSeq) return result('unverified')
  const events = log.events.filter(event => event.seq >= turn.startSeq && event.seq <= turn.endSeq && !event.ignorable)
  const workers = await runtime.workerLogs(events)
  const child = runtime.ctx.mbot.ctx.subprocess.spawn({ argv: [process.execPath, join(packageRoot, 'bin/turn-receipt.mjs')],
    cwd: packageRoot, graceMs: 5000, stdio: { stdin: { data: JSON.stringify({ workspace: bot.workspacePath, botId, sessionId: agent.id,
      record, turn, confirmation, events, workers }) },
      stdout: { maxBytes: 1600000 }, stderr: { maxBytes: 8000 } } })
  runtime.ctx.mbot.active.add(child)
  try {
    const exited = await child.done
    const output = child.collected.stdout.readFrom(0)
    if (exited.exitCode !== 0 || output.lossy) return result('unverified')
    return await redactValue({ ...receipt, result: { ...JSON.parse(output.text), observedThroughSeq } }, bot.workspacePath)
  } finally {
    child.terminate()
    await child.waitForExit()
    runtime.ctx.mbot.active.delete(child)
  }
}
