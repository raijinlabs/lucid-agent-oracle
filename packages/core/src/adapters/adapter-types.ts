import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { RawEconomicEvent } from '../types/events.js'
import type { ERC8004Event } from '../types/identity.js'
import type { RedpandaProducer } from '../clients/redpanda.js'
import type { AdapterSink } from './sink.js'

/**
 * Core adapter definition — the single interface every data source implements.
 *
 * Adapters are the extensibility unit of the oracle. To add a new data source:
 *   1. Create a file implementing AdapterDefinition
 *   2. Register it in register-defaults.ts (or at runtime via AdapterRegistry)
 *
 * That's it — the registry handles topic routing, webhook wiring, and lifecycle.
 */
export interface AdapterDefinition {
  /** Unique source identifier — must match the `source` field on emitted events */
  readonly source: string
  /** Semantic version of this adapter (bumped on breaking schema changes) */
  readonly version: number
  /** Human-readable description for observability */
  readonly description: string

  /** Redpanda topic this adapter publishes to */
  readonly topic: string
  /** Chains this adapter indexes */
  readonly chains: readonly string[]

  /** Optional webhook handler — if present, the router auto-mounts the route */
  readonly webhook?: WebhookAdapter
  /** Optional identity handler — if present, the resolver dispatches events to it */
  readonly identity?: IdentityHandler
}

/**
 * Webhook adapter — handles inbound HTTP webhooks for a data source.
 * The webhook router calls `mount()` during startup to register routes.
 */
export interface WebhookAdapter {
  /** URL path for the webhook (e.g., '/v1/internal/helius/webhook') */
  readonly path: string
  /** HTTP method (defaults to POST) */
  readonly method?: 'GET' | 'POST' | 'PUT'
  /** Mount the webhook route on the Fastify instance */
  mount(
    app: FastifyInstance,
    producer: RedpandaProducer,
    context: WebhookContext,
  ): void
}

/** Runtime context passed to webhook adapters during mount */
export interface WebhookContext {
  /** Environment variables (adapters read their own config from here) */
  readonly env: Record<string, string | undefined>
  /** Shared services — adapters can request what they need */
  readonly services: {
    readonly watchlist?: {
      getSolanaWallets(): Set<string>
      getBaseWallets(): Set<string>
    }
  }
  /** AdapterSink for no-broker mode — adapters should prefer this over producer */
  readonly sink?: AdapterSink
}

/**
 * Identity handler — processes domain-specific events for identity resolution.
 * Each handler knows how to extract entity/wallet/link info from its source's events.
 */
export interface IdentityHandler {
  /** Event types this handler processes */
  readonly handles: readonly string[]
  /** Process a single event, performing DB mutations and emitting watchlist updates */
  handleEvent(
    event: Record<string, unknown>,
    db: DbClient,
    producer: RedpandaProducer | null,
  ): Promise<void>
}

/** Minimal DB client interface — adapters depend on this, not on pg directly */
export interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}
