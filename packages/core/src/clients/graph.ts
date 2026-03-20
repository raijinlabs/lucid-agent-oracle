/**
 * The Graph client — centralized GraphQL query interface for all subgraph interactions.
 *
 * Reusable across identity ingestion, reputation queries, metadata lookups, etc.
 * Builds gateway URLs from subgraph IDs + GRAPH_API_KEY env var, with fallback
 * to full URLs for backward compatibility.
 */

// ── Types ──

export interface GraphQueryResult<T = any> {
  data: T | null
  errors?: Array<{ message: string }>
}

export interface GraphClientConfig {
  /** The Graph gateway API key (from env). Overrides keys embedded in URLs. */
  apiKey?: string
  /** HTTP timeout in milliseconds (default: 15000) */
  timeoutMs?: number
}

// ── URL builder ──

/** The Graph gateway base URL */
const GRAPH_GATEWAY = 'https://gateway.thegraph.com/api'

/**
 * Build a full subgraph URL from a subgraph ID and API key.
 * If no apiKey is provided, reads from GRAPH_API_KEY env var.
 * Returns null if no key is available.
 */
export function buildSubgraphUrl(subgraphId: string, apiKey?: string): string | null {
  const key = apiKey ?? process.env.GRAPH_API_KEY
  if (!key) return null
  return `${GRAPH_GATEWAY}/${key}/subgraphs/id/${subgraphId}`
}

/** Regex to match and replace the API key portion of a Graph gateway URL */
const GRAPH_URL_RE = /^https:\/\/gateway\.thegraph\.com\/api\/([^/]+)\/subgraphs\/id\/(.+)$/

/**
 * Extract the subgraph ID from a full Graph gateway URL.
 * Returns null if the URL doesn't match the expected pattern.
 */
export function extractSubgraphId(url: string): string | null {
  const m = GRAPH_URL_RE.exec(url)
  return m ? m[2] : null
}

/**
 * Replace the API key in a Graph gateway URL with GRAPH_API_KEY env var (if set).
 * If GRAPH_API_KEY is not set, returns the original URL unchanged (backward compat).
 */
export function resolveGraphUrl(url: string): string {
  const envKey = process.env.GRAPH_API_KEY
  if (!envKey) return url
  return url.replace(GRAPH_URL_RE, `${GRAPH_GATEWAY}/${envKey}/subgraphs/id/$2`)
}

// ── Generic query client ──

/**
 * Query a Graph Protocol subgraph via HTTP POST.
 *
 * If GRAPH_API_KEY env var is set, the API key portion of the URL is replaced
 * with the env var value. Otherwise the URL is used as-is (backward compat).
 *
 * @param subgraphUrl - Full Graph gateway URL (or partial — will be resolved)
 * @param query       - GraphQL query string
 * @param variables   - Optional GraphQL variables
 * @param timeoutMs   - HTTP timeout (default 15000)
 * @returns Parsed response data, or throws on HTTP/GraphQL errors
 */
export async function queryGraph<T = any>(
  subgraphUrl: string,
  query: string,
  variables?: Record<string, any>,
  timeoutMs = 15_000,
): Promise<GraphQueryResult<T>> {
  const url = resolveGraphUrl(subgraphUrl)
  const body = JSON.stringify(variables ? { query, variables } : { query })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Graph HTTP ${res.status}: ${text.slice(0, 200)}`)
    }

    const json = (await res.json()) as GraphQueryResult<T>

    if (json.errors?.length) {
      throw new Error(`Graph GraphQL error: ${json.errors[0].message}`)
    }

    return json
  } finally {
    clearTimeout(timer)
  }
}
