// One Agent-keyed registry survives ESM cache eviction. It carries no profile
// defaults or global Bot identity; Agent objects remain the isolation keys.
const key = Symbol.for('dsh-mbot.runtime.cells')
let registry = globalThis[key]
if (registry === undefined) {
  registry = Object.freeze({ schemaVersion: 1, cells: new WeakMap() })
  Object.defineProperty(globalThis, key, { value: registry, configurable: false, enumerable: false, writable: false })
}
if (registry.schemaVersion !== 1 || !(registry.cells instanceof WeakMap)) throw new Error('Unsupported MBot Agent gate registry; preserve existing owners and reload a compatible Runtime')
export const runtimeCells = registry.cells
export const gateSchemaVersion = 1
