/**
 * Position Ledger — FIFO cost basis matching for realized execution gain.
 *
 * For each agent wallet, tracks:
 *   - Open positions (buys not yet matched to sells)
 *   - Matched positions (buy + sell paired, realized delta computed)
 *
 * Only operates on high-confidence swaps with stablecoin-leg pricing.
 * Does NOT claim to compute "profit" (excludes gas, fees, slippage tracking).
 * Computes: realized_delta_usd = sell_notional - buy_notional for matched quantity.
 *
 * Accounting method: FIFO (first in, first out).
 */
import type pg from 'pg'

/**
 * Process new high-confidence swaps into the position ledger.
 * Call after swap classification + price derivation.
 */
export async function updatePositionLedger(pool: pg.Pool): Promise<number> {
  const client = await pool.connect()
  let matched = 0

  try {
    const lockResult = await client.query("SELECT pg_try_advisory_lock(hashtext('position_ledger'))")
    if (!lockResult.rows[0].pg_try_advisory_lock) {
      return 0
    }

    // Find unprocessed swaps (high confidence, with execution price)
    // Identify buys (outbound stablecoin = buying tokens) and sells (inbound stablecoin = selling tokens)
    const swaps = await client.query(
      `SELECT wt.agent_entity, wt.chain, wt.tx_hash, wt.block_number, wt.event_timestamp,
              wt.direction, wt.token_address, wt.token_symbol, wt.token_decimals,
              wt.amount, wt.amount_usd, wt.execution_price_usd
       FROM oracle_wallet_transactions wt
       WHERE wt.tx_type = 'swap'
         AND wt.classification_confidence = 'high'
         AND wt.execution_price_usd IS NOT NULL
         AND wt.token_address NOT IN (
           SELECT token_address FROM oracle_token_registry WHERE is_stablecoin = true AND chain = wt.chain
         )
         AND NOT EXISTS (
           SELECT 1 FROM oracle_position_ledger pl
           WHERE (pl.buy_tx_hash = wt.tx_hash OR pl.sell_tx_hash = wt.tx_hash)
             AND pl.agent_entity = wt.agent_entity
             AND pl.token_address = wt.token_address
         )
       ORDER BY wt.event_timestamp ASC`,
    )

    for (const swap of swaps.rows) {
      const quantity = swap.token_decimals
        ? Number(swap.amount) / Math.pow(10, swap.token_decimals)
        : Number(swap.amount)

      if (swap.direction === 'inbound') {
        // Agent RECEIVED tokens (bought) — create open position
        await client.query(
          `INSERT INTO oracle_position_ledger
           (agent_entity, chain, token_address, buy_tx_hash, buy_block_number, buy_timestamp,
            buy_quantity, buy_price_usd, buy_notional_usd, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open')`,
          [swap.agent_entity, swap.chain, swap.token_address, swap.tx_hash,
           swap.block_number, swap.event_timestamp, quantity,
           swap.execution_price_usd, swap.amount_usd],
        )
      } else if (swap.direction === 'outbound') {
        // Agent SENT tokens (sold) — match against open positions (FIFO)
        let remainingToMatch = quantity

        const openPositions = await client.query(
          `SELECT id, buy_tx_hash, buy_block_number, buy_timestamp, buy_quantity, buy_price_usd, buy_notional_usd
           FROM oracle_position_ledger
           WHERE agent_entity = $1 AND chain = $2 AND token_address = $3 AND status = 'open'
           ORDER BY buy_timestamp ASC`, // FIFO
          [swap.agent_entity, swap.chain, swap.token_address],
        )

        for (const pos of openPositions.rows) {
          if (remainingToMatch <= 0) break

          const posQty = Number(pos.buy_quantity)
          const matchQty = Math.min(remainingToMatch, posQty)
          const matchRatio = matchQty / posQty

          const buyNotionalMatched = Number(pos.buy_notional_usd) * matchRatio
          const sellNotionalMatched = Number(swap.amount_usd) * (matchQty / quantity)
          const realizedDelta = sellNotionalMatched - buyNotionalMatched

          if (matchQty >= posQty) {
            // Full match — close position
            await client.query(
              `UPDATE oracle_position_ledger
               SET sell_tx_hash = $1, sell_block_number = $2, sell_timestamp = $3,
                   sell_quantity = $4, sell_price_usd = $5, sell_notional_usd = $6,
                   realized_delta_usd = $7, status = 'matched', matched_at = now()
               WHERE id = $8`,
              [swap.tx_hash, swap.block_number, swap.event_timestamp,
               matchQty, swap.execution_price_usd, sellNotionalMatched,
               realizedDelta, pos.id],
            )
            matched++
          } else {
            // Partial match — split the position
            // Reduce the open position's quantity
            const remainingBuyQty = posQty - matchQty
            const remainingBuyNotional = Number(pos.buy_notional_usd) * (1 - matchRatio)

            await client.query(
              `UPDATE oracle_position_ledger
               SET buy_quantity = $1, buy_notional_usd = $2
               WHERE id = $3`,
              [remainingBuyQty, remainingBuyNotional, pos.id],
            )

            // Create matched record for the sold portion
            await client.query(
              `INSERT INTO oracle_position_ledger
               (agent_entity, chain, token_address,
                buy_tx_hash, buy_block_number, buy_timestamp, buy_quantity, buy_price_usd, buy_notional_usd,
                sell_tx_hash, sell_block_number, sell_timestamp, sell_quantity, sell_price_usd, sell_notional_usd,
                realized_delta_usd, status, matched_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'matched', now())`,
              [swap.agent_entity, swap.chain, swap.token_address,
               // buy side (from the original open position)
               pos.buy_tx_hash, pos.buy_block_number, pos.buy_timestamp,
               matchQty, pos.buy_price_usd, buyNotionalMatched,
               // sell side
               swap.tx_hash, swap.block_number, swap.event_timestamp,
               matchQty, swap.execution_price_usd, sellNotionalMatched,
               realizedDelta],
            )
            matched++
          }

          remainingToMatch -= matchQty
        }

        // If there's unmatched sell quantity (sold more than bought — short or missing buy data)
        // Don't create a position — this is an unmatched sell
        if (remainingToMatch > 0) {
          console.log(`[position-ledger] Unmatched sell: ${remainingToMatch.toFixed(4)} ${swap.token_symbol ?? swap.token_address.slice(0, 8)} for agent ${swap.agent_entity}`)
        }
      }
    }

    await client.query("SELECT pg_advisory_unlock(hashtext('position_ledger'))")
  } finally {
    client.release()
  }

  return matched
}

