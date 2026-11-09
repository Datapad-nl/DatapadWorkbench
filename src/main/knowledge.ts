import { execFile } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { existsSync, watch, type FSWatcher } from 'fs'
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { BrowserWindow, shell } from 'electron'
import type {
  KnowledgeEdge,
  KnowledgeNode,
  KnowledgeNodeKind,
  KnowledgeNote,
  KnowledgeReason,
  KnowledgeSnapshot,
  Project
} from '../shared/types'
import { askOnce } from './askOnce'
import { buildOrientation, listIndexedFiles, syncIndex, type IndexedFile } from './codegraph'
import {
  batches,
  featurePrompt,
  featuresSignature,
  firstSentence,
  moduleSignature,
  outline,
  parseFeatures,
  parseSummaries,
  readStored,
  readStoredFeatures,
  storedText,
  summaryPrompt,
  type Feature,
  type ModuleBrief,
  type ModuleSummary,
  type StoredFeatures,
  type StoredSummary
} from './moduleSummaries'
import { listProjects } from './store'
import { writeFileAtomic } from './storeIo'

export const VAULT_FOLDER = 'knowledge'

const IGNORE = new Set([
  '.git',
  '.codegraph',
  '.obsidian',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.turbo',
  'coverage',
  'knowledge',
  'design-studies'
])

const RESERVED = new Set(['home', 'overview', 'architecture', 'stack', 'rules'])
const MARK_START = '%% datapad-workbench:start %%'
const MARK_END = '%% datapad-workbench:end %%'
const LEGACY_MARKS = [
  ['%% grok-build-workbench:start %%', '%% grok-build-workbench:end %%'],
  ['%% grokcode:start %%', '%% grokcode:end %%']
]
const WATCH_MS = 400
const MAX_NOTES = 200
const MAX_AREAS = 16
const MAX_CHILDREN = 8
/** Folder notes below the top-level areas, so the area, fixed and user notes still fit in MAX_NOTES. */
const LAYOUT_BUDGET = 120
const MAX_KEY_FILES = 3
const SCRIPT_LANGUAGES = new Set(['typescript', 'tsx', 'javascript', 'jsx'])
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const RELATIVE_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](\.{1,2}\/[^'"\n]+)['"]/g
/** Under `generated/`: what the model wrote about each module. A dot file, so Obsidian doesn't list it. */
const SUMMARIES_FILE = '.summaries.json'
// A whole module's outline is a long read, so these allow more than a short prompt would.
const SUMMARY_TIMEOUTS = { apiMs: 120_000, agentMs: 240_000 }

/** How many runs are writing each project's vault. While one is, its watchers skip the runs' own writes. */
const writing = new Map<string, number>()
/**
 * What runs are leaving on disk, by absolute path: a content hash, DIR for a folder, or null for a file
 * they removed. A watcher event during a run whose path doesn't match is an outside edit.
 */
const ownWrites = new Map<string, string | null>()
const DIR = 'dir'
let stopping = false
const jobs = new Map<string, Promise<KnowledgeSnapshot>>()
/** One more run per project, asked for while a run was going. It uses the latest project it was given. */
const queued = new Map<string, { project: Project; job: Promise<KnowledgeSnapshot> }>()
const projectWatchers = new Map<string, FSWatcher>()
const projectWatchPaths = new Map<string, string>()
const vaultWatchers = new Map<string, FSWatcher>()
const pending = new Map<string, ReturnType<typeof setTimeout>>()
let activeProjectId: string | null = null
/** Summaries the model wrote since the last run, by project id. The next run stores them in the vault. */
const freshSummaries = new Map<string, Map<string, StoredSummary>>()
/** By project id, the signature each module was last sent to the model with, so each change is asked about once. */
const askedSignatures = new Map<string, Map<string, string>>()
/** The features the model wrote since the last run, by project id. The next run stores them in the vault. */
const freshFeatures = new Map<string, StoredFeatures>()
/** By project id, the signature the features were last asked for with, so each change is asked about once. */
const askedFeatures = new Map<string, string>()
/** Projects whose modules or features are being described. */
const describing = new Set<string>()

type Area = { name: string; children: string[] }
type Folder = { folders: string[]; files: string[]; tests: string[] }
/**
 * The index's folders and files under the top-level areas, by project path. `noted` holds the folders with a note.
 * `loose` holds the areas the index has nothing of, such as docs or images, with what is directly in each.
 */
type Layout = {
  folders: Map<string, Folder>
  files: Map<string, IndexedFile>
  noted: Set<string>
  loose: Map<string, string[]>
}
/** Imports between noted folders, by importing folder then imported one, and how many files import each file. */
type ModuleLinks = { uses: Map<string, Map<string, number>>; importers: Map<string, number> }

function posix(path: string): string {
  return path.split(/[\\/]/).join('/')
}

function vaultPath(projectPath: string): string {
  return join(projectPath, VAULT_FOLDER)
}

function emptySnapshot(
  projectId: string | null,
  path: string | null,
  reason: KnowledgeReason,
  error: string | null
): KnowledgeSnapshot {
  return {
    projectId,
    path,
    available: false,
    reason,
    error,
    nodes: [],
    edges: []
  }
}

function emit(snapshot: KnowledgeSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('knowledge:snapshot', snapshot)
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|#[\]]+/g, '-').replace(/\s+/g, ' ').trim() || 'untitled'
}

function titleOf(relPath: string, body: string): string {
  const heading = body.match(/^#\s+(.+)$/m)
  if (heading) return heading[1].trim()
  const base = posix(relPath).split('/').pop() ?? relPath
  return base.replace(/\.md$/i, '')
}

function kindOf(relPath: string): KnowledgeNodeKind {
  const path = posix(relPath)
  if (path === 'Home.md') return 'home'
  if (path.startsWith('generated/')) return 'generated'
  return 'note'
}

function parseTags(body: string): string[] {
  const tags = new Set<string>()
  const yaml = body.match(/^---\n([\s\S]*?)\n---/)
  if (yaml) {
    const block = yaml[1].match(/tags:\n((?:\s+-\s+.+\n?)*)/)
    if (block) {
      for (const line of block[1].split('\n')) {
        const name = line.match(/^\s+-\s+(.+)$/)
        if (name) tags.add(name[1].trim())
      }
    }
  }
  for (const match of body.matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)) {
    tags.add(match[1])
  }
  return [...tags]
}

function wikiTargets(body: string): string[] {
  const targets: string[] = []
  for (const match of body.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const raw = match[1].split('|')[0]?.split('#')[0]?.trim() ?? ''
    if (raw) targets.push(raw.replace(/\.md$/i, ''))
  }
  for (const match of body.matchAll(/\[[^\]]+\]\(([^)\s]+\.md)\)/gi)) {
    const raw = match[1].split('#')[0]?.trim() ?? ''
    if (raw) targets.push(decodeURIComponent(raw.replace(/\.md$/i, '')))
  }
  return targets
}

