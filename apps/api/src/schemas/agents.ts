import { Type, type Static } from '@sinclair/typebox'
import {
  CursorQuery,
  CursorMeta,
  PaginatedList,
  DataEnvelope,
} from './common.js'

// Re-export helpers used by route files
export { CursorMeta, PaginatedList, DataEnvelope }

// ---------------------------------------------------------------------------
// 1. Wallet (sub-schema, no $id)
// ---------------------------------------------------------------------------

export const Wallet = Type.Object({
  chain: Type.String(),
  address: Type.String(),
  link_type: Type.String(),
  confidence: Type.Number(),
})

export type Wallet = Static<typeof Wallet>

// ---------------------------------------------------------------------------
// 2. IdentityLink (sub-schema, no $id)
// ---------------------------------------------------------------------------

export const IdentityLink = Type.Object({
  protocol: Type.String(),
  protocol_id: Type.String(),
  link_type: Type.String(),
  confidence: Type.Number(),
})

export type IdentityLink = Static<typeof IdentityLink>

// ---------------------------------------------------------------------------
// 3. AgentProfile ($id: 'AgentProfile')
// ---------------------------------------------------------------------------

export const AgentProfile = Type.Object(
  {
    id: Type.String(),
    display_name: Type.Union([Type.String(), Type.Null()]),
    erc8004_id: Type.Union([Type.String(), Type.Null()]),
    lucid_tenant: Type.Union([Type.String(), Type.Null()]),
    reputation: Type.Union([
      Type.Object({
        score: Type.Number(),
        updated_at: Type.String(),
      }),
      Type.Null(),
    ]),
    wallets: Type.Array(Wallet),
    protocols: Type.Array(IdentityLink),
    stats: Type.Object({
      wallet_count: Type.Integer(),
      protocol_count: Type.Integer(),
      evidence_count: Type.Integer(),
    }),
    created_at: Type.String(),
    updated_at: Type.String(),
  },
  { $id: 'AgentProfile' },
)

export type AgentProfile = Static<typeof AgentProfile>

// ---------------------------------------------------------------------------
// 4. AgentProfileResponse
// ---------------------------------------------------------------------------

export const AgentProfileResponse = DataEnvelope(AgentProfile, 'AgentProfileResponse')

export type AgentProfileResponse = Static<typeof AgentProfileResponse>

// ---------------------------------------------------------------------------
// 5. AgentSearchQuery ($id: 'AgentSearchQuery')
// ---------------------------------------------------------------------------

export const AgentSearchQuery = Type.Intersect(
  [
    CursorQuery,
    Type.Object({
      wallet: Type.Optional(Type.String()),
      chain: Type.Optional(Type.String()),
      protocol: Type.Optional(Type.String()),
      protocol_id: Type.Optional(Type.String()),
      erc8004_id: Type.Optional(Type.String()),
      q: Type.Optional(Type.String({ maxLength: 200 })),
    }),
  ],
  { $id: 'AgentSearchQuery' },
)

export type AgentSearchQuery = Static<typeof AgentSearchQuery>

// ---------------------------------------------------------------------------
// 6. AgentSearchItem (sub-schema, no $id)
// ---------------------------------------------------------------------------

export const AgentSearchItem = Type.Object({
  id: Type.String(),
  display_name: Type.Union([Type.String(), Type.Null()]),
  erc8004_id: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
})

export type AgentSearchItem = Static<typeof AgentSearchItem>

// ---------------------------------------------------------------------------
// 7. AgentSearchResponse
// ---------------------------------------------------------------------------

export const AgentSearchResponse = PaginatedList(AgentSearchItem, 'AgentSearchResponse')

export type AgentSearchResponse = Static<typeof AgentSearchResponse>

// ---------------------------------------------------------------------------
// 8. LeaderboardQuery ($id: 'LeaderboardQuery')
// ---------------------------------------------------------------------------

export const LeaderboardQuery = Type.Intersect(
  [
    CursorQuery,
    Type.Object({
      sort: Type.Optional(
        Type.Union([
          Type.Literal('wallet_count'),
          Type.Literal('protocol_count'),
          Type.Literal('evidence_count'),
          Type.Literal('newest'),
        ], { default: 'wallet_count' }),
      ),
    }),
  ],
  { $id: 'LeaderboardQuery' },
)

export type LeaderboardQuery = Static<typeof LeaderboardQuery>

