import { createConfig } from '@ponder/core'
import { http } from 'viem'

// ERC-8004 Identity Registry ABI (relevant events only)
const IDENTITY_REGISTRY_ABI = [
  {
    type: 'event',
    name: 'AgentRegistered',
    inputs: [
      { name: 'agentId', type: 'bytes32', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'tba', type: 'address', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AgentUpdated',
    inputs: [
      { name: 'agentId', type: 'bytes32', indexed: true },
      { name: 'metadataUri', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OwnershipTransferred',
    inputs: [
      { name: 'agentId', type: 'bytes32', indexed: true },
      { name: 'previousOwner', type: 'address', indexed: true },
      { name: 'newOwner', type: 'address', indexed: true },
    ],
  },
] as const

// ERC-8004 Reputation Registry ABI (relevant events only)
const REPUTATION_REGISTRY_ABI = [
  {
    type: 'event',
    name: 'ReputationUpdated',
    inputs: [
      { name: 'agentId', type: 'bytes32', indexed: true },
      { name: 'score', type: 'uint256', indexed: false },
      { name: 'validator', type: 'address', indexed: true },
      { name: 'evidenceHash', type: 'bytes32', indexed: false },
    ],
  },
] as const

// Base USDC contract for wallet activity tracking
const ERC20_TRANSFER_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

export default createConfig({
  networks: {
    base: {
      chainId: 8453,
      transport: http(process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'),
    },
  },
  contracts: {
    IdentityRegistry: {
      network: 'base',
      abi: IDENTITY_REGISTRY_ABI,
      address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      startBlock: 41_670_000, // First events found at ~41,671,000 via binary search
    },
    ReputationRegistry: {
      network: 'base',
      abi: REPUTATION_REGISTRY_ABI,
      address: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
      startBlock: 41_670_000,
    },
    // USDC transfers on Base — filtered by watchlist in handler (only agent wallets)
    BaseUSDC: {
      network: 'base',
      abi: ERC20_TRANSFER_ABI,
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      startBlock: 41_670_000, // Same start — only relevant after agents are registered
    },
  },
})
