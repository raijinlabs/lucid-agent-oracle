/** Recursive key-sorted JSON serialization for deterministic hashing.
 *  TODO(plan-2): Evaluate RFC 8785 (JCS) before on-chain publication. */
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
