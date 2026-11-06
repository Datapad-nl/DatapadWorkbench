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

import { claudeAcpCommand, getClaudeCliInfo } from './claudeCli'

describe('Claude sign-in probe', () => {
  it('asks again after a probe that gave no answer, and keeps a signed-in run off the API key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    stub.replies = ['', JSON.stringify({ loggedIn: true, subscriptionType: 'max', email: null })]

    expect((await getClaudeCliInfo()).signedIn).toBe(false)
    const command = await claudeAcpCommand()
    expect(stub.calls).toBe(2)
    expect(command.env.ANTHROPIC_API_KEY).toBeUndefined()
  })
})
