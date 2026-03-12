import { Kafka, type Producer, type Consumer, type EachMessagePayload } from 'kafkajs'
import type { RawEconomicEvent } from '../types/events.js'

/** Redpanda connection configuration */
export interface RedpandaConfig {
  brokers: string[]
  clientId?: string
}

/** Redpanda topic names for the oracle event pipeline */
export const TOPICS = {
  RAW_GATEWAY: 'raw.lucid_gateway.events',
  RAW_VIRTUALS: 'raw.virtuals_acp.events',
  RAW_OLAS: 'raw.olas.events',
  RAW_ERC8004: 'raw.erc8004.events',
  RAW_AGENT_WALLETS: 'raw.agent_wallets.events',
  NORMALIZED: 'normalized.economic',
  INDEX_UPDATES: 'index.updates',
  PUBLICATION: 'publication.requests',
  WATCHLIST: 'wallet_watchlist.updated',
} as const

/**
 * Redpanda producer for publishing economic events to topics.
 * Must call connect() before publishing.
 */
export class RedpandaProducer {
  private readonly kafka: Kafka
  private producer: Producer | null = null

  constructor(config: RedpandaConfig) {
    this.kafka = new Kafka({
      clientId: config.clientId ?? 'oracle-economy-producer',
      brokers: config.brokers,
    })
  }

  /** Connect the producer to the Redpanda cluster */
  async connect(): Promise<void> {
    this.producer = this.kafka.producer()
    await this.producer.connect()
  }

  /** Publish economic events to a topic */
  async publishEvents(topic: string, events: RawEconomicEvent[]): Promise<void> {
    if (!this.producer) throw new Error('Producer not connected')
    if (events.length === 0) return

    await this.producer.send({
      topic,
      messages: events.map((e) => ({
        key: `${e.source}:${e.chain}`,
        value: JSON.stringify(e),
        timestamp: e.event_timestamp.getTime().toString(),
      })),
    })
  }

  /** Publish a generic JSON message (for INDEX_UPDATES fanout). */
  async publishJson(topic: string, key: string, value: unknown): Promise<void> {
    if (!this.producer) throw new Error('Producer not connected')
    await this.producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(value) }],
    })
  }

  /** Disconnect the producer */
  async disconnect(): Promise<void> {
    await this.producer?.disconnect()
    this.producer = null
  }
}

/**
 * Redpanda consumer for processing economic events from topics.
 * Call subscribe() then run() to start consuming.
 */
export class RedpandaConsumer {
  private readonly kafka: Kafka
  private consumer: Consumer | null = null

  constructor(config: RedpandaConfig & { groupId: string }) {
    this.kafka = new Kafka({
      clientId: config.clientId ?? 'oracle-economy-consumer',
      brokers: config.brokers,
    })
    this.consumer = this.kafka.consumer({ groupId: config.groupId })
  }

  /** Subscribe to topics (connects automatically) */
  async subscribe(topics: string[]): Promise<void> {
    if (!this.consumer) throw new Error('Consumer not initialized')
    await this.consumer.connect()
    for (const topic of topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false })
    }
  }

  /** Start consuming messages */
  async run(handler: (event: RawEconomicEvent, meta: { topic: string; partition: number; offset: string }) => Promise<void>): Promise<void> {
    if (!this.consumer) throw new Error('Consumer not initialized')
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
        if (!message.value) return
        const event = JSON.parse(message.value.toString()) as RawEconomicEvent
        await handler(event, { topic, partition, offset: message.offset })
      },
    })
  }

  /** Run consumer with raw string messages (for INDEX_UPDATES — not RawEconomicEvent). */
  async runRaw(handler: (key: string | null, value: string | null) => Promise<void>): Promise<void> {
    if (!this.consumer) throw new Error('Consumer not initialized')
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        await handler(
          message.key?.toString() ?? null,
          message.value?.toString() ?? null,
        )
      },
    })
  }

  /** Disconnect the consumer */
  async disconnect(): Promise<void> {
    await this.consumer?.disconnect()
    this.consumer = null
  }
}
