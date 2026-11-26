import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool, ToolResult } from './tools'
import type { ImageBlock, TextBlock } from './types'

/** The longest wait a timer takes: an MCP call may wait on a person, so it has no deadline of its own. */
const NO_TIMEOUT_MS = 2 ** 31 - 1

type Pair = { name?: unknown; value?: unknown }

/** One server of `session/new`'s `mcpServers`, in ACP's shape. */
export type McpServer = {
  type?: string
  name?: string
  command?: string
  args?: string[]
  env?: Pair[]
  url?: string
  headers?: Pair[]
}

export type McpConnection = { tools: Tool[]; close: () => Promise<void> }

function record(pairs: Pair[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of pairs ?? []) {
    if (typeof pair?.name === 'string' && typeof pair.value === 'string') out[pair.name] = pair.value
  }
  return out
}

function transportFor(server: McpServer, cwd: string): Transport {
  if (server.type === 'http' || server.type === 'sse') {
    if (!server.url) throw new Error('no url')
    const options = { requestInit: { headers: record(server.headers) } }
    return server.type === 'http'
      ? new StreamableHTTPClientTransport(new URL(server.url), options)
      : new SSEClientTransport(new URL(server.url), options)
  }
  if (!server.command) throw new Error('no command')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...env, ...record(server.env) },
    cwd
  })
}

function resultContent(content: unknown): Array<TextBlock | ImageBlock> {
  const items = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
  return items.map((item) => {
    if (item?.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text }
    if (item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      return { type: 'image', mimeType: item.mimeType, data: item.data }
    }
    return { type: 'text', text: JSON.stringify(item) }
  })
}

async function connectOne(server: McpServer, cwd: string): Promise<{ client: Client; tools: Tool[] }> {
  const serverName = (server.name ?? 'server').replace(/[^A-Za-z0-9_-]/g, '_')
  const client = new Client({ name: 'workbench-agent', version: '1.0.0' })
  try {
    await client.connect(transportFor(server, cwd))
    const listed = await client.listTools()
    const tools = listed.tools.map((tool): Tool => {
      const name = `mcp__${serverName}__${tool.name}`
      return {
        spec: {
          name,
          description: tool.description ?? '',
          schema: tool.inputSchema as Record<string, unknown>
        },
        kind: 'other',
        asks: tool.annotations?.readOnlyHint !== true,
        prepare: (input) => ({ input, title: `${serverName}: ${tool.name}`, locations: [] }),
        async run(input, context): Promise<ToolResult> {
          const result = await client.callTool({ name: tool.name, arguments: input }, undefined, {
            timeout: NO_TIMEOUT_MS,
            signal: context.signal
          })
          const content = resultContent(result.content)
          if (content.length === 0 && result.structuredContent !== undefined) {
            content.push({ type: 'text', text: JSON.stringify(result.structuredContent) })
          }
          if (content.length === 0) content.push({ type: 'text', text: '(no output)' })
          return { content, isError: result.isError === true }
        }
      }
    })
    return { client, tools }
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
}

/** Connect every server and gather their tools. A server that fails is reported and left out. */
export async function connectMcp(servers: McpServer[], cwd: string, log: (line: string) => void): Promise<McpConnection> {
  const settled = await Promise.allSettled(servers.map((server) => connectOne(server, cwd)))
  const clients: Client[] = []
  const tools: Tool[] = []
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      clients.push(result.value.client)
      tools.push(...result.value.tools)
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      log(`MCP server ${servers[index]?.name ?? index} did not start: ${reason}`)
    }
  })
  return {
    tools,
    close: async () => {
      await Promise.allSettled(clients.map((client) => client.close()))
    }
  }
}
