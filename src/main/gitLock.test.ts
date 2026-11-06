import { execFileSync } from 'child_process'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withRepoLock } from './gitLock'

let root = ''
let repoA = ''
let worktreeA = ''
let repoB = ''

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    stdio: 'ignore'
  })
}

async function makeRepo(path: string): Promise<void> {
  await mkdir(path)
  git(path, ['init', '-q'])
  git(path, ['commit', '-q', '--allow-empty', '-m', 'start'])
}

/** A task that holds the lock until `release` is called, and records when it ran. */
function held(order: string[], name: string): { run: () => Promise<void>; release: () => void; started: Promise<void> } {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve
  })
  return {
    run: async () => {
      order.push(`${name}:start`)
      started()
      await gate
      order.push(`${name}:end`)
    },
    release: () => release(),
    started: startedPromise
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'git-lock-'))
  repoA = join(root, 'a')
  repoB = join(root, 'b')
  worktreeA = join(root, 'a-worktree')
  await makeRepo(repoA)
  await makeRepo(repoB)
  git(repoA, ['worktree', 'add', '-q', '-b', 'chat', worktreeA])
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('withRepoLock', () => {
  it('runs writes to a repository and its worktrees one at a time, in order', async () => {
    const order: string[] = []
    const first = held(order, 'main')
    const running = withRepoLock(repoA, first.run)
    await first.started
    // Calls queue once their repository is known, so give each lookup time to finish before the next call.
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300))
    const second = withRepoLock(worktreeA, async () => {
      order.push('worktree')
    })
    await settle()
    const third = withRepoLock(join(repoA, '.'), async () => {
      order.push('main-again')
    })
    await settle()
    expect(order).toEqual(['main:start'])
    first.release()
    await Promise.all([running, second, third])
    expect(order).toEqual(['main:start', 'main:end', 'worktree', 'main-again'])
  })

  it('does not make another repository wait', async () => {
    const order: string[] = []
    const slow = held(order, 'a')
    const running = withRepoLock(repoA, slow.run)
    await slow.started
    await withRepoLock(repoB, async () => {
      order.push('b')
    })
    expect(order).toEqual(['a:start', 'b'])
    slow.release()
    await running
  })

  it('lets the next write run after one fails', async () => {
    await expect(
      withRepoLock(repoA, async () => {
        throw new Error('index.lock exists')
      })
    ).rejects.toThrow('index.lock exists')
    await expect(withRepoLock(worktreeA, async () => 'next')).resolves.toBe('next')
  })

  it('still locks a folder that is not a repository, by its own path', async () => {
    const plain = join(root, 'plain')
    await mkdir(plain, { recursive: true })
    const order: string[] = []
    const first = held(order, 'one')
    const running = withRepoLock(plain, first.run)
    await first.started
    const second = withRepoLock(plain, async () => {
      order.push('two')
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(order).toEqual(['one:start'])
    first.release()
    await Promise.all([running, second])
    expect(order).toEqual(['one:start', 'one:end', 'two'])
  })
})
