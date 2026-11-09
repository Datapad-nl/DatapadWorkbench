import { createHash } from 'crypto'

/** What the model says a module, and each file directly in it, does. */
export type ModuleSummary = { about: string; files: Record<string, string> }
/** A summary as stored in the vault, with the signature of the module it was written for. */
export type StoredSummary = ModuleSummary & { signature: string }
/** Something the project does, in the model's words, and the files that do it, by project path. */
export type Feature = { name: string; about: string; files: string[] }
/** The features as stored in the vault, with the signature of the summaries they were written from. */
export type StoredFeatures = { signature: string; list: Feature[] }

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
const MAX_FEATURES = 20
const MAX_FEATURE_FILES = 12

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

/** Changes when a module is described again, which is when the features are written again. */
export function featuresSignature(summaries: Map<string, StoredSummary>): string {
  const parts = [...summaries].map(([path, summary]) => [path, summary.signature]).sort(([a], [b]) => a.localeCompare(b))
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

export function featurePrompt(
  projectName: string,
  overview: string | null,
  summaries: Map<string, ModuleSummary>,
  limit = BATCH_CHARS
): string {
  const modules: string[] = []
  let size = 0
  for (const [path, summary] of summaries) {
    // Past the limit a module goes without its files, so the model still hears of every module.
    const files = size > limit ? [] : Object.entries(summary.files).map(([name, does]) => `- ${path}/${name}: ${does}`)
    const lines = [`## ${path}/`, summary.about, ...files, '']
    size += lines.join('\n').length
    modules.push(...lines)
  }
  return [
    `You are writing the feature notes of a knowledge vault for the software project "${projectName}".`,
    overview ? `The project: ${overview}` : null,
    'Below is every module of the project with what it does, and the files in it with what each does.',
    'List what the project does as features: what someone using it would name when asked what it can do, not its folders or layers.',
    `Give each feature one subject. Do not join unrelated things into one feature. At most ${MAX_FEATURES}, and fewer for a small project.`,
    'For each feature write:',
    '- "name": a title of one to four words.',
    '- "about": three to five plain sentences on what the feature does for whoever uses the project, and how the parts behind it work together.',
    `- "files": the paths of the files that implement it, the most important first, at most ${MAX_FEATURE_FILES}. A file can be in several features.`,
    'Work only from what is given. Do not use tools. Do not read files. Reply with JSON only:',
    '{"features":[{"name":"...","about":"...","files":["src/example/file.ts"]}]}',
    '',
    ...modules
  ]
    .filter((line): line is string => line != null)
    .join('\n')
}

/** The features in a model's reply, each with the files it names that are among `known`. */
export function parseFeatures(raw: string, known: Set<string>): Feature[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
  } catch {
    return []
  }
  const features: Feature[] = []
  const names = new Set<string>()
  const list = record(parsed)?.features
  for (const item of Array.isArray(list) ? list : []) {
    const entry = record(item)
    // The name becomes a note's title and the text of links to it.
    const name = typeof entry?.name === 'string' ? clip(entry.name.replace(/[|[\]#]/g, ' '), 60) : ''
    const about = typeof entry?.about === 'string' ? clip(entry.about, 1200) : ''
    const named = Array.isArray(entry?.files) ? entry.files : []
    const files = [...new Set(named.filter((file): file is string => typeof file === 'string' && known.has(file)))]
    // A feature with no file of the project behind it is a guess.
    if (!name || !about || files.length === 0 || names.has(name.toLowerCase())) continue
    names.add(name.toLowerCase())
    features.push({ name, about, files: files.slice(0, MAX_FEATURE_FILES) })
    if (features.length === MAX_FEATURES) break
  }
  return features
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

/** The features stored in the vault, if any. */
export function readStoredFeatures(text: string | null): StoredFeatures | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text ?? '')
  } catch {
    return null
  }
  const entry = record(record(parsed)?.features)
  if (typeof entry?.signature !== 'string' || !Array.isArray(entry.list)) return null
  const list = entry.list.filter((item): item is Feature => {
    const feature = record(item)
    return (
      typeof feature?.name === 'string' &&
      typeof feature.about === 'string' &&
      Array.isArray(feature.files) &&
      feature.files.every((file) => typeof file === 'string')
    )
  })
  return { signature: entry.signature, list }
}

/** The vault file for `summaries` and `features`, in path order so an unchanged set writes the same bytes. */
export function storedText(summaries: Map<string, StoredSummary>, features: StoredFeatures | null = null): string {
  const modules = Object.fromEntries([...summaries].sort(([a], [b]) => a.localeCompare(b)))
  return `${JSON.stringify(features ? { modules, features } : { modules }, null, 2)}\n`
}

/** The first sentence of a summary, for a one-line list. */
export function firstSentence(about: string): string {
  return /^.*?[.!?](?=\s|$)/.exec(about)?.[0] ?? about
}
