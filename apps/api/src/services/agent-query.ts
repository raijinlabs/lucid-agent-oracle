export const PROTOCOL_REGISTRY: Record<string, { name: string; chains: string[]; status: string }> = {
  lucid: { name: 'Lucid', chains: ['offchain', 'base', 'solana'], status: 'active' },
  virtuals: { name: 'Virtuals Protocol', chains: ['base'], status: 'pending' },
  olas: { name: 'Olas / Autonolas', chains: ['gnosis', 'base', 'optimism'], status: 'pending' },
  erc8004: { name: 'ERC-8004 Agent Registry', chains: ['base'], status: 'active' },
}
