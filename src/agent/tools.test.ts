import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtinTools, grepFallback, type PlanEntry, type ToolResult } from './tools'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-agent-tools-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const plans: PlanEntry[][] = []

/** Run a tool as the session does: prepare the input, then run it. */
async function run(name: string, input: Record<string, unknown>, extra: { env?: Record<string, string>; signal?: AbortSignal } = {}): Promise<ToolResult & { title: string; input: Record<string, unknown>; locations: string[] }> {
  const tool = builtinTools.find((item) => item.spec.name === name)!
  const prepared = tool.prepare(input, dir)
  const result = await tool.run(prepared.input, {
    cwd: dir,
    env: extra.env ?? {},
    signal: extra.signal ?? new AbortController().signal,
    plan: (entries) => plans.push(entries)
  })
  return { ...result, ...prepared }
}

const textOf = (result: ToolResult): string => result.content.map((block) => (block.type === 'text' ? block.text : '[image]')).join('\n')

describe('read_file', () => {
  it('reads a file by a relative path and shows it with an absolute one', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree')
    const result = await run('read_file', { file_path: 'a.txt' })
    expect(textOf(result)).toBe('one\ntwo\nthree')
    expect(result.input.file_path).toBe(join(dir, 'a.txt'))
    expect(result.locations).toEqual([join(dir, 'a.txt')])
    expect(result.title).toBe('Read a.txt')
  })

  it('reads a range of lines and says which', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour')
    expect(textOf(await run('read_file', { file_path: 'a.txt', offset: 2, limit: 2 }))).toBe('two\nthree\n[lines 2-3 of 4]')
  })

  it('answers an image as an image', async () => {
    await writeFile(join(dir, 'p.png'), Buffer.from([1, 2, 3]))
    expect((await run('read_file', { file_path: 'p.png' })).content).toEqual([{ type: 'image', mimeType: 'image/png', data: 'AQID' }])
  })

  it('fails for a file that is not there', async () => {
    await expect(run('read_file', { file_path: 'nope.txt' })).rejects.toThrow(/ENOENT/)
  })
})

describe('write_file', () => {
  it('creates a file and its folders, with a diff from nothing', async () => {
    const result = await run('write_file', { file_path: 'sub/new.txt', content: 'hello' })
    expect(await readFile(join(dir, 'sub/new.txt'), 'utf8')).toBe('hello')
    expect(result.diff).toEqual({ path: join(dir, 'sub/new.txt'), oldText: null, newText: 'hello' })
  })

  it('replaces a file and keeps what it was in the diff', async () => {
    await writeFile(join(dir, 'a.txt'), 'old')
    const result = await run('write_file', { file_path: 'a.txt', content: 'new' })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('new')
    expect(result.diff?.oldText).toBe('old')
  })
})

describe('edit_file', () => {
  it('replaces text that occurs once, also when the new text holds $', async () => {
    await writeFile(join(dir, 'a.txt'), 'const price = 1\nconst other = 2\n')
    const result = await run('edit_file', { file_path: 'a.txt', old_string: 'price = 1', new_string: "price = '$&'" })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe("const price = '$&'\nconst other = 2\n")
    expect(result.diff).toEqual({ path: join(dir, 'a.txt'), oldText: 'price = 1', newText: "price = '$&'" })
  })

  it('refuses text that occurs more than once, and leaves the file', async () => {
    await writeFile(join(dir, 'a.txt'), 'x = 1\nx = 1\n')
    await expect(run('edit_file', { file_path: 'a.txt', old_string: 'x = 1', new_string: 'x = 2' })).rejects.toThrow(/occurs 2 times/)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('x = 1\nx = 1\n')
  })

  it('replaces every occurrence with replace_all', async () => {
    await writeFile(join(dir, 'a.txt'), 'x = 1\nx = 1\n')
    await run('edit_file', { file_path: 'a.txt', old_string: 'x = 1', new_string: 'x = 2', replace_all: true })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('x = 2\nx = 2\n')
  })

  it('refuses text that is not in the file', async () => {
    await writeFile(join(dir, 'a.txt'), 'abc')
    await expect(run('edit_file', { file_path: 'a.txt', old_string: 'zzz', new_string: 'y' })).rejects.toThrow(/not found/)
  })
})

