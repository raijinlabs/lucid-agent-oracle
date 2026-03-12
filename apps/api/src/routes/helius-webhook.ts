import { createHmac } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { normalizeHeliusTransaction, type HeliusTransaction } from '@lucid/oracle-core'
import type { RawEconomicEvent, RedpandaProducer } from '@lucid/oracle-core'

/** Verify Helius HMAC-SHA256 webhook signature */
export function verifyHeliusHmac(body: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  return expected === signature
}

/** Process Helius webhook payload — normalize and filter by watched wallets */
export function handleHeliusWebhook(
  transactions: HeliusTransaction[],
  watchedWallets: Set<string>,
): RawEconomicEvent[] {
  const events: RawEconomicEvent[] = []
  for (const tx of transactions) {
    for (const wallet of watchedWallets) {
      const event = normalizeHeliusTransaction(tx, wallet)
      if (event) {
        events.push(event)
        break // one event per tx is enough
      }
    }
  }
  return events
}

/**
 * Register the Helius webhook route.
 *
 * Uses `publishEvents()` for RawEconomicEvent[] batches (wallet activity).
 * The identity resolver uses `publishJson()` for WatchlistUpdate messages.
 * Both methods exist on RedpandaProducer.
 */
export function registerHeliusWebhook(
  app: FastifyInstance,
  producer: RedpandaProducer,
  watchedWallets: Set<string>,
  webhookSecret: string,
): void {
  app.post('/v1/internal/helius/webhook', {
    config: { rawBody: true },
  }, async (request, reply) => {
    const signature = request.headers['x-helius-signature'] as string | undefined
    if (!signature || !verifyHeliusHmac(JSON.stringify(request.body), signature, webhookSecret)) {
      return reply.status(401).send({ error: 'Invalid webhook signature' })
    }

    const transactions = request.body as HeliusTransaction[]
    const events = handleHeliusWebhook(transactions, watchedWallets)

    if (events.length > 0) {
      await producer.publishEvents('raw.agent_wallets.events', events)
    }

    return { processed: events.length }
  })
}
