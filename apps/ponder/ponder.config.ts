import { createConfig } from '@ponder/core'
import { http } from 'viem'

// ERC-8004 Identity Registry ABI — real events from deployed contract on Base
// Verified via openchain.xyz signature database + on-chain log analysis
const IDENTITY_REGISTRY_ABI = [
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'URIUpdated',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'MetadataSet',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'key', type: 'string', indexed: false },
      { name: 'value', type: 'string', indexed: false },
      { name: 'data', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'MetadataUpdate',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const

// ERC-8004 Reputation Registry ABI — placeholder until we verify events
// TODO: Fetch real events from 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
const REPUTATION_REGISTRY_ABI = [
  {
    type: 'event',
    name: 'NewFeedback',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'reviewer', type: 'address', indexed: true },
      { name: 'rating', type: 'uint8', indexed: false },
      { name: 'feedbackURI', type: 'string', indexed: false },
    ],
  },
] as const

export default createConfig({
  database: {
    connectionString: process.env.DATABASE_URL!,
    poolConfig: { max: 3 },
  },
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
      startBlock: 41_670_000,
    },
    // Reputation Registry disabled until we verify its actual event signatures
    // ReputationRegistry: {
    //   network: 'base',
    //   abi: REPUTATION_REGISTRY_ABI,
    //   address: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    //   startBlock: 41_670_000,
    // },
  },
})
