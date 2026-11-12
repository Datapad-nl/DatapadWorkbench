import type { AgentCommand, ChatAgent } from './types'

/** `agent` commands go to the agent as typed; the agent announced them itself. */
export type SlashKind = 'local' | 'prompt' | 'unavailable' | 'agent'

export type SlashDef = {
  id: string
  aliases?: string[]
  hint: string
  kind: SlashKind
  prompt?: string
  needsArgs?: boolean
  /** Only offered in chats on these agents. */
  agents?: ChatAgent[]
}

// `agents: ['grok']` marks Grok Build features and its terminal-only commands. Claude chats
// get Claude Code's own commands instead, from what it announces.
export const SLASH_COMMANDS: SlashDef[] = [
  { id: 'new', aliases: ['clear', 'clean'], hint: 'New chat in this project', kind: 'local' },
  { id: 'rewind', aliases: ['undo'], hint: 'Rewind files and later messages', kind: 'local' },
  { id: 'plan', hint: 'Switch to plan mode', kind: 'local' },
  { id: 'ask', hint: 'Switch to ask mode', kind: 'local' },
  {
    id: 'always-approve',
    aliases: ['auto'],
    hint: 'Switch to auto-approve tools',
    kind: 'local'
  },
  { id: 'commit', hint: 'Commit the current changes', kind: 'prompt', prompt:
      'Commit the current changes. Inspect the git status and diff, write a clear commit message, and create the commit. Do not push.' },
  { id: 'review', hint: 'Review the current changes', kind: 'prompt', prompt:
      'Review the current uncommitted changes. Point out bugs, regressions, and missing tests. Do not edit files unless I ask.' },
  { id: 'handoff', hint: 'Continue in a new chat with a fresh context', kind: 'local' },
  { id: 'compact', hint: 'Compress conversation history', kind: 'prompt', prompt:
      'Compact this conversation. Keep decisions, file paths, and unfinished work. Drop recovered dead ends.' },
  { id: 'copy', hint: 'Copy the latest reply', kind: 'local' },
  { id: 'export', hint: 'Save the conversation as a Markdown file', kind: 'local' },
  { id: 'rename', aliases: ['title'], hint: 'Rename this chat', kind: 'local', needsArgs: true },
  { id: 'delete', hint: 'Delete this chat', kind: 'local' },
  { id: 'model', aliases: ['m'], hint: 'Set the model', kind: 'local', needsArgs: true },
  { id: 'settings', aliases: ['config', 'preferences', 'prefs'], hint: 'Open settings', kind: 'local' },
  { id: 'theme', aliases: ['t'], hint: 'Open appearance settings', kind: 'local' },
  { id: 'docs', aliases: ['howto', 'guides'], hint: 'Open Grok Build docs', kind: 'local', agents: ['grok'] },
  { id: 'usage', aliases: ['cost'], hint: 'Show usage / billing', kind: 'local' },
  { id: 'login', hint: 'Sign-in help', kind: 'local', agents: ['grok'] },
  { id: 'logout', hint: 'Sign-out help', kind: 'local', agents: ['grok'] },
  { id: 'quit', aliases: ['exit'], hint: 'Quit Datapad Workbench', kind: 'local' },
  {
    id: 'transcribe',
    aliases: ['yt', 'youtube'],
    hint: 'Transcribe a YouTube video',
    kind: 'prompt',
    needsArgs: true,
    prompt:
      'Transcribe this YouTube video with the transcribe_youtube tool. Return a readable transcript. URL or video id:'
  },
  { id: 'imagine', hint: 'Generate an image', kind: 'prompt', needsArgs: true, prompt: 'Generate an image:', agents: ['grok'] },
  {
    id: 'imagine-video',
    hint: 'Generate a video',
    kind: 'prompt',
    needsArgs: true,
    prompt: 'Generate a video:',
    agents: ['grok']
  },
  { id: 'remember', hint: 'Save a note to memory', kind: 'prompt', needsArgs: true, prompt: 'Remember this for later:' },
  { id: 'loop', hint: 'Run a prompt on an interval', kind: 'prompt', needsArgs: true, prompt:
      'Set up a recurring task with the scheduler. Interval and prompt:', agents: ['grok'] },
  {
    id: 'goal',
    hint: 'Run a long task until it is done',
    kind: 'prompt',
    needsArgs: true,
    prompt: '/goal',
    agents: ['grok']
  },
  { id: 'deep-research', hint: 'Start a research workflow', kind: 'prompt', needsArgs: true, prompt:
      'Start a deep-research workflow:', agents: ['grok'] },
  { id: 'workflow', hint: 'Launch or control a workflow', kind: 'prompt', needsArgs: true, prompt:
      'Run or manage this workflow:', agents: ['grok'] },
  { id: 'workflows', hint: 'List workflow runs', kind: 'prompt', prompt:
      'List active and recent workflow runs and their status.', agents: ['grok'] },
  { id: 'conduct', aliases: ['orchestrate'], hint: 'Plan a large task and hand the work to subagents', kind: 'local', needsArgs: true },
  { id: 'btw', hint: 'Ask a side question without steering the task', kind: 'prompt', needsArgs: true, prompt:
      'Side question — answer this without dropping the main task:' },
  { id: 'feedback', hint: 'Send feedback', kind: 'prompt', prompt: 'User feedback about Datapad Workbench / Grok Build:', agents: ['grok'] },
  { id: 'doctor', hint: 'Diagnose this session', kind: 'prompt', prompt:
      'Diagnose this Datapad Workbench / Grok Build session: auth, model, folder, and anything that looks broken. Suggest fixes. Do not edit files.', agents: ['grok'] },
  { id: 'memory', aliases: ['mem'], hint: 'Browse or toggle memory', kind: 'prompt', prompt:
      'Show or manage cross-session memory for this project.', agents: ['grok'] },
  { id: 'flush', hint: 'Save this session into memory now', kind: 'prompt', prompt:
      'Flush the important facts from this session into memory now.', agents: ['grok'] },
  { id: 'dream', hint: 'Consolidate memory', kind: 'prompt', prompt:
      'Run memory consolidation. Merge session notes into organized topics.', agents: ['grok'] },
  { id: 'view-plan', aliases: ['show-plan', 'plan-view'], hint: 'Show the current plan', kind: 'local' },
  { id: 'session-info', aliases: ['status', 'info'], hint: 'Show session details', kind: 'local' },
  { id: 'context', hint: 'Show context-window use', kind: 'unavailable', agents: ['grok'] },
  { id: 'resume', hint: 'Reload a previous session', kind: 'unavailable', agents: ['grok'] },
  { id: 'dashboard', aliases: ['agents-dashboard', 'sessions'], hint: 'Agent dashboard', kind: 'unavailable', agents: ['grok'] },
  { id: 'fork', hint: 'Branch this session', kind: 'unavailable', agents: ['grok'] },
  { id: 'edit-prompt', hint: 'Edit the draft in $EDITOR', kind: 'unavailable', agents: ['grok'] },
  { id: 'home', aliases: ['welcome'], hint: 'Return to the welcome screen', kind: 'unavailable', agents: ['grok'] },
  { id: 'effort', hint: 'Set reasoning effort', kind: 'local', needsArgs: true },
  { id: 'multiline', aliases: ['ml'], hint: 'Toggle multiline Enter', kind: 'unavailable', agents: ['grok'] },
  { id: 'history', hint: 'Search prompt history', kind: 'unavailable', agents: ['grok'] },
  { id: 'compact-mode', hint: 'Toggle compact display', kind: 'unavailable', agents: ['grok'] },
  { id: 'vim-mode', hint: 'Toggle vim scrollback keys', kind: 'unavailable', agents: ['grok'] },
  { id: 'minimal', hint: 'Switch to minimal TUI', kind: 'unavailable', agents: ['grok'] },
  { id: 'fullscreen', aliases: ['full'], hint: 'Switch to fullscreen TUI', kind: 'unavailable', agents: ['grok'] },
  { id: 'hooks', hint: 'Manage hooks', kind: 'unavailable', agents: ['grok'] },
  { id: 'plugins', hint: 'Manage plugins', kind: 'unavailable', agents: ['grok'] },
  { id: 'marketplace', hint: 'Open the plugin marketplace', kind: 'unavailable', agents: ['grok'] },
  { id: 'skills', hint: 'Manage skills', kind: 'unavailable', agents: ['grok'] },
  { id: 'mcps', aliases: ['mcp'], hint: 'Manage MCP servers', kind: 'local' },
  { id: 'tutorial', aliases: ['tour', 'onboarding'], hint: 'Open the onboarding tutorial', kind: 'unavailable', agents: ['grok'] },
  { id: 'import-claude', hint: 'Import ~/.claude settings', kind: 'unavailable', agents: ['grok'] },
  { id: 'config-agents', aliases: ['agents'], hint: 'Manage agent definitions', kind: 'unavailable', agents: ['grok'] },
  { id: 'personas', hint: 'Manage personas', kind: 'unavailable', agents: ['grok'] },
  { id: 'privacy', hint: 'Coding data and training', kind: 'unavailable', agents: ['grok'] },
  { id: 'timestamps', hint: 'Toggle message timestamps', kind: 'unavailable', agents: ['grok'] },
  { id: 'release-notes', aliases: ['changelog'], hint: 'View release notes', kind: 'unavailable', agents: ['grok'] }
]

