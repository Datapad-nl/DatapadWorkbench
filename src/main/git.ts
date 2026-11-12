import { execFile } from 'child_process'
import { watch, type FSWatcher } from 'fs'
import { mkdir, readFile, rm, stat } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { BrowserWindow } from 'electron'
import type {
  Chat,
  GitActionResult,
  GitChangeKind,
  GitDiffResult,
  GitFile,
  GitGraphNode,
  GitReason,
  GitSnapshot,
  GitSummary,
  PermissionMode
} from '../shared/types'
import { relPath } from './checkpoints'
import { withRepoLock } from './gitLock'
import { getChat, listProjects } from './store'
import { killProcessesUnder } from './worktreeProcs'

const GRAPH_LIMIT = 80
const MAX_DIFF_CHARS = 200_000
const WATCH_MS = 800
const IGNORE_SEGMENTS = new Set([
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
  '.cache',
  '.output',
  '.nuxt',
  '.svelte-kit',
  '.vercel',
  '.netlify',
  'objects',
  'logs'
])

function noisyWatchPath(filename: string | Buffer | null | undefined): boolean {
  if (filename == null) return false
  const rel = String(filename)
  if (rel.endsWith('.lock') || rel.endsWith('.swp') || rel.endsWith('~')) return true
  return rel.split(/[/\\]/).some((part) => IGNORE_SEGMENTS.has(part))
}

type RunResult = { code: number; stdout: string; stderr: string }

const gitWatchers = new Map<string, { watcher: FSWatcher; cwd: string }>()
const worktreeWatchers = new Map<string, FSWatcher>()
const pending = new Map<string, ReturnType<typeof setTimeout>>()
const runningBroadcast = new Set<string>()
const rerunBroadcast = new Set<string>()
let activeWatch: { projectId: string; chatId: string | null } | null = null
let activeGen = 0
let syncChain: Promise<void> = Promise.resolve()
let resyncTimer: ReturnType<typeof setTimeout> | null = null

