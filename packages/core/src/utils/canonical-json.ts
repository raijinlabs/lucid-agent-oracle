/** Recursive key-sorted JSON serialization for deterministic hashing.
 *
 *  HARD GATE for Plan 2: The canonicalization format MUST be frozen before
 *  any on-chain publication or external API consumers depend on attestation
 *  signatures. Evaluate RFC 8785 (JCS) as a candidate replacement. Once
 *  frozen, changing the format would break signature verification for all
 *  existing attested values. */
export function canonicalStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj)
  if (typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(v => canonicalStringify(v)).join(',') + ']'
  const sorted = Object.keys(obj as Record<string, unknown>).sort()
  const entries = sorted.map(k =>
    JSON.stringify(k) + ':' + canonicalStringify((obj as Record<string, unknown>)[k])
  )
  return '{' + entries.join(',') + '}'
}
