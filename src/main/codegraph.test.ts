import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectIndex } from '../shared/types'

// The real home may hold an installed CLI, and the real temp folder counts as unsafe to index.
const paths = vi.hoisted(() => ({ home: '' }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const fake = { ...actual, homedir: () => paths.home, tmpdir: () => '/nonexistent-tmp' }
  return { ...fake, default: fake }
})

// A stand-in CLI. It logs each command, reports .codegraph as the index, and init creates it.
// A fail-init file next to it fails the next init, and slow-status holds back the next status
// answer, read before the wait. A parent-index file reports an index for any folder, as the real
// CLI does for a folder inside an indexed one. In the folder, slow-init slows init down,
// count sets the reported file count, and sync makes next-count the count.
const FAKE_CLI = `#!/bin/sh
echo "$1" >> "$(dirname "$0")/calls.log"
case "$1" in
  status)
    if [ -f "$(dirname "$0")/hang" ]; then trap '' TERM; echo started >> "$(dirname "$0")/calls.log"; sleep 3; fi
    count=3; if [ -f "$3/count" ]; then count=$(cat "$3/count"); fi
    if [ -d "$3/.codegraph" ] || [ -f "$(dirname "$0")/parent-index" ]; then out="{\\"initialized\\":true,\\"fileCount\\":$count,\\"nodeCount\\":9,\\"languages\\":[\\"typescript\\"]}"
    else out='{"initialized":false}'; fi
    if [ -f "$(dirname "$0")/slow-status" ]; then rm "$(dirname "$0")/slow-status"; sleep 1.5; fi
    echo "$out" ;;
  init)
    if [ -f "$(dirname "$0")/fail-init" ]; then rm "$(dirname "$0")/fail-init"; echo boom >&2; exit 1; fi
    if [ -f "$3/slow-init" ]; then sleep 1.5; fi
    sleep 0.2; mkdir -p "$3/.codegraph" ;;
  sync)
    if [ -f "$3/next-count" ]; then mv "$3/next-count" "$3/count"; fi ;;
  files)
    if [ "$4" = "--json" ]; then echo '[{"path":"src/main.ts","language":"typescript","nodeCount":4,"size":10}]'
    else printf '\\033[1m\\nProject Structure (1 files):\\n\\033[0m\\n├── src\\n│   └── main.ts\\n'; fi ;;
esac
`

let root = ''
let bin = ''
let folder = ''
const env = { bin: process.env.CODEGRAPH_BIN, path: process.env.PATH }

function project(id: string): Project {
  return { id, name: id, path: folder, createdAt: '', updatedAt: '' }
}

async function installFakeCli(): Promise<void> {
  await writeFile(bin, FAKE_CLI)
  await chmod(bin, 0o755)
}

async function calls(): Promise<string[]> {
  const log = await readFile(join(root, 'bin', 'calls.log'), 'utf8').catch(() => '')
  return log.split('\n').filter(Boolean)
}

beforeEach(async () => {
  const { tmpdir } = await vi.importActual<typeof import('os')>('os')
  root = await mkdtemp(join(tmpdir(), 'codegraph-'))
  paths.home = join(root, 'home')
  folder = join(root, 'project')
  bin = join(root, 'bin', 'codegraph')
  await mkdir(paths.home)
  await mkdir(folder)
  await mkdir(join(root, 'bin'))
  process.env.CODEGRAPH_BIN = bin
  process.env.PATH = '/usr/bin:/bin'
  vi.resetModules()
})

afterEach(async () => {
  vi.useRealTimers()
  if (env.bin === undefined) delete process.env.CODEGRAPH_BIN
  else process.env.CODEGRAPH_BIN = env.bin
  process.env.PATH = env.path
  await rm(root, { recursive: true, force: true })
})

describe('isUnsafeProjectPath', () => {
  it('refuses the shared temp folder itself, but not a project inside it', async () => {
    const { isUnsafeProjectPath } = await import('./codegraph')
    expect(isUnsafeProjectPath('/tmp')).toBe(true)
    expect(isUnsafeProjectPath('/private/tmp/')).toBe(true)
    expect(isUnsafeProjectPath('/tmp/scratch')).toBe(false)
  })
})

