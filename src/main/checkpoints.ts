import { execFile } from 'child_process'
import { app } from 'electron'
import type { Stats } from 'fs'
import { copyFile, lstat, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { Chat, Checkpoint } from '../shared/types'
import { withRepoLock } from './gitLock'
import { id, now, titleFromPrompt } from './ids'
import { isMutatingTool } from './permissions'
import { getChat, mutateChat } from './store'
import type { SessionUpdate } from './acp'

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const PATH_KEYS = ['path', 'file', 'file_path', 'target_file', 'filename']
/** A folder outside git gets a whole-tree copy before each turn only up to this size. */
const MAX_SHADOW_FILES = 20_000
const MAX_SHADOW_BYTES = 200 * 1024 * 1024
/** Folders a project can rebuild, left out of that copy. */
const SHADOW_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.cache/', '.next/', '.DS_Store']
/** Folders found too big for that copy, not listed again this session. */
const tooBigForShadow = new Set<string>()

type Active = {
  checkpoint: Checkpoint
  root: string | null
  snapDir: string
  /** Each path's copy, so a second tool on the same file waits for the first copy. */
  seen: Map<string, Promise<void>>
}

const active = new Map<string, Active>()

function checkpointRoot(chatId: string): string {
  return join(app.getPath('userData'), 'workbench', 'checkpoints', chatId)
}

function snapDirFor(chatId: string, checkpointId: string): string {
  return join(checkpointRoot(chatId), checkpointId)
}

function gitEnv(indexFile?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Datapad Workbench',
    GIT_AUTHOR_EMAIL: 'workbench@local',
    GIT_COMMITTER_NAME: 'Datapad Workbench',
    GIT_COMMITTER_EMAIL: 'workbench@local',
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {})
  }
}

function runGit(
  cwd: string,
  args: string[],
  extra?: NodeJS.ProcessEnv,
  timeout = 30_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    execFile(
      'git',
      args,
      { cwd, env: extra ?? gitEnv(), timeout, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolveResult({ code: 0, stdout, stderr })
          return
        }
        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
        resolveResult({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

export function relPath(root: string, raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed)
  const base = resolve(root)
  if (abs === base) return null
  const prefix = base.endsWith(sep) ? base : base + sep
  if (!abs.startsWith(prefix)) return null
  return relative(base, abs).split(/[/\\]/).join('/')
}

function collectPaths(value: unknown, found: string[]): void {
  if (!value) return
  if (typeof value === 'string') return
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, found)
    return
  }
  if (typeof value !== 'object') return
  const record = value as Record<string, unknown>
  for (const key of PATH_KEYS) {
    const item = record[key]
    if (typeof item === 'string' && item.trim()) found.push(item)
  }
  for (const nested of [record.arguments, record.input, record.params, record.args]) {
    collectPaths(nested, found)
  }
}

export function pathsFromUpdate(update: SessionUpdate['update'], root: string | null): string[] {
  const raw: string[] = []
  for (const location of update.locations ?? []) {
    if (location.path) raw.push(location.path)
  }
  collectPaths(update.rawInput, raw)
  if (!root) return []
  const unique: string[] = []
  for (const item of raw) {
    const rel = relPath(root, item)
    if (!rel || unique.includes(rel)) continue
    unique.push(rel)
  }
  return unique
}

function nulList(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean)
}

async function insideGitWorkTree(cwd: string): Promise<boolean> {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  return inside.code === 0 && inside.stdout.trim() === 'true'
}

