import {
  OracleClickHouse,
  RedpandaConsumer,
  TOPICS,
  type PublicationRequest,
} from '@lucid/oracle-core'
import { loadConfig } from './config.js'
import { checkAlreadyPublished, recordPublicationStatus } from './status.js'

export interface PublicationHandlers {
  postSolana: (req: PublicationRequest) => Promise<string>
  postBase: (req: PublicationRequest) => Promise<string>
  clickhouse: OracleClickHouse
}

export async function handlePublicationRequest(
  req: PublicationRequest,
  handlers: PublicationHandlers,
): Promise<void> {
  const alreadyPublished = await checkAlreadyPublished(handlers.clickhouse, req)

  const [solanaResult, baseResult] = await Promise.allSettled([
    alreadyPublished.skipSolana
      ? Promise.resolve(null)
      : handlers.postSolana(req).catch((err) => {
          console.error(`[publisher] Solana posting failed for ${req.feed_id}:`, err.message)
          return null
        }),
    alreadyPublished.skipBase
      ? Promise.resolve(null)
      : handlers.postBase(req).catch((err) => {
          console.error(`[publisher] Base posting failed for ${req.feed_id}:`, err.message)
          return null
        }),
  ])

  const solanaTxHash = solanaResult.status === 'fulfilled' ? solanaResult.value : null
  const baseTxHash = baseResult.status === 'fulfilled' ? baseResult.value : null

  await recordPublicationStatus(handlers.clickhouse, req, solanaTxHash, baseTxHash)
}

async function main(): Promise<void> {
  const config = loadConfig()

  const clickhouse = new OracleClickHouse({
    url: config.clickhouseUrl,
    username: config.clickhouseUser,
    password: config.clickhousePassword,
  })

  const consumer = new RedpandaConsumer({
    brokers: config.redpandaBrokers,
    groupId: config.consumerGroup,
  })

  const handlers: PublicationHandlers = {
    postSolana: async (_req) => { throw new Error('Solana client not configured') },
    postBase: async (_req) => { throw new Error('Base client not configured') },
    clickhouse,
  }

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    console.log('[publisher] Shutting down...')
    await consumer.disconnect()
    await clickhouse.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await consumer.subscribe([TOPICS.PUBLICATION])
  console.log('[publisher] Subscribed to', TOPICS.PUBLICATION)

  await consumer.runRaw(async (_key, value) => {
    if (!value) return
    const req = JSON.parse(value) as PublicationRequest
    console.log(`[publisher] Processing ${req.feed_id} @ ${req.computed_at}`)
    await handlePublicationRequest(req, handlers)
  })
}

const isMain = process.argv[1]?.includes('publisher')
if (isMain) {
  main().catch((err) => {
    console.error('[publisher] Fatal error:', err)
    process.exit(1)
  })
}
