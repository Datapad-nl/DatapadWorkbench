import { spawn } from 'child_process'
import { glob, mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, extname, isAbsolute, join, matchesGlob, relative, resolve } from 'path'
import type { ImageBlock, TextBlock, ToolSpec } from './types'

const READ_LINES = 2000
const READ_MAX_BYTES = 10_000_000
const OUTPUT_CHARS = 30_000
const LIST_MAX = 500
const FETCH_CHARS = 50_000
const FETCH_TIMEOUT_MS = 30_000
const COMMAND_TIMEOUT_MS = 120_000
const COMMAND_MAX_TIMEOUT_MS = 600_000
const SKIPPED = new Set(['node_modules', '.git'])
const IMAGES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

export type PlanEntry = { content: string; status: 'pending' | 'in_progress' | 'completed' }

export type ToolContext = {
  cwd: string
  /** Added to the shell tool's environment: the chat's secrets. */
  env: Record<string, string>
  signal: AbortSignal
  plan: (entries: PlanEntry[]) => void
}

export type ToolResult = {
  content: Array<TextBlock | ImageBlock>
  isError?: boolean
  diff?: { path: string; oldText: string | null; newText: string }
}

export type Tool = {
  spec: ToolSpec
  kind: string
  /** The app is asked before the tool runs. */
  asks: boolean
  /** Not shown as a tool call. */
  hidden?: boolean
  /** The input with absolute paths, and how the call shows in the app. */
  prepare: (input: Record<string, unknown>, cwd: string) => { input: Record<string, unknown>; title: string; locations: string[] }
  run: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

function need(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value) throw new Error(`Missing argument: ${key}`)
  return value
}

/** A path for a title: relative when inside the project. */
function shown(path: string, cwd: string): string {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
}

function withPath(key: string, input: Record<string, unknown>, cwd: string): { input: Record<string, unknown>; path: string } {
  const path = resolve(cwd, str(input[key]) || '.')
  return { input: { ...input, [key]: path }, path }
}

function capped(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n[cut off: ${value.length - max} more characters]` : value
}

const readFileTool: Tool = {
  spec: {
    name: 'read_file',
    description:
      `Read a file. Text comes back as it is, at most ${READ_LINES} lines from line \`offset\` (1 is the first); ` +
      'pass `offset` and `limit` to read another part. PNG, JPEG, GIF and WebP files come back as an image.',
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path, or relative to the project folder' },
        offset: { type: 'integer', description: 'First line to read, from 1' },
        limit: { type: 'integer', description: 'Number of lines to read' }
      },
      required: ['file_path']
    }
  },
  kind: 'read',
  asks: false,
  prepare(input, cwd) {
    const { input: out, path } = withPath('file_path', input, cwd)
    return { input: out, title: `Read ${shown(path, cwd)}`, locations: [path] }
  },
  async run(input) {
    const path = need(input, 'file_path')
    const info = await stat(path)
    if (info.isDirectory()) throw new Error(`${path} is a folder. Use list_files.`)
    if (info.size > READ_MAX_BYTES) throw new Error(`${path} is too large to read (${info.size} bytes).`)
    const mimeType = IMAGES[extname(path).toLowerCase()]
    const data = await readFile(path)
    if (mimeType) return { content: [{ type: 'image', mimeType, data: data.toString('base64') }] }
    if (data.subarray(0, 8000).includes(0)) throw new Error(`${path} is a binary file.`)
    const lines = data.toString('utf8').split('\n')
    const first = Math.max(1, Math.floor(Number(input.offset) || 1))
    const count = Math.max(1, Math.floor(Number(input.limit) || READ_LINES))
    const part = lines.slice(first - 1, first - 1 + count)
    const last = first - 1 + part.length
    const body = capped(part.join('\n'), 200_000)
    return text(first > 1 || last < lines.length ? `${body}\n[lines ${first}-${last} of ${lines.length}]` : body)
  }
}

