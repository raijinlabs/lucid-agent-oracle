import type { FastifyInstance } from 'fastify'
import type { RedpandaProducer } from '../clients/redpanda.js'
import type { WebhookContext } from './adapter-types.js'
import { adapterRegistry } from './registry.js'

/**
 * Mount all registered webhook adapters onto a Fastify instance.
 *
 * Iterates the adapter registry and calls `mount()` on every adapter
 * that declares a webhook handler. This replaces per-adapter manual
 * route registration in server.ts.
 *
 * @returns Number of webhook routes mounted
 */
export function mountWebhookRoutes(
  app: FastifyInstance,
  producer: RedpandaProducer,
  context: WebhookContext,
): number {
  const webhookAdapters = adapterRegistry.withWebhook()
  let mounted = 0

  for (const adapter of webhookAdapters) {
    try {
      adapter.webhook!.mount(app, producer, context)
      mounted++
    } catch (err) {
      console.error(`[webhook-router] Failed to mount webhook for ${adapter.source}:`, err)
    }
  }

  return mounted
}
