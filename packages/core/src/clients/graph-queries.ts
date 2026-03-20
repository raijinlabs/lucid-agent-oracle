/**
 * Pre-built GraphQL queries for ERC-8004 subgraphs.
 *
 * Extracted from subgraph-ingester.ts so they can be reused by any module
 * that needs to query agent data from The Graph.
 */

/**
 * Query agents ordered by ID, using skip-based pagination.
 * Used for initial bulk sync.
 */
export function agentsQuery(first: number, skip: number): string {
  return JSON.stringify({
    query: `{
  agents(first: ${first}, skip: ${skip}, orderBy: agentId, orderDirection: asc) {
    agentId
    owner
    agentURI
  }
}`,
  })
}

/**
 * Query agents with agentId greater than a given value.
 * Used for incremental sync after initial bulk load.
 */
export function agentsAfterQuery(first: number, afterId: number): string {
  return JSON.stringify({
    query: `{
  agents(first: ${first}, orderBy: agentId, orderDirection: asc, where: { agentId_gt: "${afterId}" }) {
    agentId
    owner
    agentURI
  }
}`,
  })
}

/**
 * Query a single agent by its ID.
 */
export function agentByIdQuery(agentId: string): string {
  return JSON.stringify({
    query: `{
  agent(id: "${agentId}") {
    agentId
    owner
    agentURI
  }
}`,
  })
}

/**
 * Query feedback records for a specific agent.
 */
export function feedbackQuery(agentId: string, first: number): string {
  return JSON.stringify({
    query: `{
  feedbacks(first: ${first}, where: { agentId: "${agentId}" }, orderBy: timestamp, orderDirection: desc) {
    id
    agentId
    reporter
    score
    comment
    timestamp
  }
}`,
  })
}

/**
 * Query metadata for a specific agent.
 */
export function metadataQuery(agentId: string): string {
  return JSON.stringify({
    query: `{
  agent(id: "${agentId}") {
    agentId
    owner
    agentURI
    metadata {
      key
      value
    }
  }
}`,
  })
}
