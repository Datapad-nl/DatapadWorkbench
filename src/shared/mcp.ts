/** One MCP server in the `mcpServers` format that Claude Code, Cursor and most MCP docs use. */
export type McpServerEntry =
  | { command: string; args?: string[]; env?: Record<string, string>; disabled?: boolean }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string>; disabled?: boolean }

export type McpServers = Record<string, McpServerEntry>

type NameValue = Array<{ name: string; value: string }>

/** The shapes ACP's session/new and session/load take. */
export type AcpMcpServer =
  | { type: 'stdio'; name: string; command: string; args: string[]; env: NameValue }
  | { type: 'http' | 'sse'; name: string; url: string; headers: NameValue }

/** The Workbench's own server. A user entry may not take its name. */
export const BUILT_IN_MCP = 'browser'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringRecord(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    throw new Error(`${where} must map names to text values`)
  }
  return value as Record<string, string>
}

/**
 * Read the MCP editor text. Takes `{ "mcpServers": { … } }` or just the inner object.
 * Throws a message the user can act on.
 */
export function parseMcpServers(text: string): McpServers {
  if (!text.trim()) return {}
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (isRecord(raw) && 'mcpServers' in raw) raw = raw.mcpServers
  if (!isRecord(raw)) throw new Error('Expected an object of servers, like { "mcpServers": { "name": { … } } }')

  const servers: McpServers = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!name.trim()) throw new Error('A server needs a name')
    if (name === BUILT_IN_MCP) throw new Error(`"${BUILT_IN_MCP}" is the built-in server. Pick another name.`)
    if (!isRecord(value)) throw new Error(`"${name}" must be an object`)
    const disabled = value.disabled === true ? { disabled: true } : {}
    if (typeof value.url === 'string') {
      const type = value.type ?? 'http'
      if (type !== 'http' && type !== 'sse') throw new Error(`"${name}": type must be "http" or "sse" for a url`)
      const headers = stringRecord(value.headers, `"${name}" headers`)
      servers[name] = { type, url: value.url.trim(), ...(headers ? { headers } : {}), ...disabled }
      continue
    }
    if (typeof value.command !== 'string' || !value.command.trim()) {
      throw new Error(`"${name}" needs a "command" to run, or a "url"`)
    }
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string'))) {
      throw new Error(`"${name}" args must be a list of text values`)
    }
    const env = stringRecord(value.env, `"${name}" env`)
    servers[name] = {
      command: value.command.trim(),
      ...(value.args ? { args: value.args as string[] } : {}),
      ...(env ? { env } : {}),
      ...disabled
    }
  }
  return servers
}

function pairs(record: Record<string, string> | undefined): NameValue {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))
}

/** The enabled servers, in the form the agents expect. */
export function toAcpMcpServers(servers: McpServers): AcpMcpServer[] {
  return Object.entries(servers)
    .filter(([, entry]) => !entry.disabled)
    .map(([name, entry]) =>
      'url' in entry
        ? { type: entry.type, name, url: entry.url, headers: pairs(entry.headers) }
        : { type: 'stdio', name, command: entry.command, args: entry.args ?? [], env: pairs(entry.env) }
    )
}
