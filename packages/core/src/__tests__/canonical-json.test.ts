import { describe, it, expect } from 'vitest'
import { canonicalStringify } from '../utils/canonical-json.js'

describe('canonicalStringify', () => {
  it('produces deterministic output for nested objects (golden test — v1 frozen format)', () => {
    const input = {
      z: 1,
      a: [3, 1, { y: true, x: null }],
      m: 'hello',
    }
    expect(canonicalStringify(input)).toBe(
      '{"a":[3,1,{"x":null,"y":true}],"m":"hello","z":1}'
    )
  })

  it('handles primitives', () => {
    expect(canonicalStringify(null)).toBe('null')
    expect(canonicalStringify(42)).toBe('42')
    expect(canonicalStringify('test')).toBe('"test"')
    expect(canonicalStringify(true)).toBe('true')
  })

  it('throws on undefined input (not a valid JSON value)', () => {
    expect(() => canonicalStringify(undefined)).toThrow()
  })

  it('handles empty structures', () => {
    expect(canonicalStringify({})).toBe('{}')
    expect(canonicalStringify([])).toBe('[]')
  })
})
