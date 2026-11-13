import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { findGrokSessionDir } from './sessions'

const TAIL_BYTES = 12_000

function sessionCwd(dir: string): string | null {
  try {
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as {
      info?: { cwd?: unknown }
      cwd?: unknown
    }
    const cwd = summary.info?.cwd ?? summary.cwd
    return typeof cwd === 'string' && cwd.trim() ? cwd : null
  } catch {
    return null
  }
}

function expand(path: string, cwd: string | null): string | null {
  const trimmed = path.trim().replace(/[;,]+$/, '')
  if (!trimmed || trimmed === '/dev/null' || trimmed.startsWith('&')) return null
  const home = trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed
  if (isAbsolute(home)) return home
  if (!cwd) return null
  return resolve(cwd, home)
}

/** Files a shell command is writing, from redirects, tee, or a tool output-file tag. */
export function outputPathsFromText(text: string, cwd: string | null): string[] {
  const found: string[] = []
  const add = (raw: string | undefined): void => {
    if (!raw) return
    const path = expand(raw, cwd)
    if (!path || found.includes(path)) return
    found.push(path)
  }
  const redirect = /(?:^|[\s;|&])(?:\d)?>>?\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g
  for (const match of text.matchAll(redirect)) add(match[1] || match[2] || match[3])
  const tee = /\btee(?:\s+-a)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g
  for (const match of text.matchAll(tee)) add(match[1] || match[2] || match[3])
  const tagged = /<output-file>([^<]+)<\/output-file>/g
  for (const match of text.matchAll(tagged)) add(match[1])
  return found
}

function tail(path: string): string {
  let size = 0
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size <= 0) return ''
    size = stat.size
  } catch {
    return ''
  }
  const length = Math.min(TAIL_BYTES, size)
  const start = size - length
  const buf = Buffer.alloc(length)
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    readSync(fd, buf, 0, length, start)
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
  return buf.toString('utf8')
}

/** Terminal colour and cursor codes, which a log keeps but the chat cannot show. */
// eslint-disable-next-line no-control-regex -- matching escape codes is the point
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

export function lastLine(text: string): string | null {
  const lines = text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length > 0 ? lines[lines.length - 1]! : null
}

function consider(path: string, since: number, best: { mtime: number; line: string }): void {
  let mtime = 0
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return
    mtime = stat.mtimeMs
  } catch {
    return
  }
  if (mtime < since) return
  const line = lastLine(tail(path))
  if (!line || mtime < best.mtime) return
  best.mtime = mtime
  best.line = line
}

function terminalLogs(dir: string): string[] {
  const folder = join(dir, 'terminal')
  if (!existsSync(folder)) return []
  const logs: string[] = []
  try {
    for (const name of readdirSync(folder)) {
      if (name.endsWith('.log')) logs.push(join(folder, name))
    }
  } catch {
    return logs
  }
  return logs
}

function childSessionDirs(dir: string): string[] {
  const folder = join(dir, 'subagents')
  if (!existsSync(folder)) return []
  const dirs: string[] = []
  let names: string[] = []
  try {
    names = readdirSync(folder)
  } catch {
    return dirs
  }
  for (const name of names) {
    try {
      const meta = JSON.parse(readFileSync(join(folder, name, 'meta.json'), 'utf8')) as {
        status?: unknown
        child_session_id?: unknown
      }
      if (meta.status === 'completed' || meta.status === 'failed' || meta.status === 'cancelled') continue
      const id = typeof meta.child_session_id === 'string' ? meta.child_session_id : name
      const child = findGrokSessionDir(id)
      if (child) dirs.push(child)
    } catch {
      // not a subagent folder
    }
  }
  return dirs
}

/**
 * Latest line written by a running task since `since` (ms).
 * Looks at this session's terminal logs, live subagent sessions, and files
 * the running command redirects or tees into.
 */
export function latestTaskLine(sessionId: string | null, hints: string, since: number): string | null {
  if (!sessionId) return null
  const dir = findGrokSessionDir(sessionId)
  if (!dir) return null
  const cwd = sessionCwd(dir)
  const best = { mtime: 0, line: '' }
  const dirs = [dir, ...childSessionDirs(dir)]
  for (const sessionDir of dirs) {
    for (const log of terminalLogs(sessionDir)) consider(log, since, best)
  }
  for (const path of outputPathsFromText(hints, cwd)) consider(path, since, best)
  return best.line ? best.line : null
}
