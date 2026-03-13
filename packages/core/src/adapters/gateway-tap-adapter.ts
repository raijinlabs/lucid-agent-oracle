import type { AdapterDefinition } from './adapter-types.js'
import { TOPICS } from '../clients/redpanda.js'

/** Lucid Gateway adapter — ingests receipts, audit logs, and payment sessions */
export const gatewayTapAdapter: AdapterDefinition = {
  source: 'lucid_gateway',
  version: 1,
  description: 'Lucid AI Gateway — receipts, audit logs, payment sessions',
  topic: TOPICS.RAW_GATEWAY,
  chains: ['offchain'],
  // No webhook — uses polling via the worker app
  // No identity handler — gateway events use tenant IDs, not on-chain identities
}