function runGit(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolveResult) => {
    execFile(
      'git',
      args,
      { cwd, env: process.env, timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolveResult({ code: 0, stdout, stderr })
          return
        }
        const code =
          typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
        resolveResult({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

type MergeGuard = (projectId: string, chatId: string) => string | null | Promise<string | null>
let mergeGuard: MergeGuard = () => null

/** The chat layer imports this file, so it hands its check in. The guard says why a merge must wait, or null. */
export function setMergeGuard(guard: MergeGuard): void {
  mergeGuard = guard
}

export function chatWorkingDir(
  chat: Pick<Chat, 'worktreePath'>,
  projectPath: string | null | undefined
): string | null {
  return chat.worktreePath || projectPath || null
}

function shortChatId(chatId: string): string {
  return chatId.replace(/-/g, '').slice(0, 8)
}

export async function addChatWorktree(
  projectPath: string,
  chatId: string
): Promise<{ path: string; branch: string }> {
  const inside = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw new Error('Project is not a git repository')
  }
  const branch = `workbench/${shortChatId(chatId)}`
  const dest = join(
    dirname(projectPath),
    '.workbench-worktrees',
    `${basename(projectPath)}-${shortChatId(chatId)}`
  )
  await mkdir(dirname(dest), { recursive: true })
  await withRepoLock(projectPath, async () => {
    const created = await runGit(projectPath, ['worktree', 'add', '-b', branch, dest])
    if (created.code !== 0) {
      const reused = await runGit(projectPath, ['worktree', 'add', dest, branch])
      if (reused.code !== 0) {
        throw new Error(reused.stderr.trim() || created.stderr.trim() || 'Could not create worktree')
      }
    }
  })
  return { path: dest, branch }
}

/** Resolves false when the worktree is still on disk, for example because it has uncommitted files. */
export async function removeChatWorktree(projectPath: string, worktreePath: string): Promise<boolean> {
  return withRepoLock(projectPath, () => removeWorktreeLocked(projectPath, worktreePath))
}

/** The caller holds the repository lock. */
async function removeWorktreeLocked(projectPath: string, worktreePath: string): Promise<boolean> {
  await killProcessesUnder(worktreePath)
  // Without --force, git keeps a worktree that has uncommitted or untracked files.
  const removed = await runGit(projectPath, ['worktree', 'remove', worktreePath])
  if (removed.code === 0) return true
  await runGit(projectPath, ['worktree', 'prune'])
  const left = await stat(worktreePath).then(
    () => true,
    () => false
  )
  if (left) console.error('worktree remove', worktreePath, removed.stderr.trim())
  return !left
}

/** Remove a chat's worktree and branch when it has no uncommitted files and no commits of its own. */
export async function dropWorktreeIfUnchanged(
  projectPath: string,
  worktreePath: string,
  branch: string
): Promise<boolean> {
  // Locked from the checks on, so nothing commits to the branch between "unchanged" and the delete.
  return withRepoLock(projectPath, async () => {
    const status = await runGit(worktreePath, ['status', '--porcelain'])
    if (status.code !== 0 || status.stdout.trim()) return false
    const ahead = await runGit(projectPath, ['rev-list', '--count', `HEAD..${branch}`])
    if (ahead.code !== 0 || ahead.stdout.trim() !== '0') return false
    if (!(await removeWorktreeLocked(projectPath, worktreePath))) return false
    // The worktree is gone either way, so the caller still clears the chat's worktree fields.
    const deleted = await runGit(projectPath, ['branch', '-d', branch])
    if (deleted.code !== 0) console.error('branch delete', branch, deleted.stderr.trim())
    return true
  })
}

/** Which of `paths` (relative to the repository folder) have uncommitted changes, new files included. */
export async function uncommittedPaths(projectPath: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  const status = await runGit(projectPath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    ...paths
  ])
  if (status.code !== 0) return []
  // Git names files from the top of the repository, which may sit above the project folder.
  const prefix = (await runGit(projectPath, ['rev-parse', '--show-prefix'])).stdout.trim()
  const changed = new Set<string>()
  const entries = status.stdout.split('\0')
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry.length < 4) continue
    changed.add(entry.slice(3))
    // A rename or copy is followed by the path it came from.
    if (/[RC]/.test(entry.slice(0, 2))) index++
  }
  return paths.filter((path) => changed.has(prefix + path))
}