function agentDef(command: AgentCommand, aliases?: string[]): SlashDef {
  const hint = command.description || 'Agent command'
  return { id: command.name, aliases, hint: command.hint ? `${hint} · ${command.hint}` : hint, kind: 'agent' }
}

/**
 * The commands a chat on `agent` offers: ours that fit the agent, plus what the agent announced.
 * The agent's own version wins over a prompt we would only approximate, like /compact.
 */
export function slashCommandsFor(agent: ChatAgent, announced: AgentCommand[]): SlashDef[] {
  const theirs = new Map(announced.map((command) => [command.name.toLowerCase(), command]))
  const ours = SLASH_COMMANDS.filter((def) => !def.agents || def.agents.includes(agent)).map((def) => {
    const command = def.kind === 'local' ? undefined : theirs.get(def.id)
    return command ? agentDef(command, def.aliases) : def
  })
  const taken = new Set(ours.flatMap((def) => [def.id, ...(def.aliases ?? [])]))
  const extra = announced.filter((command) => !taken.has(command.name.toLowerCase()))
  return [...ours, ...extra.map((command) => agentDef(command))]
}

export function parseSlashLine(
  text: string,
  commands: SlashDef[] = SLASH_COMMANDS
): { raw: string; name: string; args: string; def: SlashDef | null } | null {
  const line = text.trim()
  if (!line.startsWith('/')) return null
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line)
  if (!match) return null
  const name = match[1].toLowerCase()
  const args = (match[2] ?? '').trim()
  const def =
    commands.find((item) => item.id.toLowerCase() === name || (item.aliases ?? []).includes(name)) ?? null
  return { raw: line, name, args, def }
}

