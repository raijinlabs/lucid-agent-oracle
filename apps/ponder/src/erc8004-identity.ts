import { ponder } from '@/generated'
import { upsertAgentFromERC8004 } from './db-sink.js'

ponder.on('IdentityRegistry:AgentRegistered', async ({ event }) => {
  await upsertAgentFromERC8004({
    agent_id: event.args.agentId,
    owner_address: event.args.owner,
    tba_address: event.args.tba === '0x0000000000000000000000000000000000000000' ? null : event.args.tba,
    chain: 'base',
    tx_hash: event.transaction.hash,
    timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
  })
})

ponder.on('IdentityRegistry:AgentUpdated', async ({ event }) => {
  // Update handled by upsert — re-register with same ID
  await upsertAgentFromERC8004({
    agent_id: event.args.agentId,
    owner_address: '', // no owner in update event
    tba_address: null,
    chain: 'base',
    tx_hash: event.transaction.hash,
    timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
  })
})

ponder.on('IdentityRegistry:OwnershipTransferred', async ({ event }) => {
  await upsertAgentFromERC8004({
    agent_id: event.args.agentId,
    owner_address: event.args.newOwner,
    tba_address: null,
    chain: 'base',
    tx_hash: event.transaction.hash,
    timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
  })
})