function resolveLink(
  sourceRel: string,
  target: string,
  byPath: Map<string, string>,
  byTitle: Map<string, string[]>
): string | null {
  const normalized = posix(target).replace(/^\.\//, '')
  if (byPath.has(`${normalized}.md`)) return `${normalized}.md`
  if (byPath.has(normalized)) return normalized
  const fromDir = posix(sourceRel).split('/').slice(0, -1).join('/')
  if (fromDir) {
    const nested = posix(join(fromDir, `${normalized}.md`))
    if (byPath.has(nested)) return nested
  }
  const hits = byTitle.get(normalized.toLowerCase())
  if (hits && hits.length === 1) return hits[0]
  return null
}

async function listMarkdown(vault: string, rel = ''): Promise<string[]> {
  const dir = rel ? join(vault, rel) : vault
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const child = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await listMarkdown(vault, child)))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(posix(child))
    }
  }
  return files
}

async function readSnapshot(project: Project): Promise<KnowledgeSnapshot> {
  if (!project.path) return emptySnapshot(project.id, null, 'no-folder', null)
  const vault = vaultPath(project.path)
  if (!existsSync(vault)) return emptySnapshot(project.id, vault, 'error', 'Vault is missing')
  const rels = (await listMarkdown(vault)).slice(0, MAX_NOTES)
  const nodes: KnowledgeNode[] = []
  const byPath = new Map<string, string>()
  const byTitle = new Map<string, string[]>()
  const bodies = new Map<string, string>()

  for (const rel of rels) {
    let body = ''
    try {
      body = await readFile(join(vault, rel), 'utf8')
    } catch {
      continue
    }
    const title = titleOf(rel, body)
    byPath.set(rel, rel)
    const key = title.toLowerCase()
    const existing = byTitle.get(key) ?? []
    existing.push(rel)
    byTitle.set(key, existing)
    const base = rel.replace(/\.md$/i, '').split('/').pop() ?? title
    const baseKey = base.toLowerCase()
    if (baseKey !== key) {
      const extra = byTitle.get(baseKey) ?? []
      extra.push(rel)
      byTitle.set(baseKey, extra)
    }
    bodies.set(rel, body)
    nodes.push({
      id: rel,
      title,
      kind: kindOf(rel),
      path: rel,
      tags: parseTags(body)
    })
  }

  const edges: KnowledgeEdge[] = []
  const seen = new Set<string>()
  for (const node of nodes) {
    const body = bodies.get(node.path) ?? ''
    for (const target of wikiTargets(body)) {
      const resolved = resolveLink(node.path, target, byPath, byTitle)
      if (!resolved || resolved === node.path) continue
      const key = `${node.path}->${resolved}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: node.path, to: resolved })
    }
  }

  return {
    projectId: project.id,
    path: vault,
    available: true,
    reason: 'ok',
    error: null,
    nodes,
    edges
  }
}

function digest(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex')
}

/** Notes what a run is about to leave at `path`. A run stops here at quit, between writes. */
function claim(path: string, print: string | null): void {
  if (stopping) throw new Error('The app is quitting')
  ownWrites.set(path, print)
}

async function makeDir(path: string): Promise<void> {
  claim(path, DIR)
  await mkdir(path, { recursive: true })
}

async function writeOwn(path: string, contents: string): Promise<void> {
  claim(dirname(path), DIR)
  claim(path, digest(contents))
  await writeFileAtomic(path, contents)
}

/** What `path` holds now, in the form ownWrites records it. */
async function onDisk(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).isDirectory()) return DIR
    return digest(await readFile(path))
  } catch {
    return null
  }
}

/** Whether a watcher event is a run's own write: the path still holds what the run left there. */
async function isOwnEvent(dir: string, filename: string | null): Promise<boolean> {
  // Without a file name the change can't be matched, so it may be an outside one.
  if (filename == null) return false
  const path = join(dir, filename)
  // macOS also reports a change inside the watched folder under the folder's own name.
  // Any outside edit there comes with an event of its own.
  if (filename === basename(dir) && !existsSync(path)) return true
  // writeFileAtomic writes a temp file next to its target first.
  const target = path.replace(/\.\d+\.\d+\.tmp$/, '')
  if (target !== path) return ownWrites.has(target)
  if (!ownWrites.has(path)) return false
  return (await onDisk(path)) === ownWrites.get(path)
}

/** Runs `react` for a watcher event, unless it is the project's running job writing. */
function unlessOwn(projectId: string, dir: string, filename: string | null, react: () => void): void {
  if (!writing.has(projectId)) {
    react()
    return
  }
  void isOwnEvent(dir, filename).then((own) => {
    if (!own) react()
  })
}

async function writeIfMissing(path: string, contents: string): Promise<void> {
  if (existsSync(path)) return
  await writeOwn(path, contents)
}

async function ensureObsidian(vault: string): Promise<void> {
  const dir = join(vault, '.obsidian')
  await makeDir(dir)
  await writeIfMissing(
    join(dir, 'app.json'),
    `${JSON.stringify(
      {
        legacyEditor: false,
        livePreview: true,
        defaultViewMode: 'preview',
        newFileLocation: 'folder',
        newFileFolderPath: 'notes',
        attachmentFolderPath: 'attachments',
        useMarkdownLinks: false,
        newLinkFormat: 'shortest',
        alwaysUpdateLinks: true
      },
      null,
      2
    )}\n`
  )
  await writeIfMissing(
    join(dir, 'appearance.json'),
    `${JSON.stringify({ baseFontSize: 16, theme: 'obsidian', cssTheme: '', accentColor: '' }, null, 2)}\n`
  )
  await writeIfMissing(
    join(dir, 'graph.json'),
    `${JSON.stringify(
      {
        'collapse-filter': false,
        search: '',
        showTags: false,
        showAttachments: false,
        hideUnresolved: false,
        showOrphans: true,
        'collapse-color-groups': false,
        colorGroups: [
          { query: 'path:generated', color: { a: 1, rgb: 12884700 } },
          { query: 'path:notes', color: { a: 1, rgb: 8037060 } },
          { query: 'file:Home.md', color: { a: 1, rgb: 15921906 } }
        ],
        'collapse-display': false,
        showArrow: false,
        textFadeMultiplier: 0,
        nodeSizeMultiplier: 1,
        lineSizeMultiplier: 1,
        'collapse-forces': false,
        centerStrength: 0.46,
        repelStrength: 10,
        linkStrength: 1,
        linkDistance: 250,
        scale: 1,
        close: true
      },
      null,
      2
    )}\n`
  )
  await writeIfMissing(
    join(dir, 'core-plugins.json'),
    `${JSON.stringify(
      {
        'file-explorer': true,
        'global-search': true,
        switcher: true,
        graph: true,
        backlink: true,
        'outgoing-link': true,
        'tag-pane': true,
        'page-preview': true,
        templates: false,
        'note-composer': true,
        'command-palette': true,
        outline: true,
        'word-count': true,
        'open-with-default-app': true,
        'file-recovery': true
      },
      null,
      2
    )}\n`
  )
  await writeIfMissing(join(dir, 'community-plugins.json'), '[]\n')
  await writeIfMissing(
    join(vault, '.gitignore'),
    '.obsidian/workspace.json\n.obsidian/workspace-mobile.json\n.obsidian/cache\n'
  )
}

function generatedNote(title: string, extraTags: string[], body: string): string {
  const tags = ['datapad-workbench', 'generated', ...extraTags]
  return [
    '---',
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    'workbench_generated: true',
    '---',
    '',
    `# ${title}`,
    '',
    '> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.',
    '',
    body.trim(),
    ''
  ].join('\n')
}

async function listAreas(root: string): Promise<{ areas: Area[]; files: string[] }> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return { areas: [], files: [] }
  }
  const visible = entries
    .filter((entry) => !entry.name.startsWith('.') && !IGNORE.has(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  const areas: Area[] = []
  const files: string[] = []
  for (const entry of visible) {
    if (entry.isDirectory()) {
      if (areas.length >= MAX_AREAS) continue
      let children: string[] = []
      try {
        const nested = await readdir(join(root, entry.name), { withFileTypes: true })
        children = nested
          .filter((item) => !item.name.startsWith('.') && !IGNORE.has(item.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .slice(0, MAX_CHILDREN)
          .map((item) => item.name + (item.isDirectory() ? '/' : ''))
      } catch {
        children = []
      }
      areas.push({ name: entry.name, children })
    } else {
      files.push(entry.name)
    }
  }
  return { areas, files }
}

function areaFileName(dir: string): string {
  const base = sanitizeName(dir)
  if (RESERVED.has(base.toLowerCase())) return `area-${base}`
  return base
}

function wiki(title: string): string {
  return `[[${title}]]`
}

/** A test is listed in its folder's note, without a note of its own. */
function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[^./]+$/.test(path) || path.split('/').includes('__tests__')
}

function buildLayout(indexed: IndexedFile[], listed: Area[]): Layout {
  const areas = new Set(listed.map((area) => area.name))
  const folders = new Map<string, Folder>()
  const files = new Map<string, IndexedFile>()
  const folderAt = (path: string): Folder => {
    let folder = folders.get(path)
    if (!folder) {
      folder = { folders: [], files: [], tests: [] }
      folders.set(path, folder)
      const cut = path.lastIndexOf('/')
      if (cut > 0) folderAt(path.slice(0, cut)).folders.push(path)
    }
    return folder
  }
  for (const file of [...indexed].sort((a, b) => a.path.localeCompare(b.path))) {
    const path = posix(file.path)
    const parts = path.split('/')
    // Loose files at the root are listed in Architecture.
    if (parts.length < 2 || !areas.has(parts[0])) continue
    if (parts.some((part) => part.startsWith('.') || IGNORE.has(part))) continue
    const folder = folderAt(parts.slice(0, -1).join('/'))
    if (isTestFile(path)) {
      folder.tests.push(path)
    } else {
      folder.files.push(path)
      files.set(path, { ...file, path })
    }
  }
  for (const folder of folders.values()) folder.folders.sort()
  const depth = (path: string): number => path.split('/').length
  const nested = [...folders.keys()]
    .filter((path) => path.includes('/'))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
  // Past the budget, the deepest folders go without a note.
  const noted = new Set([...folders.keys()].filter((path) => !path.includes('/')))
  for (const path of nested.slice(0, LAYOUT_BUDGET)) noted.add(path)
  const loose = new Map(
    listed
      .filter((area) => !folders.has(area.name) && area.children.length > 0)
      .map((area) => [area.name, area.children])
  )
  return { folders, files, noted, loose }
}

/** The noted folder a file counts toward: its own, or the nearest one above it. */
function moduleOf(path: string, layout: Layout): string {
  let dir = path.slice(0, path.lastIndexOf('/'))
  // Top-level folders are always noted.
  while (!layout.noted.has(dir)) dir = dir.slice(0, dir.lastIndexOf('/'))
  return dir
}

/** Where a folder's note lives under `generated/`. A top-level folder's is its area note. */
function layoutFile(path: string): string {
  const parts = path.split('/')
  const dirs = [areaFileName(parts[0]), ...parts.slice(1, -1).map(sanitizeName)]
  if (parts.length === 1) return `${dirs[0]}.md`
  return `${dirs.join('/')}/${areaFileName(parts[parts.length - 1])}.md`
}

/** A link by path: folders share names across the project, so a title alone could point at several notes. */
function layoutLink(path: string): string {
  return `[[generated/${layoutFile(path)}|${path.split('/').pop() ?? path}]]`
}

function folderContents(path: string, folder: Folder, layout: Layout, summary: ModuleSummary | undefined): string {
  const name = (item: string): string => item.slice(path.length + 1)
  const file = (item: string): string => {
    const does = summary?.files[name(item)]
    return does ? `- \`${name(item)}\`: ${does}` : `- \`${name(item)}\``
  }
  const lines = [
    ...folder.folders.map((item) => (layout.noted.has(item) ? `- ${layoutLink(item)}` : `- \`${name(item)}/\``)),
    ...folder.files.map(file),
    ...folder.tests.map((item) => `- \`${name(item)}\` (test)`)
  ]
  return lines.length > 0 ? lines.join('\n') : '_Nothing indexed._'
}

/** The indexed files a JS or TS file imports by relative path. */
function relativeImports(from: string, source: string, layout: Layout): string[] {
  const found = new Set<string>()
  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    const base = posix(join(dirname(from), match[1]))
    // TypeScript imports `./a.js` for `a.ts`.
    const stem = base.replace(/\.(?:[mc]?js|jsx)$/, '')
    const target = [base, ...SCRIPT_EXTENSIONS.flatMap((ext) => [stem + ext, `${base}/index${ext}`])].find(
      (candidate) => candidate !== from && layout.files.has(candidate)
    )
    if (target) found.add(target)
  }
  return [...found]
}

async function readModuleLinks(root: string, layout: Layout): Promise<ModuleLinks> {
  const uses = new Map<string, Map<string, number>>()
  const importers = new Map<string, number>()
  for (const file of layout.files.values()) {
    if (!SCRIPT_LANGUAGES.has(file.language)) continue
    const source = await readFile(join(root, file.path), 'utf8').catch(() => '')
    const from = moduleOf(file.path, layout)
    for (const target of relativeImports(file.path, source, layout)) {
      importers.set(target, (importers.get(target) ?? 0) + 1)
      const to = moduleOf(target, layout)
      if (to === from) continue
      const counts = uses.get(from) ?? new Map<string, number>()
      counts.set(to, (counts.get(to) ?? 0) + 1)
      uses.set(from, counts)
    }
  }
  return { uses, importers }
}

/** Lines of the project's docs about a folder, or failing that about a file directly in it. */
function describedIn(docs: string, path: string): string[] {
  const at = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // The folder itself, maybe with a trailing slash or full stop, but not a path inside it or a longer name.
  const folder = new RegExp(`(?<![\\w./-])${at}/?(?![\\w-]|\\.\\w|/[\\w.-])`)
  const file = new RegExp(`(?<![\\w./-])${at}/[\\w-]+(?:\\.[\\w-]+)+(?![\\w/-])`)
  const lines: string[] = []
  let fenced = false
  for (const line of docs.split('\n')) {
    if (line.trimStart().startsWith('```')) fenced = !fenced
    else if (!fenced && line.trim()) lines.push(line)
  }
  const aboutFolder = lines.filter((line) => folder.test(line))
  const picked = aboutFolder.length > 0 ? aboutFolder : lines.filter((line) => file.test(line))
  return picked.slice(0, 3).map((line) => line.trim().replace(/^(?:#+|[-*+]|\d+[.)])\s+/, ''))
}

/**
 * What a folder's note says: what it does, what the docs call it, its parent, the folders it uses, its key files,
 * and what it holds.
 */
function moduleSections(
  path: string,
  folder: Folder,
  layout: Layout,
  links: ModuleLinks,
  docs: string,
  summary: ModuleSummary | undefined
): string[] {
  const described = describedIn(docs, path)
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
  const uses = [...(links.uses.get(path) ?? [])].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const key = [...links.importers]
    .filter(([file, count]) => count >= 2 && moduleOf(file, layout) === path)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_KEY_FILES)
  return [
    ...(summary ? [summary.about, ''] : []),
    ...(described.length > 0 ? [...described, ''] : []),
    ...(parent != null ? ['## In', '', `- ${layoutLink(parent)}`, ''] : []),
    ...(uses.length > 0
      ? ['## Uses', '', ...uses.map(([to, count]) => `- ${layoutLink(to)} (${count} import${count === 1 ? '' : 's'})`), '']
      : []),
    ...(key.length > 0
      ? ['## Key files', '', ...key.map(([file, count]) => `- \`${file.slice(path.length + 1)}\`: imported by ${count} files`), '']
      : []),
    '## Contains',
    '',
    folderContents(path, folder, layout, summary)
  ]
}

function signatureOf(path: string, layout: Layout): string {
  const loose = layout.loose.get(path)
  if (loose) return moduleSignature(path, loose, [])
  const folder = layout.folders.get(path)
  const name = (item: string): string => item.slice(path.length + 1)
  return moduleSignature(path, folder?.files.map(name) ?? [], folder?.folders.map(name) ?? [])
}

/** What the model is told about a module: the docs on it, what it holds and uses, and an outline of each file. */
async function readBrief(root: string, path: string, layout: Layout, links: ModuleLinks, docs: string): Promise<ModuleBrief> {
  const loose = layout.loose.get(path)
  if (loose) {
    // The index has no outline of these, so the model gets the names, and the first lines of what is written in prose.
    const files = await Promise.all(
      loose
        .filter((name) => !name.endsWith('/'))
        .map(async (name) => ({
          name,
          outline: /\.(?:md|txt)$/i.test(name) ? outline(await readFile(join(root, path, name), 'utf8').catch(() => '')) : []
        }))
    )
    return { path, docs: describedIn(docs, path), folders: loose.filter((name) => name.endsWith('/')), uses: [], files }
  }
  const folder = layout.folders.get(path) ?? { folders: [], files: [], tests: [] }
  const files = await Promise.all(
    folder.files.map(async (file) => ({
      name: file.slice(path.length + 1),
      outline: outline(await readFile(join(root, file), 'utf8').catch(() => ''))
    }))
  )
  return {
    path,
    docs: describedIn(docs, path),
    folders: folder.folders.map((item) => item.slice(path.length + 1)),
    uses: [...(links.uses.get(path)?.keys() ?? [])],
    files
  }
}

/** Each file a feature can name, with the module whose note lists it. */
function featureFiles(layout: Layout): Map<string, string> {
  return new Map([
    ...[...layout.files.keys()].map((file): [string, string] => [file, moduleOf(file, layout)]),
    ...[...layout.loose].flatMap(([area, children]) => children.map((child): [string, string] => [`${area}/${child}`, area]))
  ])
}

/**
 * Has the model say what the project does, as features, from what is written about its modules.
 * Asked again when a module is described again.
 */
function describeFeatures(
  project: Project,
  layout: Layout,
  overview: string | null,
  stored: Map<string, StoredSummary>,
  features: StoredFeatures | null
): void {
  const signature = featuresSignature(stored)
  if (stored.size === 0 || features?.signature === signature || askedFeatures.get(project.id) === signature) return
  askedFeatures.set(project.id, signature)
  describing.add(project.id)
  const known = new Set(featureFiles(layout).keys())
  void askOnce(project, featurePrompt(project.name, overview, stored), SUMMARY_TIMEOUTS)
    .then((raw) => {
      const list = raw ? parseFeatures(raw, known) : []
      if (list.length === 0) return
      freshFeatures.set(project.id, { signature, list })
      void maintainVaultForProjectId(project.id)
    })
    .catch(() => undefined)
    .finally(() => describing.delete(project.id))
}

/**
 * Has the model describe the modules of the open Knowledge pane's project that changed since it last did, and
 * once none is left, the project's features. Each batch it answers is stored by the run it starts.
 */
function describeChanged(
  project: Project,
  layout: Layout,
  links: ModuleLinks,
  docs: string,
  overview: string | null,
  stored: Map<string, StoredSummary>,
  features: StoredFeatures | null
): void {
  if (!project.path || stopping || describing.has(project.id)) return
  const root = project.path
  const asked = askedSignatures.get(project.id) ?? new Map<string, string>()
  askedSignatures.set(project.id, asked)
  const signatures = new Map([...layout.noted, ...layout.loose.keys()].map((path) => [path, signatureOf(path, layout)]))
  // Asked once per change: a module the model skipped or failed on waits for its next change, or the next launch.
  const changed = [...signatures.keys()].filter((path) => {
    const signature = signatures.get(path)
    return stored.get(path)?.signature !== signature && asked.get(path) !== signature
  })
  if (changed.length === 0) {
    describeFeatures(project, layout, overview, stored, features)
    return
  }
  for (const path of changed) asked.set(path, signatures.get(path) ?? '')
  describing.add(project.id)
  void (async () => {
    const groups = batches(await Promise.all(changed.map((path) => readBrief(root, path, layout, links, docs))))
    for (let index = 0; index < groups.length; index++) {
      // Closing the pane or quitting stops the asking. What wasn't asked yet is asked next time.
      if (stopping || activeProjectId !== project.id) {
        for (const brief of groups.slice(index).flat()) asked.delete(brief.path)
        return
      }
      const raw = await askOnce(project, summaryPrompt(project.name, overview, groups[index]), SUMMARY_TIMEOUTS)
      const described = raw ? parseSummaries(raw, groups[index]) : new Map<string, ModuleSummary>()
      if (described.size === 0) continue
      const fresh = freshSummaries.get(project.id) ?? new Map<string, StoredSummary>()
      for (const [path, summary] of described) fresh.set(path, { ...summary, signature: signatures.get(path) ?? '' })
      freshSummaries.set(project.id, fresh)
      void maintainVaultForProjectId(project.id)
    }
  })()
    .catch(() => undefined)
    .finally(() => describing.delete(project.id))
}

/** Where a feature's note lives under `generated/`. */
function featureFile(name: string): string {
  return `features/${areaFileName(name)}.md`
}

/** What a feature's note says: what it does, then the files behind it under the module each is in. */
function featureSections(feature: Feature, files: Map<string, string>, summaries: Map<string, StoredSummary>): string[] | null {
  const byModule = new Map<string, string[]>()
  for (const file of feature.files) {
    const module = files.get(file)
    // A file that has left the project since the feature was written.
    if (module == null) continue
    byModule.set(module, [...(byModule.get(module) ?? []), file.slice(module.length + 1)])
  }
  if (byModule.size === 0) return null
  return [
    feature.about,
    '',
    '## Where it lives',
    '',
    ...[...byModule].flatMap(([module, names]) => [
      `- [[generated/${layoutFile(module)}|${module}]]`,
      ...names.map((name) => {
        const does = summaries.get(module)?.files[name]
        return does ? `  - \`${name}\`: ${does}` : `  - \`${name}\``
      })
    ])
  ]
}

async function listUserNotes(vault: string): Promise<string[]> {
  const dir = join(vault, 'notes')
  let entries: Array<{ name: string; isFile: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name.replace(/\.md$/i, ''))
    .sort((a, b) => a.localeCompare(b))
}

function homeGeneratedBlock(
  projectName: string,
  links: { overview: boolean; architecture: boolean; stack: boolean; rules: boolean; areas: string[] },
  userNotes: string[]
): string {
  const generated = [
    links.overview ? `- ${wiki('Overview')}` : null,
    links.architecture ? `- ${wiki('Architecture')}` : null,
    links.stack ? `- ${wiki('Stack')}` : null,
    links.rules ? `- ${wiki('Rules')}` : null,
    ...links.areas.map((link) => `- ${link}`)
  ].filter(Boolean)
  const notes =
    userNotes.length > 0
      ? userNotes.map((name) => `- ${wiki(name)}`)
      : ['- Add markdown files in `notes/` — they show up here and in the graph.']
  return [
    `A living map of **${projectName}**. Generated notes stay in \`generated/\`; your writing stays in \`notes/\`.`,
    '',
    '## Generated',
    '',
    ...generated,
    '',
    '## Your notes',
    '',
    ...notes,
    ''
  ].join('\n')
}

async function patchHome(vault: string, projectName: string, block: string): Promise<void> {
  const path = join(vault, 'Home.md')
  const header = [
    '---',
    'tags:',
    '  - map',
    '  - datapad-workbench',
    '---',
    '',
    `# ${projectName}`,
    '',
    'This folder is an [Obsidian](https://obsidian.md) vault. In Obsidian choose **Open folder as vault** and pick this `knowledge` directory.',
    ''
  ].join('\n')
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch {
    current = ''
  }
  const section = `${MARK_START}\n\n${block.trim()}\n\n${MARK_END}\n`
  if (!current) {
    await writeOwn(path, `${header}\n${section}`)
    return
  }
  const bounds = findHomeSection(current)
  if (bounds) {
    const next = syncHomeBranding(
      `${current.slice(0, bounds.start)}${section}${current.slice(bounds.end + bounds.endLen).replace(/^\n/, '')}`,
      projectName
    )
    if (next !== current) await writeOwn(path, next)
    return
  }
  await writeOwn(path, `${syncHomeBranding(current.trimEnd(), projectName)}\n\n${section}`)
}

function findHomeSection(markdown: string): { start: number; end: number; endLen: number } | null {
  for (const [startMark, endMark] of [
    [MARK_START, MARK_END],
    ...LEGACY_MARKS
  ]) {
    const start = markdown.indexOf(startMark)
    const end = markdown.indexOf(endMark)
    if (start >= 0 && end > start) return { start, end, endLen: endMark.length }
  }
  return null
}

function syncHomeBranding(markdown: string, projectName: string): string {
  return markdown
    .replace(/^# .+$/m, `# ${projectName}`)
    .replace(/^(\s+- )(grokcode|grok-build-workbench)$/m, '$1datapad-workbench')
}

async function writeGenerated(vault: string, fileName: string, contents: string): Promise<void> {
  const path = join(vault, 'generated', fileName)
  // An unchanged note keeps its mtime, so Obsidian and other watchers see no churn.
  if ((await readFile(path, 'utf8').catch(() => null)) === contents) return
  // writeFileAtomic makes the folders on the way; writeOwn notes only the last.
  const parts = fileName.split('/')
  for (let i = 0; i < parts.length - 1; i++) claim(join(vault, 'generated', ...parts.slice(0, i)), DIR)
  await writeOwn(path, contents)
}

/** Removes the notes under `generated/` that aren't in `keep`, by path below it, and the folders that leaves empty. */
async function pruneGenerated(vault: string, keep: Set<string>, rel = ''): Promise<void> {
  const dir = join(vault, 'generated', rel)
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await pruneGenerated(vault, keep, child)
      if ((await readdir(path).catch(() => [entry.name])).length > 0) continue
      claim(path, null)
      await rmdir(path).catch(() => undefined)
    } else if (entry.name.toLowerCase().endsWith('.md') && !keep.has(child)) {
      claim(path, null)
      await rm(path, { force: true })
    }
  }
}

async function ensureStarterNote(vault: string): Promise<void> {
  const dir = join(vault, 'notes')
  await makeDir(dir)
  await makeDir(join(vault, 'attachments'))
  await writeIfMissing(
    join(dir, 'How to use this vault.md'),
    [
      '---',
      'tags:',
      '  - datapad-workbench',
      '---',
      '',
      '# How to use this vault',
      '',
      'This `knowledge` folder is a real Obsidian vault. Open it with **Open folder as vault**.',
      '',
      '- Wiki-links use `[[Square brackets]]`, same as Obsidian.',
      '- Datapad Workbench rewrites files in `generated/` when the project index updates.',
      '- Anything you add under `notes/` is yours and is never overwritten.',
      `- ${wiki('Home')} is the map of content.`,
      `- ${wiki('Overview')} and ${wiki('Architecture')} are the generated base for how this project works.`,
      '',
      'New notes created in Obsidian land in `notes/` by default.',
      ''
    ].join('\n')
  )
}

export async function maintainVault(project: Project): Promise<KnowledgeSnapshot> {
  if (!project.path) return emptySnapshot(project.id, null, 'no-folder', null)
  // A run already going read its inputs before this request. Queue one more instead of dropping it.
  const next = queued.get(project.id)
  if (next) {
    next.project = project
    return next.job
  }
  const running = jobs.get(project.id)
  if (!running) return startMaintain(project)
  const rerun = (): Promise<KnowledgeSnapshot> => {
    const latest = queued.get(project.id)?.project ?? project
    queued.delete(project.id)
    return startMaintain(latest)
  }
  const job = running.then(rerun, rerun)
  queued.set(project.id, { project, job })
  return job
}

function startMaintain(project: Project): Promise<KnowledgeSnapshot> {
  const job = maintainVaultNow(project).finally(() => {
    jobs.delete(project.id)
  })
  jobs.set(project.id, job)
  return job
}

async function maintainVaultNow(project: Project): Promise<KnowledgeSnapshot> {
  if (!project.path) return emptySnapshot(project.id, null, 'no-folder', null)
  const vault = vaultPath(project.path)
  writing.set(project.id, (writing.get(project.id) ?? 0) + 1)
  try {
    await makeDir(vault)
    await ensureObsidian(vault)
    await ensureStarterNote(vault)
    // The counts and tree come from the index, which nothing else keeps up with the files.
    await syncIndex(project)
    const [orientation, listing, userNotes, indexed] = await Promise.all([
      buildOrientation(project),
      listAreas(project.path),
      listUserNotes(vault),
      listIndexedFiles(project)
    ])
    const layout = buildLayout(indexed ?? [], listing.areas)
    const root = project.path
    const links = await readModuleLinks(root, layout)
    const docs = (
      await Promise.all(
        [orientation.rulesFile, 'README.md']
          .filter((name): name is string => name != null)
          .map((name) => readFile(join(root, name), 'utf8').catch(() => ''))
      )
    ).join('\n')
    const keep = new Set<string>()
    const areaLinks: string[] = []

    const summariesPath = join(vault, 'generated', SUMMARIES_FILE)
    const storedState = await readFile(summariesPath, 'utf8').catch(() => null)
    const summaries = readStored(storedState)
    let features = readStoredFeatures(storedState)
    const fresh = freshSummaries.get(project.id)
    for (const [path, summary] of fresh ?? []) summaries.set(path, summary)
    // Without the index there is no layout to tell a gone module from an unread one.
    if (indexed) {
      for (const path of summaries.keys()) {
        if (!layout.noted.has(path) && !layout.loose.has(path)) summaries.delete(path)
      }
      features = freshFeatures.get(project.id) ?? features
      freshFeatures.delete(project.id)
      if (summaries.size > 0) await writeGenerated(vault, SUMMARIES_FILE, storedText(summaries, features))
      else if (existsSync(summariesPath)) {
        claim(summariesPath, null)
        await rm(summariesPath, { force: true })
      }
      if (fresh) freshSummaries.delete(project.id)
      if (activeProjectId === project.id) {
        describeChanged(project, layout, links, docs, orientation.summary, summaries, features)
      }
    }

    const files = featureFiles(layout)
    const featureLines: string[] = []
    for (const feature of features?.list ?? []) {
      const sections = featureSections(feature, files, summaries)
      if (!sections) continue
      const file = featureFile(feature.name)
      await writeGenerated(vault, file, generatedNote(feature.name, ['feature'], sections.join('\n')))
      keep.add(file)
      featureLines.push(`- [[generated/${file}|${feature.name}]] — ${firstSentence(feature.about)}`)
    }

    const overviewBits = [
      orientation.summary,
      orientation.stack ? `Stack: ${orientation.stack}.` : null,
      orientation.languages.length ? `Languages: ${orientation.languages.join(', ')}.` : null,
      orientation.fileCount != null ? `${orientation.fileCount} indexed files.` : null,
      orientation.nodeCount != null ? `${orientation.nodeCount} symbols.` : null,
      ...(featureLines.length > 0 ? ['', '## What it does', '', ...featureLines] : []),
      '',
      '## Map',
      '',
      `- ${wiki('Architecture')}`,
      orientation.stack ? `- ${wiki('Stack')}` : null,
      orientation.rulesFile ? `- ${wiki('Rules')}` : null,
      `- ${wiki('Home')}`
    ].filter((line): line is string => line != null)
    await writeGenerated(
      vault,
      'Overview.md',
      generatedNote('Overview', ['overview'], overviewBits.join('\n'))
    )
    keep.add('Overview.md')

    const areaLines: string[] = []
    for (const area of listing.areas) {
      const file = layoutFile(area.name)
      const title = area.name
      areaLinks.push(layoutLink(area.name))
      const indexedFolder = layout.folders.get(area.name)
      const summary = summaries.get(area.name)
      const sections = indexedFolder
        ? moduleSections(area.name, indexedFolder, layout, links, docs, summary)
        : [
            ...(summary ? [summary.about, ''] : []),
            '## Contains',
            '',
            area.children.length > 0
              ? area.children
                  .map((child) => {
                    const does = summary?.files[child]
                    return does ? `- \`${area.name}/${child}\`: ${does}` : `- \`${area.name}/${child}\``
                  })
                  .join('\n')
              : '_Empty or unread folder._'
          ]
      await writeGenerated(
        vault,
        file,
        generatedNote(
          title,
          ['area'],
          [
            `Top-level area \`${area.name}/\`.`,
            '',
            ...sections,
            '',
            '## Related',
            '',
            `- ${wiki('Architecture')}`,
            `- ${wiki('Overview')}`
          ].join('\n')
        )
      )
      keep.add(file)
      areaLines.push(`- ${layoutLink(area.name)} — ${summary ? firstSentence(summary.about) : `\`${area.name}/\``}`)
    }

    for (const [path, folder] of layout.folders) {
      if (!path.includes('/') || !layout.noted.has(path)) continue
      const file = layoutFile(path)
      await writeGenerated(
        vault,
        file,
        generatedNote(
          path,
          ['folder'],
          [
            `Folder \`${path}/\`.`,
            '',
            ...moduleSections(path, folder, layout, links, docs, summaries.get(path))
          ].join('\n')
        )
      )
      keep.add(file)
    }

    const rootFiles =
      listing.files.length > 0
        ? listing.files.slice(0, 20).map((name) => `- \`${name}\``).join('\n')
        : '_No loose files at the project root._'
    await writeGenerated(
      vault,
      'Architecture.md',
      generatedNote(
        'Architecture',
        ['architecture'],
        [
          `How **${project.name}** is laid out. Areas below are wiki-linked so the graph stays connected.`,
          '',
          '## Areas',
          '',
          areaLines.length > 0 ? areaLines.join('\n') : '_No source folders yet._',
          '',
          '## Root files',
          '',
          rootFiles,
          orientation.tree ? `\n## Tree\n\n\`\`\`\n${orientation.tree}\n\`\`\`\n` : '',
          '',
          `- ${wiki('Overview')}`,
          `- ${wiki('Home')}`
        ].join('\n')
      )
    )
    keep.add('Architecture.md')

    let hasStack = false
    if (orientation.stack) {
      hasStack = true
      await writeGenerated(
        vault,
        'Stack.md',
        generatedNote(
          'Stack',
          ['stack'],
          [
            orientation.stack,
            '',
            orientation.languages.length
              ? `Detected languages: ${orientation.languages.join(', ')}.`
              : '',
            '',
            `- ${wiki('Overview')}`,
            `- ${wiki('Architecture')}`
          ].join('\n')
        )
      )
      keep.add('Stack.md')
    }

    let hasRules = false
    if (orientation.rulesFile) {
      hasRules = true
      await writeGenerated(
        vault,
        'Rules.md',
        generatedNote(
          'Rules',
          ['rules'],
          [
            `Agent rules live in \`${orientation.rulesFile}\` at the project root (outside this vault).`,
            '',
            orientation.summary ?? 'Read that file for the source of truth.',
            '',
            `- ${wiki('Overview')}`,
            `- ${wiki('Home')}`
          ].join('\n')
        )
      )
      keep.add('Rules.md')
    }

    await pruneGenerated(vault, keep)
    await patchHome(
      vault,
      project.name,
      homeGeneratedBlock(
        project.name,
        {
          overview: true,
          architecture: true,
          stack: hasStack,
          rules: hasRules,
          areas: areaLinks
        },
        userNotes
      )
    )
    const snapshot = await readSnapshot(project)
    if (activeProjectId === project.id) emit(snapshot)
    return snapshot
  } catch (error) {
    const snapshot = emptySnapshot(
      project.id,
      vault,
      'error',
      error instanceof Error ? error.message : 'Could not update the knowledge vault'
    )
    if (activeProjectId === project.id) emit(snapshot)
    return snapshot
  } finally {
    setTimeout(() => {
      const count = (writing.get(project.id) ?? 1) - 1
      if (count > 0) {
        writing.set(project.id, count)
        return
      }
      writing.delete(project.id)
      for (const path of ownWrites.keys()) {
        if (path === vault || path.startsWith(vault + sep)) ownWrites.delete(path)
      }
    }, 500)
  }
}

