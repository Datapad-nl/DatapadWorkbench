import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { isUnsafeProjectPath } from './codegraph'

export type ScanField =
  | 'kind'
  | 'stage'
  | 'frontend'
  | 'backend'
  | 'data'
  | 'platforms'
  | 'constraints'

export type ScanFinding = {
  field: ScanField
  values: string[]
  source: string
}

export type ProjectScan = {
  hasFolder: boolean
  empty: boolean
  summary: string | null
  stackLabel: string | null
  kind: string | null
  packageName: string | null
  scripts: string[]
  tree: string | null
  fileCount: number
  notable: string[]
  readme: string | null
  findings: ScanFinding[]
}

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
  'coverage'
])

const SOURCE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.swift',
  '.kt',
  '.java',
  '.cs',
  '.rb',
  '.php',
  '.vue',
  '.svelte',
  '.css',
  '.html'
])

type Pkg = {
  name?: string
  private?: boolean
  bin?: unknown
  main?: string
  exports?: unknown
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function hasDep(deps: Set<string>, name: string): boolean {
  if (deps.has(name)) return true
  const prefix = `${name}/`
  for (const item of deps) {
    if (item.startsWith(prefix)) return true
  }
  return false
}

function anyDep(deps: Set<string>, names: string[]): boolean {
  return names.some((name) => hasDep(deps, name))
}

async function readText(root: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(root, rel), 'utf8')
  } catch {
    return null
  }
}

async function readJsonFile<T>(root: string, rel: string): Promise<T | null> {
  const raw = await readText(root, rel)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
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

function collectDeps(pkg: Pkg | null): Set<string> {
  if (!pkg) return new Set()
  return new Set(
    [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {})
    ].map((name) => name.toLowerCase())
  )
}

async function listRoot(root: string): Promise<{ dirs: Set<string>; files: Set<string> }> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const dirs = new Set<string>()
    const files = new Set<string>()
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.add(entry.name)
      else if (entry.isFile()) files.add(entry.name)
    }
    return { dirs, files }
  } catch {
    return { dirs: new Set(), files: new Set() }
  }
}

async function countSources(root: string): Promise<{ files: number; tests: boolean; ci: boolean }> {
  let files = 0
  let tests = false
  let ci = false
  const queue = [root]
  let visited = 0
  while (queue.length > 0 && visited < 800 && files < 200) {
    const dir = queue.shift()
    if (!dir) break
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    visited += 1
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      if (IGNORE.has(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.github' || entry.name === 'workflows') ci = true
        if (entry.name === 'test' || entry.name === 'tests' || entry.name === '__tests__') tests = true
        queue.push(abs)
        continue
      }
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (lower.includes('.test.') || lower.includes('.spec.') || lower.endsWith('_test.go')) tests = true
      if (lower.endsWith('.yml') && dir.includes('.github')) ci = true
      const dot = lower.lastIndexOf('.')
      const ext = dot >= 0 ? lower.slice(dot) : ''
      if (SOURCE_EXT.has(ext)) files += 1
    }
  }
  return { files, tests, ci }
}