const SPIKE_RE =
  /\b(spike|prototype|experiment|try (a|this|out)|don't touch main|leave main|feature branch|isolated|worktree|sandbox)\b/i

/**
 * A chat gets its own worktree only when the prompt asks for an experiment, or another chat is
 * at work in the project folder right now. Idle chats and chats in their own worktrees leave the
 * folder alone, so they are no reason to move out of it.
 */
export async function isolateChatIfNeeded(
  chat: Chat,
  projectPath: string | null | undefined,
  prompt: string,
  siblings: { streaming: boolean }
): Promise<{ chat: Chat; reason: string | null }> {
  if (chat.worktreePath || !projectPath) return { chat, reason: null }
  const mode = chat.mode as PermissionMode | undefined
  if (mode === 'ask' || mode === 'plan') return { chat, reason: null }
  const inside = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { chat, reason: null }

  let reason: string | null = null
  if (SPIKE_RE.test(prompt)) {
    reason = 'This looks like an experiment — using a separate worktree.'
  } else if (siblings.streaming) {
    reason = 'Another chat is already working in this project — isolating so files do not collide.'
  }

  if (!reason) return { chat, reason: null }
  try {
    const worktree = await addChatWorktree(projectPath, chat.id)
    chat.worktreePath = worktree.path
    chat.worktreeBranch = worktree.branch
    return { chat, reason }
  } catch {
    return { chat, reason: null }
  }
}

function emptySnapshot(
  projectId: string | null,
  path: string | null,
  reason: GitReason,
  error: string | null,
  chatId: string | null = null
): GitSnapshot {
  return {
    projectId,
    chatId,
    path,
    available: false,
    reason,
    error,
    branch: null,
    detached: false,
    ahead: 0,
    behind: 0,
    dirtyCount: 0,
    files: [],
    graph: [],
    merge: null
  }
}

function emitGit(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function kindFrom(code: string): GitChangeKind | null {
  if (!code || code === ' ') return null
  if (code === 'U' || code === 'A' || code === 'D') {
    /* conflict letters handled by pair */
  }
  if (code === '?') return 'untracked'
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R') return 'renamed'
  if (code === 'C') return 'copied'
  if (code === 'M' || code === 'T') return 'modified'
  if (code === 'U') return 'conflict'
  return 'modified'
}

function pairKind(x: string, y: string, side: 'index' | 'work'): GitChangeKind | null {
  const pair = `${x}${y}`
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(pair)) return 'conflict'
  return kindFrom(side === 'index' ? x : y)
}

function parseBranchLine(line: string): {
  branch: string | null
  detached: boolean
  ahead: number
  behind: number
} {
  const raw = line.replace(/^##\s+/, '')
  if (!raw || raw.startsWith('No commits yet')) {
    const match = /No commits yet on (.+)$/.exec(raw)
    return { branch: match?.[1] ?? null, detached: false, ahead: 0, behind: 0 }
  }
  if (raw.startsWith('HEAD (no branch)')) {
    return { branch: null, detached: true, ahead: 0, behind: 0 }
  }
  const ahead = Number(/\[ahead (\d+)/.exec(raw)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(raw)?.[1] ?? 0)
  const name = raw.split('...')[0]?.trim() || null
  return { branch: name, detached: false, ahead, behind }
}

function parseStatus(stdout: string): {
  branch: string | null
  detached: boolean
  ahead: number
  behind: number
  files: GitFile[]
} {
  const parts = stdout.split('\0')
  let branch = parseBranchLine('')
  const files: GitFile[] = []
  let i = 0
  if (parts[0]?.startsWith('## ')) {
    branch = parseBranchLine(parts[0])
    i = 1
  }
  while (i < parts.length) {
    const entry = parts[i]
    if (!entry) {
      i += 1
      continue
    }
    if (entry.length < 3) {
      i += 1
      continue
    }
    const x = entry[0]
    const y = entry[1]
    const firstPath = entry.slice(3)
    const renamed = x === 'R' || x === 'C' || y === 'R' || y === 'C'
    let path = firstPath
    let oldPath: string | null = null
    if (renamed && parts[i + 1]) {
      oldPath = firstPath
      path = parts[i + 1]
      i += 1
    }
    if (path) {
      const staged = x === '?' ? null : pairKind(x, y, 'index')
      const unstaged = pairKind(x, y, 'work')
      files.push({ path, oldPath, staged, unstaged })
    }
    i += 1
  }
  files.sort((a, b) => {
    const rank = (file: GitFile): number => {
      if (file.staged === 'conflict' || file.unstaged === 'conflict') return 0
      if (file.unstaged) return 1
      if (file.staged) return 2
      return 3
    }
    const delta = rank(a) - rank(b)
    return delta !== 0 ? delta : a.path.localeCompare(b.path)
  })
  return { ...branch, files }
}

function layoutGraph(
  commits: Array<Omit<GitGraphNode, 'lane' | 'openLanes' | 'isHead'>>,
  head: string | null
): GitGraphNode[] {
  const lanes: (string | null)[] = []
  const nodes: GitGraphNode[] = []
  for (const commit of commits) {
    let lane = lanes.indexOf(commit.sha)
    if (lane < 0) {
      lane = lanes.findIndex((slot) => slot === null)
      if (lane < 0) {
        lanes.push(commit.sha)
        lane = lanes.length - 1
      } else {
        lanes[lane] = commit.sha
      }
    }
    const [first, ...rest] = commit.parents
    lanes[lane] = first ?? null
    for (const parent of rest) {
      if (lanes.includes(parent)) continue
      const free = lanes.findIndex((slot) => slot === null)
      if (free < 0) lanes.push(parent)
      else lanes[free] = parent
    }
    const openLanes = lanes
      .map((slot, index) => (slot ? index : -1))
      .filter((index) => index >= 0)
    nodes.push({
      ...commit,
      lane,
      openLanes,
      isHead: Boolean(head && commit.sha === head)
    })
  }
  return nodes
}

async function readGraph(cwd: string, head: string | null): Promise<GitGraphNode[]> {
  const log = await runGit(cwd, [
    'log',
    '--all',
    '--topo-order',
    `--pretty=format:%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%aI%x1f%D%x1e`,
    '-n',
    String(GRAPH_LIMIT)
  ])
  if (log.code !== 0 || !log.stdout.trim()) return []
  const commits: Array<Omit<GitGraphNode, 'lane' | 'openLanes' | 'isHead'>> = []
  for (const record of log.stdout.split('\x1e')) {
    const trimmed = record.trim()
    if (!trimmed) continue
    const [sha, shortSha, parents, subject, author, date, decorate] = trimmed.split('\x1f')
    if (!sha) continue
    const refs = (decorate ?? '')
      .split(',')
      .map((item) => item.trim().replace(/^HEAD\s*->\s*/, '').replace(/^tag:\s*/, ''))
      .filter((item) => item && item !== 'HEAD')
    commits.push({
      sha,
      shortSha: shortSha || sha.slice(0, 7),
      subject: subject || '(no subject)',
      author: author || '',
      date: date || '',
      refs,
      parents: (parents ?? '').split(' ').filter(Boolean)
    })
  }
  return layoutGraph(commits, head)
}

async function resolveRepo(
  projectId: string,
  chatId?: string | null
): Promise<
  | { id: string; path: string; chatId: string | null; projectPath: string | null; worktreeBranch: string | null }
  | { snapshot: GitSnapshot }
> {
  const projects = await listProjects()
  const project = projects.find((item) => item.id === projectId)
  if (!project) return { snapshot: emptySnapshot(projectId, null, 'error', 'Project not found', null) }
  let cwd = project.path
  let resolvedChatId: string | null = null
  let worktreeBranch: string | null = null
  if (chatId) {
    try {
      const chat = await getChat(chatId)
      if (chat.projectId === projectId) {
        cwd = chatWorkingDir(chat, project.path)
        resolvedChatId = chatId
        if (chat.worktreePath) worktreeBranch = chat.worktreeBranch ?? null
      }
    } catch {
      cwd = project.path
    }
  }
  if (!cwd) return { snapshot: emptySnapshot(projectId, null, 'no-folder', null, resolvedChatId) }
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { snapshot: emptySnapshot(projectId, cwd, 'not-a-repo', null, resolvedChatId) }
  }
  return { id: project.id, path: cwd, chatId: resolvedChatId, projectPath: project.path, worktreeBranch }
}

/** Where a worktree chat's branch would merge to, and how many of its commits are not there yet. */
async function readMergeTarget(
  projectPath: string | null,
  branch: string | null
): Promise<GitSnapshot['merge']> {
  if (!projectPath || !branch) return null
  const head = await runGit(projectPath, ['symbolic-ref', '--short', '-q', 'HEAD'])
  const into = head.stdout.trim()
  if (head.code !== 0 || !into || into === branch) return null
  const count = await runGit(projectPath, ['rev-list', '--count', `${into}..${branch}`])
  if (count.code !== 0) return null
  return { into, commits: Number(count.stdout.trim()) || 0 }
}

export async function getGitSnapshot(projectId: string, chatId?: string | null): Promise<GitSnapshot> {
  const repo = await resolveRepo(projectId, chatId)
  if ('snapshot' in repo) return repo.snapshot
  const status = await runGit(repo.path, ['status', '--porcelain=v1', '-b', '-z'])
  if (status.code !== 0) {
    return emptySnapshot(projectId, repo.path, 'error', status.stderr.trim() || 'git status failed', repo.chatId)
  }
  const parsed = parseStatus(status.stdout)
  const head = await runGit(repo.path, ['rev-parse', 'HEAD'])
  const graph = await readGraph(repo.path, head.code === 0 ? head.stdout.trim() : null)
  return {
    projectId,
    chatId: repo.chatId,
    path: repo.path,
    available: true,
    reason: 'ok',
    error: null,
    branch: parsed.branch,
    detached: parsed.detached,
    ahead: parsed.ahead,
    behind: parsed.behind,
    dirtyCount: parsed.files.length,
    files: parsed.files,
    graph,
    merge: await readMergeTarget(repo.projectPath, repo.worktreeBranch)
  }
}

export async function getGitSummaries(): Promise<Record<string, GitSummary>> {
  const projects = await listProjects()
  const entries = await Promise.all(
    projects.map(async (project) => {
      if (!project.path) {
        return [project.id, { projectId: project.id, available: false, branch: null, dirtyCount: 0 }] as const
      }
      const status = await runGit(project.path, ['status', '--porcelain=v1', '-b', '-z'])
      if (status.code !== 0) {
        return [project.id, { projectId: project.id, available: false, branch: null, dirtyCount: 0 }] as const
      }
      const parsed = parseStatus(status.stdout)
      return [
        project.id,
        {
          projectId: project.id,
          available: true,
          branch: parsed.branch,
          dirtyCount: parsed.files.length
        }
      ] as const
    })
  )
  return Object.fromEntries(entries)
}

function guardedPath(cwd: string, raw: string): string {
  const rel = relPath(cwd, raw)
  if (!rel) throw new Error('Invalid path')
  return rel
}

async function afterAction(
  projectId: string,
  result: RunResult,
  chatId?: string | null
): Promise<GitActionResult> {
  const snapshot = await getGitSnapshot(projectId, chatId)
  if (result.code !== 0) {
    return { ok: false, error: result.stderr.trim() || result.stdout.trim() || 'git failed', snapshot }
  }
  void broadcastGit(projectId, chatId)
  return { ok: true, error: null, snapshot }
}

export async function stageGitPath(
  projectId: string,
  path: string,
  chatId?: string | null
): Promise<GitActionResult> {
  const repo = await resolveRepo(projectId, chatId)
  if ('snapshot' in repo) return { ok: false, error: repo.snapshot.error, snapshot: repo.snapshot }
  const rel = guardedPath(repo.path, path)
  const result = await withRepoLock(repo.path, () => runGit(repo.path, ['add', '--', rel]))
  return afterAction(projectId, result, chatId)
}

export async function unstageGitPath(
  projectId: string,
  path: string,
  chatId?: string | null
): Promise<GitActionResult> {
  const repo = await resolveRepo(projectId, chatId)
  if ('snapshot' in repo) return { ok: false, error: repo.snapshot.error, snapshot: repo.snapshot }
  const rel = guardedPath(repo.path, path)
  const result = await withRepoLock(repo.path, () => runGit(repo.path, ['restore', '--staged', '--', rel]))
  return afterAction(projectId, result, chatId)
}

export async function discardGitPath(
  projectId: string,
  path: string,
  chatId?: string | null
): Promise<GitActionResult> {
  const repo = await resolveRepo(projectId, chatId)
  if ('snapshot' in repo) return { ok: false, error: repo.snapshot.error, snapshot: repo.snapshot }
  const rel = guardedPath(repo.path, path)
  // Locked from the status read on, so the file is discarded in the state it was read in.
  const result = await withRepoLock(repo.path, async (): Promise<RunResult> => {
    const snapshot = await getGitSnapshot(projectId, chatId)
    const file = snapshot.files.find((item) => item.path === rel)
    if (file?.unstaged === 'untracked' && !file.staged) {
      await rm(resolve(repo.path, rel), { recursive: true, force: true })
      return { code: 0, stdout: '', stderr: '' }
    }
    const restore = await runGit(repo.path, ['restore', '--staged', '--worktree', '--', rel])
    if (restore.code !== 0 && file?.staged === 'added') {
      await runGit(repo.path, ['restore', '--staged', '--', rel])
      await rm(resolve(repo.path, rel), { recursive: true, force: true })
      return { code: 0, stdout: '', stderr: '' }
    }
    return restore
  })
  return afterAction(projectId, result, chatId)
}

export async function commitGit(
  projectId: string,
  message: string,
  chatId?: string | null
): Promise<GitActionResult> {
  const repo = await resolveRepo(projectId, chatId)
  if ('snapshot' in repo) return { ok: false, error: repo.snapshot.error, snapshot: repo.snapshot }
  const text = message.trim()
  if (!text) {
    const snapshot = await getGitSnapshot(projectId, chatId)
    return { ok: false, error: 'Commit message is empty', snapshot }
  }
  const result = await withRepoLock(repo.path, () => runGit(repo.path, ['commit', '-m', text]))
  return afterAction(projectId, result, chatId)
}

export async function checkoutGit(
  projectId: string,
  ref: string,
  chatId?: string | null
): Promise<GitActionResult> {
  const repo = await resolveRepo(projectId, chatId)
  if ('snapshot' in repo) return { ok: false, error: repo.snapshot.error, snapshot: repo.snapshot }
  const target = ref.trim()
  if (!target || target.startsWith('-')) {
    const snapshot = await getGitSnapshot(projectId, chatId)
    return { ok: false, error: 'Invalid ref', snapshot }
  }
  const result = await withRepoLock(repo.path, () => runGit(repo.path, ['checkout', target]))
  return afterAction(projectId, result, chatId)
}

export async function createGitBranch(
  projectId: string,
  name: string,
  chatId?: string | null
): Promise<GitActionResult> {
  const repo = await resolveRepo(projectId, chatId)
  if ('snapshot' in repo) return { ok: false, error: repo.snapshot.error, snapshot: repo.snapshot }
  const branch = name.trim()
  if (!branch) {
    const snapshot = await getGitSnapshot(projectId, chatId)
    return { ok: false, error: 'Branch name is empty', snapshot }
  }
  const check = await runGit(repo.path, ['check-ref-format', '--branch', branch])
  if (check.code !== 0) {
    const snapshot = await getGitSnapshot(projectId, chatId)
    return { ok: false, error: 'Invalid branch name', snapshot }
  }
  const created = await withRepoLock(repo.path, () => runGit(repo.path, ['checkout', '-b', branch]))
  return afterAction(projectId, created, chatId)
}

/**
 * Merges a worktree chat's branch into the branch the project folder has checked out.
 * Stops without changing anything when either side has uncommitted work or the merge conflicts.
 */
export async function mergeChatBranch(projectId: string, chatId: string): Promise<GitActionResult> {
  const repo = await resolveRepo(projectId, chatId)
  if ('snapshot' in repo) return { ok: false, error: repo.snapshot.error, snapshot: repo.snapshot }
  const fail = async (error: string): Promise<GitActionResult> => ({
    ok: false,
    error,
    snapshot: await getGitSnapshot(projectId, chatId)
  })
  // Locked from the checks on, so no other git write from this app lands between them and the merge.
  return withRepoLock(repo.path, async () => {
    const target = await readMergeTarget(repo.projectPath, repo.worktreeBranch)
    if (!repo.projectPath || !repo.worktreeBranch || !target) {
      return fail('The project folder is not on a branch this chat can merge into')
    }
    if (target.commits === 0) return fail(`Nothing to merge: ${target.into} already has these commits`)
    const own = await runGit(repo.path, ['status', '--porcelain'])
    if (own.stdout.trim()) return fail('Commit or discard the chat’s changes first')
    const main = await runGit(repo.projectPath, ['status', '--porcelain', '--untracked-files=no'])
    if (main.stdout.trim()) {
      return fail(`The project folder has uncommitted changes on ${target.into}. Commit or stash them first.`)
    }
    const blocked = await mergeGuard(projectId, chatId)
    if (blocked) return fail(blocked)
    const merged = await runGit(repo.projectPath, ['merge', '--no-edit', repo.worktreeBranch])
    if (merged.code !== 0) {
      const merging = await runGit(repo.projectPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
      if (merging.code !== 0) return fail(merged.stderr.trim() || `Could not merge into ${target.into}`)
      await runGit(repo.projectPath, ['merge', '--abort'])
      return fail(
        `Merging into ${target.into} conflicts, so nothing changed. Ask the chat to merge ${target.into} into its branch and resolve the conflicts, then try again.`
      )
    }
    void broadcastGit(projectId, null)
    return afterAction(projectId, merged, chatId)
  })
}

async function readGitBlob(cwd: string, spec: string): Promise<string> {
  const shown = await runGit(cwd, ['show', spec])
  if (shown.code !== 0) return ''
  return shown.stdout
}

function clip(text: string): string {
  if (text.includes('\0')) return '(binary file)'
  if (text.length > MAX_DIFF_CHARS) return `${text.slice(0, MAX_DIFF_CHARS)}\n…`
  return text
}

export async function getGitDiff(
  projectId: string,
  path: string,
  staged: boolean,
  chatId?: string | null
): Promise<GitDiffResult> {
  const repo = await resolveRepo(projectId, chatId)
  if ('snapshot' in repo) return { path, oldText: '', newText: '', staged }
  const rel = guardedPath(repo.path, path)
  if (staged) {
    return {
      path: rel,
      oldText: clip(await readGitBlob(repo.path, `HEAD:${rel}`)),
      newText: clip(await readGitBlob(repo.path, `:${rel}`)),
      staged: true
    }
  }
  const abs = resolve(repo.path, rel)
  let work = ''
  try {
    const info = await stat(abs)
    if (info.isFile()) work = await readFile(abs, 'utf8')
  } catch {
    work = ''
  }
  const index = await readGitBlob(repo.path, `:${rel}`)
  const head = await readGitBlob(repo.path, `HEAD:${rel}`)
  return {
    path: rel,
    oldText: clip(index || head),
    newText: clip(work),
    staged: false
  }
}

function scheduleProject(projectId: string, chatId?: string | null): void {
  const key = `${projectId}:${chatId ?? ''}`
  const existing = pending.get(key)
  if (existing) clearTimeout(existing)
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      void broadcastGit(projectId, chatId)
    }, WATCH_MS)
  )
}