export async function getKnowledgeSnapshot(projectId: string): Promise<KnowledgeSnapshot> {
  const projects = await listProjects()
  const project = projects.find((item) => item.id === projectId)
  if (!project) return emptySnapshot(projectId, null, 'error', 'Project not found')
  if (!project.path) return emptySnapshot(project.id, null, 'no-folder', null)
  const vault = vaultPath(project.path)
  if (!existsSync(join(vault, 'Home.md'))) return maintainVault(project)
  return readSnapshot(project)
}

export async function rebuildKnowledge(projectId: string): Promise<KnowledgeSnapshot> {
  const projects = await listProjects()
  const project = projects.find((item) => item.id === projectId)
  if (!project) return emptySnapshot(projectId, null, 'error', 'Project not found')
  return maintainVault(project)
}

export async function getKnowledgeNote(projectId: string, relPath: string): Promise<KnowledgeNote | null> {
  const projects = await listProjects()
  const project = projects.find((item) => item.id === projectId)
  if (!project?.path) return null
  const vault = resolve(vaultPath(project.path))
  const abs = resolve(vault, relPath)
  const prefix = vault.endsWith(sep) ? vault : vault + sep
  if (abs !== vault && !abs.startsWith(prefix)) return null
  if (posix(relative(vault, abs)).split('/').includes('.obsidian')) return null
  try {
    const info = await stat(abs)
    if (!info.isFile()) return null
    const body = await readFile(abs, 'utf8')
    const path = posix(relative(vault, abs))
    return { path, title: titleOf(path, body), body }
  } catch {
    return null
  }
}

function obsidianConfigPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library/Application Support/obsidian/obsidian.json')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || homedir(), 'obsidian', 'obsidian.json')
  }
  return join(homedir(), '.config/obsidian/obsidian.json')
}

function runMacOpen(args: string[]): Promise<boolean> {
  return new Promise((resolveResult) => {
    execFile('open', args, (error) => resolveResult(!error))
  })
}

async function registerObsidianVault(vault: string): Promise<void> {
  const configPath = obsidianConfigPath()
  type VaultsFile = {
    vaults?: Record<string, { path: string; ts: number; open?: boolean }>
    cli?: boolean
  }
  let data: VaultsFile = { vaults: {} }
  try {
    data = JSON.parse(await readFile(configPath, 'utf8')) as VaultsFile
  } catch {
    /* first run or missing config */
  }
  data.vaults ??= {}
  const resolved = resolve(vault)
  for (const entry of Object.values(data.vaults)) {
    if (resolve(entry.path) === resolved) {
      entry.ts = Date.now()
      await mkdir(join(configPath, '..'), { recursive: true })
      await writeFile(configPath, JSON.stringify(data), 'utf8')
      return
    }
  }
  data.vaults[randomBytes(8).toString('hex')] = { path: resolved, ts: Date.now() }
  await mkdir(join(configPath, '..'), { recursive: true })
  await writeFile(configPath, JSON.stringify(data), 'utf8')
}

