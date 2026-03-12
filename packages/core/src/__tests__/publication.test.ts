import { describe, it, expect } from 'vitest'
import { encodeOnChainValue } from '../types/publication.js'

describe('encodeOnChainValue', () => {
  it('encodes AEGDP value_usd as USD × 10^6', () => {
    const result = encodeOnChainValue('aegdp', 847_000, null)
    expect(result).toEqual({ value: 847_000_000_000n, decimals: 6 })
  })

  it('encodes AAI value_index as integer (decimals=0)', () => {
    const result = encodeOnChainValue('aai', null, 742)
    expect(result).toEqual({ value: 742n, decimals: 0 })
  })

  it('encodes APRI value_index as integer (decimals=0)', () => {
    const result = encodeOnChainValue('apri', null, 3200)
    expect(result).toEqual({ value: 3200n, decimals: 0 })
  })

  it('throws for unknown feed_id', () => {
    expect(() => encodeOnChainValue('unknown' as any, 100, null)).toThrow('Unknown feed_id')
  })

  it('throws when AEGDP has no value_usd', () => {
    expect(() => encodeOnChainValue('aegdp', null, null)).toThrow('AEGDP requires value_usd')
  })

  it('throws when AAI/APRI has no value_index', () => {
    expect(() => encodeOnChainValue('aai', null, null)).toThrow('AAI requires value_index')
  })
})
