import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({
  dir: '',
  fetch: vi.fn<(url: string, init: { headers: Record<string, string> }) => Promise<Response>>()
}))
// A stand-in keychain: reversible, but never the plain text on disk.
vi.mock('electron', () => ({
  app: { getPath: () => stub.dir },
  net: { fetch: (url: string, init: { headers: Record<string, string> }) => stub.fetch(url, init) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString('hex')}`),
    decryptString: (sealed: Buffer) => Buffer.from(sealed.toString().slice('sealed:'.length), 'hex').toString()
  }
}))
const cli = vi.hoisted(() => ({ path: 'grok', version: '1.0.92', channel: 'stable' as const, models: ['grok-4.6', 'grok-4.5'] }))
vi.mock('./grokCli', () => ({
  grokBinary: () => 'grok',
  getGrokCliInfo: async () => cli,
  peekGrokCliInfo: () => cli,
  resetGrokCliInfo: vi.fn()
}))
vi.mock('./claudeCli', () => ({
  getClaudeCliInfo: async () => ({ signedIn: false, subscription: null, email: null }),
  peekClaudeCliInfo: () => ({ signedIn: false, subscription: null, email: null })
}))

import { DEFAULT_MODEL, type ProviderModel } from '../shared/types'
import {
  clampEffort,
  listProviderModels,
  parseProviderModels,
  providerEnv,
  providerModelEfforts,
  removeProvider,
  renderProvidersToml,
  saveProvider,
  tomlString,
  withProvidersBlock
} from './providers'
import { ensureStore, grokModelFor, updateSettings, type StoredProvider } from './store'

const sonnet: ProviderModel = {
  id: 'anthropic/claude-sonnet-4.5',
  name: 'Sonnet 4.5',
  contextWindow: 200000,
  efforts: ['low', 'high']
}

function stored(overrides: Partial<StoredProvider>): StoredProvider {
  return {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    backend: 'chat_completions',
    apiKey: '',
    models: [],
    ...overrides
  }
}

describe('tomlString', () => {
  it('escapes quotes, backslashes and control characters', () => {
    expect(tomlString('plain')).toBe('"plain"')
    expect(tomlString('say "hi" \\ there')).toBe('"say \\"hi\\" \\\\ there"')
    expect(tomlString('a\nb\tc\rd')).toBe('"a\\nb\\tc\\rd"')
    expect(tomlString('\u0001\u007f')).toBe('"\\u0001\\u007f"')
    expect(tomlString('é ✓')).toBe('"é ✓"')
  })
})

describe('renderProvidersToml', () => {
  it('writes a provider table and a model table per model, the key only as a variable name', () => {
    const toml = renderProvidersToml([stored({ apiKey: 'sk-secret', models: [sonnet, { id: 'meta/llama', name: 'Llama', efforts: [] }] })])
    expect(toml).toBe(
      [
        '[model_providers."wb-openrouter"]',
        'base_url = "https://openrouter.ai/api/v1"',
        'env_key = "WB_PROVIDER_OPENROUTER_KEY"',
        '',
        '[model."wb-openrouter-anthropic-claude-sonnet-4-5"]',
        'model = "anthropic/claude-sonnet-4.5"',
        'model_provider = "wb-openrouter"',
        'api_backend = "chat_completions"',
        'name = "Sonnet 4.5 (OpenRouter)"',
        'context_window = 200000',
        'reasoning_efforts = [{ value = "low" }, { value = "high" }]',
        '',
        '[model."wb-openrouter-meta-llama"]',
        'model = "meta/llama"',
        'model_provider = "wb-openrouter"',
        'api_backend = "chat_completions"',
        'name = "Llama (OpenRouter)"'
      ].join('\n')
    )
    expect(toml).not.toContain('sk-secret')
  })

  it('sends Anthropic’s own API the key as x-api-key, other Messages endpoints a bearer key', () => {
    const anthropic = renderProvidersToml([
      stored({ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', backend: 'messages' })
    ])
    expect(anthropic).toContain('env_http_headers = { "x-api-key" = "WB_PROVIDER_ANTHROPIC_KEY" }')
    expect(anthropic).toContain('extra_headers = { "anthropic-version" = "2023-06-01" }')
    expect(anthropic).not.toContain('env_key')
    const gateway = renderProvidersToml([stored({ id: 'or-msg', backend: 'messages' })])
    expect(gateway).toContain('env_key = "WB_PROVIDER_OR_MSG_KEY"')
    expect(gateway).not.toContain('x-api-key')
  })

  it('escapes names and ids', () => {
    const toml = renderProvidersToml([stored({ name: 'My "Box"', models: [{ id: 'a"b\\c', name: 'Line\nbreak', efforts: [] }] })])
    expect(toml).toContain('model = "a\\"b\\\\c"')
    expect(toml).toContain('name = "Line\\nbreak (My \\"Box\\")"')
  })

  it('is empty without providers', () => {
    expect(renderProvidersToml([])).toBe('')
  })
})

describe('withProvidersBlock', () => {
  const toml = '[model_providers."wb-x"]\nbase_url = "http://x"'

  it('appends the block at the end, after a blank line', () => {
    const next = withProvidersBlock('[models]\ndefault = "grok-4.6"\n', toml)
    expect(next.startsWith('[models]\ndefault = "grok-4.6"\n\n# >>> Datapad Workbench providers\n')).toBe(true)
    expect(next).toContain(`\n\n${toml}\n\n# <<< Datapad Workbench providers\n`)
    expect(next.split('\n')[4]).toMatch(/^# Datapad Workbench rewrites this block/)
  })

  it('ends a last line without a newline first', () => {
    expect(withProvidersBlock('a = 1', toml).startsWith('a = 1\n\n# >>> ')).toBe(true)
  })

  it('makes an empty file the block alone', () => {
    expect(withProvidersBlock('', toml).startsWith('# >>> Datapad Workbench providers\n')).toBe(true)
  })

  it('replaces an earlier block in place and keeps the text around it', () => {
    const before = '# mine\na = 1\n\n'
    const after = '\n[features]\ntelemetry = false\n'
    const config = withProvidersBlock(before, toml).replace(/\n$/, '') + '\n' + after
    const next = withProvidersBlock(config, '[model_providers."wb-y"]\nbase_url = "http://y"')
    expect(next.startsWith(before)).toBe(true)
    expect(next.endsWith(after)).toBe(true)
    expect(next).toContain('wb-y')
    expect(next).not.toContain('wb-x')
  })

  it('removes the block when there are no providers, back to the file it was', () => {
    const original = '[models]\ndefault = "grok-4.6"\n'
    expect(withProvidersBlock(withProvidersBlock(original, toml), '')).toBe(original)
    expect(withProvidersBlock(withProvidersBlock('', toml), '')).toBe('')
    const middle = withProvidersBlock('a = 1\n', toml) + '\nb = 2\n'
    expect(withProvidersBlock(middle, '')).toBe('a = 1\n\n\nb = 2\n')
  })

  it('leaves a file without a block alone when there are no providers', () => {
    expect(withProvidersBlock('a = 1', '')).toBe('a = 1')
  })

  it('is the same text when nothing changed', () => {
    const once = withProvidersBlock('a = 1\n', toml)
    expect(withProvidersBlock(once, toml)).toBe(once)
  })
})

