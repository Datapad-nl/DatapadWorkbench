import { execFile } from 'child_process'
import { app } from 'electron'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { Chat, Checkpoint } from '../shared/types'
import { id, now, titleFromPrompt } from './ids'
import { isMutatingTool } from './permissions'
import { getChat, saveChat } from './store'
import type { SessionUpdate } from './acp'

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const PATH_KEYS = ['path', 'file', 'file_path', 'target_file', 'filename']

type Active = {
  checkpoint: Checkpoint
  root: string | null
  snapDir: string
  seen: Set<string>
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
      gitSha = await createGitCheckpoint(input.cwd, input.chat.id, checkpointId)
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

  active.set(input.chat.id, {
    checkpoint,
    root: input.cwd,
    snapDir,
    seen: new Set()
  })

  const chat = await getChat(input.chat.id)
  chat.checkpoints = [...(chat.checkpoints ?? []), checkpoint]
  await saveChat(chat)
  return checkpoint
}

export async function snapshotTouched(chatId: string, update: SessionUpdate['update']): Promise<void> {
  const current = active.get(chatId)
  if (!current?.root) return
  if (!isMutatingTool(update.kind, update.title, update.name)) return

  const paths = pathsFromUpdate(update, current.root)
  for (const rel of paths) {
    if (current.seen.has(rel)) continue
    current.seen.add(rel)
    current.checkpoint.files.push(rel)
    await snapshotFile(current.root, rel, current.snapDir)
  }
}

export async function finishCheckpoint(chatId: string): Promise<Checkpoint | null> {
  const current = active.get(chatId)
  active.delete(chatId)
  if (!current) return null
  try {
    const chat = await getChat(chatId)
    chat.checkpoints = (chat.checkpoints ?? []).map((item) =>
      item.id === current.checkpoint.id ? current.checkpoint : item
    )
    await saveChat(chat)
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
  const chat = await getChat(chatId)
  const checkpoints = chat.checkpoints ?? []
  const index = checkpoints.findIndex((item) => item.id === checkpointId)
  if (index === -1) throw new Error('Checkpoint not found')
  const target = checkpoints[index]

  if (cwd && target.gitSha) {
    await restoreGit(cwd, target.gitSha)
  }
  if (cwd) {
    await restoreSnapshots(cwd, snapDirFor(chatId, target.id), target.files)
  }

  const keepUntil = chat.messages.findIndex((message) => message.id === target.messageId)
  chat.messages = keepUntil === -1 ? chat.messages : chat.messages.slice(0, keepUntil)
  chat.grokSessionId = null
  chat.plan = null

  const removed = checkpoints.slice(index)
  chat.checkpoints = checkpoints.slice(0, index)
  await saveChat(chat)

  for (const item of removed) {
    await deleteCheckpointArtifacts(item, cwd)
  }
  active.delete(chatId)
  return chat
}
