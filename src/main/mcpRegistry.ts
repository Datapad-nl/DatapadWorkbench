import { installOptions, type RegistrySearchResult, type RegistryServer } from '../shared/mcpRegistry'

/** The official MCP Registry. Its search matches server names. */
const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers'
const PAGE_SIZE = 40

type RegistryPage = {
  servers?: Array<{ server?: RegistryServer; _meta?: Record<string, { status?: string } | undefined> }>
  metadata?: { nextCursor?: string }
}

/** One page of the latest server versions whose name contains `query`, keeping those the Workbench can run. */
export async function searchMcpRegistry(query: string, cursor?: string): Promise<RegistrySearchResult> {
  const params = new URLSearchParams({ version: 'latest', limit: String(PAGE_SIZE) })
  if (query.trim()) params.set('search', query.trim())
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(`${REGISTRY_URL}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`The MCP Registry answered ${response.status}`)
  const page = (await response.json()) as RegistryPage
  const servers = (page.servers ?? []).flatMap((item) => {
    const status = item._meta?.['io.modelcontextprotocol.registry/official']?.status
    if (!item.server?.name || status === 'deleted') return []
    return installOptions(item.server).length ? [item.server] : []
  })
  return { servers, nextCursor: page.metadata?.nextCursor ?? null }
}
