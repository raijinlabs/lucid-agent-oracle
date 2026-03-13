import { createHmac } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { AdapterDefinition, WebhookAdapter, WebhookContext } from './adapter-types.js'
import type { RedpandaProducer } from '../clients/redpanda.js'
import type { RawEconomicEvent } from '../types/events.js'
import { normalizeHeliusTransaction, type HeliusTransaction } from './helius.js'
import { TOPICS } from '../clients/redpanda.js'

/** Process Helius webhook payload — normalize and filter by watched wallets */
function handleHeliusWebhookPayload(
  transactions: HeliusTransaction[],
  watchedWallets: Set<string>,
): RawEconomicEvent[] {
  const events: RawEconomicEvent[] = []
  for (const tx of transactions) {
    for (const wallet of watchedWallets) {
      const event = normalizeHeliusTransaction(tx, wallet)
      if (event) {
        events.push(event)
        break
      }
    }
  }
  return events
}

const heliusWebhook: WebhookAdapter = {
  path: '/v1/internal/helius/webhook',
  method: 'POST',

  mount(
    app: FastifyInstance,
    producer: RedpandaProducer,
    context: WebhookContext,
  ): void {
    const webhookSecret = context.env.HELIUS_WEBHOOK_SECRET
    if (!webhookSecret) {
      console.warn('[helius-adapter] HELIUS_WEBHOOK_SECRET not set — webhook disabled')
      return
    }

    const watchedWallets = context.services.watchlist?.getSolanaWallets()
    if (!watchedWallets) {
      console.warn('[helius-adapter] No watchlist service — webhook disabled')
      return
    }

    app.post(heliusWebhook.path, {
      config: { rawBody: true },
    }, async (request, reply) => {
      const signature = request.headers['x-helius-signature'] as string | undefined
      const bodyStr = JSON.stringify(request.body)
      const expected = createHmac('sha256', webhookSecret).update(bodyStr).digest('hex')

      if (!signature || signature !== expected) {
        return reply.status(401).send({ error: 'Invalid webhook signature' })
      }

      const transactions = request.body as HeliusTransaction[]
      const events = handleHeliusWebhookPayload(transactions, watchedWallets)

      if (events.length > 0) {
        await producer.publishEvents(TOPICS.RAW_AGENT_WALLETS, events)
      }

      return { processed: events.length }
    })
  },
}

/** Helius adapter — indexes Solana agent wallet activity via webhooks */
export const heliusAdapter: AdapterDefinition = {
  source: 'agent_wallets_sol',
  version: 1,
  description: 'Helius Solana webhook — agent wallet transfers',
  topic: TOPICS.RAW_AGENT_WALLETS,
  chains: ['solana'],
  webhook: heliusWebhook,
  // No identity handler — wallet activity feeds into existing entity resolution
}
