import { ponder } from '@/generated'
import { writeERC8004Event } from './adapter-sink.js'
import { computeEventId } from '@lucid/oracle-core'

function sanitizeChainText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, '')
}

// ERC-8004 Identity Registry — real events from Base mainnet contract
// Agent identity: agentRegistry = eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432

ponder.on('IdentityRegistry:Registered', async ({ event }) => {
  await writeERC8004Event({
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    source: 'erc8004',
    source_adapter_ver: 2,
    chain: 'base',
    event_type: 'agent_registered',
    event_timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    payload_json: JSON.stringify({
      agent_id: event.args.agentId.toString(),
      agent_uri: sanitizeChainText(event.args.agentURI),
      owner_address: event.args.owner,
    }),
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
  })
})

ponder.on('IdentityRegistry:URIUpdated', async ({ event }) => {
  await writeERC8004Event({
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    source: 'erc8004',
    source_adapter_ver: 2,
    chain: 'base',
    event_type: 'uri_updated',
    event_timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    payload_json: JSON.stringify({
      agent_id: event.args.agentId.toString(),
      agent_uri: sanitizeChainText(event.args.agentURI),
      owner_address: event.args.owner,
    }),
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
  })
})

ponder.on('IdentityRegistry:MetadataSet', async ({ event }) => {
  await writeERC8004Event({
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    source: 'erc8004',
    source_adapter_ver: 3,
    chain: 'base',
    event_type: 'metadata_set',
    event_timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    payload_json: JSON.stringify({
      agent_id: event.args.agentId.toString(),
      key_hash: sanitizeChainText(event.args.keyHash),
      value: sanitizeChainText(event.args.value),       // key name string (e.g. "agentWallet", "ecosystem")
      data: event.args.data,          // actual value as hex bytes (e.g. wallet address)
    }),
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
  })
})

ponder.on('IdentityRegistry:Transfer', async ({ event }) => {
  // Skip mint events (from = 0x0) — they're covered by Registered
  if (event.args.from === '0x0000000000000000000000000000000000000000') return

  await writeERC8004Event({
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    source: 'erc8004',
    source_adapter_ver: 2,
    chain: 'base',
    event_type: 'ownership_transferred',
    event_timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    payload_json: JSON.stringify({
      agent_id: event.args.tokenId.toString(),
      previous_owner: event.args.from,
      new_owner: event.args.to,
    }),
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
  })
})
