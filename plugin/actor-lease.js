/** A role/task-scoped data capability sharing one Host-owned transaction. */
export class ActorLease {
  #execute
  #environment
  #redact
  #revoke
  #record
  #seal
  #calls = new Set()
  #closed = false
  #closing
  constructor(identity, snapshot, capability) {
    Object.defineProperty(this, 'identity', { value: Object.freeze(identity) })
    Object.defineProperty(this, 'snapshot', { value: Object.freeze(snapshot) })
    this.#execute = capability.execute
    this.#environment = capability.environment
    this.#redact = capability.redact
    this.#revoke = capability.revoke
    this.#record = capability.record
    this.#seal = capability.seal
  }
  get closed() { return this.#closed }
  shellEnvironment() {
    if (this.#closed) throw new Error('Delegated actor is closed')
    return this.#environment()
  }
  redactResult(value) { return this.#redact(value) }
  execute(program, args, options = {}) {
    if (this.#closed) return Promise.reject(new Error('Delegated actor is closed'))
    if (program !== 'botctl' || !Array.isArray(args) || !['boot', 'lint', 'board', 'task', 'remember'].includes(args[0])) return Promise.reject(new Error('Delegated actors use scoped botctl data operations'))
    const operation = this.#execute(program, args, options)
    this.#calls.add(operation)
    void operation.finally(() => this.#calls.delete(operation)).catch(() => {})
    return operation
  }
  record(event) {
    if (this.#closed) return Promise.reject(new Error('Delegated actor is closed'))
    return this.#record(structuredClone(event))
  }
  sealNative(input) {
    if (this.#closed) return Promise.reject(new Error('Delegated actor is closed'))
    return this.#seal(structuredClone(input))
  }
  /** Caller must join its Agent/tools before closing; this joins data calls. */
  close() {
    if (this.#closing) return this.#closing
    this.#closed = true
    this.#closing = Promise.allSettled([...this.#calls]).then(() => this.#revoke())
    return this.#closing
  }
}