async function createGitCheckpoint(cwd: string, chatId: string, checkpointId: string): Promise<string | null> {
  const gitDirRaw = await runGit(cwd, ['rev-parse', '--git-dir'])
  if (gitDirRaw.code !== 0) return null
  const gitDir = isAbsolute(gitDirRaw.stdout.trim())
    ? gitDirRaw.stdout.trim()
    : join(cwd, gitDirRaw.stdout.trim())
  const indexFile = join(gitDir, `workbench-index-${checkpointId}`)

  try {
    await mkdir(gitDir, { recursive: true })
    try {
      await copyFile(join(gitDir, 'index'), indexFile)
    } catch {
      // no existing index
    }

    const add = await runGit(cwd, ['add', '-A', '--', '.'], gitEnv(indexFile))
    if (add.code !== 0) return null

    const tree = await runGit(cwd, ['write-tree'], gitEnv(indexFile))
    const treeSha = tree.stdout.trim()
    if (tree.code !== 0 || !treeSha) return null

    const head = await runGit(cwd, ['rev-parse', 'HEAD'])
    const headSha = head.stdout.trim()
    const parent = head.code === 0 && /^[0-9a-f]{40,}$/i.test(headSha) ? ['-p', headSha] : []

    const commit = await runGit(
      cwd,
      ['commit-tree', treeSha, ...parent, '-m', `workbench ${chatId} ${checkpointId}`],
      gitEnv(indexFile)
    )
    const sha = commit.stdout.trim()
    if (commit.code !== 0 || !sha) return null

    const ref = await runGit(cwd, ['update-ref', `refs/workbench/${chatId}/${checkpointId}`, sha])
    if (ref.code !== 0) return null
    return sha
  } finally {
    await rm(indexFile, { force: true })
  }
}

function shadowGitDir(chatId: string): string {
  return join(checkpointRoot(chatId), 'shadow.git')
}

/** Git options for a chat's private repository holding copies of a folder that is not in git. */
function shadowArgs(chatId: string, cwd: string): string[] {
  return [`--git-dir=${shadowGitDir(chatId)}`, `--work-tree=${cwd}`]
}

/** What that repository copies: links, and files up to MAX_SNAPSHOT_BYTES. */
function shadowHolds(info: Stats): boolean {
  return info.isSymbolicLink() || (info.isFile() && info.size <= MAX_SNAPSHOT_BYTES)
}

/**
 * Commits a whole folder that is not in git to the chat's private repository, so a rewind also
 * restores files a tool changed before the app heard about it.
 */
async function createShadowCheckpoint(cwd: string, chatId: string, checkpointId: string): Promise<string | null> {
  if (tooBigForShadow.has(cwd)) return null
  const gitDir = shadowGitDir(chatId)
  const git = shadowArgs(chatId, cwd)
  const exists = await stat(join(gitDir, 'HEAD')).then(
    () => true,
    () => false
  )
  if (!exists) {
    if ((await runGit(cwd, ['init', '--bare', '--quiet', gitDir])).code !== 0) return null
    await mkdir(join(gitDir, 'info'), { recursive: true })
    await writeFile(join(gitDir, 'info', 'exclude'), SHADOW_EXCLUDES.join('\n') + '\n')
  }

  // A folder too big to list in 10 seconds is too big to copy before every turn.
  const listed = await runGit(cwd, [...git, 'ls-files', '-co', '--exclude-standard', '-z'], undefined, 10_000)
  if (listed.code !== 0) {
    tooBigForShadow.add(cwd)
    return null
  }
  const files: string[] = []
  let bytes = 0
  for (const rel of nulList(listed.stdout)) {
    const info = await lstat(join(cwd, rel)).catch(() => null)
    if (!info || !shadowHolds(info)) continue
    files.push(rel)
    bytes += info.isFile() ? info.size : 0
    if (files.length > MAX_SHADOW_FILES || bytes > MAX_SHADOW_BYTES) {
      tooBigForShadow.add(cwd)
      return null
    }
  }

  const list = join(gitDir, `list-${checkpointId}`)
  const indexFile = join(gitDir, `index-${checkpointId}`)
  try {
    await writeFile(list, files.join('\0'))
    const env = gitEnv(indexFile)
    const add = await runGit(
      cwd,
      ['--literal-pathspecs', ...git, 'add', `--pathspec-from-file=${list}`, '--pathspec-file-nul'],
      env
    )
    if (add.code !== 0) return null
    const tree = await runGit(cwd, [...git, 'write-tree'], env)
    const treeSha = tree.stdout.trim()
    if (tree.code !== 0 || !treeSha) return null
    const commit = await runGit(cwd, [...git, 'commit-tree', treeSha, '-m', `workbench ${chatId} ${checkpointId}`], env)
    const sha = commit.stdout.trim()
    if (commit.code !== 0 || !sha) return null
    const ref = await runGit(cwd, [...git, 'update-ref', `refs/workbench/${chatId}/${checkpointId}`, sha])
    return ref.code === 0 ? sha : null
  } finally {
    await rm(list, { force: true })
    await rm(indexFile, { force: true })
  }
}