async function nestedPackageJsons(root: string, dirs: Set<string>): Promise<Pkg[]> {
  const extra: Pkg[] = []
  const buckets = ['apps', 'packages', 'src']
  for (const bucket of buckets) {
    if (!dirs.has(bucket)) continue
    let children
    try {
      children = await readdir(join(root, bucket), { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children.slice(0, 12)) {
      if (!child.isDirectory()) continue
      const pkg = await readJsonFile<Pkg>(root, join(bucket, child.name, 'package.json'))
      if (pkg) extra.push(pkg)
    }
  }
  return extra
}

function frontendFromDeps(deps: Set<string>, files: Set<string>, dirs: Set<string>): string[] {
  const found: string[] = []
  const add = (label: string): void => {
    if (!found.includes(label)) found.push(label)
  }
  if (anyDep(deps, ['next'])) add('Next.js')
  if (anyDep(deps, ['react']) && !anyDep(deps, ['react-native'])) add('React')
  if (anyDep(deps, ['vue', 'nuxt'])) add('Vue')
  if (anyDep(deps, ['svelte', '@sveltejs/kit'])) add('Svelte / SvelteKit')
  if (anyDep(deps, ['@angular/core', '@angular/common'])) add('Angular')
  if (anyDep(deps, ['react-native', 'expo'])) add('React Native / Expo')
  if (anyDep(deps, ['electron', 'electron-vite'])) add('Electron / desktop webview')
  if (
    dirs.has('ios') ||
    [...files, ...dirs].some((name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'))
  ) {
    add('Native iOS (Swift)')
  }
  if (dirs.has('android') || files.has('build.gradle') || files.has('settings.gradle')) {
    add('Native Android (Kotlin)')
  }
  if (found.length === 0 && (files.has('index.html') || files.has('index.htm'))) {
    add('HTML/CSS, no framework')
  }
  return found
}

function backendFrom(
  deps: Set<string>,
  files: Set<string>,
  manifests: { cargo: boolean; go: boolean; python: boolean; ruby: boolean; php: boolean; dotnet: boolean }
): string[] {
  const found: string[] = []
  const add = (label: string): void => {
    if (!found.includes(label)) found.push(label)
  }
  const node =
    files.has('package.json') ||
    files.has('tsconfig.json') ||
    anyDep(deps, ['express', 'fastify', '@nestjs/core', 'hono', 'koa', 'graphql'])
  if (node) add('Node.js / TypeScript')
  if (manifests.python) add('Python')
  if (manifests.go) add('Go')
  if (manifests.cargo) add('Rust')
  if (manifests.ruby) add('Ruby')
  if (manifests.php) add('PHP')
  if (manifests.dotnet) add('C# / .NET')
  if (dirsHasJava(files)) add('Java / Kotlin')
  return found
}

function dirsHasJava(files: Set<string>): boolean {
  return files.has('pom.xml') || files.has('build.gradle') || files.has('build.gradle.kts')
}

function dataFromDeps(deps: Set<string>, prisma: string | null, envSample: string | null): string[] {
  const found: string[] = []
  const add = (label: string): void => {
    if (!found.includes(label)) found.push(label)
  }
  const blob = `${prisma ?? ''}\n${envSample ?? ''}`.toLowerCase()
  if (anyDep(deps, ['pg', 'postgres', '@vercel/postgres']) || blob.includes('postgresql') || blob.includes('postgres')) {
    add('Postgres')
  }
  if (
    anyDep(deps, ['better-sqlite3', 'sqlite3', 'sql.js']) ||
    blob.includes('sqlite')
  ) {
    add('SQLite')
  }
  if (anyDep(deps, ['mysql2', 'mysql', 'mariadb']) || blob.includes('mysql') || blob.includes('mariadb')) {
    add('MySQL / MariaDB')
  }
  if (anyDep(deps, ['mongoose', 'mongodb']) || blob.includes('mongodb')) add('MongoDB')
  if (anyDep(deps, ['ioredis', 'redis']) || blob.includes('redis')) add('Redis')
  if (anyDep(deps, ['@supabase/supabase-js', '@supabase/ssr']) || blob.includes('supabase')) add('Supabase')
  if (anyDep(deps, ['firebase', 'firebase-admin']) || blob.includes('firebase')) add('Firebase')
  return found
}

function platformsFrom(input: {
  kind: string | null
  frontend: string[]
  hasBin: boolean
  hasServer: boolean
}): string[] {
  const { kind, frontend, hasBin, hasServer } = input
  const found: string[] = ['Local development']
  const add = (label: string): void => {
    if (!found.includes(label)) found.push(label)
  }
  if (kind === 'Web app' || frontend.includes('Next.js')) add('Web (browser)')
  if (kind === 'Desktop app' || frontend.includes('Electron / desktop webview')) {
    add('Desktop (macOS / Windows / Linux)')
  }
  if (kind === 'Native mobile app' || frontend.includes('React Native / Expo')) {
    add('iOS')
    add('Android')
  }
  if (frontend.includes('Native iOS (Swift)')) add('iOS')
  if (frontend.includes('Native Android (Kotlin)')) add('Android')
  if (kind === 'API / backend service' || hasServer) add('Server / API')
  if (kind === 'CLI / developer tool' || hasBin) add('CLI')
  return found
}

function kindFrom(input: {
  deps: Set<string>
  frontend: string[]
  backend: string[]
  hasBin: boolean
  hasLibShape: boolean
  files: Set<string>
}): string | null {
  const { deps, frontend, backend, hasBin, hasLibShape, files } = input
  if (frontend.includes('Electron / desktop webview') || anyDep(deps, ['electron'])) return 'Desktop app'
  if (
    frontend.includes('React Native / Expo') ||
    frontend.includes('Native iOS (Swift)') ||
    frontend.includes('Native Android (Kotlin)') ||
    files.has('pubspec.yaml')
  ) {
    return 'Native mobile app'
  }
  if (anyDep(deps, ['three', 'phaser', 'babylonjs']) || files.has('project.godot')) return 'Game'
  if (
    frontend.includes('Next.js') ||
    frontend.includes('React') ||
    frontend.includes('Vue') ||
    frontend.includes('Svelte / SvelteKit') ||
    frontend.includes('Angular') ||
    frontend.includes('HTML/CSS, no framework')
  ) {
    return 'Web app'
  }
  if (hasBin && frontend.length === 0) return 'CLI / developer tool'
  if (hasLibShape && frontend.length === 0 && !hasBin) return 'Library / SDK'
  if (backend.length > 0 && frontend.length === 0) return 'API / backend service'
  return null
}

function finding(field: ScanField, values: string[], source: string): ScanFinding | null {
  const unique = [...new Set(values.map((item) => item.trim()).filter(Boolean))]
  if (unique.length === 0) return null
  return { field, values: unique, source }
}

export async function scanProject(path: string | null): Promise<ProjectScan> {
  const emptyScan = (): ProjectScan => ({
    hasFolder: false,
    empty: false,
    summary: null,
    stackLabel: null,
    kind: null,
    packageName: null,
    scripts: [],
    tree: null,
    fileCount: 0,
    notable: [],
    readme: null,
    findings: []
  })
  if (!path || isUnsafeProjectPath(path)) return emptyScan()
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return emptyScan()
  } catch {
    return emptyScan()
  }

  const { dirs, files } = await listRoot(path)
  const pkg = await readJsonFile<Pkg>(path, 'package.json')
  const nested = await nestedPackageJsons(path, dirs)
  const deps = collectDeps(pkg)
  for (const item of nested) {
    for (const name of collectDeps(item)) deps.add(name)
  }

  const cargo = await readText(path, 'Cargo.toml')
  const goMod = await readText(path, 'go.mod')
  const pyproject = await readText(path, 'pyproject.toml')
  const requirements = await readText(path, 'requirements.txt')
  const gemfile = await readText(path, 'Gemfile')
  const composer = await readText(path, 'composer.json')
  const prisma = (await readText(path, 'prisma/schema.prisma')) ?? (await readText(path, 'schema.prisma'))
  const envSample =
    (await readText(path, '.env.example')) ??
    (await readText(path, '.env.sample')) ??
    (await readText(path, '.env.template'))
  let summary: string | null = null
  let readme: string | null = null
  for (const doc of ['README.md', 'AGENTS.md', 'CLAUDE.md']) {
    const raw = await readText(path, doc)
    if (!raw) continue
    if (!readme) readme = raw.replace(/\r\n/g, '\n').slice(0, 1200)
    if (!summary) summary = firstParagraph(raw)
  }

  const counts = await countSources(path)
  const empty = counts.files === 0 && !pkg && !cargo && !goMod && !pyproject
  const hasBin = Boolean(pkg?.bin) || Boolean(cargo && /\[\[bin\]\]/.test(cargo))
  const hasLibShape = Boolean(pkg?.exports || (pkg?.main && !pkg.bin && pkg.private !== true))
  const typed = files.has('tsconfig.json') || anyDep(deps, ['typescript'])

  const frontend = frontendFromDeps(deps, files, dirs)
  const backend = backendFrom(deps, files, {
    cargo: cargo !== null,
    go: goMod !== null,
    python: pyproject !== null || requirements !== null || files.has('Pipfile'),
    ruby: gemfile !== null,
    php: composer !== null,
    dotnet: [...files].some((name) => name.endsWith('.csproj') || name.endsWith('.sln'))
  })
  if (frontend.includes('Electron / desktop webview') && !backend.includes('Node.js / TypeScript')) {
    backend.unshift('Node.js / TypeScript')
  }

  const data = dataFromDeps(deps, prisma, envSample)
  const kind = kindFrom({ deps, frontend, backend, hasBin, hasLibShape, files })
  const hasServer = anyDep(deps, ['express', 'fastify', '@nestjs/core', 'hono', 'koa'])
  const platforms =
    kind || frontend.length || backend.length
      ? platformsFrom({ kind, frontend, hasBin, hasServer })
      : []

  const findings: ScanFinding[] = []
  const push = (item: ScanFinding | null): void => {
    if (item) findings.push(item)
  }

  push(finding('kind', kind ? [kind] : [], 'project manifests and folders'))
  push(finding('frontend', frontend, 'package.json and project files'))
  push(finding('backend', backend, 'language manifests'))
  push(finding('data', data, 'dependencies and schema files'))
  push(finding('platforms', platforms, 'detected product and stack'))

  if (empty) {
    push(finding('stage', ['Empty folder / not started'], 'no source files in the folder'))
    push(finding('constraints', ['Greenfield — pick sensible defaults'], 'empty project folder'))
  } else if (counts.files > 0 && counts.files < 12 && !counts.ci) {
    push(finding('stage', ['Early prototype'], `${counts.files} source files, no CI`))
  }

  if (!empty) {
    const constraints: string[] = ['Must match the existing stack in the repo']
    if (typed) constraints.push('Stay typed (TypeScript / types)')
    push(finding('constraints', constraints, 'existing repository'))
  }

  const stackParts = [...frontend, ...backend.filter((item) => !frontend.includes(item))]
  const stackLabel = stackParts.length > 0 ? stackParts.slice(0, 4).join(' + ') : kind
  const notableKnown = [
    'electron',
    'next',
    'react',
    'vue',
    'svelte',
    'express',
    'prisma',
    'drizzle-orm',
    'tailwindcss',
    'stripe',
    'supabase',
    'firebase',
    'graphql',
    'trpc',
    '@trpc/server',
    'openai',
    'playwright',
    'vitest',
    'jest'
  ]
  const notable = notableKnown.filter((name) => hasDep(deps, name))
  const tree = [...dirs]
    .sort()
    .slice(0, 16)
    .map((name) => `${name}/`)
    .concat([...files].sort().slice(0, 16))
    .join('\n')

  return {
    hasFolder: true,
    empty,
    summary,
    stackLabel,
    kind,
    packageName: pkg?.name?.trim() || null,
    scripts: Object.keys(pkg?.scripts ?? {}).slice(0, 12),
    tree: tree || null,
    fileCount: counts.files,
    notable,
    readme,
    findings: findings.filter((item) => item.values.length > 0)
  }
}
