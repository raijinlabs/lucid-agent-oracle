// Types
export * from './types/index.js'

// Services
export { computeConfidence, computeFreshnessScore, computeStalenessRisk } from './services/confidence-service.js'
export { AttestationService, type ReportPayload, type ReportEnvelope } from './services/attestation-service.js'

// Feeds
export { computeAEGDP, type AEGDPInputs, type AEGDPResult } from './feeds/aegdp.js'

// Adapters
export {
  transformReceiptEvent,
  transformAuditLogEntry,
  transformPaymentSession,
} from './adapters/gateway-tap.js'

// Clients
export { OracleClickHouse, type ClickHouseConfig, type RollupRow, type StoredFeedValue } from './clients/clickhouse.js'
export { RedpandaProducer, RedpandaConsumer, TOPICS, type RedpandaConfig } from './clients/redpanda.js'

// Utils
export { canonicalStringify } from './utils/canonical-json.js'