describe('queueIndex', () => {
  it('reports one shared job to every project with the same folder', async () => {
    await installFakeCli()
    const codegraph = await import('./codegraph')
    const latest = new Map<string, ProjectIndex>()
    codegraph.onIndexChange((index) => latest.set(index.projectId, index))
    codegraph.queueIndex('a', folder)
    codegraph.queueIndex('b', folder)
    await vi.waitFor(
      () => {
        expect(latest.get('a')?.state).toBe('indexed')
        expect(latest.get('b')?.state).toBe('indexed')
      },
      { timeout: 5_000, interval: 20 }
    )
    expect((await calls()).filter((call) => call === 'init')).toHaveLength(1)
    // Longer than the waits inside, which spawn real processes and slow down on a busy machine.
  }, 15_000)
})

describe('readIndex', () => {
  it('reads again once the .codegraph folder is gone', async () => {
    await installFakeCli()
    await mkdir(join(folder, '.codegraph'))
    const { readIndex } = await import('./codegraph')
    expect((await readIndex(project('a'))).state).toBe('indexed')
    await rm(join(folder, '.codegraph'), { recursive: true })
    expect((await readIndex(project('a'))).state).toBe('not-indexed')
  })

  it('does not count a parent folder’s index as the project’s, and keeps that answer', async () => {
    await installFakeCli()
    await writeFile(join(root, 'bin', 'parent-index'), '')
    const { readIndex } = await import('./codegraph')
    expect((await readIndex(project('a'))).state).toBe('not-indexed')
    expect((await readIndex(project('a'))).state).toBe('not-indexed')
    expect((await calls()).filter((call) => call === 'status')).toHaveLength(1)
  })

  it('looks for a missing CLI again after a while', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { readIndex } = await import('./codegraph')
    expect((await readIndex(project('a'))).state).toBe('missing-cli')
    await installFakeCli()
    expect((await readIndex(project('a'))).state).toBe('missing-cli')
    vi.setSystemTime(Date.now() + 61_000)
    expect((await readIndex(project('a'))).state).toBe('not-indexed')
  })

  it('fails a timed-out command only once it has exited', async () => {
    await installFakeCli()
    await writeFile(join(root, 'bin', 'hang'), '')
    const wait = globalThis.setTimeout
    const pause = (ms: number): Promise<void> => new Promise((resolve) => wait(resolve, ms))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { readIndex } = await import('./codegraph')
    let settled = false
    const read = readIndex(project('a')).finally(() => {
      settled = true
    })
    // The CLI ignores SIGTERM once it has started, so only the SIGKILL 2s later ends it.
    await vi.waitFor(async () => expect(await calls()).toContain('started'), { timeout: 5_000, interval: 20 })
    vi.advanceTimersByTime(20_000)
    await pause(300)
    expect(settled).toBe(false)
    vi.advanceTimersByTime(2_000)
    expect((await read).state).toBe('error')
  }, 15_000)
})

/** Every index event, by project, in the order they came. */
function record(codegraph: typeof import('./codegraph')): Map<string, ProjectIndex[]> {
  const seen = new Map<string, ProjectIndex[]>()
  codegraph.onIndexChange((index) => seen.set(index.projectId, [...(seen.get(index.projectId) ?? []), index]))
  return seen
}

const waitLong = { timeout: 8_000, interval: 20 }