export async function openKnowledgeVault(projectId: string): Promise<boolean> {
  const projects = await listProjects()
  const project = projects.find((item) => item.id === projectId)
  if (!project?.path) return false
  const vault = vaultPath(project.path)
  if (!existsSync(join(vault, 'Home.md'))) await maintainVault(project)
  await registerObsidianVault(vault)
  if (process.platform === 'darwin' && (await runMacOpen(['-a', 'Obsidian', vault]))) return true
  const home = join(vault, 'Home.md')
  await shell.openExternal(`obsidian://open?path=${encodeURIComponent(home)}`)
  return true
}

export async function revealKnowledgeVault(projectId: string): Promise<boolean> {
  const projects = await listProjects()
  const project = projects.find((item) => item.id === projectId)
  if (!project?.path) return false
  const vault = vaultPath(project.path)
  if (!existsSync(vault)) await maintainVault(project)
  const error = await shell.openPath(vault)
  return !error
}

export async function maintainVaultForProjectId(projectId: string): Promise<void> {
  const projects = await listProjects()
  const project = projects.find((item) => item.id === projectId)
  if (!project?.path) return
  await maintainVault(project)
}

function schedule(projectId: string, fn: () => void): void {
  const existing = pending.get(projectId)
  if (existing) clearTimeout(existing)
  pending.set(
    projectId,
    setTimeout(() => {
      pending.delete(projectId)
      fn()
    }, WATCH_MS)
  )
}