const writeFileTool: Tool = {
  spec: {
    name: 'write_file',
    description: 'Create a file with the given content, or replace all of an existing one. Folders are made as needed.',
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path, or relative to the project folder' },
        content: { type: 'string' }
      },
      required: ['file_path', 'content']
    }
  },
  kind: 'edit',
  asks: true,
  prepare(input, cwd) {
    const { input: out, path } = withPath('file_path', input, cwd)
    return { input: out, title: `Write ${shown(path, cwd)}`, locations: [path] }
  },
  async run(input) {
    const path = need(input, 'file_path')
    if (typeof input.content !== 'string') throw new Error('Missing argument: content')
    const oldText = await readFile(path, 'utf8').catch(() => null)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, input.content)
    return {
      ...text(oldText === null ? `Created ${path}` : `Replaced ${path}`),
      diff: { path, oldText, newText: input.content }
    }
  }
}

const editFileTool: Tool = {
  spec: {
    name: 'edit_file',
    description:
      'Replace `old_string` with `new_string` in a file. `old_string` must match the file exactly, whitespace ' +
      'included, and must occur once: give more surrounding lines when it occurs more often, or set ' +
      '`replace_all` to replace every occurrence.',
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path, or relative to the project folder' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  kind: 'edit',
  asks: true,
  prepare(input, cwd) {
    const { input: out, path } = withPath('file_path', input, cwd)
    return { input: out, title: `Edit ${shown(path, cwd)}`, locations: [path] }
  },
  async run(input) {
    const path = need(input, 'file_path')
    const oldString = need(input, 'old_string')
    if (typeof input.new_string !== 'string') throw new Error('Missing argument: new_string')
    const newString = input.new_string
    if (oldString === newString) throw new Error('old_string and new_string are the same.')
    const before = await readFile(path, 'utf8')
    const count = before.split(oldString).length - 1
    if (count === 0) throw new Error(`old_string was not found in ${path}.`)
    if (count > 1 && input.replace_all !== true) {
      throw new Error(`old_string occurs ${count} times in ${path}. Give more context to make it unique, or set replace_all.`)
    }
    // split/join, so `$` in new_string is not read as a replacement pattern.
    await writeFile(path, before.split(oldString).join(newString))
    return {
      ...text(`Edited ${path}${count > 1 ? ` (${count} replacements)` : ''}`),
      diff: { path, oldText: oldString, newText: newString }
    }
  }
}

const listFilesTool: Tool = {
  spec: {
    name: 'list_files',
    description:
      'List a folder, or with `pattern` find files by glob (for example `src/**/*.ts`) under it. ' +
      `node_modules and .git are left out. At most ${LIST_MAX} entries.`,
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder to list; the project folder when left out' },
        pattern: { type: 'string', description: 'Glob, relative to the folder' }
      }
    }
  },
  kind: 'search',
  asks: false,
  prepare(input, cwd) {
    const { input: out, path } = withPath('path', input, cwd)
    return { input: out, title: `List ${str(input.pattern) || shown(path, cwd)}`, locations: [path] }
  },
  async run(input) {
    const path = need(input, 'path')
    const pattern = str(input.pattern)
    const found: string[] = []
    let more = false
    if (pattern) {
      for await (const entry of glob(pattern, { cwd: path, exclude: (name) => SKIPPED.has(name) })) {
        if (found.length >= LIST_MAX) {
          more = true
          break
        }
        found.push(entry)
      }
    } else {
      const entries = await readdir(path, { withFileTypes: true })
      for (const entry of entries) found.push(entry.isDirectory() ? `${entry.name}/` : entry.name)
      more = found.length > LIST_MAX
      found.length = Math.min(found.length, LIST_MAX)
    }
    if (found.length === 0) return text('Nothing found.')
    return text(found.sort().join('\n') + (more ? `\n[more than ${LIST_MAX}: narrow the pattern]` : ''))
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (SKIPPED.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

/** grep without ripgrep: a JavaScript regular expression over every text file under `path`. */
export async function grepFallback(pattern: string, path: string, fileGlob: string, signal: AbortSignal): Promise<string> {
  const regex = new RegExp(pattern)
  const lines: string[] = []
  let size = 0
  const files = (await stat(path)).isDirectory() ? walk(path) : [path]
  for await (const file of files) {
    if (signal.aborted || size > OUTPUT_CHARS) break
    if (fileGlob && !matchesGlob(relative(path, file), fileGlob) && !matchesGlob(file.split(/[\\/]/).pop() ?? '', fileGlob)) continue
    const info = await stat(file).catch(() => null)
    if (!info || info.size > 1_000_000) continue
    const body = await readFile(file).catch(() => null)
    if (!body || body.subarray(0, 8000).includes(0)) continue
    body
      .toString('utf8')
      .split('\n')
      .forEach((line, index) => {
        if (!regex.test(line)) return
        const hit = `${file}:${index + 1}:${line.slice(0, 300)}`
        lines.push(hit)
        size += hit.length + 1
      })
  }
  return lines.join('\n')
}

/** ripgrep's output, or null when it is not installed. */
function ripgrep(pattern: string, path: string, fileGlob: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((done, fail) => {
    const args = ['--line-number', '--no-heading', '--with-filename', '--color', 'never', '--max-columns', '300']
    if (fileGlob) args.push('--glob', fileGlob)
    const child = spawn('rg', [...args, '-e', pattern, path], { stdio: ['ignore', 'pipe', 'pipe'], signal })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (out.length <= OUTPUT_CHARS) out += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')))
    child.on('error', (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? done(null) : fail(error)))
    // 1 is ripgrep's "no match".
    child.on('close', (code) => (code === 0 || code === 1 ? done(out) : fail(new Error(err.trim() || `rg exited with ${code}`))))
  })
}

const grepTool: Tool = {
  spec: {
    name: 'grep',
    description:
      'Search file contents with a regular expression. Answers `path:line:text` for each matching line. ' +
      '`glob` limits the files, for example `*.ts`.',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression' },
        path: { type: 'string', description: 'File or folder to search; the project folder when left out' },
        glob: { type: 'string' }
      },
      required: ['pattern']
    }
  },
  kind: 'search',
  asks: false,
  prepare(input, cwd) {
    const { input: out, path } = withPath('path', input, cwd)
    return { input: out, title: `Grep ${str(input.pattern)}`, locations: [path] }
  },
  async run(input, context) {
    const pattern = need(input, 'pattern')
    const path = need(input, 'path')
    const fileGlob = str(input.glob)
    const found =
      (await ripgrep(pattern, path, fileGlob, context.signal)) ?? (await grepFallback(pattern, path, fileGlob, context.signal))
    return text(found.trim() ? capped(found.trimEnd(), OUTPUT_CHARS) : 'No matches.')
  }
}

