import { homedir } from 'os'
import type { ClaudeUsage } from '../shared/types'
import { promptIsolated } from './acp'

const TTL_MS = 60_000
const RETRY_MS = 30_000

let cached: { at: number; usage: ClaudeUsage } | null = null
let inflight: Promise<ClaudeUsage> | null = null
let failed: { at: number; error: unknown } | null = null

/**
 * Plan limits from Claude Code's local `/usage` command. It makes no model
 * call. The adapter renders it as markdown, so read the "Limits" lines back:
 * `**Weekly · all models** — **7%** · Resets Nov 10, 1:59 AM GMT+1`.
 */
export function parseClaudeUsage(markdown: string): ClaudeUsage {
  const plan = markdown.match(/^>\s*Claude (\w+) subscription usage/m)?.[1] ?? null
  const limits: ClaudeUsage['limits'] = []
  for (const match of markdown.split(/\n---\n/)[0].matchAll(/^\*\*(.+?)\*\* — \*\*(\d+(?:\.\d+)?)%\*\*(?: · Resets (.+))?$/gm)) {
    limits.push({ label: match[1], usedPercent: Number(match[2]), resets: match[3]?.trim() || null })
  }
  return { plan, limits }
}

export async function fetchClaudeUsage(): Promise<ClaudeUsage> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.usage
  if (inflight) return inflight
  // After a failure, wait before starting another Claude process. Until then, the last good value stands in.
  if (failed && Date.now() - failed.at < RETRY_MS) {
    if (cached) return cached.usage
    throw failed.error
  }
  inflight = promptIsolated(homedir(), '/usage', [], undefined, undefined, {
    agent: 'claude',
    timeoutMs: 30_000,
    rules: ''
  })
    .then((markdown) => {
      const usage = parseClaudeUsage(markdown)
      if (usage.limits.length === 0) throw new Error('Claude Code did not report plan limits.')
      cached = { at: Date.now(), usage }
      failed = null
      return usage
    })
    .catch((error: unknown) => {
      failed = { at: Date.now(), error }
      if (cached) return cached.usage
      throw error
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
