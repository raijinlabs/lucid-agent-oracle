import { describe, it, expect } from 'vitest'
import { evaluateCondition, matchesFilter } from '../evaluate.js'

describe('evaluateCondition', () => {
  it('gt: true when value > threshold', () => {
    expect(evaluateCondition({ field: 'value', operator: 'gt', threshold: 100 }, { value: 150 })).toBe(true)
  })

  it('gt: false when value <= threshold', () => {
    expect(evaluateCondition({ field: 'value', operator: 'gt', threshold: 100 }, { value: 100 })).toBe(false)
  })

  it('gte: true when value >= threshold', () => {
    expect(evaluateCondition({ field: 'value', operator: 'gte', threshold: 100 }, { value: 100 })).toBe(true)
  })

  it('lt: true when value < threshold', () => {
    expect(evaluateCondition({ field: 'value', operator: 'lt', threshold: 100 }, { value: 50 })).toBe(true)
  })

  it('lte: true when value <= threshold', () => {
    expect(evaluateCondition({ field: 'value', operator: 'lte', threshold: 100 }, { value: 100 })).toBe(true)
  })

  it('eq: true when value == threshold', () => {
    expect(evaluateCondition({ field: 'value', operator: 'eq', threshold: 100 }, { value: 100 })).toBe(true)
  })

  it('neq: true when value != threshold', () => {
    expect(evaluateCondition({ field: 'value', operator: 'neq', threshold: 100 }, { value: 50 })).toBe(true)
  })

  it('returns true when no condition (fire on every event)', () => {
    expect(evaluateCondition(undefined, { value: 50 })).toBe(true)
  })

  it('handles nested payload field via dot access', () => {
    expect(evaluateCondition({ field: 'confidence', operator: 'lt', threshold: 0.5 }, { confidence: 0.3 })).toBe(true)
  })

  it('returns false when field is missing from payload', () => {
    expect(evaluateCondition({ field: 'missing', operator: 'gt', threshold: 0 }, { value: 100 })).toBe(false)
  })
})

describe('matchesFilter', () => {
  it('matches when no filter', () => {
    expect(matchesFilter('feeds', undefined, { feedId: 'aegdp' })).toBe(true)
  })

  it('matches when feedId in filter list', () => {
    expect(matchesFilter('feeds', { feedIds: ['aegdp', 'aai'] }, { feedId: 'aegdp' })).toBe(true)
  })

  it('does not match when feedId not in filter list', () => {
    expect(matchesFilter('feeds', { feedIds: ['aai'] }, { feedId: 'aegdp' })).toBe(false)
  })

  it('matches agent_events by agentId', () => {
    expect(matchesFilter('agent_events', { agentIds: ['a1'] }, { agentId: 'a1' })).toBe(true)
  })

  it('matches reports when no filter specified', () => {
    expect(matchesFilter('reports', undefined, { reportId: 'r1' })).toBe(true)
  })
})
