import type { AdapterDefinition } from './adapter-types.js'

/**
 * Central registry for all data source adapters.
 *
 * Adapters self-register at startup via `register()`. The rest of the system
 * discovers adapters through `get()`, `list()`, and query helpers like
 * `getByTopic()` and `withWebhook()` — no switch statements, no hardcoded lists.
 *
 * Usage:
 *   import { adapterRegistry } from '@lucid/oracle-core'
 *   adapterRegistry.register(myAdapter)
 *   const adapter = adapterRegistry.get('my_source')
 */
class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterDefinition>()

  /** Register an adapter. Throws if the source is already registered. */
  register(adapter: AdapterDefinition): void {
    if (this.adapters.has(adapter.source)) {
      throw new Error(
        `Adapter already registered for source: ${adapter.source}. ` +
        `Use replace() to override an existing adapter.`,
      )
    }
    this.adapters.set(adapter.source, adapter)
  }

  /** Replace an existing adapter (for testing or hot-swapping). */
  replace(adapter: AdapterDefinition): void {
    this.adapters.set(adapter.source, adapter)
  }

  /** Get an adapter by source. Returns undefined if not registered. */
  get(source: string): AdapterDefinition | undefined {
    return this.adapters.get(source)
  }

  /** Get an adapter by source. Throws if not registered. */
  getOrThrow(source: string): AdapterDefinition {
    const adapter = this.adapters.get(source)
    if (!adapter) {
      throw new Error(`No adapter registered for source: ${source}`)
    }
    return adapter
  }

  /** List all registered adapters. */
  list(): AdapterDefinition[] {
    return Array.from(this.adapters.values())
  }

  /** Get all registered source identifiers. */
  sources(): string[] {
    return Array.from(this.adapters.keys())
  }

  /** Find the adapter that publishes to a given topic. */
  getByTopic(topic: string): AdapterDefinition | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.topic === topic) return adapter
    }
    return undefined
  }

  /** Get all adapters that have webhook handlers. */
  withWebhook(): AdapterDefinition[] {
    return this.list().filter((a) => a.webhook != null)
  }

  /** Get all adapters that have identity handlers. */
  withIdentity(): AdapterDefinition[] {
    return this.list().filter((a) => a.identity != null)
  }

  /** Remove an adapter (primarily for testing). */
  remove(source: string): boolean {
    return this.adapters.delete(source)
  }

  /** Clear all adapters (primarily for testing). */
  clear(): void {
    this.adapters.clear()
  }

  /** Number of registered adapters. */
  get size(): number {
    return this.adapters.size
  }
}

/** Singleton adapter registry — shared across the entire process */
export const adapterRegistry = new AdapterRegistry()

export { AdapterRegistry }