/** A change under a folder the vault doesn't describe: dependencies, builds, the vault itself, or a dot folder. */
function skippedPath(filename: string | null): boolean {
  if (filename == null) return false
  return posix(filename)
    .split('/')
    .some((part) => part.startsWith('.') || IGNORE.has(part))
}

function watchProjectRoot(project: Project): void {
  if (!project.path) return
  if (projectWatchers.has(project.id) && projectWatchPaths.get(project.id) === project.path) return
  const existing = projectWatchers.get(project.id)
  if (existing) {
    existing.close()
    projectWatchers.delete(project.id)
  }
  const root = project.path
  try {
    const watcher = watch(root, { persistent: false, recursive: true }, (_event, filename) => {
      if (skippedPath(filename)) return
      unlessOwn(project.id, root, filename, () =>
        schedule(project.id, () => {
          // By id, so a rename since this watcher started is picked up.
          void maintainVaultForProjectId(project.id)
        })
      )
    })
    watcher.on('error', () => {
      watcher.close()
      if (projectWatchers.get(project.id) !== watcher) return
      projectWatchers.delete(project.id)
      projectWatchPaths.delete(project.id)
    })
    projectWatchers.set(project.id, watcher)
    projectWatchPaths.set(project.id, project.path)
  } catch {
    /* watch unavailable */
  }
}

