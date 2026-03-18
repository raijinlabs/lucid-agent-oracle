import { ponder } from '@/generated'
import { writeERC8004Event } from './adapter-sink.js'
import { computeEventId } from '@lucid/oracle-core'

ponder.on('IdentityRegistry:AgentRegistered', async ({ event }) => {
  await writeERC8004Event({
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    source: 'erc8004',
    source_adapter_ver: 1,
    chain: 'base',
    event_type: 'agent_registered',
    event_timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    payload_json: JSON.stringify({
      agent_id: event.args.agentId,
      owner_address: event.args.owner,
      tba_address: event.args.tba === '0x0000000000000000000000000000000000000000' ? null : event.args.tba,
    }),
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
  })
})

ponder.on('IdentityRegistry:AgentUpdated', async ({ event }) => {
  await writeERC8004Event({
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    source: 'erc8004',
    source_adapter_ver: 1,
    chain: 'base',
    event_type: 'agent_updated',
    event_timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    payload_json: JSON.stringify({
      agent_id: event.args.agentId,
      metadata_uri: event.args.metadataUri,
    }),
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
  })
})

ponder.on('IdentityRegistry:OwnershipTransferred', async ({ event }) => {
  await writeERC8004Event({
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    source: 'erc8004',
    source_adapter_ver: 1,
    chain: 'base',
    event_type: 'ownership_transferred',
    event_timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    payload_json: JSON.stringify({
      agent_id: event.args.agentId,
      new_owner: event.args.newOwner,
      previous_owner: event.args.previousOwner,
    }),
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
  })
})
