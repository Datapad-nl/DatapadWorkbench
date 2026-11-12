import type { ChatAgent } from './types'

/**
 * The tools a bot can be allowed to use without asking, under the names each agent gives them:
 * Claude Code in `_meta.claudeCode.toolName`, Grok Build in `_meta["x.ai/tool"].name`.
 * A tool only one agent has leaves the other name out.
 */
export const BOT_TOOLS: ReadonlyArray<{ label: string; claude?: string; grok?: string }> = [
  { label: 'Read files', claude: 'Read', grok: 'read_file' },
  { label: 'List folders', claude: 'Glob', grok: 'list_dir' },
  { label: 'Search in files', claude: 'Grep', grok: 'grep' },
  { label: 'Edit files', claude: 'Edit', grok: 'search_replace' },
  { label: 'Write files', claude: 'Write', grok: 'write' },
  { label: 'Edit notebooks', claude: 'NotebookEdit' },
  { label: 'Run commands', claude: 'Bash', grok: 'run_terminal_command' },
  { label: 'Fetch web pages', claude: 'WebFetch', grok: 'web_fetch' },
  { label: 'Search the web', claude: 'WebSearch' },
  { label: 'Make images', grok: 'image_gen' },
  { label: 'Edit images', grok: 'image_edit' }
]

/** The Workbench's own MCP servers, which every chat has. */
export const WORKBENCH_MCP_SERVERS = ['browser', 'workbench'] as const

/** The allowed-tools entry for every tool of an MCP server, in Claude Code's rule form. */
export function mcpServerTool(server: string): string {
  return `mcp__${server}`
}

/** The bot's tools under the other agent's names. A tool that agent lacks, or a name not in the list, stays as it is. */
export function toolsForAgent(tools: string[], from: ChatAgent, to: ChatAgent): string[] {
  const next = tools.map((tool) => {
    const known = BOT_TOOLS.find((item) => item[from] === tool)
    return known?.[to] ?? tool
  })
  return [...new Set(next)]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * The name of the tool a tool call runs, as the allowed-tools list holds it.
 * Grok Build runs an MCP tool through `use_tool` with `server__tool`, which reads as Claude's `mcp__server__tool`.
 */
export function toolCallName(toolCall: { _meta?: unknown; rawInput?: unknown } | undefined): string | null {
  const meta = record(toolCall?._meta)
  const claude = record(meta?.claudeCode)?.toolName
  if (typeof claude === 'string' && claude) return claude
  const grok = record(meta?.['x.ai/tool'])?.name
  if (typeof grok !== 'string' || !grok) return null
  const mcpTool = record(toolCall?.rawInput)?.tool_name
  if (grok === 'use_tool' && typeof mcpTool === 'string' && mcpTool) return `mcp__${mcpTool}`
  return grok
}

/** Whether the list allows the tool: by its own name, or by its MCP server's `mcp__<server>`. */
export function isToolAllowed(allowed: readonly string[], name: string): boolean {
  return allowed.some((entry) => entry === name || (entry.startsWith('mcp__') && name.startsWith(`${entry}__`)))
}