async function broadcastGit(projectId: string, chatId?: string | null): Promise<void> {
  const key = `${projectId}:${chatId ?? ''}`
  if (runningBroadcast.has(key)) {
    rerunBroadcast.add(key)
    return
  }
  runningBroadcast.add(key)
  try {
    const [snapshot, summaries] = await Promise.all([
      getGitSnapshot(projectId, chatId),
      getGitSummaries()
    ])
    emitGit('git:snapshot', snapshot)
    emitGit('git:summaries', summaries)
  } catch (error) {
    console.error('git broadcast', error)
  } finally {
    runningBroadcast.delete(key)
    if (rerunBroadcast.has(key)) {
      rerunBroadcast.delete(key)
      void broadcastGit(projectId, chatId)
    }
  }
}

/** A watcher that errored is dropped; a later sync installs a fresh one. */
function resyncSoon(): void {
  if (resyncTimer) return
  resyncTimer = setTimeout(() => {
    resyncTimer = null
    void syncGitWatchers()
  }, 5_000)
}

async function watchGitDir(projectId: string, cwd: string): Promise<void> {
  const dir = await runGit(cwd, ['rev-parse', '--absolute-git-dir'])
  gitWatchers.get(projectId)?.watcher.close()
  gitWatchers.delete(projectId)
  if (dir.code !== 0) return
  try {
    const watcher = watch(dir.stdout.trim(), { persistent: false }, (_event, filename) => {
      if (noisyWatchPath(filename)) return
      scheduleProject(projectId, activeWatch?.projectId === projectId ? activeWatch.chatId : null)
    })
    watcher.on('error', () => {
      watcher.close()
      if (gitWatchers.get(projectId)?.watcher === watcher) gitWatchers.delete(projectId)
      resyncSoon()
    })
    gitWatchers.set(projectId, { watcher, cwd })
  } catch {
    /* watch unavailable */
  }
}

