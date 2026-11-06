import { readdir, stat } from 'fs/promises'
import { basename, join, relative, sep } from 'path'
import type { FileHit } from '../shared/types'
import { getChat, listProjects } from './store'

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

const MAX_WALK = 4000
const MAX_HITS = 30
const CACHE_MS = 20_000

type Cache = {
  at: number
  files: FileHit[]
}

const cache = new Map<string, Cache>()
const walking = new Map<string, Promise<FileHit[]>>()

function toHit(root: string, abs: string, kind: FileHit['kind']): FileHit {
  const path = relative(root, abs).split(sep).join('/')
  return { path, name: basename(abs), kind }
}

async function walk(root: string): Promise<FileHit[]> {
  const out: FileHit[] = []
  const queue = [root]
  while (queue.length > 0 && out.length < MAX_WALK) {
    const dir = queue.shift()
    if (!dir) break
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (out.length >= MAX_WALK) break
      if (entry.name.startsWith('.') || IGNORE.has(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        out.push(toHit(root, abs, 'folder'))
        queue.push(abs)
        continue
      }
      if (entry.isFile()) out.push(toHit(root, abs, 'file'))
    }
  }
  return out
}

async function filesFor(root: string): Promise<FileHit[]> {
  const now = Date.now()
  const hit = cache.get(root)
  if (hit && now - hit.at < CACHE_MS) return hit.files
  // One walk per root at a time: keystrokes during a cold walk share it.
  let pending = walking.get(root)
  if (!pending) {
    pending = walk(root)
      .then((files) => {
        cache.set(root, { at: now, files })
        return files
      })
      .finally(() => walking.delete(root))
    walking.set(root, pending)
  }
  return pending
}

function score(item: FileHit, query: string): number {
  const q = query.toLowerCase()
  if (!q) return item.kind === 'folder' ? 2 : 1
  const name = item.name.toLowerCase()
  const path = item.path.toLowerCase()
  if (name === q) return 100
  if (name.startsWith(q)) return 80
  if (name.includes(q)) return 60
  if (path.startsWith(q)) return 50
  if (path.includes(q)) return 40
  let from = 0
  for (const char of q) {
    const next = path.indexOf(char, from)
    if (next === -1) return 0
    from = next + 1
  }
  return 15
}

export async function searchProjectFiles(
  projectId: string,
  query: string,
  chatId?: string
): Promise<FileHit[]> {
  const projects = await listProjects()
  const project = projects.find((item) => item.id === projectId)
  if (!project?.path) return []
  let root = project.path
  if (chatId) {
    try {
      const chat = await getChat(chatId)
      root = chat.worktreePath || project.path
    } catch {
      root = project.path
    }
  }
  try {
    const info = await stat(root)
    if (!info.isDirectory()) return []
  } catch {
    return []
  }
  const files = await filesFor(root)
  const trimmed = query.trim().toLowerCase()
  const ranked = files
    .map((item) => ({ item, points: score(item, trimmed) }))
    .filter((row) => row.points > 0)
    .sort((a, b) => b.points - a.points || a.item.path.localeCompare(b.item.path))
  return ranked.slice(0, MAX_HITS).map((row) => row.item)
}
