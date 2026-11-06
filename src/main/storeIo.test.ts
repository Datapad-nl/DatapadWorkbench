import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJsonFile, withLock, writeFileAtomic } from './storeIo'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'store-io-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('withLock', () => {
  it('runs calls with the same key one at a time, in order', async () => {
    let value = 0
    const seen: number[] = []
    const bump = (): Promise<void> =>
      withLock('key', async () => {
        const read = value
        await new Promise((resolve) => setTimeout(resolve, 5))
        value = read + 1
        seen.push(value)
      })
    await Promise.all([bump(), bump(), bump()])
    expect(value).toBe(3)
    expect(seen).toEqual([1, 2, 3])
  })

  it('releases the lock when the callback throws', async () => {
    await expect(withLock('key', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(withLock('key', async () => 'next')).resolves.toBe('next')
  })

  it('does not serialise different keys', async () => {
    const order: string[] = []
    let releaseSlow!: () => void
    const slow = withLock('a', async () => {
      await new Promise<void>((resolve) => {
        releaseSlow = resolve
      })
      order.push('a')
    })
    await withLock('b', async () => {
      order.push('b')
    })
    releaseSlow()
    await slow
    expect(order).toEqual(['b', 'a'])
  })
})

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temp files', async () => {
    const path = join(dir, 'nested', 'data.json')
    await writeFileAtomic(path, '{"a":1}')
    await writeFileAtomic(path, '{"a":2}')
    expect(await readFile(path, 'utf8')).toBe('{"a":2}')
    expect(await readdir(join(dir, 'nested'))).toEqual(['data.json'])
  })
})

describe('readJsonFile', () => {
  it('returns the fallback for a missing file', async () => {
    expect(await readJsonFile(join(dir, 'missing.json'), { empty: true })).toEqual({ empty: true })
  })

  it('moves a file that does not parse aside and returns the fallback', async () => {
    const path = join(dir, 'broken.json')
    await writeFile(path, '{"projects": [', 'utf8')
    let corrupt = ''
    const value = await readJsonFile(path, null, (aside) => {
      corrupt = aside
    })
    expect(value).toBeNull()
    const files = await readdir(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^broken\.json\.corrupt-\d+$/)
    expect(corrupt).toBe(join(dir, files[0]))
    expect(await readFile(join(dir, files[0]), 'utf8')).toBe('{"projects": [')
  })

  it('throws read errors other than a missing file', async () => {
    await expect(readJsonFile(dir, null)).rejects.toThrow()
  })
})