function watchWorktree(projectId: string, cwd: string, chatId: string | null): void {
  const existing = worktreeWatchers.get(projectId)
  if (existing) {
    existing.close()
    worktreeWatchers.delete(projectId)
  }
  try {
    const watcher = watch(cwd, { persistent: false, recursive: true }, (_event, filename) => {
      if (noisyWatchPath(filename)) return
      scheduleProject(projectId, chatId)
    })
    watcher.on('error', () => {
      watcher.close()
      if (worktreeWatchers.get(projectId) === watcher) worktreeWatchers.delete(projectId)
      resyncSoon()
    })
    worktreeWatchers.set(projectId, watcher)
  } catch {
    /* watch unavailable */
  }
}

/** Runs one sync at a time, so two callers never install watchers for the same project. */
export function syncGitWatchers(): Promise<void> {
  syncChain = syncChain.then(syncGitWatchersNow)
  return syncChain
}

async function syncGitWatchersNow(): Promise<void> {
  try {
    const projects = await listProjects()
    const wanted = new Set(projects.map((project) => project.id))
    for (const [id, entry] of gitWatchers) {
      if (wanted.has(id)) continue
      entry.watcher.close()
      gitWatchers.delete(id)
    }
    for (const [id, watcher] of worktreeWatchers) {
      if (wanted.has(id)) continue
      watcher.close()
      worktreeWatchers.delete(id)
    }
    for (const project of projects) {
      const current = gitWatchers.get(project.id)
      if (project.path && current?.cwd === project.path) continue
      // The project is new, or its folder changed: watch the .git dir of its current path.
      current?.watcher.close()
      gitWatchers.delete(project.id)
      if (!project.path) continue
      const inside = await runGit(project.path, ['rev-parse', '--is-inside-work-tree'])
      if (inside.code !== 0 || inside.stdout.trim() !== 'true') continue
      await watchGitDir(project.id, project.path)
    }
    const active = activeWatch
    const gen = activeGen
    if (active) {
      const repo = await resolveRepo(active.projectId, active.chatId)
      if (gen === activeGen && !('snapshot' in repo)) watchWorktree(repo.id, repo.path, active.chatId)
    }
    emitGit('git:summaries', await getGitSummaries())
  } catch (error) {
    console.error('git watchers', error)
  }
}

export async function setGitActiveProject(
  projectId: string | null,
  chatId?: string | null
): Promise<void> {
  const gen = ++activeGen
  for (const watcher of worktreeWatchers.values()) watcher.close()
  worktreeWatchers.clear()
  activeWatch = projectId ? { projectId, chatId: chatId ?? null } : null
  if (!projectId) return
  const repo = await resolveRepo(projectId, chatId)
  // Another project or chat became active while this one resolved.
  if (gen !== activeGen || 'snapshot' in repo) return
  watchWorktree(repo.id, repo.path, chatId ?? null)
}

export function stopGitWatchers(): void {
  for (const entry of gitWatchers.values()) entry.watcher.close()
  for (const watcher of worktreeWatchers.values()) watcher.close()
  gitWatchers.clear()
  worktreeWatchers.clear()
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
  if (resyncTimer) clearTimeout(resyncTimer)
  resyncTimer = null
}