async function snapshotFile(root: string, rel: string, snapDir: string): Promise<void> {
  const abs = resolve(root, rel)
  const dest = join(snapDir, rel)
  await mkdir(dirname(dest), { recursive: true })
  try {
    const info = await stat(abs)
    if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) {
      await writeFile(`${dest}.grok-skip`, '')
      return
    }
    await copyFile(abs, dest)
    await writeFile(`${dest}.grok-meta`, 'present')
  } catch {
    await writeFile(`${dest}.grok-meta`, 'missing')
  }
}

export async function startCheckpoint(input: {
  chat: Chat
  messageId: string
  label: string
  cwd: string | null
}): Promise<Checkpoint> {
  const checkpointId = id()
  const snapDir = snapDirFor(input.chat.id, checkpointId)
  await mkdir(snapDir, { recursive: true })

  let gitSha: string | null = null
  let kind: Checkpoint['kind'] = 'files'
  if (input.cwd) {
    try {
      const cwd = input.cwd
      const inRepo = await insideGitWorkTree(cwd)
      // Under the repo lock, so a commit or checkout from the Git pane can't change files mid-snapshot.
      gitSha = await withRepoLock(cwd, () =>
        inRepo
          ? createGitCheckpoint(cwd, input.chat.id, checkpointId)
          : createShadowCheckpoint(cwd, input.chat.id, checkpointId)
      )
      if (gitSha) kind = inRepo ? 'git' : 'shadow'
    } catch {
      gitSha = null
    }
  }

  const checkpoint: Checkpoint = {
    id: checkpointId,
    chatId: input.chat.id,
    messageId: input.messageId,
    createdAt: now(),
    kind,
    gitSha,
    label: titleFromPrompt(input.label || 'Turn'),
    files: []
  }

  const entry = {
    checkpoint,
    root: input.cwd,
    snapDir,
    seen: new Map()
  }
  active.set(input.chat.id, entry)

  try {
    await mutateChat(input.chat.id, (chat) => {
      chat.checkpoints = [...(chat.checkpoints ?? []), checkpoint]
    })
  } catch (error) {
    // Nothing points at this checkpoint, so the files it would snapshot have nowhere to go.
    if (active.get(input.chat.id) === entry) active.delete(input.chat.id)
    throw error
  }
  return checkpoint
}

function snapshotPaths(current: Active, update: SessionUpdate['update']): Promise<void> {
  if (!current.root || !isMutatingTool(update.kind, update.title, update.name)) return Promise.resolve()
  const root = current.root
  const copies: Array<Promise<void>> = []
  for (const rel of pathsFromUpdate(update, root)) {
    let copy = current.seen.get(rel)
    if (!copy) {
      current.checkpoint.files.push(rel)
      copy = snapshotFile(root, rel, current.snapDir).catch(() => {})
      current.seen.set(rel, copy)
    }
    copies.push(copy)
  }
  return Promise.all(copies).then(() => undefined)
}

/** Note the files a tool update names. The tool may already be running, so this is best effort. */
export async function snapshotTouched(chatId: string, update: SessionUpdate['update']): Promise<void> {
  const current = active.get(chatId)
  if (!current) return
  await snapshotPaths(current, update)
}

/** Copy the files a tool will change before it is allowed to run. */
export async function snapshotBeforeTool(chatId: string, update: SessionUpdate['update']): Promise<void> {
  await snapshotTouched(chatId, update)
}

/** Save the turn's checkpoint once its copies are on disk. Only the turn that opened it may close it. */
export async function finishCheckpoint(chatId: string, checkpointId: string): Promise<Checkpoint | null> {
  const current = active.get(chatId)
  if (!current || current.checkpoint.id !== checkpointId) return null
  await Promise.all(current.seen.values())
  if (active.get(chatId) === current) active.delete(chatId)
  try {
    await mutateChat(chatId, (chat) => {
      chat.checkpoints = (chat.checkpoints ?? []).map((item) =>
        item.id === current.checkpoint.id ? current.checkpoint : item
      )
    })
  } catch {
    // chat may have been deleted
  }
  return current.checkpoint
}

