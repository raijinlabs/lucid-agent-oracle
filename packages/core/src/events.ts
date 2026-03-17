/** Logical SSE/webhook channel names */
export const CHANNELS = ['feeds', 'agent_events', 'reports'] as const
export type Channel = (typeof CHANNELS)[number]

/** Feed update event payload */
export interface FeedEventPayload {
  feedId: string
  value: number
  confidence: number
  freshness: number
  revision: number
}

/** Agent activity event payload */
export interface AgentEventPayload {
  agentId: string
  eventType: string
  delta: Record<string, unknown>
}

/** Published report event payload */
export interface ReportEventPayload {
  reportId: string
  feedIds: string[]
  attestation: string
}

/** Unified event envelope emitted by EventBus */
export interface OracleEvent {
  id: string
  channel: Channel
  ts: string
  payload: FeedEventPayload | AgentEventPayload | ReportEventPayload | Record<string, unknown>
}
