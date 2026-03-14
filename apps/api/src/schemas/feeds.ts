import { Type, type Static } from '@sinclair/typebox'
import { DataEnvelope } from './common.js'

// ---------------------------------------------------------------------------
// Feed ID params (shared with v1.ts feed routes)
// ---------------------------------------------------------------------------

export const FeedIdParams = Type.Object(
  {
    id: Type.String({ description: 'Feed identifier (aegdp, aai, apri)' }),
  },
  { $id: 'FeedIdParams' },
)

export type FeedIdParams = Static<typeof FeedIdParams>

// ---------------------------------------------------------------------------
// Feed History
// ---------------------------------------------------------------------------

export const FeedHistoryQuery = Type.Object(
  {
    period: Type.Optional(
      Type.Union([
        Type.Literal('1d'),
        Type.Literal('7d'),
        Type.Literal('30d'),
        Type.Literal('90d'),
      ], { default: '7d' }),
    ),
    interval: Type.Optional(
      Type.Union([
        Type.Literal('1m'),
        Type.Literal('1h'),
        Type.Literal('1d'),
      ], { default: '1h' }),
    ),
  },
  { $id: 'FeedHistoryQuery' },
)

export type FeedHistoryQuery = Static<typeof FeedHistoryQuery>

export const FeedHistoryPoint = Type.Object({
  timestamp: Type.String(),
  value: Type.String(),
  confidence: Type.Number(),
})

export type FeedHistoryPoint = Static<typeof FeedHistoryPoint>

const FeedHistoryData = Type.Object({
  feed_id: Type.String(),
  period: Type.String(),
  interval: Type.String(),
  has_data: Type.Boolean(),
  points: Type.Array(FeedHistoryPoint),
})

export const FeedHistoryResponse = DataEnvelope(FeedHistoryData, 'FeedHistoryResponse')

export type FeedHistoryResponse = Static<typeof FeedHistoryResponse>

// ---------------------------------------------------------------------------
// V1 existing route schemas (needed for OpenAPI completeness → Speakeasy)
// ---------------------------------------------------------------------------

const FeedValuePublic = Type.Object({
  feed_id: Type.String(),
  value: Type.String(),
  confidence: Type.Number(),
  completeness: Type.Number(),
  freshness_ms: Type.Integer(),
  staleness_risk: Type.String(),
  computed_at: Type.String(),
  signer: Type.String(),
  signature: Type.String(),
})

const FeedDefPublic = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  version: Type.Integer(),
  methodology_url: Type.String(),
  update_interval_ms: Type.Integer(),
  deviation_threshold_bps: Type.Integer(),
  latest_value: Type.Union([FeedValuePublic, Type.Null()]),
})

export const FeedListResponse = Type.Object(
  { feeds: Type.Array(FeedDefPublic) },
  { $id: 'FeedListResponse' },
)

export const FeedDetailResponse = Type.Object(
  {
    feed: Type.Object({
      id: Type.String(),
      name: Type.String(),
      description: Type.String(),
      version: Type.Integer(),
      methodology_url: Type.String(),
    }),
    latest: Type.Union([FeedValuePublic, Type.Null()]),
    methodology_url: Type.String(),
  },
  { $id: 'FeedDetailResponse' },
)

export const FeedMethodologyResponse = Type.Object(
  {
    feed_id: Type.String(),
    version: Type.Integer(),
    name: Type.String(),
    description: Type.String(),
    update_interval_ms: Type.Integer(),
    deviation_threshold_bps: Type.Integer(),
    confidence_formula: Type.Object({
      version: Type.Integer(),
      weights: Type.Record(Type.String(), Type.Number()),
    }),
    computation: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    canonical_json_version: Type.Optional(Type.String()),
  },
  { $id: 'FeedMethodologyResponse' },
)

export const ReportLatestResponse = Type.Object(
  {
    report: Type.Union([
      Type.Object({ feeds: Type.Array(FeedValuePublic) }),
      Type.Null(),
    ]),
  },
  { $id: 'ReportLatestResponse' },
)
