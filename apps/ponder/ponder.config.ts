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
      { name: 'keyHash', type: 'string', indexed: true }, // indexed string → topic is keccak256
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
// ERC-8004 Reputation Registry ABI — verified against EIP-8004 spec + on-chain topic hash.
// keccak256("NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)")
// = 0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc ✓
const REPUTATION_REGISTRY_ABI = [
  {
    type: 'event',
    name: 'NewFeedback',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'clientAddress', type: 'address', indexed: true },
      { name: 'feedbackIndex', type: 'uint64', indexed: false },
      { name: 'value', type: 'int128', indexed: false },
      { name: 'valueDecimals', type: 'uint8', indexed: false },
      { name: 'indexedTag1', type: 'string', indexed: true }, // hashed to bytes32 in topic
      { name: 'tag1', type: 'string', indexed: false },
      { name: 'tag2', type: 'string', indexed: false },
      { name: 'endpoint', type: 'string', indexed: false },
      { name: 'feedbackURI', type: 'string', indexed: false },
      { name: 'feedbackHash', type: 'bytes32', indexed: false },
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
    ReputationRegistry: {
      network: 'base',
      abi: REPUTATION_REGISTRY_ABI,
      address: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
      startBlock: 41_670_000,
    },
  },
})
