/**
 * Chain Configuration — centralised chain definitions for all enrichers.
 *
 * Replaces hardcoded chain strings ('0x2105', '0x1') and chain filters
 * across enricher modules with a single source of truth.
 *
 * Subgraph URLs are now derived at runtime from subgraphId + GRAPH_API_KEY env var.
 * Fallback API keys are embedded as defaults (from agent0-sdk) but GRAPH_API_KEY
 * takes precedence when set.
 */

import { buildSubgraphUrl } from '../clients/graph.js'

export interface ChainConfig {
  id: string                    // 'base', 'solana', 'eth'
  name: string                  // 'Base', 'Solana', 'Ethereum'
  type: 'evm' | 'solana'
  moralisChainParam: string | null  // '0x2105' for base, '0x1' for eth, null for solana
  explorerUrl: string
  /** The Graph subgraph ID for ERC-8004 agent indexing (EVM chains only) */
  subgraphId?: string
  /** Fallback API key for this chain's subgraph (used when GRAPH_API_KEY env var is not set) */
  subgraphFallbackKey?: string
  /**
   * @deprecated Use getSubgraphUrl(chain) instead, which builds the URL from subgraphId + GRAPH_API_KEY.
   * Retained for backward compatibility only.
   */
  subgraphUrl?: string
}

export const CHAINS: Record<string, ChainConfig> = {
  base: {
    id: 'base', name: 'Base', type: 'evm', moralisChainParam: '0x2105', explorerUrl: 'https://basescan.org',
    subgraphId: '43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb',
    subgraphFallbackKey: '536c6d8572876cabea4a4ad0fa49aa57',
  },
  eth: {
    id: 'eth', name: 'Ethereum', type: 'evm', moralisChainParam: '0x1', explorerUrl: 'https://etherscan.io',
    subgraphId: 'FV6RR6y13rsnCxBAicKuQEwDp8ioEGiNaWaZUmvr1F8k',
    subgraphFallbackKey: '7fd2e7d89ce3ef24cd0d4590298f0b2c',
  },
  poly: {
    id: 'poly', name: 'Polygon', type: 'evm', moralisChainParam: '0x89', explorerUrl: 'https://polygonscan.com',
    subgraphId: '9q16PZv1JudvtnCAf44cBoxg82yK9SSsFvrjCY9xnneF',
    subgraphFallbackKey: '782d61ed390e625b8867995389699b4c',
  },
  bsc: {
    id: 'bsc', name: 'BSC', type: 'evm', moralisChainParam: '0x38', explorerUrl: 'https://bscscan.com',
    subgraphId: 'D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K',
    subgraphFallbackKey: '7fd2e7d89ce3ef24cd0d4590298f0b2c',
  },
  monad: {
    id: 'monad', name: 'Monad', type: 'evm', moralisChainParam: null, explorerUrl: 'https://explorer.monad.xyz',
    subgraphId: '4tvLxkczjhSaMiqRrCV1EyheYHyJ7Ad8jub1UUyukBjg',
    subgraphFallbackKey: '7fd2e7d89ce3ef24cd0d4590298f0b2c',
  },
  solana: { id: 'solana', name: 'Solana', type: 'solana', moralisChainParam: null, explorerUrl: 'https://solscan.io' },
}

// Populate subgraphUrl as a computed getter for backward compatibility
for (const chain of Object.values(CHAINS)) {
  if (chain.subgraphId) {
    Object.defineProperty(chain, 'subgraphUrl', {
      get() {
        return getSubgraphUrl(chain)
      },
      enumerable: true,
      configurable: true,
    })
  }
}

export const EVM_CHAINS = Object.values(CHAINS).filter(c => c.type === 'evm')
export const ALL_CHAIN_IDS = Object.keys(CHAINS)

/**
 * Resolve the full subgraph URL for a chain.
 *
 * Priority:
 * 1. GRAPH_API_KEY env var + subgraphId
 * 2. subgraphFallbackKey + subgraphId (embedded default keys)
 * 3. null (no subgraph configured)
 */
export function getSubgraphUrl(chain: ChainConfig): string | null {
  if (!chain.subgraphId) return null
  // Try env var first
  const envUrl = buildSubgraphUrl(chain.subgraphId)
  if (envUrl) return envUrl
  // Fall back to embedded key
  if (chain.subgraphFallbackKey) {
    return buildSubgraphUrl(chain.subgraphId, chain.subgraphFallbackKey)
  }
  return null
}

export function getMoralisChainParam(chain: string): string {
  return CHAINS[chain]?.moralisChainParam ?? chain
}
