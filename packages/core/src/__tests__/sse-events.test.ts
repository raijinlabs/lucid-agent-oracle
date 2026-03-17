import { describe, it, expect } from 'vitest'
import {
  CHANNELS,
  type Channel,
  type FeedEventPayload,
  type AgentEventPayload,
  type ReportEventPayload,
  type OracleEvent,
} from '../events.js'

describe('Event types', () => {
  it('exports all three channel names', () => {
    expect(CHANNELS).toEqual(['feeds', 'agent_events', 'reports'])
  })

  it('channel type accepts valid channels', () => {
    const ch: Channel = 'feeds'
    expect(CHANNELS.includes(ch)).toBe(true)
  })

  it('OracleEvent shape is valid', () => {
    const event: OracleEvent = {
      id: '1710547200000-1',
      channel: 'feeds',
      ts: '2026-03-16T12:00:00Z',
      payload: {
        feedId: 'aegdp',
        value: 142.7,
        confidence: 0.94,
        freshness: 12,
        revision: 8847,
      },
    }
    expect(event.channel).toBe('feeds')
    expect(event.id).toContain('-')
  })
})
