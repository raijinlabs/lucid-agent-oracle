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

// Adapter framework
export type {
  AdapterDefinition,
  WebhookAdapter,
  WebhookContext,
  IdentityHandler,
  DbClient,
} from './adapters/adapter-types.js'
export { AdapterRegistry, adapterRegistry } from './adapters/registry.js'
export { registerDefaultAdapters } from './adapters/register-defaults.js'
export { topicForSource } from './adapters/topic-for-source.js'
export { mountWebhookRoutes } from './adapters/webhook-router.js'
export { dispatchIdentityEvent, getIdentityTopics } from './adapters/identity-dispatch.js'

// Identity verification (Plan 4B)
export type { WalletVerifier } from './identity/wallet-verifier.js'
export { VerifierRegistry, verifierRegistry } from './identity/wallet-verifier.js'
export { evmVerifier } from './identity/evm-verifier.js'
export { solanaVerifier } from './identity/solana-verifier.js'
export {
  formatChallengeMessage,
  formatAuthMessage,
  CHALLENGE_TTL_MS,
  AUTH_SIGNATURE_MAX_AGE_MS,
  type ChallengeMessageParams,
  type AuthMessageParams,
} from './identity/challenge.js'

// Built-in adapter definitions
export { gatewayTapAdapter } from './adapters/gateway-tap-adapter.js'
export { erc8004Adapter } from './adapters/erc8004-adapter.js'
export { heliusAdapter } from './adapters/helius-adapter.js'

// Adapter normalizers (low-level — prefer adapter definitions for new integrations)
export {
  transformReceiptEvent,
  transformAuditLogEntry,
  transformPaymentSession,
} from './adapters/gateway-tap.js'

export {
  normalizeAgentRegistered,
  normalizeAgentUpdated,
  normalizeOwnershipTransferred,
  normalizeReputationUpdated,
} from './adapters/erc8004.js'

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

// Events (Plan 3E)
export {
  CHANNELS,
  type Channel,
  type FeedEventPayload,
  type AgentEventPayload,
  type ReportEventPayload,
  type OracleEvent,
} from './events.js'
