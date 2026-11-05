import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Message } from '../shared/types'
import { id } from './ids'

// Claude Code keeps one JSONL transcript per session under
// ~/.claude/projects/<cwd with every non-alphanumeric char as "-">/<id>.jsonl.

export type ClaudeSession = {
  id: string
  cwd: string
  title: string
  createdAt: string
  updatedAt: string
}

type Row = {
  type?: string
  cwd?: string
  sessionId?: string
  entrypoint?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  timestamp?: string
  customTitle?: string
  aiTitle?: string
  message?: { id?: string; content?: unknown }
}

const HEAD_BYTES = 512 * 1024
const TAIL_BYTES = 128 * 1024
const cache = new Map<string, { mtimeMs: number; size: number; session: ClaudeSession | null }>()

function projectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

export function claudeProjectDir(cwd: string): string {
  return join(projectsRoot(), cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

function parseRows(text: string): Row[] {
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      rows.push(JSON.parse(line) as Row)
    } catch {
      // partial line at a chunk edge
    }
  }
  return rows
}

function readRange(path: string, start: number, length: number): string {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, start)
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function userText(row: Row): string | null {
  if (row.type !== 'user' || row.isMeta || row.isSidechain || row.isCompactSummary) return null
  const content = row.message?.content
  let raw = ''
  if (typeof content === 'string') raw = content
  else if (Array.isArray(content)) {
    raw = content
      .filter((part) => part && typeof part === 'object' && part.type === 'text')
      .map((part) => String(part.text ?? ''))
      .join('\n')
  }
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (!text) return null
  if (/^<(command-name|command-message|local-command-\w+|bash-\w+|task-notification)>/.test(text)) return null
  if (text.startsWith('[Request interrupted')) return null
  return text
}

function assistantText(row: Row): string {
  if (row.type !== 'assistant' || row.isSidechain) return ''
  const content = row.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && typeof part === 'object' && part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n')
    .trim()
}

function readSessionFile(path: string, size: number, mtime: Date): ClaudeSession | null {
  const head = parseRows(readRange(path, 0, Math.min(size, HEAD_BYTES)))
  const tail = size > HEAD_BYTES ? parseRows(readRange(path, size - TAIL_BYTES, TAIL_BYTES)) : []
  const first = head.find((row) => row.cwd && row.sessionId)
  if (!first?.cwd || !first.sessionId) return null
  // Headless SDK runs (asides, other tools, and Workbench's own chats) are not user sessions.
  if ((first.entrypoint ?? '').startsWith('sdk-')) return null
  const prompt = head.map(userText).find(Boolean)
  if (!prompt) return null
  const rows = [...head, ...tail]
  const title =
    rows.filter((row) => row.type === 'custom-title' && row.customTitle).at(-1)?.customTitle ||
    rows.filter((row) => row.type === 'ai-title' && row.aiTitle).at(-1)?.aiTitle ||
    prompt.split('\n')[0].slice(0, 80)
  return {
    id: first.sessionId,
    cwd: first.cwd,
    title,
    createdAt: head.find((row) => row.timestamp)?.timestamp ?? mtime.toISOString(),
    updatedAt: mtime.toISOString()
  }
}

/** Claude Code sessions whose working directory is one of `cwds`. */
export function listClaudeSessions(cwds: string[]): ClaudeSession[] {
  const found: ClaudeSession[] = []
  for (const cwd of new Set(cwds)) {
    const dir = claudeProjectDir(cwd)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(dir, name)
      try {
        const stat = statSync(path)
        const hit = cache.get(path)
        let session = hit?.session ?? null
        if (!hit || hit.mtimeMs !== stat.mtimeMs || hit.size !== stat.size) {
          session = readSessionFile(path, stat.size, stat.mtime)
          cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, session })
        }
        if (session && session.cwd === cwd) found.push(session)
      } catch {
        // unreadable transcript
      }
    }
  }
  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function readClaudeHistory(sessionId: string, cwd: string): Message[] {
  const path = join(claudeProjectDir(cwd), `${sessionId}.jsonl`)
  if (!existsSync(path)) return []
  const messages: Message[] = []
  // Claude Code writes one line per content block, so consecutive assistant
  // lines belong to the same reply until the next real user prompt.
  let reply: Message | null = null
  for (const row of parseRows(readFileSync(path, 'utf8'))) {
    const prompt = userText(row)
    if (prompt) {
      reply = null
      messages.push({ id: id(), role: 'user', content: prompt, createdAt: row.timestamp ?? '' })
      continue
    }
    const text = assistantText(row)
    if (!text) continue
    if (reply) {
      reply.content += `\n\n${text}`
    } else {
      reply = { id: id(), role: 'assistant', content: text, createdAt: row.timestamp ?? '' }
      messages.push(reply)
    }
  }
  return messages
}
