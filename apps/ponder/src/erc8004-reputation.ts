import { ponder } from '@/generated'
import { writeERC8004Event } from './adapter-sink.js'
import { computeEventId } from '@lucid/oracle-core'

ponder.on('ReputationRegistry:ReputationUpdated', async ({ event }) => {
  await writeERC8004Event({
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    source: 'erc8004',
    source_adapter_ver: 1,
    chain: 'base',
    event_type: 'reputation_updated',
    event_timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    payload_json: JSON.stringify({
      agent_id: event.args.agentId,
      reputation_score: Number(event.args.score),
      validator_address: event.args.validator,
      evidence_hash: event.args.evidenceHash,
    }),
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
  })
})
