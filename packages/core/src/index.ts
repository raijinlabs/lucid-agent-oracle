// Types
export * from './types/index.js'
export { encodeOnChainValue, type PublicationRequest, type OnChainValue } from './types/publication.js'

// Services
export { computeConfidence, computeFreshnessScore, computeStalenessRisk } from './services/confidence-service.js'
export {
  AttestationService,
  MultiSignerAttestationService,
  SignerSetRegistry,
  signerSetRegistry,
  type ReportPayload,
  type ReportEnvelope,
  type SignerSet,
} from './services/attestation-service.js'

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

// Adapter Sink (no-broker mode)
export type { AdapterSink, RawAdapterEvent } from './adapters/sink.js'
export { DirectSink } from './adapters/direct-sink.js'
export { createAdapterSink, type SinkConfig } from './adapters/sink-factory.js'
export { processAdapterEvents, startResolverPoller, type ResolverPollConfig, type IdentityDispatcher } from './adapters/resolver-poller.js'
export { startURIResolver, resolveAgentURIs } from './adapters/uri-resolver.js'
export { startTxHarvester, harvestBaseTransactions } from './adapters/base-tx-harvester.js'
export { startSolanaTxHarvester, harvestSolanaTransactions } from './adapters/solana-tx-harvester.js'
export { TokenRegistry } from './adapters/token-registry.js'
export { updatePositionLedger, getAgentRealizedDeltas } from './adapters/position-ledger.js'
export { startMoralisClassifier, classifyWalletTransactions } from './adapters/moralis-classifier.js'
export { startBalanceEnricher, enrichWalletBalances, type BalanceEnricherConfig } from './adapters/balance-enricher.js'
export { startEconomyMetrics, computeEconomySnapshot, type EconomySnapshot, type EconomyMetricsConfig } from './adapters/economy-metrics.js'
export { startENSResolver, resolveNames, type ENSResolverConfig, type NameResolution } from './adapters/ens-resolver.js'
export { startOlasEnricher, enrichOlasAgents, type OlasEnricherConfig } from './adapters/olas-enricher.js'
export { startGasMetrics, computeGasMetrics, getAgentGasMetrics, type GasMetricsConfig, type GasMetricsResult } from './adapters/gas-metrics.js'
export { startContractAnalyzer, analyzeContractInteractions, getAgentContractInteractions, type ContractAnalyzerConfig, type ContractInteraction } from './adapters/contract-analyzer.js'
export { startDefiEnricher, enrichDefiPositions, type DefiEnricherConfig } from './adapters/defi-enricher.js'
export { startNftEnricher, enrichNftHoldings, type NftEnricherConfig } from './adapters/nft-enricher.js'
export {
  startSubgraphIngester, runSubgraphSync, syncSubgraphChain,
  querySubgraph, writeAgentStagingEvent, getCheckpoint, setCheckpoint,
  type SubgraphAgent, type SubgraphSyncResult, type SubgraphIngesterConfig,
} from './adapters/subgraph-ingester.js'

// Chain configuration + enricher utilities
export { CHAINS, EVM_CHAINS, ALL_CHAIN_IDS, getMoralisChainParam, type ChainConfig } from './adapters/chains.js'
export { withAdvisoryLock, processBatch, startEnricherLoop, fetchMoralis } from './adapters/enricher-utils.js'

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
export { erc8004Adapter, erc8004IdentityHandler } from './adapters/erc8004-adapter.js'
export { heliusAdapter } from './adapters/helius-adapter.js'
export { sol8004Adapter } from './adapters/sol8004-adapter.js'

// Solana Identity (pluggable provider system)
export type { SolanaIdentityProvider, StagingEvent, SolanaIdentityIndexerConfig } from './adapters/solana-identity/types.js'
export { Sol8004Provider } from './adapters/solana-identity/sol8004-provider.js'
export { startSolanaIdentityIndexer, indexSolanaIdentityEvents } from './adapters/solana-identity/indexer.js'

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

// Metrics (lightweight — no OTel SDK dependency, just @opentelemetry/api)
export * as oracleMetrics from './metrics.js'

// Events (Plan 3E)
export {
  CHANNELS,
  type Channel,
  type FeedEventPayload,
  type AgentEventPayload,
  type ReportEventPayload,
  type OracleEvent,
} from './events.js'
