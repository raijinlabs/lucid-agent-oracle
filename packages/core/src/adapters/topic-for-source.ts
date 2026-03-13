import { adapterRegistry } from './registry.js'

/**
 * Resolve the Redpanda topic for a given event source.
 *
 * Looks up the registered adapter first. Falls back to the convention
 * `raw.<source>.events` if no adapter is registered (forward-compatible
 * with sources that haven't been formally adapted yet).
 */
export function topicForSource(source: string): string {
  const adapter = adapterRegistry.get(source)
  if (adapter) return adapter.topic
  return `raw.${source}.events`
}
