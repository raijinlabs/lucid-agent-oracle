import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WalletWatchlist } from '../services/wallet-watchlist.js'

const mockDb = {
  query: vi.fn(),
}

describe('WalletWatchlist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads Solana wallets from DB', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { address: 'SolWallet1' },
        { address: 'SolWallet2' },
      ],
    })
    const wl = new WalletWatchlist(mockDb as any)
    await wl.loadSolanaWallets()
    expect(wl.getSolanaWallets()).toEqual(new Set(['SolWallet1', 'SolWallet2']))
  })

  it('loads Base wallets from DB', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { address: '0xBase1' },
        { address: '0xBase2' },
      ],
    })
    const wl = new WalletWatchlist(mockDb as any)
    await wl.loadBaseWallets()
    expect(wl.getBaseWallets()).toEqual(new Set(['0xBase1', '0xBase2']))
  })

  it('adds wallet to watchlist', () => {
    const wl = new WalletWatchlist(mockDb as any)
    wl.handleWatchlistUpdate({ action: 'add', chain: 'solana', address: 'NewWallet', agent_entity_id: 'ae_1' })
    expect(wl.getSolanaWallets().has('NewWallet')).toBe(true)
  })

  it('removes wallet from watchlist', () => {
    const wl = new WalletWatchlist(mockDb as any)
    wl.handleWatchlistUpdate({ action: 'add', chain: 'solana', address: 'W1', agent_entity_id: 'ae_1' })
    wl.handleWatchlistUpdate({ action: 'remove', chain: 'solana', address: 'W1', agent_entity_id: 'ae_1' })
    expect(wl.getSolanaWallets().has('W1')).toBe(false)
  })

  it('tracks Base wallets separately from Solana', () => {
    const wl = new WalletWatchlist(mockDb as any)
    wl.handleWatchlistUpdate({ action: 'add', chain: 'base', address: '0xBase1', agent_entity_id: 'ae_1' })
    wl.handleWatchlistUpdate({ action: 'add', chain: 'solana', address: 'Sol1', agent_entity_id: 'ae_2' })
    expect(wl.getSolanaWallets().has('0xBase1')).toBe(false)
    expect(wl.getSolanaWallets().has('Sol1')).toBe(true)
    expect(wl.getBaseWallets().has('0xBase1')).toBe(true)
    expect(wl.getBaseWallets().has('Sol1')).toBe(false)
  })
})
