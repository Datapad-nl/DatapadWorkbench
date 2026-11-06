import { createHash } from 'crypto'

/** What the model says a module, and each file directly in it, does. */
export type ModuleSummary = { about: string; files: Record<string, string> }
/** A summary as stored in the vault, with the signature of the module it was written for. */
export type StoredSummary = ModuleSummary & { signature: string }

/** What the model is told about a module. */
export type ModuleBrief = {
  path: string
  docs: string[]
  folders: string[]
  uses: string[]
  files: Array<{ name: string; outline: string[] }>
}

const MAX_DECLARATIONS = 8
const MAX_LINE = 120
const BATCH_CHARS = 40_000

// Top-level declarations in JS/TS, Python, Go and Rust.
const DECLARATION =
  /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|def|func|fn|struct|trait|impl|module|pub(?:\([\w:]+\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|mod|const|type))\b/

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * A file's top-level declarations, each after the first line of the comment above it: what it exports first, then
 * what is commented. A file with none shows its first lines.
 */
export function outline(source: string): string[] {
  const found: Array<{ comment: string | null; line: string; rank: number }> = []
  let comment: string | null = null
  let block: { first: string | null } | null = null
  for (const raw of source.split('\n')) {
    const line = raw.trimEnd()
    if (block) {
      const text = line.replace(/^\s*\*?\s?/, '').replace(/\*\/.*$/, '').trim()
      if (block.first == null && text) block.first = text
      if (line.includes('*/')) {
        comment = block.first
        block = null
      }
      continue
    }
    if (line.startsWith('/*')) {
      const text = line.replace(/^\/\*+/, '').replace(/\*\/.*$/, '').trim()
      if (line.includes('*/')) comment = text || null
      else block = { first: text || null }
      continue
    }
    // `#[...]` is a Rust attribute and `#!` a shebang, not a comment.
    const remark = /^(?:\/\/+|#(?![[!]))\s?(.*)$/.exec(line)
    if (remark) {
      comment ??= remark[1].trim() || null
      continue
    }
    if (!line.trim()) continue
    if (DECLARATION.test(line)) {
      const exported = /^(?:export|pub)\b/.test(line)
      found.push({ comment, line: clip(line.replace(/\s*\{\s*$/, ''), MAX_LINE), rank: exported ? 2 : comment ? 1 : 0 })
    }
    comment = null
  }
  const kept = new Set([...found].sort((a, b) => b.rank - a.rank).slice(0, MAX_DECLARATIONS))
  const lines = found
    .filter((item) => kept.has(item))
    .flatMap((item) => (item.comment ? [`// ${clip(item.comment, MAX_LINE)}`, item.line] : [item.line]))
  if (lines.length > 0) return lines
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((line) => clip(line, MAX_LINE))
}

/** Changes when a module gains, loses or renames a file or folder, which is when its description is written again. */
export function moduleSignature(path: string, files: string[], folders: string[]): string {
  return createHash('sha1').update(JSON.stringify([path, files, folders])).digest('hex').slice(0, 16)
}

function dossier(brief: ModuleBrief): string {
  return [
    `## Module ${brief.path}/`,
    ...brief.docs.map((line) => `Docs: ${line}`),
    brief.uses.length > 0 ? `Uses: ${brief.uses.join(', ')}` : null,
    brief.folders.length > 0 ? `Folders: ${brief.folders.join(', ')}` : null,
    ...brief.files.flatMap((file) => [`### ${file.name}`, ...file.outline]),
    ''
  ]
    .filter((line): line is string => line != null)
    .join('\n')
}

/** Modules in groups whose outlines fit one request. A module bigger than that goes alone. */
export function batches(briefs: ModuleBrief[], limit = BATCH_CHARS): ModuleBrief[][] {
  const groups: ModuleBrief[][] = []
  let size = 0
  for (const brief of briefs) {
    const length = dossier(brief).length
    if (groups.length === 0 || size + length > limit) {
      groups.push([])
      size = 0
    }
    groups[groups.length - 1].push(brief)
    size += length
  }
  return groups
}

export function summaryPrompt(projectName: string, overview: string | null, briefs: ModuleBrief[]): string {
  return [
    `You are writing the module notes of a knowledge vault for the software project "${projectName}".`,
    overview ? `The project: ${overview}` : null,
    'Each module below is a folder, with an outline of every file in it: its top-level declarations and the comments above them.',
    'For each module write:',
    '- "about": two or three plain sentences on what the module does and what the rest of the project uses it for. Describe behavior, not the folder.',
    '- "files": for each file listed under the module, one line of at most 15 words on what that file does.',
    'Work only from what is given. Do not use tools. Do not read files. Reply with JSON only:',
    '{"modules":[{"path":"src/example","about":"...","files":{"file.ts":"..."}}]}',
    '',
    ...briefs.map(dossier)
  ]
    .filter((line): line is string => line != null)
    .join('\n')
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** The summaries in a model's reply, for the modules and files it was asked about. */
export function parseSummaries(raw: string, briefs: ModuleBrief[]): Map<string, ModuleSummary> {
  const result = new Map<string, ModuleSummary>()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
  } catch {
    return result
  }
  const asked = new Map(briefs.map((brief) => [brief.path, new Set(brief.files.map((file) => file.name))]))
  const modules = record(parsed)?.modules
  for (const item of Array.isArray(modules) ? modules : []) {
    const entry = record(item)
    const path = typeof entry?.path === 'string' ? entry.path.trim().replace(/\/+$/, '') : ''
    const names = asked.get(path)
    if (!entry || !names || typeof entry.about !== 'string' || !entry.about.trim()) continue
    const files: Record<string, string> = {}
    for (const [name, text] of Object.entries(record(entry.files) ?? {})) {
      if (names.has(name) && typeof text === 'string' && text.trim()) files[name] = clip(text, 200)
    }
    result.set(path, { about: clip(entry.about, 800), files })
  }
  return result
}

/** The summaries stored in the vault. A file that can't be read holds none. */
export function readStored(text: string | null): Map<string, StoredSummary> {
  const stored = new Map<string, StoredSummary>()
  if (!text) return stored
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return stored
  }
  for (const [path, value] of Object.entries(record(record(parsed)?.modules) ?? {})) {
    const entry = record(value)
    if (typeof entry?.about !== 'string' || typeof entry.signature !== 'string') continue
    const files = Object.fromEntries(
      Object.entries(record(entry.files) ?? {}).filter((pair): pair is [string, string] => typeof pair[1] === 'string')
    )
    stored.set(path, { signature: entry.signature, about: entry.about, files })
  }
  return stored
}

/** The vault file for `summaries`, in path order so an unchanged set writes the same bytes. */
export function storedText(summaries: Map<string, StoredSummary>): string {
  const modules = Object.fromEntries([...summaries].sort(([a], [b]) => a.localeCompare(b)))
  return `${JSON.stringify({ modules }, null, 2)}\n`
}

/** The first sentence of a summary, for a one-line list. */
export function firstSentence(about: string): string {
  return /^.*?[.!?](?=\s|$)/.exec(about)?.[0] ?? about
}
