export interface Condition {
  field: string
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  threshold: number
}

export function evaluateCondition(
  condition: Condition | undefined | null,
  payload: Record<string, unknown>,
): boolean {
  if (!condition) return true // No condition = fire on every event

  const value = payload[condition.field]
  if (value === undefined || value === null) return false

  const num = Number(value)
  if (Number.isNaN(num)) return false

  switch (condition.operator) {
    case 'gt':  return num > condition.threshold
    case 'gte': return num >= condition.threshold
    case 'lt':  return num < condition.threshold
    case 'lte': return num <= condition.threshold
    case 'eq':  return num === condition.threshold
    case 'neq': return num !== condition.threshold
    default:    return false
  }
}

export function matchesFilter(
  channel: string,
  filter: Record<string, string[]> | undefined | null,
  payload: Record<string, unknown>,
): boolean {
  if (!filter) return true

  if (channel === 'feeds' && filter.feedIds) {
    return filter.feedIds.includes(payload.feedId as string)
  }
  if (channel === 'agent_events' && filter.agentIds) {
    return filter.agentIds.includes(payload.agentId as string)
  }
  // reports — no standard filter key yet, pass through
  return true
}
