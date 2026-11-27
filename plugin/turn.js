import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { redact, redactValue } from './redact.js'
import { processStart } from './recovery.js'

function write(stream, value) {
  return new Promise((resolve, reject) => stream.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()))
}

/** Host-owned, non-reentrant data transaction. DSH still owns the conversation. */
export class TurnLease {
  #token
  #writes = Promise.resolve()
  #calls = new Set()
  #cancel = new AbortController()
  #completion
  #timer
  #closed = false
  #finalizationTimeoutMs
  #transportEnded = false
  #onExpiry
  #onCancel
  #cancellation
  #botctl

  constructor(mbot, child, frames, ready, identity, finalizationTimeoutMs, onExpiry, onCancel, root) {
    this.mbot = mbot
    this.child = child
    this.frames = frames
    this.#token = ready.token
    this.#onExpiry = onExpiry
    this.#onCancel = onCancel
    this.#botctl = join(root, 'bin', 'botctl')
    Object.defineProperty(this, 'expiresAt', { value: ready.expiresAt })
    void child.done.then(() => { this.#transportEnded = true }, () => { this.#transportEnded = true })
    this.#finalizationTimeoutMs = finalizationTimeoutMs
    Object.defineProperty(this, 'identity', { value: Object.freeze({ ...identity, runId: ready.runId }) })
    Object.defineProperty(this, 'snapshot', { value: Object.freeze(ready.snapshot) })
    const scheduleExpiry = () => {
      if (this.#closed) return
      const remaining = ready.expiresAt - Date.now()
      if (remaining <= 0) { void this.expire().catch(() => {}); return }
      this.#timer = setTimeout(scheduleExpiry, Math.min(remaining, 2147483647))
      this.#timer.unref()
    }
    scheduleExpiry()
  }

  record(event) {
    if (this.#closed) throw new Error('Managed turn is closed')
    // Own the bytes at admission; caller edits cannot change a pending write.
    const frame = JSON.parse(JSON.stringify({ kind: 'event', event }))
    this.#writes = this.#writes.then(() => write(this.child.stdin, frame))
    // Keep eventual transport failure observable by finish, without an unhandled rejection.
    void this.#writes.catch(() => {})
    return this.#writes
  }

  get transportEnded() { return this.#transportEnded }

  async expire() {
    // Runtime owners must stop the model and every writer before any audit.
    await this.#onExpiry?.()
    return this.cancel('Managed turn timeout')
  }

  shellEnvironment() {
    if (this.#closed) throw new Error('Managed turn is closed')
    return { DSH_MBOT_WS: this.snapshot.workspace, DSH_MBOT_RUN_ID: this.identity.runId, DSH_MBOT_PERMIT_TOKEN: this.#token,
      DSH_MBOT_BOTCTL: this.#botctl }
  }

  redactResult(value) {
    return redactValue(value, this.snapshot.workspace, [this.#token])
  }

  execute(program, args, options = {}) {
    if (this.#closed) return Promise.reject(new Error('Managed turn is closed'))
    const signal = options.signal ? AbortSignal.any([options.signal, this.#cancel.signal]) : this.#cancel.signal
    const operation = this.mbot.execute(program, args, { workspace: this.snapshot.workspace, signal, input: options.input,
      permit: { runId: this.identity.runId, token: this.#token } })
    this.#calls.add(operation)
    void operation.finally(() => this.#calls.delete(operation)).catch(() => {})
    return operation
  }

  finish(outcome) {
    if (this.#completion) return this.#completion
    let frozen
    try {
      frozen = JSON.parse(JSON.stringify(outcome))
      if (!frozen?.reason?.kind || typeof frozen.reason.kind !== 'string' || typeof frozen.text !== 'string') throw new Error('Invalid managed turn outcome')
    } catch { return Promise.reject(new Error('Invalid managed turn outcome')) }
    this.#closed = true
    clearTimeout(this.#timer)
    this.#completion = this.complete(frozen)
    return this.#completion
  }

  cancel(message = 'Managed turn cancelled') {
    this.#cancel.abort(new Error(message))
    if (this.#completion) return this.#completion
    if (this.#onCancel) {
      this.#cancellation ??= Promise.resolve().then(() => this.#onCancel(message))
        .then(() => this.finish({ reason: { kind: 'aborted', message }, text: '' }))
      return this.#cancellation
    }
    return this.finish({ reason: { kind: 'aborted', message }, text: '' })
  }

  async complete(outcome) {
    const deadline = setTimeout(() => {
      this.#cancel.abort(new Error('Managed turn finalization timed out'))
      this.child.terminate()
    }, this.#finalizationTimeoutMs)
    deadline.unref()
    try {
      await Promise.allSettled([...this.#calls])
      await this.#writes
      await write(this.child.stdin, { ...outcome, kind: 'finish', token: this.#token })
      this.child.stdin.end()
      const { value, done } = await this.frames.next()
      const result = done ? undefined : JSON.parse(value)
      const exited = await this.child.done
      if (exited.exitCode !== 0 || result?.kind !== 'finished' || result.runId !== this.identity.runId) {
        throw new Error('Managed turn validation or commit did not complete')
      }
      return Object.freeze(result)
    } catch (error) {
      const diagnostics = this.child.collected.stderr?.readFrom(0).text ?? ''
      throw new Error(await redact(diagnostics || error.message, this.snapshot.workspace), { cause: error })
    } finally {
      clearTimeout(deadline)
      this.child.terminate()
      await this.child.waitForExit()
      await this.frames.return?.()
      this.mbot.active.delete(this.child)
      this.mbot.leases.delete(this)
    }
  }
}

export async function openTurn(mbot, root, bot, options) {
  const finalizationTimeoutMs = options.finalizationTimeoutMs ?? 30000
  const header = { kind: 'begin', schemaVersion: 1, botId: bot.botId, sessionId: options.sessionId,
    turn: options.turn, request: options.request, requestIds: [...(options.requestIds ?? [])], writerScope: options.writerScope ?? 'data-subprocesses', finalizationTimeoutMs,
    ...(options.messages === undefined ? {} : { messages: structuredClone(options.messages) }) }
  if (typeof header.sessionId !== 'string' || !header.sessionId || /[\0\r\n]/u.test(header.sessionId)
    || !Number.isSafeInteger(header.turn) || header.turn < 1 || typeof header.request !== 'string' || header.request.includes('\0')
    || header.requestIds.some(id => typeof id !== 'string' || !id || /[\0\r\n]/u.test(id))
    || !['data-subprocesses', 'agent-runtime'].includes(header.writerScope)
    || (options.onExpiry !== undefined && typeof options.onExpiry !== 'function')
    || (options.onCancel !== undefined && typeof options.onCancel !== 'function')
    || (header.writerScope === 'agent-runtime' && (!options.onExpiry || !options.onCancel))
    || (header.writerScope === 'agent-runtime' && (!Array.isArray(header.messages) || header.messages.some(message =>
      message.role !== 'user' || typeof message.id !== 'string' || !message.id || !Array.isArray(message.content) || typeof message.source?.kind !== 'string')))
    || !Number.isSafeInteger(finalizationTimeoutMs) || finalizationTimeoutMs < 1 || finalizationTimeoutMs > 2147483647) throw new Error('Invalid managed turn identity or request')
  const ownerStart = await processStart()
  options.signal?.throwIfAborted()
  const child = mbot.ctx.subprocess.spawn({ argv: [join(root, 'bin', 'mbot-turn'), '-C', bot.workspacePath, bot.defaultRole],
    cwd: root, env: { DSH_HOME: process.env.DSH_HOME, MBOT_OWNER_PID: String(process.pid), MBOT_OWNER_START: ownerStart,
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}` },
    graceMs: 5000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 128000 } } })
  mbot.active.add(child)
  child.stdin.on('error', () => {})
  const reader = createInterface({ input: child.stdout })
  const frames = reader[Symbol.asyncIterator]()
  const abort = () => child.terminate()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    await write(child.stdin, header)
    const { value, done } = await frames.next()
    options.signal?.throwIfAborted()
    if (done) {
      await child.done
      throw new Error('Managed turn did not acquire its transaction')
    }
    const ready = JSON.parse(value)
    if (ready.kind !== 'ready' || !/^[a-f0-9]{64}$/u.test(ready.token) || ready.snapshot?.workspace !== bot.workspacePath
      || !Number.isSafeInteger(ready.expiresAt) || ready.expiresAt <= Date.now()) throw new Error('Invalid managed turn admission')
    const lease = new TurnLease(mbot, child, frames, ready, { botId: bot.botId, sessionId: header.sessionId, turn: header.turn }, finalizationTimeoutMs, options.onExpiry, options.onCancel, root)
    mbot.leases.add(lease)
    if (mbot.closed) {
      await lease.cancel('MBot plugin disposed during admission')
      throw new Error('mbot plugin is disposed')
    }
    return lease
  } catch (error) {
    child.terminate()
    await child.waitForExit()
    const diagnostics = child.collected.stderr?.readFrom(0).text ?? ''
    throw new Error(await redact(diagnostics || error.message, bot.workspacePath), { cause: error })
  } finally {
    options.signal?.removeEventListener('abort', abort)
    if (![...mbot.leases].some(lease => lease.child === child)) {
      reader.close()
      mbot.active.delete(child)
    }
  }
}