describe('parseProviderModels', () => {
  it('reads OpenRouter’s name, context length and reasoning', () => {
    const models = parseProviderModels({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.5',
          name: 'Anthropic: Claude Sonnet 4.5',
          context_length: 1000000,
          supported_parameters: ['tools', 'reasoning']
        },
        { id: 'meta/llama', name: 'Meta: Llama', context_length: 131072, supported_parameters: ['tools'] }
      ]
    })
    expect(models).toEqual([
      {
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Anthropic: Claude Sonnet 4.5',
        contextWindow: 1000000,
        efforts: ['low', 'medium', 'high']
      },
      { id: 'meta/llama', name: 'Meta: Llama', contextWindow: 131072, efforts: [] }
    ])
  })

  it('names an OpenAI-compatible model by its id', () => {
    expect(parseProviderModels({ object: 'list', data: [{ id: 'gpt-5', object: 'model', owned_by: 'openai' }] })).toEqual([
      { id: 'gpt-5', name: 'gpt-5', efforts: [] }
    ])
  })

  it('reads Anthropic’s display name', () => {
    expect(
      parseProviderModels({
        data: [{ type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }],
        has_more: false
      })
    ).toEqual([{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', efforts: [] }])
  })

  it('skips rows without an id and refuses a body without a list', () => {
    expect(parseProviderModels({ data: [{ name: 'x' }, null, { id: 'ok' }] })).toEqual([{ id: 'ok', name: 'ok', efforts: [] }])
    expect(() => parseProviderModels({ error: 'nope' })).toThrow('no models')
  })
})

describe('clampEffort', () => {
  it('keeps an offered level', () => {
    expect(clampEffort('medium', ['low', 'medium', 'high'])).toBe('medium')
  })

  it('takes the highest offered for xhigh and max', () => {
    expect(clampEffort('xhigh', ['low', 'medium', 'high'])).toBe('high')
    expect(clampEffort('max', ['low', 'high'])).toBe('high')
  })

  it('takes the nearest, the lower one on a tie', () => {
    expect(clampEffort('low', ['high', 'medium'])).toBe('medium')
    expect(clampEffort('medium', ['high', 'low'])).toBe('low')
  })

  it('is none when the model offers none', () => {
    expect(clampEffort('high', [])).toBeNull()
  })
})

describe('saving providers', () => {
  let grokHome = ''

  beforeEach(async () => {
    stub.dir = mkdtempSync(join(tmpdir(), 'wb-providers-'))
    grokHome = join(stub.dir, 'grok-home')
    mkdirSync(grokHome)
    vi.stubEnv('GROK_HOME', grokHome)
    await ensureStore()
  })

  afterEach(() => {
    rmSync(stub.dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    stub.fetch.mockReset()
  })

  const settingsFile = (): string => readFileSync(join(stub.dir, 'workbench', 'settings.json'), 'utf8')
  const config = (): string => readFileSync(join(grokHome, 'config.toml'), 'utf8')

  it('seals the key, shows only a preview, and writes the models into Grok’s config', async () => {
    writeFileSync(join(grokHome, 'config.toml'), '[models]\ndefault = "grok-4.6"\n')
    chmodSync(join(grokHome, 'config.toml'), 0o600)
    const settings = await saveProvider({
      name: 'Open Router',
      baseUrl: 'https://openrouter.ai/api/v1/',
      backend: 'chat_completions',
      apiKey: ' sk-or-v1-abcdef123456 ',
      models: [sonnet, sonnet, { id: ' ', name: 'blank', efforts: [] }]
    })
    expect(settings.providers).toEqual([
      {
        id: 'open-router',
        name: 'Open Router',
        baseUrl: 'https://openrouter.ai/api/v1',
        backend: 'chat_completions',
        hasKey: true,
        keyPreview: 'sk-o…3456',
        models: [sonnet]
      }
    ])
    expect(settingsFile()).not.toContain('sk-or-v1-abcdef123456')
    expect(config().startsWith('[models]\ndefault = "grok-4.6"\n\n# >>> Datapad Workbench providers')).toBe(true)
    expect(config()).toContain('[model."wb-open-router-anthropic-claude-sonnet-4-5"]')
    expect(config()).not.toContain('sk-or')
    expect(statSync(join(grokHome, 'config.toml')).mode & 0o777).toBe(0o600)
    expect((await providerEnv()).vars).toEqual({ WB_PROVIDER_OPEN_ROUTER_KEY: 'sk-or-v1-abcdef123456' })
    expect(await providerModelEfforts('wb-open-router-anthropic-claude-sonnet-4-5')).toEqual(['low', 'high'])
    expect(await providerModelEfforts('grok-4.6')).toBeNull()
  })

  it('keeps the key when none is given, clears it with an empty one, and removes the block with the last provider', async () => {
    const first = await saveProvider({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', backend: 'chat_completions', apiKey: 'sk-12345678', models: [sonnet] })
    const id = first.providers[0].id
    const kept = await saveProvider({ id, name: 'OpenRouter 2', baseUrl: 'https://openrouter.ai/api/v1', backend: 'chat_completions', models: [] })
    expect(kept.providers[0]).toMatchObject({ id, name: 'OpenRouter 2', hasKey: true, models: [] })
    const cleared = await saveProvider({ id, name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', backend: 'chat_completions', apiKey: '', models: [] })
    expect(cleared.providers[0]).toMatchObject({ hasKey: false, keyPreview: null })
    const second = await saveProvider({ name: 'OpenRouter', baseUrl: 'http://localhost:11434/v1', backend: 'chat_completions', models: [] })
    expect(second.providers.map((provider) => provider.id)).toEqual(['openrouter', 'openrouter-2'])
    await removeProvider('openrouter')
    const last = await removeProvider('openrouter-2')
    expect(last.providers).toEqual([])
    expect(config()).toBe('')
  })

  it('refuses a provider without a name or a web address, and one that was removed', async () => {
    const base = { baseUrl: 'https://x.test/v1', backend: 'chat_completions' as const, models: [] }
    await expect(saveProvider({ ...base, name: ' ' })).rejects.toThrow('name')
    await expect(saveProvider({ ...base, name: 'X', baseUrl: 'file:///etc' })).rejects.toThrow('http')
    await expect(saveProvider({ ...base, name: 'X', id: 'gone' })).rejects.toThrow('removed')
  })

  it('runs a chat without a model of its own on the one picked in Settings while it exists', async () => {
    expect(await grokModelFor(undefined)).toBe('')
    await updateSettings({ model: 'grok-4.5' })
    expect(await grokModelFor(undefined)).toBe('grok-4.5')
    await updateSettings({ model: 'grok-gone' })
    expect(await grokModelFor(undefined)).toBe('')
    await updateSettings({ model: DEFAULT_MODEL })
    expect(await grokModelFor(undefined)).toBe('')
    const saved = await saveProvider({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', backend: 'chat_completions', models: [sonnet] })
    await updateSettings({ model: 'wb-openrouter-anthropic-claude-sonnet-4-5' })
    expect(await grokModelFor(undefined)).toBe('wb-openrouter-anthropic-claude-sonnet-4-5')
    // The update keeps the providers.
    expect((await updateSettings({ conciseReplies: true })).providers).toEqual(saved.providers)
    await removeProvider('openrouter')
    expect(await grokModelFor(undefined)).toBe('')
  })

  it('lists models with the stored key, and Anthropic’s with its own headers', async () => {
    await saveProvider({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', backend: 'chat_completions', apiKey: 'sk-stored', models: [] })
    stub.fetch.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'a/b', name: 'B' }] })))
    expect(await listProviderModels({ id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', backend: 'chat_completions' })).toEqual([
      { id: 'a/b', name: 'B', efforts: [] }
    ])
    expect(stub.fetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models')
    expect(stub.fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer sk-stored' })

    await listProviderModels({ baseUrl: 'https://api.anthropic.com/v1', backend: 'messages', apiKey: 'sk-ant' })
    expect(stub.fetch.mock.calls[1][0]).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(stub.fetch.mock.calls[1][1].headers).toEqual({ 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant' })
  })

  it('says what the provider answered when it refuses', async () => {
    stub.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }))
    await expect(listProviderModels({ baseUrl: 'https://api.openai.com/v1', backend: 'responses', apiKey: 'bad' })).rejects.toThrow(
      'api.openai.com answered 401: Invalid API key'
    )
    stub.fetch.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(listProviderModels({ baseUrl: 'http://localhost:11434/v1', backend: 'chat_completions' })).rejects.toThrow(
      'Could not reach localhost:11434: ECONNREFUSED'
    )
  })
})
