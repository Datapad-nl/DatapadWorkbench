import { describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({ replies: [] as string[], calls: 0 }))
vi.mock('child_process', () => ({
  execFile: (_file: string, _args: string[], _opts: unknown, done: (error: Error | null, stdout: string) => void) => {
    stub.calls += 1
    const stdout = stub.replies.shift() ?? ''
    // A timed-out probe is killed with nothing printed.
    setTimeout(() => done(stdout ? null : new Error('timed out'), stdout), 0)
  }
}))

const forked = vi.hoisted(() => ({
  calls: [] as Array<{ script: string; args: string[]; env: NodeJS.ProcessEnv }>,
  posted: [] as Array<string | null>,
  child: null as null | import('events').EventEmitter
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('events')
  const { PassThrough } = await import('stream')
  return {
    app: { getAppPath: () => process.cwd() },
    utilityProcess: {
      fork: (script: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        forked.calls.push({ script, args, env: options.env })
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          postMessage: (data: string | null) => forked.posted.push(data),
          kill: () => {
            child.emit('exit', 0)
            return true
          }
        })
        forked.child = child
        return child
      }
    }
  }
})

import { getClaudeCliInfo, startClaudeAdapter } from './claudeCli'

describe('Claude sign-in probe', () => {
  it('asks again after a probe that gave no answer, and keeps a signed-in run off the API key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    stub.replies = ['', JSON.stringify({ loggedIn: true, subscriptionType: 'max', email: null })]

    expect((await getClaudeCliInfo()).signedIn).toBe(false)
    await startClaudeAdapter()
    expect(stub.calls).toBe(2)
    expect(forked.calls[0].env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(forked.calls[0].env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})

describe('Claude adapter in a utility process', () => {
  it('runs the adapter through the host script and feeds its stdin over the parent port', async () => {
    forked.calls.length = 0
    forked.posted.length = 0
    const proc = await startClaudeAdapter()
    expect(forked.calls[0].script).toMatch(/claude-acp-host\.mjs$/)
    expect(forked.calls[0].args[0]).toMatch(/claude-agent-acp[\\/]dist[\\/]index\.js$/)

    // Input written before the process has started waits for it.
    proc.stdin.write('{"id":1}\n')
    expect(forked.posted).toEqual([])
    forked.child?.emit('spawn')
    expect(forked.posted).toEqual(['{"id":1}\n'])
    await new Promise<void>((resolve) => proc.stdin.end(resolve))
    expect(forked.posted).toEqual(['{"id":1}\n', null])

    const exited = new Promise<void>((resolve) => proc.on('exit', resolve))
    expect(proc.killed).toBe(false)
    expect(proc.kill()).toBe(true)
    await exited
    expect(proc.killed).toBe(true)
    expect(proc.kill()).toBe(false)
  })

  it('kills a process stopped before it started once it starts, and reports a fatal error', async () => {
    const proc = await startClaudeAdapter()
    const child = forked.child as import('events').EventEmitter & { kill: () => boolean }
    let kills = 0
    const kill = child.kill
    child.kill = () => {
      kills += 1
      return kill()
    }
    proc.stdin.write('{"id":1}\n')
    expect(proc.kill()).toBe(true)
    expect(kills).toBe(0)
    forked.posted.length = 0
    child.emit('spawn')
    expect(kills).toBe(1)
    expect(forked.posted).toEqual([])

    const second = await startClaudeAdapter()
    const errors: Error[] = []
    second.on('error', (error) => errors.push(error))
    forked.child?.emit('error', 'FatalError', 'adapter.js:1')
    expect(errors.map((error) => error.message)).toEqual(['FatalError at adapter.js:1'])
  })
})