// ---------------------------------------------------------------------------
// 9. LeaderboardItem (sub-schema, no $id)
// ---------------------------------------------------------------------------

export const LeaderboardItem = Type.Object({
  id: Type.String(),
  display_name: Type.Union([Type.String(), Type.Null()]),
  erc8004_id: Type.Union([Type.String(), Type.Null()]),
  wallet_count: Type.Integer(),
  protocol_count: Type.Integer(),
  evidence_count: Type.Integer(),
  created_at: Type.String(),
})

export type LeaderboardItem = Static<typeof LeaderboardItem>

// ---------------------------------------------------------------------------
// 10. LeaderboardResponse
// ---------------------------------------------------------------------------

export const LeaderboardResponse = PaginatedList(LeaderboardItem, 'LeaderboardResponse')

export type LeaderboardResponse = Static<typeof LeaderboardResponse>

// ---------------------------------------------------------------------------
// 11. AgentMetricsResponse ($id: 'AgentMetricsResponse')
// ---------------------------------------------------------------------------

export const AgentMetricsResponse = Type.Object(
  {
    data: Type.Object({
      agent_id: Type.String(),
      wallets: Type.Object({
        total: Type.Integer(),
        by_chain: Type.Record(Type.String(), Type.Integer()),
        by_link_type: Type.Record(Type.String(), Type.Integer()),
      }),
      evidence: Type.Object({
        total: Type.Integer(),
        by_type: Type.Record(Type.String(), Type.Integer()),
      }),
      protocols: Type.Object({
        total: Type.Integer(),
        list: Type.Array(Type.String()),
      }),
      conflicts: Type.Object({
        active: Type.Integer(),
        resolved: Type.Integer(),
      }),
      first_seen: Type.String(),
      last_active: Type.String(),
    }),
  },
  { $id: 'AgentMetricsResponse' },
)

export type AgentMetricsResponse = Static<typeof AgentMetricsResponse>

// ---------------------------------------------------------------------------
// 12. ActivityQuery ($id: 'ActivityQuery')
// ---------------------------------------------------------------------------

export const ActivityQuery = Type.Intersect(
  [CursorQuery],
  { $id: 'ActivityQuery' },
)

export type ActivityQuery = Static<typeof ActivityQuery>

// ---------------------------------------------------------------------------
// 13. ActivityEvent (sub-schema, no $id)
// ---------------------------------------------------------------------------

export const ActivityEvent = Type.Object({
  type: Type.Union([
    Type.Literal('evidence_added'),
    Type.Literal('conflict_opened'),
    Type.Literal('wallet_linked'),
  ]),
  timestamp: Type.String(),
  detail: Type.Record(Type.String(), Type.Unknown()),
})

export type ActivityEvent = Static<typeof ActivityEvent>

// ---------------------------------------------------------------------------
// 14. ActivityResponse
// ---------------------------------------------------------------------------

export const ActivityResponse = PaginatedList(ActivityEvent, 'ActivityResponse')

export type ActivityResponse = Static<typeof ActivityResponse>

// ---------------------------------------------------------------------------
// 15. ModelUsageQuery ($id: 'ModelUsageQuery')
// ---------------------------------------------------------------------------

export const ModelUsageQuery = Type.Object(
  {
    period: Type.Optional(
      Type.Union([
        Type.Literal('1d'),
        Type.Literal('7d'),
        Type.Literal('30d'),
      ], { default: '7d' }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 50, default: 20 }),
    ),
  },
  { $id: 'ModelUsageQuery' },
)

export type ModelUsageQuery = Static<typeof ModelUsageQuery>

// ---------------------------------------------------------------------------
// 16. ModelUsageEntry (sub-schema, no $id)
// ---------------------------------------------------------------------------

export const ModelUsageEntry = Type.Object({
  model_id: Type.String(),
  provider: Type.String(),
  event_count: Type.Integer(),
  pct: Type.Number(),
})

export type ModelUsageEntry = Static<typeof ModelUsageEntry>

// ---------------------------------------------------------------------------
// 17. ModelUsageResponse ($id: 'ModelUsageResponse')
// ---------------------------------------------------------------------------

const ModelUsageData = Type.Object({
  period: Type.String(),
  has_data: Type.Boolean(),
  models: Type.Array(ModelUsageEntry),
  total_events: Type.Integer(),
})

export const ModelUsageResponse = DataEnvelope(ModelUsageData, 'ModelUsageResponse')

export type ModelUsageResponse = Static<typeof ModelUsageResponse>
