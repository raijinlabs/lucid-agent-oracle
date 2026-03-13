import type { DbClient } from './adapter-types.js'
import type { RedpandaProducer } from '../clients/redpanda.js'
import { adapterRegistry } from './registry.js'

/**
 * Registry-driven identity event dispatcher.
 *
 * Instead of hardcoding a switch on event_type, this function finds the
 * adapter for the event's source and delegates to its identity handler.
 * Adding identity resolution for a new protocol requires only implementing
 * IdentityHandler on the adapter — no changes to dispatch logic.
 *
 * @returns true if the event was handled, false if no handler was found
 */
export async function dispatchIdentityEvent(
  source: string,
  event: Record<string, unknown>,
  db: DbClient,
  producer: RedpandaProducer,
): Promise<boolean> {
  const adapter = adapterRegistry.get(source)
  if (!adapter?.identity) return false

  await adapter.identity.handleEvent(event, db, producer)
  return true
}

/**
 * Get all topics that have identity handlers registered.
 * Used by the API server to know which Redpanda topics to subscribe to
 * for identity resolution.
 */
export function getIdentityTopics(): string[] {
  return adapterRegistry
    .withIdentity()
    .map((a) => a.topic)
}
