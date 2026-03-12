import type { WatchlistUpdate } from '@lucid/oracle-core'

interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export class WalletWatchlist {
  private readonly solanaWallets = new Set<string>()
  private readonly baseWallets = new Set<string>()

  constructor(private readonly db: DbClient) {}

  /** Load Solana watched wallets from Postgres */
  async loadSolanaWallets(): Promise<void> {
    const result = await this.db.query(
      `SELECT address FROM wallet_mappings WHERE chain = 'solana' AND removed_at IS NULL`,
    )
    this.solanaWallets.clear()
    for (const row of result.rows) {
      this.solanaWallets.add(row.address as string)
    }
  }

  /** Load Base watched wallets from Postgres */
  async loadBaseWallets(): Promise<void> {
    const result = await this.db.query(
      `SELECT address FROM wallet_mappings WHERE chain = 'base' AND removed_at IS NULL`,
    )
    this.baseWallets.clear()
    for (const row of result.rows) {
      this.baseWallets.add(row.address as string)
    }
  }

  /** Handle a watchlist update event from Redpanda */
  handleWatchlistUpdate(update: WatchlistUpdate): void {
    const set = update.chain === 'solana' ? this.solanaWallets : this.baseWallets
    if (update.action === 'add') {
      set.add(update.address)
    } else {
      set.delete(update.address)
    }
  }

  getSolanaWallets(): Set<string> {
    return this.solanaWallets
  }

  getBaseWallets(): Set<string> {
    return this.baseWallets
  }
}