const runCommandTool: Tool = {
  spec: {
    name: 'run_command',
    description:
      'Run a shell command in the project folder and answer its output (stdout and stderr together) and exit ' +
      `code. It is stopped after \`timeout_ms\` (default ${COMMAND_TIMEOUT_MS}, at most ${COMMAND_MAX_TIMEOUT_MS}). ` +
      'It cannot take input: do not start anything that waits for the keyboard.',
    schema: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout_ms: { type: 'integer' } },
      required: ['command']
    }
  },
  kind: 'execute',
  asks: true,
  prepare(input) {
    return { input, title: str(input.command).trim().split('\n')[0].slice(0, 200) || 'Run command', locations: [] }
  },
  run(input, context) {
    const command = need(input, 'command')
    const timeoutMs = Math.min(Math.max(Number(input.timeout_ms) || COMMAND_TIMEOUT_MS, 1000), COMMAND_MAX_TIMEOUT_MS)
    return new Promise((done) => {
      // Its own process group, so what the command started is stopped with it.
      const grouped = process.platform !== 'win32'
      const child = spawn(command, {
        shell: true,
        cwd: context.cwd,
        env: { ...process.env, ...context.env },
        detached: grouped,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      let stopped = ''
      const take = (chunk: Buffer): void => {
        // The end of the output is what says how it went.
        output = (output + chunk.toString('utf8')).slice(-OUTPUT_CHARS * 2)
      }
      const kill = (signal: NodeJS.Signals): void => {
        try {
          if (grouped && child.pid) process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch {
          // already gone
        }
      }
      const stop = (why: string): void => {
        if (stopped) return
        stopped = why
        kill('SIGTERM')
        setTimeout(() => kill('SIGKILL'), 2000).unref()
      }
      const onAbort = (): void => stop('Cancelled')
      const timer = setTimeout(() => stop(`Timed out after ${timeoutMs} ms`), timeoutMs)
      context.signal.addEventListener('abort', onAbort, { once: true })
      if (context.signal.aborted) onAbort()
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      const finish = (tail: string, isError: boolean): void => {
        clearTimeout(timer)
        context.signal.removeEventListener('abort', onAbort)
        const body = output.length > OUTPUT_CHARS ? `[earlier output cut off]\n${output.slice(-OUTPUT_CHARS)}` : output
        done({ content: [{ type: 'text', text: `${body.trimEnd()}\n${tail}`.trim() }], isError })
      }
      child.on('error', (error) => finish(error.message, true))
      child.on('close', (code, signal) => {
        if (stopped) finish(`[${stopped}]`, true)
        else if (code === 0) finish(output.trim() ? '' : '(no output)', false)
        else finish(`[exit code ${code ?? signal}]`, true)
      })
    })
  }
}

function htmlToText(html: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
  return html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#39|[a-z]+);/g, (whole, name: string) => entities[name] ?? whole)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

const fetchUrlTool: Tool = {
  spec: {
    name: 'fetch_url',
    description: `Fetch a web address and answer its content as text (HTML is reduced to its text), at most ${FETCH_CHARS} characters.`,
    schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  kind: 'fetch',
  asks: false,
  prepare(input) {
    return { input, title: `Fetch ${str(input.url)}`, locations: [] }
  },
  async run(input, context) {
    const url = need(input, 'url')
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https addresses can be fetched.')
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}\n${body.slice(0, 500)}`.trim())
    const html = /html/i.test(response.headers.get('content-type') ?? '')
    return text(capped(html ? htmlToText(body) : body, FETCH_CHARS) || '(empty)')
  }
}

const todoWriteTool: Tool = {
  spec: {
    name: 'todo_write',
    description:
      'Show the user your plan for a task of several steps, and keep it current: send the whole list each time, ' +
      'with one step `in_progress` while you work on it and `completed` as soon as it is done.',
    schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
            },
            required: ['content', 'status']
          }
        }
      },
      required: ['todos']
    }
  },
  kind: 'think',
  asks: false,
  hidden: true,
  prepare(input) {
    return { input, title: 'Update plan', locations: [] }
  },
  async run(input, context) {
    context.plan(planEntries(input))
    return text('Plan updated.')
  }
}

/** The entries of a `todo_write` call; anything that is not a step with text is left out. */
export function planEntries(input: Record<string, unknown>): PlanEntry[] {
  if (!Array.isArray(input.todos)) throw new Error('Missing argument: todos')
  return (input.todos as Array<{ content?: unknown; status?: unknown }>).flatMap((todo) =>
    todo && typeof todo.content === 'string' && todo.content
      ? [{ content: todo.content, status: todo.status === 'in_progress' || todo.status === 'completed' ? todo.status : 'pending' }]
      : []
  )
}

/** `task`: the session runs `prompt` as an agent of its own and answers with that agent's last text. */
export function taskTool(run: (prompt: string, signal: AbortSignal) => Promise<ToolResult>): Tool {
  return {
    spec: {
      name: 'task',
      description:
        'Hand a self-contained piece of work to a subagent: it starts with none of this conversation, has the same ' +
        'tools, and answers with one final report, which is all you get back. Say in `prompt` everything it needs ' +
        'and what the report should hold. Several task calls in one reply run at the same time.',
      schema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'A few words on what the task is, shown to the user' },
          prompt: { type: 'string', description: 'The whole task for the subagent' }
        },
        required: ['description', 'prompt']
      }
    },
    kind: 'think',
    asks: false,
    prepare(input) {
      return { input, title: `Task: ${str(input.description) || 'subagent'}`, locations: [] }
    },
    run: (input, context) => run(need(input, 'prompt'), context.signal)
  }
}

export const builtinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  grepTool,
  runCommandTool,
  fetchUrlTool,
  todoWriteTool
]

/** Plan mode gives the model nothing that changes the project. */
export const PLAN_HIDDEN = new Set(['write_file', 'edit_file', 'run_command'])

/** A subagent hands out no tasks of its own and keeps no plan the user sees. */
export const SUBTASK_HIDDEN = new Set(['task', 'todo_write'])
