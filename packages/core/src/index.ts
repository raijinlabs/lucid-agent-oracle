// Types
export * from './types/index.js'
export { encodeOnChainValue, type PublicationRequest, type OnChainValue } from './types/publication.js'

// Services
export { computeConfidence, computeFreshnessScore, computeStalenessRisk } from './services/confidence-service.js'
export { AttestationService, type ReportPayload, type ReportEnvelope } from './services/attestation-service.js'

// Feeds
export { computeAEGDP, type AEGDPInputs, type AEGDPResult } from './feeds/aegdp.js'
export { computeAAI, AAI_WEIGHTS, AAI_NORMALIZATION, type AAIInputs, type AAIResult } from './feeds/aai.js'
export { computeAPRI, APRI_WEIGHTS, type APRIInputs, type APRIResult } from './feeds/apri.js'

// Adapters
export {
  transformReceiptEvent,
  transformAuditLogEntry,
  transformPaymentSession,
} from './adapters/gateway-tap.js'

// Adapters (ERC-8004)
export {
  normalizeAgentRegistered,
  normalizeAgentUpdated,
  normalizeOwnershipTransferred,
  normalizeReputationUpdated,
} from './adapters/erc8004.js'

// Adapters (Helius)
export { normalizeHeliusTransaction, verifyHeliusSignature, type HeliusTransaction } from './adapters/helius.js'

// Clients
export {
  OracleClickHouse,
  type ClickHouseConfig,
  type WindowAggregates,
  type ProtocolUsdRow,
  type ProviderCountRow,
  type PublishedFeedRow,
} from './clients/clickhouse.js'
export { RedpandaProducer, RedpandaConsumer, TOPICS, type RedpandaConfig } from './clients/redpanda.js'

// Utils
export { canonicalStringify } from './utils/canonical-json.js'
