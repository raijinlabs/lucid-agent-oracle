/**
 * Chain Configuration — centralised chain definitions for all enrichers.
 *
 * Replaces hardcoded chain strings ('0x2105', '0x1') and chain filters
 * across enricher modules with a single source of truth.
 */

export interface ChainConfig {
  id: string                    // 'base', 'solana', 'eth'
  name: string                  // 'Base', 'Solana', 'Ethereum'
  type: 'evm' | 'solana'
  moralisChainParam: string | null  // '0x2105' for base, '0x1' for eth, null for solana
  explorerUrl: string
  /** The Graph subgraph URL for ERC-8004 agent indexing (EVM chains only) */
  subgraphUrl?: string
}

export const CHAINS: Record<string, ChainConfig> = {
  base: {
    id: 'base', name: 'Base', type: 'evm', moralisChainParam: '0x2105', explorerUrl: 'https://basescan.org',
    subgraphUrl: 'https://gateway.thegraph.com/api/536c6d8572876cabea4a4ad0fa49aa57/subgraphs/id/43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb',
  },
  eth: {
    id: 'eth', name: 'Ethereum', type: 'evm', moralisChainParam: '0x1', explorerUrl: 'https://etherscan.io',
    subgraphUrl: 'https://gateway.thegraph.com/api/7fd2e7d89ce3ef24cd0d4590298f0b2c/subgraphs/id/FV6RR6y13rsnCxBAicKuQEwDp8ioEGiNaWaZUmvr1F8k',
  },
  poly: {
    id: 'poly', name: 'Polygon', type: 'evm', moralisChainParam: '0x89', explorerUrl: 'https://polygonscan.com',
    subgraphUrl: 'https://gateway.thegraph.com/api/782d61ed390e625b8867995389699b4c/subgraphs/id/9q16PZv1JudvtnCAf44cBoxg82yK9SSsFvrjCY9xnneF',
  },
  bsc: {
    id: 'bsc', name: 'BSC', type: 'evm', moralisChainParam: '0x38', explorerUrl: 'https://bscscan.com',
    subgraphUrl: 'https://gateway.thegraph.com/api/7fd2e7d89ce3ef24cd0d4590298f0b2c/subgraphs/id/D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K',
  },
  monad: {
    id: 'monad', name: 'Monad', type: 'evm', moralisChainParam: null, explorerUrl: 'https://explorer.monad.xyz',
    subgraphUrl: 'https://gateway.thegraph.com/api/7fd2e7d89ce3ef24cd0d4590298f0b2c/subgraphs/id/4tvLxkczjhSaMiqRrCV1EyheYHyJ7Ad8jub1UUyukBjg',
  },
  solana: { id: 'solana', name: 'Solana', type: 'solana', moralisChainParam: null, explorerUrl: 'https://solscan.io' },
}

export const EVM_CHAINS = Object.values(CHAINS).filter(c => c.type === 'evm')
export const ALL_CHAIN_IDS = Object.keys(CHAINS)

export function getMoralisChainParam(chain: string): string {
  return CHAINS[chain]?.moralisChainParam ?? chain
}
