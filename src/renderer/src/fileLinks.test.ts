import { describe, expect, it } from 'vitest'
import { createFileChecks } from './fileLinks'

function harness(exists: (src: string) => boolean = () => true) {
  let time = 0
  const calls: Array<{ chatId: string; srcs: string[] }> = []
  const pending: Array<() => void> = []
  const checks = createFileChecks({
    ask: async (chatId, srcs) => {
      calls.push({ chatId, srcs })
      return srcs.map(exists)
    },
    now: () => time,
    schedule: (run) => void pending.push(run)
  })
  const flush = async (): Promise<void> => {
    pending.splice(0).forEach((run) => run())
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { checks, calls, flush, advance: (ms: number) => (time += ms) }
}

describe('file checks', () => {
  it('asks once per chat for everything requested together', async () => {
    const { checks, calls, flush } = harness()
    checks.request('c1', 'a.md')
    checks.request('c1', 'b.md')
    checks.request('c2', 'a.md')
    await flush()
    expect(calls).toEqual([
      { chatId: 'c1', srcs: ['a.md', 'b.md'] },
      { chatId: 'c2', srcs: ['a.md'] }
    ])
    expect(checks.known('c1', 'b.md')).toBe(true)
  })

  it('asks once for a path requested again while its answer is on its way', async () => {
    const { checks, calls, flush } = harness()
    checks.request('c1', 'a.md')
    checks.request('c1', 'a.md')
    await flush()
    checks.request('c1', 'a.md')
    await flush()
    expect(calls).toEqual([{ chatId: 'c1', srcs: ['a.md'] }])
  })

  it('keeps a file that exists', async () => {
    const { checks, calls, flush, advance } = harness()
    checks.request('c1', 'a.md')
    await flush()
    advance(60_000)
    checks.request('c1', 'a.md')
    await flush()
    expect(calls).toHaveLength(1)
    expect(checks.known('c1', 'a.md')).toBe(true)
  })

  it('asks again about a missing file only after a while', async () => {
    let made = false
    const { checks, calls, flush, advance } = harness(() => made)
    checks.request('c1', 'x.md')
    await flush()
    expect(checks.known('c1', 'x.md')).toBe(false)
    made = true
    advance(4000)
    checks.request('c1', 'x.md')
    await flush()
    expect(calls).toHaveLength(1)
    advance(1500)
    checks.request('c1', 'x.md')
    await flush()
    expect(calls).toHaveLength(2)
    expect(checks.known('c1', 'x.md')).toBe(true)
  })

  it('tells every subscriber of the path when it turns out to exist', async () => {
    let made = false
    const { checks, flush, advance } = harness(() => made)
    let first = 0
    let second = 0
    let other = 0
    checks.subscribe('c1', 'x.md', () => (first += 1))
    const stop = checks.subscribe('c1', 'x.md', () => (second += 1))
    checks.subscribe('c1', 'y.md', () => (other += 1))
    checks.request('c1', 'x.md')
    await flush()
    const [afterFirst, afterSecond] = [first, second]
    made = true
    advance(6000)
    stop()
    checks.request('c1', 'x.md')
    await flush()
    expect(first).toBe(afterFirst + 1)
    expect(second).toBe(afterSecond)
    expect(other).toBe(0)
  })

  it('rechecks the missing paths on screen when the chat says so, at once', async () => {
    let made = false
    const { checks, calls, flush } = harness(() => made)
    checks.subscribe('c1', 'x.md', () => {})
    checks.request('c1', 'x.md')
    checks.request('c1', 'gone.md')
    checks.request('c1', 'ok.md')
    await flush()
    made = true
    checks.recheckChat('c1')
    checks.recheckChat('c2')
    await flush()
    // gone.md is not on screen; c2 has nothing.
    expect(calls[1]).toEqual({ chatId: 'c1', srcs: ['x.md'] })
    expect(calls).toHaveLength(2)
    expect(checks.known('c1', 'x.md')).toBe(true)
  })

  it('treats a failed call as missing, so it is asked again later', async () => {
    let time = 0
    let fail = true
    const pending: Array<() => void> = []
    const checks = createFileChecks({
      ask: async (_chatId, srcs) => {
        if (fail) throw new Error('ipc')
        return srcs.map(() => true)
      },
      now: () => time,
      schedule: (run) => void pending.push(run)
    })
    const flush = async (): Promise<void> => {
      pending.splice(0).forEach((run) => run())
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    checks.request('c1', 'a.md')
    await flush()
    expect(checks.known('c1', 'a.md')).toBe(false)
    fail = false
    time = 6000
    checks.request('c1', 'a.md')
    await flush()
    expect(checks.known('c1', 'a.md')).toBe(true)
  })
})
