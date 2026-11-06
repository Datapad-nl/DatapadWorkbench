import { type ChildProcess, execFileSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { access, readdir, readFile, stat } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { basename, delimiter, join, resolve } from 'path'
import type { IndexState, OrientationCard, Project, ProjectIndex } from '../shared/types'

const INSTALL_SCRIPT = 'https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh'
const NPM_PACKAGE = '@colbymchenry/codegraph'
const IGNORE = new Set([
  '.git',
  '.codegraph',
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
  'knowledge'
])

type StatusJson = {
  initialized?: boolean
  fileCount?: number
  nodeCount?: number
  languages?: string[]
}

type RunResult = { code: number; stdout: string; stderr: string }

const jobs = new Map<string, Promise<void>>()
/** The folder each project was last queued with. A job for any other folder is stale and stays quiet. */
const queuedPath = new Map<string, string>()
const cache = new Map<string, ProjectIndex>()
const listeners = new Set<(index: ProjectIndex) => void>()
const children = new Set<ChildProcess>()
const BLOCKED_ROOTS = new Set([
  '/',
  '/Users',
  '/home',
  '/Volumes',
  '/System',
  '/Applications',
  '/Library',
  '/opt',
  '/usr',
  '/var',
  '/private'
])

export function isUnsafeProjectPath(path: string): boolean {
  const resolved = resolve(path.trim())
  if (BLOCKED_ROOTS.has(resolved)) return true
  if (resolved === homedir()) return true
  const parts = resolved.split('/').filter(Boolean)
  if (parts[0] === 'Volumes' && parts.length <= 2) return true
  if (parts[0] === 'Users' && parts.length <= 2) return true
  // /btw asides use a throwaway cwd; never import or index it as a project
  if (basename(resolved).startsWith('workbench-btw-')) return true
  const tmp = resolve(tmpdir())
  if (resolved === tmp || resolved.startsWith(`${tmp}/`) || resolved.startsWith(`${tmp}\\`)) return true
  return false
}

/** How long readIndex trusts a cached "CLI missing" before it looks for the CLI again. */
const MISSING_CLI_TTL_MS = 60_000

let resolvedBin: string | null | undefined
/** When resolveCodegraphBin last found no CLI. */
let missingCheckedAt = 0
let installing: Promise<string> | null = null
let stopping = false

export function onIndexChange(listener: (index: ProjectIndex) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(index: ProjectIndex): void {
  cache.set(index.projectId, index)
  for (const listener of listeners) listener(index)
}

/**
 * Emits a job's result to every project still queued with `path`. Jobs are per folder, so two projects
 * with the same folder share one. A project since moved to another folder stays quiet.
 */
function emitFor(path: string, index: ProjectIndex): void {
  if (stopping) return
  for (const [projectId, queued] of queuedPath) {
    if (queued === path) emit({ ...index, projectId })
  }
}

export function augmentPath(): void {
  const extras = [
    join(homedir(), '.local/bin'),
    join(homedir(), '.codegraph/current/bin'),
    join(homedir(), '.grok/bin'),
    // Opened from Finder, the app gets a bare PATH. MCP servers often run through Homebrew's npx or node.
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  const current = process.env.PATH ?? ''
  const parts = current.split(delimiter)
  const prepend = extras.filter((dir) => !parts.includes(dir))
  if (prepend.length > 0) {
    process.env.PATH = [...prepend, current].filter(Boolean).join(delimiter)
  }
}

function candidateBins(): string[] {
  const named = [
    process.env.CODEGRAPH_BIN,
    join(homedir(), '.local/bin/codegraph'),
    join(homedir(), '.codegraph/current/bin/codegraph')
  ]
  return named.filter((path): path is string => Boolean(path))
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path)
    return existsSync(path)
  } catch {
    return false
  }
}

export async function resolveCodegraphBin(): Promise<string | null> {
  if (resolvedBin !== undefined) {
    if (resolvedBin && (await isExecutable(resolvedBin))) return resolvedBin
    resolvedBin = undefined
  }
  for (const path of candidateBins()) {
    if (await isExecutable(path)) {
      resolvedBin = path
      return path
    }
  }
  const which = await run('/usr/bin/which', ['codegraph'], { timeoutMs: 5_000 }).catch(() => null)
  const found = which?.stdout.trim()
  if (found && (await isExecutable(found))) {
    resolvedBin = found
    return found
  }
  resolvedBin = null
  missingCheckedAt = Date.now()
  return null
}

function run(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    let force: ReturnType<typeof setTimeout> | null = null
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      force = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // gone
        }
      }, 2_000)
    }, opts.timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      if (force) clearTimeout(force)
      children.delete(child)
      reject(error)
    })
    // A timed-out child fails once it has exited, not when the timer fires. Until then its job stays
    // registered, so a new job on the same folder can't start alongside it.
    child.on('exit', () => {
      if (!timedOut) return
      if (force) clearTimeout(force)
      children.delete(child)
      reject(new Error(`${command} timed out`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (force) clearTimeout(force)
      children.delete(child)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function installCli(): Promise<string> {
  const sh = await run('/bin/sh', ['-c', `curl -fsSL ${INSTALL_SCRIPT} | sh`], {
    cwd: homedir(),
    timeoutMs: 180_000
  })
  const bin = await resolveCodegraphBin()
  if (bin) return bin
  const npm = await run('npm', ['install', '-g', NPM_PACKAGE], {
    cwd: homedir(),
    timeoutMs: 180_000
  }).catch(() => null)
  const afterNpm = await resolveCodegraphBin()
  if (afterNpm) return afterNpm
  const detail = [sh.stderr, sh.stdout, npm?.stderr, npm?.stdout].filter(Boolean).join('\n').trim()
  throw new Error(detail || 'Could not install Codegraph')
}

/** One install at a time, shared by every project waiting for the CLI. */
function installOnce(): Promise<string> {
  installing ??= installCli().finally(() => {
    installing = null
  })
  return installing
}

async function ensureBin(projectId: string, path: string): Promise<string | null> {
  const existing = await resolveCodegraphBin()
  if (existing) return existing
  emitFor(path, {
    projectId,
    state: 'installing',
    error: null,
    fileCount: null,
    nodeCount: null,
    languages: []
  })
  try {
    resolvedBin = undefined
    return await installOnce()
  } catch (error) {
    emitFor(path, {
      projectId,
      state: 'missing-cli',
      error: error instanceof Error ? error.message : 'Codegraph is not installed',
      fileCount: null,
      nodeCount: null,
      languages: []
    })
    return null
  }
}

async function readStatusJson(bin: string, path: string): Promise<StatusJson | null> {
  const result = await run(bin, ['status', '--json', path], { cwd: path, timeoutMs: 20_000 })
  try {
    return JSON.parse(result.stdout.trim()) as StatusJson
  } catch {
    return null
  }
}

function fromStatus(projectId: string, status: StatusJson | null, fallback: IndexState): ProjectIndex {
  if (!status) {
    return {
      projectId,
      state: fallback,
      error: null,
      fileCount: null,
      nodeCount: null,
      languages: []
    }
  }
  if (status.initialized) {
    return {
      projectId,
      state: 'indexed',
      error: null,
      fileCount: status.fileCount ?? null,
      nodeCount: status.nodeCount ?? null,
      languages: status.languages ?? []
    }
  }
  return {
    projectId,
    state: 'not-indexed',
    error: null,
    fileCount: null,
    nodeCount: null,
    languages: []
  }
}

/** A cached index is stale once the CLI may have been installed since, or its .codegraph folder is gone. */
function isStale(path: string, index: ProjectIndex): boolean {
  if (index.state === 'missing-cli') return Date.now() - missingCheckedAt > MISSING_CLI_TTL_MS
  if (index.state === 'indexed') return !existsSync(join(path, '.codegraph'))
  return false
}

export async function readIndex(project: Project): Promise<ProjectIndex> {
  if (!project.path) {
    const index: ProjectIndex = {
      projectId: project.id,
      state: 'no-folder',
      error: null,
      fileCount: null,
      nodeCount: null,
      languages: []
    }
    cache.set(project.id, index)
    return index
  }
  const running = jobs.has(project.path)
  const cached = cache.get(project.id)
  if (running) {
    return (
      cached ?? {
        projectId: project.id,
        state: 'indexing',
        error: null,
        fileCount: null,
        nodeCount: null,
        languages: []
      }
    )
  }
  if (cached && !isStale(project.path, cached)) return cached
  const bin = await resolveCodegraphBin()
  if (!bin) {
    // Still missing. Keep the cached one, which may say why the install failed.
    if (cached?.state === 'missing-cli') return cached
    const index: ProjectIndex = {
      projectId: project.id,
      state: 'missing-cli',
      error: null,
      fileCount: null,
      nodeCount: null,
      languages: []
    }
    cache.set(project.id, index)
    return index
  }
  let status: StatusJson | null
  try {
    status = await readStatusJson(bin, project.path)
  } catch (error) {
    // Not cached, so the next read tries again.
    return {
      projectId: project.id,
      state: 'error',
      error: error instanceof Error ? error.message : 'Could not read the index',
      fileCount: null,
      nodeCount: null,
      languages: []
    }
  }
  const index = fromStatus(project.id, status, 'not-indexed')
  cache.set(project.id, index)
  return index
}

export async function collectIndexes(projects: Project[]): Promise<Record<string, ProjectIndex>> {
  const entries = await Promise.all(projects.map((project) => readIndex(project)))
  return Object.fromEntries(entries.map((index) => [index.projectId, index]))
}

async function runIndex(projectId: string, path: string): Promise<void> {
  const bin = await ensureBin(projectId, path)
  if (!bin) return
  const current = await readStatusJson(bin, path)
  if (current?.initialized) {
    emitFor(path, fromStatus(projectId, current, 'indexed'))
    return
  }
  emitFor(path, {
    projectId,
    state: 'indexing',
    error: null,
    fileCount: null,
    nodeCount: null,
    languages: []
  })
  const result = await run(bin, ['init', '-i', path], { cwd: path, timeoutMs: 10 * 60_000 })
  if (result.code !== 0) {
    emitFor(path, {
      projectId,
      state: 'error',
      error: (result.stderr || result.stdout || 'Indexing failed').trim().slice(0, 400),
      fileCount: null,
      nodeCount: null,
      languages: []
    })
    return
  }
  const next = await readStatusJson(bin, path)
  emitFor(path, fromStatus(projectId, next, 'indexed'))
}

/** At quit. Killed children fail their jobs, which must not report errors on the way out. */
export function stopCodegraphJobs(): void {
  stopping = true
  jobs.clear()
  for (const child of children) {
    try {
      child.kill('SIGKILL')
    } catch {
      // gone
    }
  }
  children.clear()
}

export function killOrphanCodegraphInits(): void {
  try {
    const out = execFileSync('pgrep', ['-f', 'codegraph.js init'], { encoding: 'utf8' })
    for (const line of out.trim().split('\n')) {
      const pid = Number(line)
      if (!pid) continue
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
  } catch {
    // none running
  }
}

export function queueIndex(projectId: string, path: string | null | undefined): void {
  if (!path || stopping) return
  queuedPath.set(projectId, path)
  if (isUnsafeProjectPath(path)) {
    emit({
      projectId,
      state: 'error',
      error: 'This folder is too large to index. Attach a project directory, not your home folder or a whole disk.',
      fileCount: null,
      nodeCount: null,
      languages: []
    })
    return
  }
  const existing = jobs.get(path)
  emit({
    projectId,
    state: 'indexing',
    error: null,
    fileCount: null,
    nodeCount: null,
    languages: []
  })
  // A job for this folder is running, maybe for another project. It reports to this one too.
  if (existing) return
  const job = runIndex(projectId, path)
    .catch((error: unknown) => {
      emitFor(path, {
        projectId,
        state: 'error',
        error: error instanceof Error ? error.message : 'Indexing failed',
        fileCount: null,
        nodeCount: null,
        languages: []
      })
    })
    .finally(() => {
      jobs.delete(path)
    })
  jobs.set(path, job)
}

function parseStack(packageJson: string): string | null {
  try {
    const pkg = JSON.parse(packageJson) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const known: Record<string, string> = {
      electron: 'Electron',
      next: 'Next.js',
      react: 'React',
      vue: 'Vue',
      svelte: 'Svelte',
      vite: 'Vite',
      express: 'Express',
      fastify: 'Fastify',
      nestjs: 'NestJS',
      tailwindcss: 'Tailwind'
    }
    const hit = Object.entries(known)
      .filter(([name]) => name in deps)
      .map(([, label]) => label)
    if (hit.length === 0) return 'Node.js'
    return [...new Set(hit)].join(' + ')
  } catch {
    return null
  }
}

async function detectStack(root: string): Promise<string | null> {
  const checks: Array<{ file: string; stack: string | ((raw: string) => string | null) }> = [
    { file: 'package.json', stack: parseStack },
    { file: 'Cargo.toml', stack: 'Rust' },
    { file: 'go.mod', stack: 'Go' },
    { file: 'pyproject.toml', stack: 'Python' },
    { file: 'requirements.txt', stack: 'Python' },
    { file: 'Gemfile', stack: 'Ruby' },
    { file: 'composer.json', stack: 'PHP' }
  ]
  for (const check of checks) {
    try {
      const raw = await readFile(join(root, check.file), 'utf8')
      return typeof check.stack === 'function' ? check.stack(raw) : check.stack
    } catch {
      // try next
    }
  }
  return null
}

function firstParagraph(markdown: string): string | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const body: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (body.length > 0) break
      continue
    }
    if (trimmed.startsWith('#')) {
      if (body.length > 0) break
      continue
    }
    body.push(trimmed)
    if (body.join(' ').length > 220) break
  }
  if (body.length === 0) return null
  const text = body.join(' ')
  return text.length > 240 ? `${text.slice(0, 237)}…` : text
}

async function detectSummary(root: string): Promise<{ summary: string | null; rulesFile: string | null }> {
  const files = ['CLAUDE.md', 'AGENTS.md', 'README.md']
  let summary: string | null = null
  let rulesFile: string | null = null
  for (const file of files) {
    try {
      const raw = await readFile(join(root, file), 'utf8')
      if (!summary) summary = firstParagraph(raw)
      if (!rulesFile && file !== 'README.md') rulesFile = file
    } catch {
      // try next
    }
  }
  return { summary, rulesFile }
}

async function filesystemTree(root: string): Promise<string | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const visible = entries
      .filter((entry) => !entry.name.startsWith('.') && !IGNORE.has(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 12)
    const lines: string[] = []
    for (const entry of visible) {
      if (entry.isDirectory()) {
        let children: string[] = []
        try {
          const nested = await readdir(join(root, entry.name), { withFileTypes: true })
          children = nested
            .filter((item) => !item.name.startsWith('.') && !IGNORE.has(item.name))
            .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
            .slice(0, 6)
            .map((item) => item.name + (item.isDirectory() ? '/' : ''))
        } catch {
          children = []
        }
        lines.push(children.length > 0 ? `${entry.name}/    ${children.join(' ')}` : `${entry.name}/`)
      } else {
        lines.push(entry.name)
      }
    }
    return lines.length > 0 ? lines.join('\n') : null
  } catch {
    return null
  }
}

async function indexedTree(bin: string, root: string): Promise<string | null> {
  const result = await run(bin, ['files', '--path', root, '--max-depth', '2', '--no-metadata'], {
    cwd: root,
    timeoutMs: 15_000
  })
  if (result.code !== 0) return null
  const lines = result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith('Project Structure') && !line.startsWith('(node:'))
  return lines.length > 0 ? lines.slice(0, 24).join('\n') : null
}

