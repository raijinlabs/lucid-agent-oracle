import { ponder } from '@/generated'
import { publishToERC8004 } from './redpanda-sink.js'
import { computeEventId } from '../../../packages/core/src/types/events.js'

ponder.on('IdentityRegistry:AgentRegistered', async ({ event }) => {
  const erc8004Event = {
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    event_type: 'agent_registered',
    source: 'erc8004',
    chain: 'base',
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
    timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    agent_id: event.args.agentId,
    owner_address: event.args.owner,
    tba_address: event.args.tba === '0x0000000000000000000000000000000000000000' ? null : event.args.tba,
    reputation_score: null,
    validator_address: null,
    evidence_hash: null,
    raw_data: JSON.stringify(event.args),
  }
  await publishToERC8004(`erc8004:${event.args.agentId}`, erc8004Event)
})

ponder.on('IdentityRegistry:AgentUpdated', async ({ event }) => {
  const erc8004Event = {
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    event_type: 'agent_updated',
    source: 'erc8004',
    chain: 'base',
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
    timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    agent_id: event.args.agentId,
    owner_address: '',
    tba_address: null,
    reputation_score: null,
    validator_address: null,
    evidence_hash: null,
    raw_data: JSON.stringify(event.args),
  }
  await publishToERC8004(`erc8004:${event.args.agentId}`, erc8004Event)
})

ponder.on('IdentityRegistry:OwnershipTransferred', async ({ event }) => {
  const erc8004Event = {
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    event_type: 'ownership_transferred',
    source: 'erc8004',
    chain: 'base',
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
    timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    agent_id: event.args.agentId,
    owner_address: event.args.newOwner,
    tba_address: null,
    reputation_score: null,
    validator_address: null,
    evidence_hash: null,
    raw_data: JSON.stringify({ ...event.args, old_owner: event.args.previousOwner }),
  }
  await publishToERC8004(`erc8004:${event.args.agentId}`, erc8004Event)
})