/**
 * Query realized execution deltas for an agent.
 *
 * Returns per-token matched positions with buy/sell prices and realized delta.
 * This is NOT profit — it excludes gas fees and slippage.
 */
export async function getAgentRealizedDeltas(
  pool: pg.Pool,
  agentEntity: string,
): Promise<Array<{
  token_address: string
  total_matched_quantity: number
  avg_buy_price_usd: number
  avg_sell_price_usd: number
  total_realized_delta_usd: number
  matched_count: number
}>> {
  const result = await pool.query(
    `SELECT token_address,
            SUM(buy_quantity)::numeric as total_matched_quantity,
            SUM(buy_notional_usd) / NULLIF(SUM(buy_quantity), 0) as avg_buy_price_usd,
            SUM(sell_notional_usd) / NULLIF(SUM(sell_quantity), 0) as avg_sell_price_usd,
            SUM(realized_delta_usd) as total_realized_delta_usd,
            COUNT(*) as matched_count
     FROM oracle_position_ledger
     WHERE agent_entity = $1 AND status = 'matched'
     GROUP BY token_address`,
    [agentEntity],
  )
  return result.rows.map((r) => ({
    token_address: r.token_address,
    total_matched_quantity: Number(r.total_matched_quantity),
    avg_buy_price_usd: Number(r.avg_buy_price_usd),
    avg_sell_price_usd: Number(r.avg_sell_price_usd),
    total_realized_delta_usd: Number(r.total_realized_delta_usd),
    matched_count: Number(r.matched_count),
  }))
}
