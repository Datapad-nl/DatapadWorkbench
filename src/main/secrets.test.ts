import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const dir = vi.hoisted(() => ({ path: '' }))
dir.path = mkdtempSync(join(tmpdir(), 'wb-secrets-'))

// A stand-in keychain: reversible, but never the plain text on disk.
vi.mock('electron', () => ({
  app: { getPath: () => dir.path },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString('hex')}`),
    decryptString: (sealed: Buffer) => {
      const text = sealed.toString()
      if (!text.startsWith('sealed:')) throw new Error('Not ours')
      return Buffer.from(text.slice('sealed:'.length), 'hex').toString()
    }
  }
}))

import {
  deleteSecret,
  envFingerprint,
  listSecrets,
  onSecretsChanged,
  secretEnv,
  secretNameError,
  secretScope,
  setSecret
} from './secrets'

afterAll(() => rmSync(dir.path, { recursive: true, force: true }))

describe('secrets vault', () => {
  it('keeps values encrypted per scope and gives them back as environment variables', async () => {
    const changes: string[] = []
    const off = onSecretsChanged((scope) => changes.push(scope))
    await setSecret('p1', 'STRIPE_KEY', 'sk_live_123')
    await setSecret('p1', 'OPENAI_KEY', 'sk-abc')
    await setSecret('bot:b1', 'TOKEN', 't0k')
    off()

    expect(await secretEnv('p1')).toEqual({ STRIPE_KEY: 'sk_live_123', OPENAI_KEY: 'sk-abc' })
    expect(await secretEnv('p2')).toEqual({})
    expect(await secretEnv(null)).toEqual({})
    expect(await listSecrets()).toEqual([
      { scope: 'p1', names: ['OPENAI_KEY', 'STRIPE_KEY'] },
      { scope: 'bot:b1', names: ['TOKEN'] }
    ])
    expect(changes).toEqual(['p1', 'p1', 'bot:b1'])
    const onDisk = readFileSync(join(dir.path, 'workbench', 'secrets.json'), 'utf8')
    expect(onDisk).not.toContain('sk_live_123')
    expect(onDisk).toContain('STRIPE_KEY')
  })

  it('deletes a secret and drops an empty scope', async () => {
    await deleteSecret('bot:b1', 'TOKEN')
    expect((await listSecrets()).map((item) => item.scope)).toEqual(['p1'])
    await expect(deleteSecret('bot:b1', 'TOKEN')).resolves.toBeUndefined()
  })

  it('refuses names that are not environment variables, and empty values', async () => {
    await expect(setSecret('p1', 'MY KEY', 'x')).rejects.toThrow('not a valid environment variable name')
    await expect(setSecret('p1', '1KEY', 'x')).rejects.toThrow('not a valid environment variable name')
    await expect(setSecret('p1', 'KEY', '')).rejects.toThrow('empty')
  })

  it('refuses names the agent itself runs on', async () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'XAI_API_KEY',
      'NODE_OPTIONS',
      'PATH',
      'https_proxy',
      'BASH_ENV',
      'GIT_SSH_COMMAND',
      'GIT_CONFIG_COUNT',
      'PYTHONSTARTUP',
      'NODE_EXTRA_CA_CERTS',
      '_JAVA_OPTIONS',
      'editor'
    ]) {
      expect(secretNameError(name)).toContain('used by the agent itself')
    }
    expect(secretNameError('STRIPE_API_KEY')).toBeNull()
    expect(secretNameError('AWS_SECRET_ACCESS_KEY')).toBeNull()
    await expect(setSecret('p1', 'ANTHROPIC_API_KEY', 'x')).rejects.toThrow('used by the agent itself')
  })

  it('scopes a chat to its project, or to its bot when it has none', () => {
    expect(secretScope({ projectId: 'p1', botId: 'b1' })).toBe('p1')
    expect(secretScope({ projectId: '', botId: 'b1' })).toBe('bot:b1')
    expect(secretScope({ projectId: '' })).toBeNull()
  })

  it('fingerprints an environment by its names and values, whatever their order', () => {
    expect(envFingerprint({ A: '1', B: '2' })).toBe(envFingerprint({ B: '2', A: '1' }))
    expect(envFingerprint({ A: '1' })).not.toBe(envFingerprint({ A: '2' }))
  })
})