describe('re-indexing', () => {
  it('starts a new init when queued after a failed one, or after the index was removed', async () => {
    await installFakeCli()
    await writeFile(join(root, 'bin', 'fail-init'), '')
    const codegraph = await import('./codegraph')
    const seen = record(codegraph)
    const last = (): ProjectIndex | undefined => seen.get('a')?.at(-1)

    codegraph.queueIndex('a', folder)
    await vi.waitFor(() => expect(last()).toMatchObject({ state: 'error', error: 'boom' }), waitLong)
    codegraph.queueIndex('a', folder)
    await vi.waitFor(() => expect(last()?.state).toBe('indexed'), waitLong)

    await rm(join(folder, '.codegraph'), { recursive: true })
    codegraph.queueIndex('a', folder)
    await vi.waitFor(() => expect(last()?.state).toBe('indexing'), waitLong)
    await vi.waitFor(() => expect(last()?.state).toBe('indexed'), waitLong)
    expect((await calls()).filter((call) => call === 'init')).toHaveLength(3)
  }, 20_000)

  it('keeps a job for a project’s old folder from reporting to it after the project moved', async () => {
    await installFakeCli()
    const moved = join(root, 'moved')
    await mkdir(moved)
    await writeFile(join(folder, 'slow-init'), '')
    await writeFile(join(folder, 'count'), '1')
    await writeFile(join(moved, 'count'), '2')
    const codegraph = await import('./codegraph')
    const seen = record(codegraph)

    codegraph.queueIndex('a', folder)
    await vi.waitFor(async () => expect(await calls()).toContain('init'), waitLong)
    codegraph.queueIndex('a', moved)
    await vi.waitFor(() => expect(seen.get('a')?.at(-1)).toMatchObject({ state: 'indexed', fileCount: 2 }), waitLong)
    // A project still on the old folder shares its job, and hears when it ends.
    codegraph.queueIndex('b', folder)
    await vi.waitFor(() => expect(seen.get('b')?.at(-1)).toMatchObject({ state: 'indexed', fileCount: 1 }), waitLong)

    expect(seen.get('a')?.some((index) => index.fileCount === 1)).toBe(false)
    expect(seen.get('a')?.at(-1)).toMatchObject({ state: 'indexed', fileCount: 2 })
  }, 20_000)
})

describe('readIndex racing a job', () => {
  it('does not let a read that started before a job overwrite what the job reported', async () => {
    await installFakeCli()
    await writeFile(join(root, 'bin', 'slow-status'), '')
    const codegraph = await import('./codegraph')
    const seen = record(codegraph)

    const reading = codegraph.readIndex(project('a'))
    await vi.waitFor(async () => expect(await calls()).toContain('status'), waitLong)
    codegraph.queueIndex('a', folder)
    await vi.waitFor(() => expect(seen.get('a')?.at(-1)?.state).toBe('indexed'), waitLong)

    // The read answered "not indexed" before the job ran, and lands after it.
    expect((await reading).state).toBe('indexed')
    expect((await codegraph.readIndex(project('a'))).state).toBe('indexed')
  }, 15_000)

  it('forgets a removed project, so a job still running for its folder stays quiet', async () => {
    await installFakeCli()
    await writeFile(join(folder, 'slow-init'), '')
    const codegraph = await import('./codegraph')
    const seen = record(codegraph)

    codegraph.queueIndex('a', folder)
    await vi.waitFor(async () => expect(await calls()).toContain('init'), waitLong)
    codegraph.forgetProjectIndex('a')
    const before = seen.get('a')?.length
    await new Promise((resolve) => setTimeout(resolve, 2_500))

    expect(seen.get('a')?.length).toBe(before)
  }, 15_000)
})

describe('syncIndex', () => {
  it('brings the index up to date, so the next read reports the new counts', async () => {
    await installFakeCli()
    await mkdir(join(folder, '.codegraph'))
    const { readIndex, syncIndex } = await import('./codegraph')
    expect((await readIndex(project('a'))).fileCount).toBe(3)
    await writeFile(join(folder, 'next-count'), '7')
    // Files changed since the last read. The cached read doesn't know.
    expect((await readIndex(project('a'))).fileCount).toBe(3)

    await syncIndex(project('a'))
    expect((await readIndex(project('a'))).fileCount).toBe(7)
    expect(await calls()).toContain('sync')
  })

  it('leaves a folder that was never indexed alone', async () => {
    await installFakeCli()
    const { syncIndex } = await import('./codegraph')
    await syncIndex(project('a'))
    expect(await calls()).not.toContain('sync')
  })
})

