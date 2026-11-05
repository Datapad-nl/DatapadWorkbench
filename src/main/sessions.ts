import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { readFile, readdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { Message } from '../shared/types'
import { id, now } from './ids'
import { jsonLines } from './jsonl'

export type GrokSession = {
  id: string
  cwd: string
  title: string
  createdAt: string
  updatedAt: string
}

function sessionsRoot(): string {
  return join(homedir(), '.grok', 'sessions')
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part) {
        return String((part as { text?: string }).text ?? '')
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function visibleUserText(raw: string): string | null {
  const query = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
  if (query?.[1]) return query[1].trim()
  if (
    raw.includes('<system-reminder>') ||
    raw.includes('<user_info>') ||
    raw.includes('<work_policy>') ||
    raw.includes('<agent_skills')
  ) {
    return null
  }
  const trimmed = raw.trim()
  return trimmed || null
}

export type DiskPlan = {
  plan: {
    title: string
    entries: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>
    markdown?: string
    awaitingApproval?: boolean
  }
  awaitingApproval: boolean
  dir: string
  markdown: string
}

function planFromMarkdown(markdown: string): DiskPlan['plan'] | null {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Plan'
  const entries: DiskPlan['plan']['entries'] = []
  const numbered = markdown.matchAll(/^\d+\.\s+\*\*(.+?)\*\*/gm)
  for (const match of numbered) {
    const content = match[1].replace(/`/g, '').trim()
    if (content) entries.push({ content, status: 'pending' })
  }
  if (entries.length === 0) {
    for (const match of markdown.matchAll(/^[-*]\s+\*\*(.+?)\*\*/gm)) {
      const content = match[1].replace(/`/g, '').trim()
      if (content) entries.push({ content, status: 'pending' })
    }
  }
  if (entries.length === 0 && title === 'Plan') return null
  return { title, entries }
}

export function findGrokSessionDir(sessionId: string): string | null {
  const root = sessionsRoot()
  if (!existsSync(root)) return null
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name, sessionId)
    if (existsSync(join(dir, 'summary.json')) || existsSync(join(dir, 'plan.md'))) return dir
  }
  return null
}

export function readGrokPlan(sessionId: string): DiskPlan | null {
  const dir = findGrokSessionDir(sessionId)
  if (!dir) return null
  let awaitingApproval = false
  const modePath = join(dir, 'plan_mode.json')
  if (existsSync(modePath)) {
    try {
      const mode = JSON.parse(readFileSync(modePath, 'utf8')) as {
        state?: string
        awaiting_plan_approval?: boolean
      }
      awaitingApproval = Boolean(mode.awaiting_plan_approval)
    } catch {
      // ignore corrupt plan_mode
    }
  }
  const planPath = join(dir, 'plan.md')
  let markdown = ''
  if (existsSync(planPath)) {
    try {
      markdown = readFileSync(planPath, 'utf8')
    } catch {
      markdown = ''
    }
  }
  if (!markdown.trim() && !awaitingApproval) return null
  const parsed = planFromMarkdown(markdown)
  const plan = parsed ?? {
    title: markdown.trim() ? markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Plan' : 'No plan written yet',
    entries: [] as DiskPlan['plan']['entries']
  }
  return {
    plan: { ...plan, markdown, awaitingApproval },
    awaitingApproval,
    dir,
    markdown
  }
}

export function clearGrokPlanApproval(sessionId: string): void {
  const dir = findGrokSessionDir(sessionId)
  if (!dir) return
  const modePath = join(dir, 'plan_mode.json')
  if (!existsSync(modePath)) return
  try {
    const mode = JSON.parse(readFileSync(modePath, 'utf8')) as Record<string, unknown>
    writeFileSync(
      modePath,
      JSON.stringify(
        {
          ...mode,
          state: 'Inactive',
          awaiting_plan_approval: false,
          pending_exit_reminder: false
        },
        null,
        2
      ),
      'utf8'
    )
  } catch {
    // leave the file if it cannot be rewritten
  }
}

export function grokBuildSignedIn(): boolean {
  try {
    const auth = readFileSync(join(homedir(), '.grok', 'auth.json'), 'utf8')
    return auth.trim().length > 2
  } catch {
    return false
  }
}

export async function listGrokSessions(): Promise<GrokSession[]> {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const found: GrokSession[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const folder = join(root, entry.name)
    for (const child of await readdir(folder, { withFileTypes: true })) {
      if (!child.isDirectory()) continue
      const summaryPath = join(folder, child.name, 'summary.json')
      try {
        const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as {
          info?: { id?: string; cwd?: string }
          session_summary?: string
          generated_title?: string
          created_at?: string
          updated_at?: string
        }
        const sessionId = summary.info?.id ?? child.name
        const cwd = summary.info?.cwd
        if (!cwd) continue
        found.push({
          id: sessionId,
          cwd,
          title: summary.generated_title || summary.session_summary || 'Grok session',
          createdAt: summary.created_at ?? now(),
          updatedAt: summary.updated_at ?? now()
        })
      } catch {
        // skip missing or corrupt summaries
      }
    }
  }
  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readGrokHistory(sessionId: string, cwd: string): Promise<Message[]> {
  const encoded = encodeURIComponent(cwd)
  const path = join(sessionsRoot(), encoded, sessionId, 'chat_history.jsonl')
  if (!existsSync(path)) return []
  const messages: Message[] = []
  for await (const value of jsonLines(path)) {
    const row = value as { type?: string; content?: unknown }
    if (row.type === 'user') {
      const text = visibleUserText(extractText(row.content))
      if (!text) continue
      messages.push({ id: id(), role: 'user', content: text, createdAt: now() })
    }
    if (row.type === 'assistant') {
      const text = extractText(row.content).trim()
      if (!text) continue
      messages.push({ id: id(), role: 'assistant', content: text, createdAt: now() })
    }
  }
  return messages
}
