import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { grokBinary } from './grokCli'
import { grokBuildSignedIn, listGrokSessions } from './sessions'

describe('GROK_HOME', () => {
  let dir = ''

  afterEach(() => {
    vi.unstubAllEnvs()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('reads sessions and the sign-in from GROK_HOME when it is set', async () => {
    dir = mkdtempSync(join(tmpdir(), 'grok-home-'))
    vi.stubEnv('GROK_HOME', dir)
    expect(grokBuildSignedIn()).toBe(false)
    expect(await listGrokSessions()).toEqual([])

    writeFileSync(join(dir, 'auth.json'), '{"token":"x"}')
    mkdirSync(join(dir, 'sessions'))
    expect(grokBuildSignedIn()).toBe(true)
  })

  it('finds the grok binary under GROK_HOME', () => {
    dir = mkdtempSync(join(tmpdir(), 'grok-home-'))
    vi.stubEnv('GROK_HOME', dir)
    vi.stubEnv('GROK_BIN', '')
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'grok'), '')
    expect(grokBinary()).toBe(join(dir, 'bin', 'grok'))
  })
})
