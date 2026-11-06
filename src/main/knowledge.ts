import { execFile } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { existsSync, watch, type FSWatcher } from 'fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
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
import { buildOrientation } from './codegraph'
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

type Area = { name: string; children: string[] }

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
    ...links.areas.map((name) => `- ${wiki(name)}`)
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
  await writeOwn(path, contents)
}

async function pruneGenerated(vault: string, keep: Set<string>): Promise<void> {
  const dir = join(vault, 'generated')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.md') || keep.has(name)) continue
    claim(join(dir, name), null)
    await rm(join(dir, name), { force: true })
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
    const [orientation, listing, userNotes] = await Promise.all([
      buildOrientation(project),
      listAreas(project.path),
      listUserNotes(vault)
    ])
    const keep = new Set<string>()
    const areaTitles: string[] = []

    const overviewBits = [
      orientation.summary,
      orientation.stack ? `Stack: ${orientation.stack}.` : null,
      orientation.languages.length ? `Languages: ${orientation.languages.join(', ')}.` : null,
      orientation.fileCount != null ? `${orientation.fileCount} indexed files.` : null,
      orientation.nodeCount != null ? `${orientation.nodeCount} symbols.` : null,
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
      const file = `${areaFileName(area.name)}.md`
      const title = area.name
      areaTitles.push(title)
      const childList =
        area.children.length > 0
          ? area.children.map((child) => `- \`${area.name}/${child}\``).join('\n')
          : '_Empty or unread folder._'
      const related = listing.areas
        .filter((item) => item.name !== area.name)
        .slice(0, 8)
        .map((item) => `- ${wiki(item.name)}`)
      await writeGenerated(
        vault,
        file,
        generatedNote(
          title,
          ['area'],
          [
            `Top-level area \`${area.name}/\`.`,
            '',
            '## Contains',
            '',
            childList,
            '',
            '## Related',
            '',
            `- ${wiki('Architecture')}`,
            `- ${wiki('Overview')}`,
            ...related
          ].join('\n')
        )
      )
      keep.add(file)
      areaLines.push(`- ${wiki(title)} — \`${area.name}/\``)
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
          areas: areaTitles
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
    const watcher = watch(root, { persistent: false }, (_event, filename) => {
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