export function commandAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const lineStart = before.lastIndexOf('\n') + 1
  const line = before.slice(lineStart)
  const match = /^\/([^\s]*)$/.exec(line)
  if (!match) return null
  return { start: lineStart, query: match[1] }
}

function isSubsequence(hay: string, needle: string): boolean {
  let i = 0
  for (let h = 0; h < hay.length && i < needle.length; h++) {
    if (hay[h] === needle[i]) i++
  }
  return i === needle.length
}

function slashScore(item: SlashDef, q: string): number {
  if (!q) return item.kind === 'unavailable' ? 100 : 0
  const aliases = item.aliases ?? []
  let score = -1
  if (item.id === q) score = 0
  else if (item.id.startsWith(q)) score = 1
  else if (aliases.some((alias) => alias === q)) score = 2
  else if (aliases.some((alias) => alias.startsWith(q))) score = 3
  else if (item.id.includes(q)) score = 4
  else if (aliases.some((alias) => alias.includes(q))) score = 5
  else if (q.length >= 2 && isSubsequence(item.id, q)) score = 6
  else if (q.length >= 2 && aliases.some((alias) => isSubsequence(alias, q))) score = 7
  else if (item.hint.toLowerCase().includes(q)) score = 8
  if (score < 0) return -1
  return item.kind === 'unavailable' ? score + 20 : score
}

export function filterSlashCommands(query: string, commands: SlashDef[] = SLASH_COMMANDS): SlashDef[] {
  const q = query.toLowerCase()
  const ranked = commands.map((item, index) => ({
    item,
    index,
    score: slashScore(item, q)
  })).filter((row) => row.score >= 0)
  ranked.sort((a, b) => a.score - b.score || a.index - b.index)
  return ranked.map((row) => row.item)
}

export function matchedSlashAlias(item: SlashDef, query: string): string | null {
  const q = query.toLowerCase()
  if (!q || item.id === q || item.id.startsWith(q) || item.id.includes(q)) return null
  return (item.aliases ?? []).find((alias) => alias === q || alias.startsWith(q) || alias.includes(q)) ?? null
}

export function completeSlash(def: SlashDef): string {
  return def.needsArgs ? `/${def.id} ` : `/${def.id}`
}
