import { execFile } from 'child_process'
import { app } from 'electron'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { Chat, Checkpoint } from '../shared/types'
import { withRepoLock } from './gitLock'
import { id, now, titleFromPrompt } from './ids'
import { isMutatingTool } from './permissions'
import { getChat, mutateChat } from './store'
import type { SessionUpdate } from './acp'

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const PATH_KEYS = ['path', 'file', 'file_path', 'target_file', 'filename']

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
  extra?: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    execFile(
      'git',
      args,
      { cwd, env: extra ?? gitEnv(), timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
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

async function createGitCheckpoint(cwd: string, chatId: string, checkpointId: string): Promise<string | null> {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null

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
  if (input.cwd) {
    try {
      const cwd = input.cwd
      // Under the repo lock, so a commit or checkout from the Git pane can't change files mid-snapshot.
      gitSha = await withRepoLock(cwd, () => createGitCheckpoint(cwd, input.chat.id, checkpointId))
    } catch {
      gitSha = null
    }
  }

  const checkpoint: Checkpoint = {
    id: checkpointId,
    chatId: input.chat.id,
    messageId: input.messageId,
    createdAt: now(),
    kind: gitSha ? 'git' : 'files',
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

async function restoreGit(cwd: string, sha: string): Promise<void> {
  const restore = await runGit(cwd, ['restore', '--source', sha, '--worktree', '--', '.'])
  if (restore.code !== 0) {
    await runGit(cwd, ['checkout', sha, '--', '.'])
  }

  const then = await runGit(cwd, ['ls-tree', '-r', '--name-only', sha])
  const nowFiles = await runGit(cwd, ['ls-files', '-co', '--exclude-standard'])
  const previous = new Set(then.stdout.split('\n').map((line) => line.trim()).filter(Boolean))
  for (const file of nowFiles.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (previous.has(file)) continue
    await rm(resolve(cwd, file), { force: true })
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
    await runGit(cwd, ['update-ref', '-d', `refs/workbench/${checkpoint.chatId}/${checkpoint.id}`])
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

  if (cwd && target.gitSha) {
    const sha = target.gitSha
    await withRepoLock(cwd, () => restoreGit(cwd, sha))
  }
  if (cwd) {
    await restoreSnapshots(cwd, snapDirFor(chatId, target.id), target.files)
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
