/** @frozen v1 — do not modify without signer_set_id version bump.
 *
 *  Recursive key-sorted JSON serialization for deterministic hashing.
 *  This format is locked: changing it breaks signature verification for
 *  all existing attested values. See golden test in canonical-json.test.ts.
 *  RFC 8785 (JCS) evaluation deferred — current format is correct and deterministic. */
export function canonicalStringify(obj: unknown): string {
  if (obj === undefined) throw new Error('canonicalStringify: undefined is not a valid JSON value')
  if (obj === null) return JSON.stringify(obj)
  if (typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(v => canonicalStringify(v)).join(',') + ']'
  const sorted = Object.keys(obj as Record<string, unknown>).sort()
  const entries = sorted.map(k =>
    JSON.stringify(k) + ':' + canonicalStringify((obj as Record<string, unknown>)[k])
  )
  return '{' + entries.join(',') + '}'
}