describe('buildOrientation', () => {
  it('keeps the CLI’s terminal styling out of the indexed tree', async () => {
    await installFakeCli()
    await mkdir(join(folder, '.codegraph'))
    const { buildOrientation } = await import('./codegraph')
    expect((await buildOrientation(project('a'))).tree).toBe('├── src\n│   └── main.ts')
  })
})

describe('listIndexedFiles', () => {
  it('lists what the index holds, and nothing for a folder without one', async () => {
    await installFakeCli()
    const { listIndexedFiles } = await import('./codegraph')
    expect(await listIndexedFiles(project('a'))).toBeNull()
    await mkdir(join(folder, '.codegraph'))
    expect(await listIndexedFiles(project('a'))).toEqual([{ path: 'src/main.ts', language: 'typescript', nodeCount: 4 }])
  })
})

describe('readIndex failures', () => {
  it('reports a CLI that fails to start as an error, without caching it or failing the other projects', async () => {
    // There but not executable, so spawning it fails.
    await writeFile(bin, FAKE_CLI)
    const { collectIndexes, readIndex } = await import('./codegraph')
    const indexes = await collectIndexes([project('a'), { ...project('b'), path: null }])
    expect(indexes.a.state).toBe('error')
    expect(indexes.b.state).toBe('no-folder')

    await chmod(bin, 0o755)
    expect((await readIndex(project('a'))).state).toBe('not-indexed')
  })
})

describe('stopCodegraphJobs', () => {
  it('reports no error for the init it kills at quit, and queues nothing after', async () => {
    await installFakeCli()
    await writeFile(join(folder, 'slow-init'), '')
    const codegraph = await import('./codegraph')
    const seen = record(codegraph)
    codegraph.queueIndex('a', folder)
    await vi.waitFor(async () => expect(await calls()).toContain('init'), waitLong)
    const before = seen.get('a')?.length ?? 0

    codegraph.stopCodegraphJobs()
    codegraph.queueIndex('a', folder)
    codegraph.queueIndex('c', folder)
    await new Promise((resolve) => setTimeout(resolve, 2_000))

    expect(seen.get('a')?.length).toBe(before)
    expect(seen.get('a')?.some((index) => index.state === 'error')).toBe(false)
    expect(seen.has('c')).toBe(false)
    expect((await calls()).filter((call) => call === 'init')).toHaveLength(1)
  }, 15_000)
})

describe('installing the CLI', () => {
  it('runs one install for every project waiting on it', async () => {
    // Stand-ins for curl and npm that fail, on a PATH with nothing else, so no real installer can run.
    const fakeBin = join(root, 'fakebin')
    const log = join(root, 'install.log')
    await mkdir(fakeBin)
    await symlink('/bin/sh', join(fakeBin, 'sh'))
    for (const tool of ['curl', 'npm']) {
      await writeFile(join(fakeBin, tool), `#!/bin/sh\necho ${tool} >> "${log}"\n/bin/sleep 0.5\nexit 1\n`)
      await chmod(join(fakeBin, tool), 0o755)
    }
    process.env.PATH = fakeBin
    const home = process.env.HOME
    process.env.HOME = paths.home
    try {
      const other = join(root, 'other')
      await mkdir(other)
      const codegraph = await import('./codegraph')
      const seen = record(codegraph)
      codegraph.queueIndex('a', folder)
      codegraph.queueIndex('b', other)
      await vi.waitFor(() => {
        expect(seen.get('a')?.at(-1)?.state).toBe('missing-cli')
        expect(seen.get('b')?.at(-1)?.state).toBe('missing-cli')
      }, waitLong)
      expect(seen.get('a')?.some((index) => index.state === 'installing')).toBe(true)
      expect(seen.get('b')?.some((index) => index.state === 'installing')).toBe(true)
      const installs = (await readFile(log, 'utf8')).split('\n').filter(Boolean)
      expect(installs).toEqual(['curl', 'npm'])
    } finally {
      process.env.HOME = home
    }
  }, 15_000)
})