/** Puts the folder back as commit `sha` holds it and removes files made since. `git` picks the repository. */
async function restoreTree(cwd: string, sha: string, git: string[], shadow: boolean): Promise<void> {
  const restore = await runGit(cwd, [...git, 'restore', '--source', sha, '--worktree', '--', '.'])
  if (restore.code !== 0) {
    await runGit(cwd, [...git, 'checkout', sha, '--', '.'])
  }

  const then = await runGit(cwd, [...git, 'ls-tree', '-r', '-z', '--name-only', sha])
  const nowFiles = await runGit(cwd, [...git, 'ls-files', '-co', '--exclude-standard', '-z'])
  const previous = new Set(nulList(then.stdout))
  for (const file of nulList(nowFiles.stdout)) {
    if (previous.has(file)) continue
    const abs = resolve(cwd, file)
    const info = await lstat(abs).catch(() => null)
    // A folder here is a nested repository. The private copy skips some files, so they may predate the turn.
    if (!info || info.isDirectory() || (shadow && !shadowHolds(info))) continue
    await rm(abs, { force: true })
  }
}

async function restoreSnapshots(root: string, snapDir: string, files: string[]): Promise<void> {
  for (const rel of files) {
    const dest = join(snapDir, rel)
    let meta = ''
    try {
      meta = (await readFile(`${dest}.grok-meta`, 'utf8')).trim()
    } catch {
      meta = ''
    }
    const abs = resolve(root, rel)
    if (meta === 'missing') {
      await rm(abs, { force: true })
      continue
    }
    if (meta === 'present') {
      await mkdir(dirname(abs), { recursive: true })
      await copyFile(dest, abs)
    }
  }
}

async function deleteCheckpointArtifacts(checkpoint: Checkpoint, cwd: string | null): Promise<void> {
  await rm(snapDirFor(checkpoint.chatId, checkpoint.id), { recursive: true, force: true })
  if (cwd && checkpoint.gitSha) {
    const git = checkpoint.kind === 'shadow' ? shadowArgs(checkpoint.chatId, cwd) : []
    await runGit(cwd, [...git, 'update-ref', '-d', `refs/workbench/${checkpoint.chatId}/${checkpoint.id}`])
  }
}

export async function deleteAllCheckpoints(chatId: string, cwd: string | null): Promise<void> {
  await rm(checkpointRoot(chatId), { recursive: true, force: true })
  if (!cwd) return
  const refs = await runGit(cwd, ['for-each-ref', '--format=%(refname)', `refs/workbench/${chatId}`])
  for (const ref of refs.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    await runGit(cwd, ['update-ref', '-d', ref])
  }
}

export async function rewindTo(chatId: string, checkpointId: string, cwd: string | null): Promise<Chat> {
  const loaded = await getChat(chatId)
  const checkpoints = loaded.checkpoints ?? []
  const index = checkpoints.findIndex((item) => item.id === checkpointId)
  if (index === -1) throw new Error('Checkpoint not found')
  const target = checkpoints[index]

  if (cwd) {
    // Every turn being undone, newest first, so each file ends at its oldest copy.
    for (const item of checkpoints.slice(index).reverse()) {
      await restoreSnapshots(cwd, snapDirFor(chatId, item.id), item.files)
    }
  }
  // The whole-tree copy last: it was taken before the turn, while a file copy made after a tool already
  // ran holds that tool's change.
  if (cwd && target.gitSha) {
    const sha = target.gitSha
    const shadow = target.kind === 'shadow'
    await withRepoLock(cwd, () => restoreTree(cwd, sha, shadow ? shadowArgs(chatId, cwd) : [], shadow))
  }

  let removed: Checkpoint[] = []
  const saved = await mutateChat(chatId, (chat) => {
    // A chat imported from a session keeps its history outside the file until first written.
    if (chat.messages.length === 0) chat.messages = loaded.messages
    const keepUntil = chat.messages.findIndex((message) => message.id === target.messageId)
    chat.messages = keepUntil === -1 ? chat.messages : chat.messages.slice(0, keepUntil)
    chat.grokSessionId = null
    chat.plan = null
    const current = chat.checkpoints ?? []
    const at = current.findIndex((item) => item.id === checkpointId)
    removed = at === -1 ? [] : current.slice(at)
    chat.checkpoints = at === -1 ? current : current.slice(0, at)
  })

  for (const item of removed) {
    await deleteCheckpointArtifacts(item, cwd)
  }
  active.delete(chatId)
  return saved
}