export async function buildOrientation(project: Project): Promise<OrientationCard> {
  const index = await readIndex(project)
  if (!project.path) {
    return {
      projectId: project.id,
      name: project.name,
      path: null,
      stack: null,
      summary: null,
      rulesFile: null,
      tree: null,
      fileCount: index.fileCount,
      nodeCount: index.nodeCount,
      languages: index.languages,
      state: index.state,
      error: index.error
    }
  }
  try {
    const info = await stat(project.path)
    if (!info.isDirectory()) throw new Error('Project path is not a folder')
  } catch (error) {
    return {
      projectId: project.id,
      name: project.name,
      path: project.path,
      stack: null,
      summary: null,
      rulesFile: null,
      tree: null,
      fileCount: null,
      nodeCount: null,
      languages: [],
      state: 'error',
      error: error instanceof Error ? error.message : 'Folder is missing'
    }
  }
  const bin = await resolveCodegraphBin()
  const [stack, meta, tree] = await Promise.all([
    detectStack(project.path),
    detectSummary(project.path),
    bin && index.state === 'indexed' ? indexedTree(bin, project.path) : filesystemTree(project.path)
  ])
  return {
    projectId: project.id,
    name: project.name,
    path: project.path,
    stack,
    summary: meta.summary,
    rulesFile: meta.rulesFile,
    tree,
    fileCount: index.fileCount,
    nodeCount: index.nodeCount,
    languages: index.languages,
    state: index.state,
    error: index.error
  }
}
