import {
  installOptions,
  rankSearchResults,
  searchWords,
  type RegistrySearchResult,
  type RegistryServer
} from '../shared/mcpRegistry'

/** The official MCP Registry. Its search matches a substring of server names. */
const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers'
const PAGE_SIZE = 40
/** Registry pages read per search word; a word as common as "mcp" stops here. */
const WORD_PAGES = 10

type RegistryPage = {
  servers?: Array<{ server?: RegistryServer; _meta?: Record<string, { status?: string } | undefined> }>
  metadata?: { nextCursor?: string }
}

/** One page of the latest server versions whose name contains `search`, keeping those the Workbench can run. */
async function registryPage(search: string, limit: number, cursor?: string): Promise<RegistrySearchResult> {
  const params = new URLSearchParams({ version: 'latest', limit: String(limit) })
  if (search) params.set('search', search)
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

/** Every server whose name contains `word`, up to WORD_PAGES pages. */
async function serversNamed(word: string): Promise<RegistryServer[]> {
  const servers: RegistryServer[] = []
  let cursor: string | undefined
  for (let page = 0; page < WORD_PAGES; page++) {
    const result = await registryPage(word, 100, cursor)
    servers.push(...result.servers)
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  return servers
}

/**
 * Without a query, one page of the registry. With one, every server whose name, title or description
 * contains each of its words, in a single result. The registry itself only matches a name against the
 * whole query, so "meta ads" would find nothing next to "meta-ads".
 */
export async function searchMcpRegistry(query: string, cursor?: string): Promise<RegistrySearchResult> {
  const words = searchWords(query)
  if (!words.length) return registryPage('', PAGE_SIZE, cursor)
  const found = await Promise.all(words.map(serversNamed))
  return { servers: rankSearchResults(found.flat(), words), nextCursor: null }
}
