import { ponder } from '@/generated'
import { writeERC8004Event } from './adapter-sink.js'
import { computeEventId } from '@lucid/oracle-core'

// ERC-8004 Reputation Registry — NewFeedback events from Base mainnet.
// Captures trust signals, ratings, and evidence per agent.

ponder.on('ReputationRegistry:NewFeedback', async ({ event }) => {
  await writeERC8004Event({
    event_id: computeEventId('erc8004_reputation', 'base', event.transaction.hash, Number(event.log.logIndex)),
    source: 'erc8004',
    source_adapter_ver: 3,
    chain: 'base',
    event_type: 'new_feedback',
    event_timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    payload_json: JSON.stringify({
      agent_id: event.args.agentId.toString(),
      client_address: event.args.clientAddress,
      feedback_index: Number(event.args.feedbackIndex),
      value: Number(event.args.value),            // int128 — rating value
      value_decimals: event.args.valueDecimals,    // decimal places for value
      tag1: event.args.tag1,                       // e.g. "trust"
      tag2: event.args.tag2,                       // e.g. "oracle-screening"
      endpoint: event.args.endpoint,               // service endpoint rated
      feedback_uri: event.args.feedbackURI,        // off-chain evidence
      feedback_hash: event.args.feedbackHash,      // evidence hash
    }),
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
  })
})
