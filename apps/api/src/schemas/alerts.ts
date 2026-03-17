import { Type, type Static } from '@sinclair/typebox'

// ── Condition operators ──────────────────────────────────────

const ConditionOperator = Type.Union([
  Type.Literal('gt'),
  Type.Literal('gte'),
  Type.Literal('lt'),
  Type.Literal('lte'),
  Type.Literal('eq'),
  Type.Literal('neq'),
])

const AlertCondition = Type.Object({
  field: Type.String({ description: 'Payload field to evaluate (e.g., "value", "confidence")' }),
  operator: ConditionOperator,
  threshold: Type.Number({ description: 'Threshold value' }),
})

// ── Channel enum ─────────────────────────────────────────────

const ChannelEnum = Type.Union([
  Type.Literal('feeds'),
  Type.Literal('agent_events'),
  Type.Literal('reports'),
])

// ── Create alert request ─────────────────────────────────────

export const CreateAlertBody = Type.Object({
  channel: ChannelEnum,
  url: Type.String({ format: 'uri', description: 'HTTPS webhook URL' }),
  filter: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()), {
    description: 'Narrows which events trigger this alert',
  })),
  conditions: Type.Optional(AlertCondition),
}, { $id: 'CreateAlertBody' })

export type CreateAlertBody = Static<typeof CreateAlertBody>

// ── Alert subscription response ──────────────────────────────

export const AlertSubscription = Type.Object({
  id: Type.String(),
  channel: ChannelEnum,
  url: Type.String(),
  filter: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
  conditions: Type.Optional(AlertCondition),
  active: Type.Boolean(),
  created_at: Type.String(),
}, { $id: 'AlertSubscription' })

export type AlertSubscription = Static<typeof AlertSubscription>

// ── Create response (includes secret) ────────────────────────

export const CreateAlertResponse = Type.Object({
  subscription: AlertSubscription,
  secret: Type.String({ description: 'HMAC secret for webhook verification (shown once)' }),
}, { $id: 'CreateAlertResponse' })

export type CreateAlertResponse = Static<typeof CreateAlertResponse>

// ── List response ────────────────────────────────────────────

export const AlertListResponse = Type.Object({
  data: Type.Array(AlertSubscription),
}, { $id: 'AlertListResponse' })

export type AlertListResponse = Static<typeof AlertListResponse>

// ── Alert ID params ──────────────────────────────────────────

export const AlertIdParams = Type.Object({
  id: Type.String({ description: 'Alert subscription ID' }),
}, { $id: 'AlertIdParams' })

export type AlertIdParams = Static<typeof AlertIdParams>