function watchVault(project: Project): void {
  if (!project.path) return
  const existing = vaultWatchers.get(project.id)
  if (existing) {
    existing.close()
    vaultWatchers.delete(project.id)
  }
  const vault = vaultPath(project.path)
  if (!existsSync(vault)) return
  try {
    const watcher = watch(vault, { persistent: false, recursive: true }, (_event, filename) => {
      unlessOwn(project.id, vault, filename, () =>
        schedule(`vault:${project.id}`, () => {
          void readSnapshot(project).then((snapshot) => {
            if (activeProjectId === project.id) emit(snapshot)
          })
        })
      )
    })
    watcher.on('error', () => {
      watcher.close()
      if (vaultWatchers.get(project.id) === watcher) vaultWatchers.delete(project.id)
    })
    vaultWatchers.set(project.id, watcher)
  } catch {
    /* watch unavailable */
  }
}

export async function syncKnowledgeWatchers(): Promise<void> {
  const projects = await listProjects()
  const wanted = new Set(projects.map((project) => project.id))
  for (const [id, watcher] of projectWatchers) {
    if (wanted.has(id)) continue
    watcher.close()
    projectWatchers.delete(id)
    projectWatchPaths.delete(id)
  }
  for (const [id, watcher] of vaultWatchers) {
    if (wanted.has(id)) continue
    watcher.close()
    vaultWatchers.delete(id)
  }
  for (const [key, timer] of pending) {
    if (wanted.has(key.replace(/^vault:/, ''))) continue
    clearTimeout(timer)
    pending.delete(key)
  }
  for (const project of projects) {
    if (!project.path) continue
    watchProjectRoot(project)
    void maintainVault(project).then(() => {
      // The active vault moves with its project's folder.
      if (activeProjectId === project.id) watchVault(project)
    })
  }
}

export async function setKnowledgeActiveProject(projectId: string | null): Promise<void> {
  for (const watcher of vaultWatchers.values()) watcher.close()
  vaultWatchers.clear()
  activeProjectId = projectId
  if (!projectId) return
  const projects = await listProjects()
  const project = projects.find((item) => item.id === projectId)
  if (!project?.path) return
  if (!existsSync(vaultPath(project.path))) await maintainVault(project)
  // Opening the pane is when the model describes the modules that changed, so a run looks for them.
  else void maintainVault(project)
  // Another project became active while this one was loading.
  if (activeProjectId !== projectId) return
  watchVault(project)
  const snapshot = await readSnapshot(project)
  if (activeProjectId === projectId) emit(snapshot)
}

export function stopKnowledgeWatchers(): void {
  for (const watcher of projectWatchers.values()) watcher.close()
  for (const watcher of vaultWatchers.values()) watcher.close()
  projectWatchers.clear()
  projectWatchPaths.clear()
  vaultWatchers.clear()
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
  activeProjectId = null
}

/** At quit. A running job stops before its next write, and a queued or new one fails at its first. */
export function stopKnowledgeJobs(): void {
  stopping = true
}