describe('list_files', () => {
  beforeEach(async () => {
    await mkdir(join(dir, 'src/deep'), { recursive: true })
    await mkdir(join(dir, 'node_modules/pkg'), { recursive: true })
    await writeFile(join(dir, 'src/a.ts'), '')
    await writeFile(join(dir, 'src/deep/b.ts'), '')
    await writeFile(join(dir, 'src/c.md'), '')
    await writeFile(join(dir, 'node_modules/pkg/d.ts'), '')
  })

  it('lists a folder, folders with a slash', async () => {
    expect(textOf(await run('list_files', {}))).toBe('node_modules/\nsrc/')
    expect(textOf(await run('list_files', { path: 'src' }))).toBe('a.ts\nc.md\ndeep/')
  })

  it('finds files by glob, without node_modules', async () => {
    expect(textOf(await run('list_files', { pattern: '**/*.ts' })).split('\n')).toEqual(['src/a.ts', join('src/deep/b.ts')])
  })
})

describe('grep', () => {
  beforeEach(async () => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'src/a.ts'), 'const alpha = 1\nconst beta = 2\n')
    await writeFile(join(dir, 'src/b.md'), 'alpha in prose\n')
    await writeFile(join(dir, 'node_modules/x.ts'), 'const alpha = 3\n')
  })

  it('finds matching lines with path and line number', async () => {
    const found = textOf(await run('grep', { pattern: 'alpha\\s*=', path: 'src' }))
    expect(found).toBe(`${join(dir, 'src/a.ts')}:1:const alpha = 1`)
    expect(textOf(await run('grep', { pattern: 'nothing-like-this' }))).toBe('No matches.')
  })

  it('limits the files with a glob', async () => {
    expect(textOf(await run('grep', { pattern: 'alpha', path: 'src', glob: '*.md' }))).toBe(`${join(dir, 'src/b.md')}:1:alpha in prose`)
  })

  it('has a fallback without ripgrep that skips node_modules', async () => {
    const signal = new AbortController().signal
    expect((await grepFallback('alpha', dir, '', signal)).split('\n').sort()).toEqual([
      `${join(dir, 'src/a.ts')}:1:const alpha = 1`,
      `${join(dir, 'src/b.md')}:1:alpha in prose`
    ])
    expect(await grepFallback('alpha', dir, '*.ts', signal)).toBe(`${join(dir, 'src/a.ts')}:1:const alpha = 1`)
  })
})

describe('run_command', () => {
  it('runs in the project folder with the session\'s env, and answers the output', async () => {
    const result = await run('run_command', { command: 'pwd; echo "$WB_TEST_SECRET"; echo err >&2' }, { env: { WB_TEST_SECRET: 'from-session' } })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('from-session')
    expect(textOf(result)).toContain('err')
    expect(textOf(result)).toMatch(/wb-agent-tools-/)
    expect(result.title).toBe('pwd; echo "$WB_TEST_SECRET"; echo err >&2')
  })

  it('reports a failing exit code', async () => {
    const result = await run('run_command', { command: 'echo before; exit 3' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('before\n[exit code 3]')
  })

  it('stops a command at its timeout', async () => {
    const started = Date.now()
    const result = await run('run_command', { command: 'sleep 30', timeout_ms: 1000 })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Timed out')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('caps long output and keeps its end', async () => {
    const result = await run('run_command', { command: 'i=0; while [ $i -lt 6000 ]; do echo "line $i padding padding"; i=$((i+1)); done; echo THE-END' })
    const out = textOf(result)
    expect(out.length).toBeLessThan(31_000)
    expect(out.startsWith('[earlier output cut off]')).toBe(true)
    expect(out.endsWith('THE-END')).toBe(true)
  })

  it('kills the command and what it started on cancel', async () => {
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 200)
    const result = await run('run_command', { command: 'sh -c "sleep 30" ; echo never' }, { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('[Cancelled]')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('todo_write', () => {
  it('sends the whole plan', async () => {
    const result = await run('todo_write', { todos: [{ content: 'First', status: 'completed' }, { content: 'Then', status: 'odd' }, { status: 'pending' }] })
    expect(textOf(result)).toBe('Plan updated.')
    expect(plans.at(-1)).toEqual([{ content: 'First', status: 'completed' }, { content: 'Then', status: 'pending' }])
  })
})

describe('fetch_url', () => {
  it('answers a page as text', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html><head><style>p{}</style><script>var a</script></head><body><h1>Title</h1><p>One &amp; two</p></body></html>')
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    try {
      const result = await run('fetch_url', { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` })
      expect(textOf(result)).toBe('Title\nOne & two')
    } finally {
      server.close()
    }
  })

  it('refuses an address that is not http', async () => {
    await expect(run('fetch_url', { url: 'file:///etc/passwd' })).rejects.toThrow(/Only http/)
  })
})
