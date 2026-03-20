/**
 * NFT Holdings Enricher — polls Moralis for NFT holdings per agent wallet.
 *
 * Uses Moralis `getWalletNFTs` API to fetch NFT holdings for agent wallets
 * on Base, then upserts into oracle_nft_holdings.
 *
 * Runs every 30 minutes, processing 10 wallets per cycle.
 * Advisory-locked to prevent concurrent execution across replicas.
 */
import type pg from 'pg'

export interface NftEnricherConfig {
  apiKey: string
  intervalMs: number
  batchSize: number
}

const DEFAULT_CONFIG: NftEnricherConfig = {
  apiKey: '',
  intervalMs: 30 * 60_000, // 30 minutes
  batchSize: 10,
}

interface MoralisNFT {
  token_address: string
  token_id: string
  name: string | null
  metadata: { name?: string; image?: string } | string | null
  collection_name: string | null
}

/**
 * Fetch and store NFT holdings for a batch of active agent wallets on Base.
 */
export async function enrichNftHoldings(
  pool: pg.Pool,
  config: NftEnricherConfig,
): Promise<number> {
  if (!config.apiKey) return 0

  const client = await pool.connect()
  let enriched = 0

  try {
    const lockResult = await client.query("SELECT pg_try_advisory_lock(hashtext('nft_enricher'))")
    if (!lockResult.rows[0].pg_try_advisory_lock) return 0

    const wallets = await client.query(
      `SELECT wm.agent_entity, wm.chain, wm.address
       FROM oracle_wallet_mappings wm
       WHERE wm.removed_at IS NULL
         AND wm.chain = 'base'
       ORDER BY wm.created_at ASC
       LIMIT $1::int`,
      [config.batchSize],
    )

    for (const wallet of wallets.rows) {
      try {
        const address = (wallet.address as string).toLowerCase()
        const chain = wallet.chain as string
        const agentEntity = wallet.agent_entity as string

        const nfts = await fetchMoralisNFTs(config.apiKey, address)

        for (const nft of nfts) {
          // Parse metadata (can be a string or object)
          let imageUrl: string | null = null
          let nftName: string | null = nft.name ?? null

          if (nft.metadata) {
            const meta = typeof nft.metadata === 'string'
              ? safeJsonParse(nft.metadata)
              : nft.metadata

            if (meta) {
              imageUrl = typeof meta.image === 'string' ? meta.image : null
              if (!nftName && typeof meta.name === 'string') {
                nftName = meta.name
              }
            }
          }

          await client.query(
            `INSERT INTO oracle_nft_holdings
             (agent_entity, chain, wallet_address, contract_address, token_id, name, image_url, collection_name, updated_at)
             VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, now())
             ON CONFLICT (chain, wallet_address, contract_address, token_id) DO UPDATE
             SET agent_entity = EXCLUDED.agent_entity,
                 name = COALESCE(EXCLUDED.name, oracle_nft_holdings.name),
                 image_url = COALESCE(EXCLUDED.image_url, oracle_nft_holdings.image_url),
                 collection_name = COALESCE(EXCLUDED.collection_name, oracle_nft_holdings.collection_name),
                 updated_at = now()`,
            [
              agentEntity,
              chain,
              address,
              nft.token_address.toLowerCase(),
              nft.token_id,
              nftName,
              imageUrl,
              nft.collection_name ?? null,
            ],
          )
          enriched++
        }

        // Rate limit: 300ms between wallets
        await new Promise((r) => setTimeout(r, 300))
      } catch (err) {
        console.error(`[nft-enricher] Error enriching ${(wallet.address as string).slice(0, 10)}:`, (err as Error).message)
      }
    }

    await client.query("SELECT pg_advisory_unlock(hashtext('nft_enricher'))")
  } finally {
    client.release()
  }

  return enriched
}

function safeJsonParse(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str) as Record<string, unknown>
  } catch {
    return null
  }
}

async function fetchMoralisNFTs(
  apiKey: string,
  address: string,
): Promise<MoralisNFT[]> {
  const url = `https://deep-index.moralis.io/api/v2.2/${address}/nft?chain=base&limit=20`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'x-api-key': apiKey,
      },
      signal: controller.signal,
    })

    if (!res.ok) {
      if (res.status === 429) console.warn('[nft-enricher] Rate limited')
      return []
    }

    const data = await res.json() as { result?: MoralisNFT[] }
    return data.result ?? []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Start the NFT holdings enricher on a timer.
 */
export function startNftEnricher(
  pool: pg.Pool,
  config: Partial<NftEnricherConfig> & { apiKey: string },
): { stop: () => void } {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  let running = true

  const loop = async () => {
    while (running) {
      try {
        const n = await enrichNftHoldings(pool, fullConfig)
        if (n > 0) console.log(`[nft-enricher] Enriched ${n} NFT holdings`)
      } catch (err) {
        console.error('[nft-enricher] Error:', (err as Error).message)
      }
      await new Promise((r) => setTimeout(r, fullConfig.intervalMs))
    }
  }

  loop()
  return { stop: () => { running = false } }
}
