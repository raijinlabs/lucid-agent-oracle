import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Post-process openapi.json to add x-speakeasy-mcp annotations.
 * Run after: curl http://localhost:4040/docs/json > openapi.json
 * Run before: speakeasy generate
 */

interface OpenAPISpec {
  paths: Record<string, Record<string, { 'x-speakeasy-mcp'?: Record<string, unknown> }>>
}

// Tool mappings: path+method → tool config
const TOOL_ANNOTATIONS: Record<string, { method: string; tool: Record<string, unknown> }> = {
  '/v1/oracle/feeds': {
    method: 'get',
    tool: { 'tool-name': 'oracle_economy_snapshot', description: 'Get current state of the agent economy — AEGDP, AAI, APRI feed values with confidence and freshness.' },
  },
  '/v1/oracle/feeds/{id}': {
    method: 'get',
    tool: { 'tool-name': 'oracle_feed_value', description: 'Deep dive on a single oracle feed with its latest value and methodology context.' },
  },
  '/v1/oracle/feeds/{id}/methodology': {
    method: 'get',
    tool: { 'tool-name': 'oracle_feed_value', description: 'Feed methodology detail — grouped with oracle_feed_value.' },
  },
  '/v1/oracle/feeds/{id}/history': {
    method: 'get',
    tool: { 'tool-name': 'oracle_feed_history', description: 'Time-series feed values for trend analysis. Empty results mean no data for the period, not an error.' },
  },
  '/v1/oracle/agents/search': {
    method: 'get',
    tool: { 'tool-name': 'oracle_agent_search', description: 'Find agents by wallet, protocol, ERC-8004 ID, or name.' },
  },
  '/v1/oracle/agents/{id}': {
    method: 'get',
    tool: { 'tool-name': 'oracle_agent_lookup', description: 'Agent profile — wallets, protocols, reputation, stats.' },
  },
  '/v1/oracle/agents/{id}/metrics': {
    method: 'get',
    tool: { 'tool-name': 'oracle_agent_deep_metrics', description: 'Full agent dossier — wallet/evidence/protocol breakdowns. Requires pro tier.' },
  },
  '/v1/oracle/agents/{id}/activity': {
    method: 'get',
    tool: { 'tool-name': 'oracle_agent_deep_metrics', description: 'Agent activity feed — grouped with oracle_agent_deep_metrics.' },
  },
  '/v1/oracle/agents/model-usage': {
    method: 'get',
    tool: { 'tool-name': 'oracle_model_usage', description: 'LLM model/provider distribution across the agent economy. Empty results mean no data, not an error.' },
  },
  '/v1/oracle/protocols': {
    method: 'get',
    tool: { 'tool-name': 'oracle_protocol_stats', description: 'Protocol listing with chain support and status.' },
  },
  '/v1/oracle/protocols/{id}': {
    method: 'get',
    tool: { 'tool-name': 'oracle_protocol_stats', description: 'Protocol detail with agent/wallet counts — grouped with oracle_protocol_stats.' },
  },
  '/v1/oracle/reports/verify': {
    method: 'post',
    tool: { 'tool-name': 'oracle_verify_report', description: 'Verify signed oracle report — Ed25519 signature + payload integrity + publication status.' },
  },
}

// Explicitly disabled endpoints (exclude from MCP)
// Uses tuples to support multiple methods on the same path
const DISABLED_ENTRIES: Array<{ path: string; method: string }> = [
  { path: '/v1/oracle/reports/latest', method: 'get' },
  { path: '/v1/oracle/agents/leaderboard', method: 'get' },
  { path: '/v1/oracle/protocols/{id}/metrics', method: 'get' },
  { path: '/health', method: 'get' },
  // Identity/admin routes — internal, must not become MCP tools
  { path: '/v1/oracle/agents/challenge', method: 'post' },
  { path: '/v1/oracle/agents/register', method: 'post' },
  { path: '/v1/internal/identity/conflicts', method: 'get' },
  { path: '/v1/internal/identity/conflicts/{id}', method: 'get' },
  { path: '/v1/internal/identity/conflicts/{id}', method: 'patch' },
  { path: '/v1/internal/identity/resolve-lucid', method: 'post' },
]

const specPath = process.argv[2] ?? 'openapi.json'
const spec = JSON.parse(readFileSync(specPath, 'utf-8')) as OpenAPISpec
let warnings = 0

// Add tool annotations
for (const [path, config] of Object.entries(TOOL_ANNOTATIONS)) {
  const pathObj = spec.paths[path]
  if (pathObj?.[config.method]) {
    pathObj[config.method]['x-speakeasy-mcp'] = config.tool
  } else {
    console.warn(`WARNING: Tool path not found in spec: ${config.method.toUpperCase()} ${path}`)
    warnings++
  }
}

// Disable explicitly listed endpoints
for (const { path, method } of DISABLED_ENTRIES) {
  const pathObj = spec.paths[path]
  if (pathObj?.[method]) {
    pathObj[method]['x-speakeasy-mcp'] = { disabled: true }
  }
}

// Disable any remaining unannotated endpoints (catch-all for future routes)
const annotatedPaths = new Set([
  ...Object.keys(TOOL_ANNOTATIONS),
  ...DISABLED_ENTRIES.map((e) => e.path),
])
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    if (method === 'parameters') continue
    if (!operation['x-speakeasy-mcp'] && !annotatedPaths.has(path)) {
      operation['x-speakeasy-mcp'] = { disabled: true }
    }
  }
}

// Validate expected tool count
const uniqueTools = new Set(Object.values(TOOL_ANNOTATIONS).map((c) => c.tool['tool-name']))
if (uniqueTools.size !== 9) {
  console.error(`ERROR: Expected 9 unique tools, found ${uniqueTools.size}`)
  process.exit(1)
}

writeFileSync(specPath, JSON.stringify(spec, null, 2))
console.log(`Annotated ${Object.keys(TOOL_ANNOTATIONS).length} endpoints → ${uniqueTools.size} unique tools, disabled remaining endpoints`)
if (warnings > 0) process.exit(1)
