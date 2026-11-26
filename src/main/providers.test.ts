import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
  agentProviders,
  chatAgentName,
  clampEffort,
  firstProviderModelKey,
  listProviderModels,
  onProvidersChanged,
  parseProviderModels,
  providerModelEfforts,
  removeProvider,
  saveProvider
} from './providers'
import { ensureStore, grokModelFor, updateSettings, workbenchModelFor } from './store'

const sonnet: ProviderModel = {
  id: 'anthropic/claude-sonnet-4.5',
  name: 'Sonnet 4.5',
  contextWindow: 200000,
  efforts: ['low', 'high']
}

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

  it('marks a model that OpenRouter lists as text only', () => {
    const models = parseProviderModels({
      data: [
        { id: 'text/only', architecture: { input_modalities: ['text'] } },
        { id: 'sees/images', architecture: { input_modalities: ['text', 'image'] } }
      ]
    })
    expect(models).toEqual([
      { id: 'text/only', name: 'text/only', efforts: [], images: false },
      { id: 'sees/images', name: 'sees/images', efforts: [] }
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

  it('seals the key, shows only a preview, and hands the app’s own agent the models with the key', async () => {
    const settings = await saveProvider({
      name: 'Open Router',
      baseUrl: 'https://openrouter.ai/api/v1/',
      backend: 'chat_completions',
      apiKey: ' sk-or-v1-abcdef123456 ',
      models: [sonnet, sonnet, { id: ' ', name: 'blank', efforts: [] }, { id: 'meta/llama', name: 'Llama', efforts: [] }]
    })
    expect(settings.providers).toEqual([
      {
        id: 'open-router',
        name: 'Open Router',
        baseUrl: 'https://openrouter.ai/api/v1',
        backend: 'chat_completions',
        hasKey: true,
        keyPreview: 'sk-o…3456',
        models: [sonnet, { id: 'meta/llama', name: 'Llama', efforts: [] }]
      }
    ])
    expect(settingsFile()).not.toContain('sk-or-v1-abcdef123456')
    expect(await agentProviders()).toEqual([
      {
        id: 'open-router',
        name: 'Open Router',
        backend: 'chat_completions',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-v1-abcdef123456',
        models: [
          {
            key: 'wb-open-router-anthropic-claude-sonnet-4-5',
            id: 'anthropic/claude-sonnet-4.5',
            name: 'Sonnet 4.5',
            contextWindow: 200000,
            efforts: ['low', 'high']
          },
          { key: 'wb-open-router-meta-llama', id: 'meta/llama', name: 'Llama' }
        ]
      }
    ])
    expect(await providerModelEfforts('wb-open-router-anthropic-claude-sonnet-4-5')).toEqual(['low', 'high'])
    expect(await providerModelEfforts('grok-4.6')).toBeNull()
  })

  it('keeps a text-only model as one and tells the app’s own agent', async () => {
    const settings = await saveProvider({
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      backend: 'chat_completions',
      models: [{ id: 'text/only', name: 'Text', efforts: [], images: false }, { id: 'any', name: 'Any', efforts: [], images: true }]
    })
    expect(settings.providers[0].models).toEqual([
      { id: 'text/only', name: 'Text', efforts: [], images: false },
      { id: 'any', name: 'Any', efforts: [] }
    ])
    expect((await agentProviders())[0].models).toEqual([
      { key: 'wb-openrouter-text-only', id: 'text/only', name: 'Text', images: false },
      { key: 'wb-openrouter-any', id: 'any', name: 'Any' }
    ])
  })

  it('names a chat’s replies after its provider, Claude or Grok', async () => {
    await saveProvider({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', backend: 'chat_completions', models: [sonnet] })
    expect(await chatAgentName('workbench', 'wb-openrouter-anthropic-claude-sonnet-4-5')).toBe('OpenRouter')
    expect(await chatAgentName('workbench', 'wb-gone-x')).toBe('Assistant')
    expect(await chatAgentName('claude', '')).toBe('Claude')
    expect(await chatAgentName('grok', 'grok-4.6')).toBe('Grok')
  })

  it('tells the listeners of each change, and leaves Grok’s config alone', async () => {
    const block = '[models]\ndefault = "grok-4.6"\n\n# >>> Datapad Workbench providers\n[model."wb-x"]\n# <<< Datapad Workbench providers\n'
    writeFileSync(join(grokHome, 'config.toml'), block)
    const heard = vi.fn()
    onProvidersChanged(heard)
    await saveProvider({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', backend: 'chat_completions', models: [sonnet] })
    await removeProvider('openrouter')
    expect(heard).toHaveBeenCalledTimes(2)
    expect(config()).toBe(block)
  })

  it("names the first provider's first model", async () => {
    expect(await firstProviderModelKey()).toBeNull()
    await saveProvider({ name: 'Ollama', baseUrl: 'http://localhost:11434/v1', backend: 'chat_completions', models: [] })
    await saveProvider({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', backend: 'chat_completions', models: [sonnet] })
    expect(await firstProviderModelKey()).toBe('wb-openrouter-anthropic-claude-sonnet-4-5')
  })

  it('keeps the key when none is given, clears it with an empty one, and removes providers', async () => {
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
    expect(await agentProviders()).toEqual([])
  })

  it('refuses a provider without a name or a web address, and one that was removed', async () => {
    const base = { baseUrl: 'https://x.test/v1', backend: 'chat_completions' as const, models: [] }
    await expect(saveProvider({ ...base, name: ' ' })).rejects.toThrow('name')
    await expect(saveProvider({ ...base, name: 'X', baseUrl: 'file:///etc' })).rejects.toThrow('http')
    await expect(saveProvider({ ...base, name: 'X', id: 'gone' })).rejects.toThrow('removed')
  })

  it('runs a chat without a model of its own on the one picked in Settings while it exists, on its own agent', async () => {
    expect(await grokModelFor(undefined)).toBe('')
    await updateSettings({ model: 'grok-4.5' })
    expect(await grokModelFor(undefined)).toBe('grok-4.5')
    await updateSettings({ model: 'grok-gone' })
    expect(await grokModelFor(undefined)).toBe('')
    await updateSettings({ model: DEFAULT_MODEL })
    expect(await grokModelFor(undefined)).toBe('')
    const saved = await saveProvider({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', backend: 'chat_completions', models: [sonnet] })
    await updateSettings({ model: 'wb-openrouter-anthropic-claude-sonnet-4-5' })
    // A provider's model is the app's own agent's, never Grok's.
    expect(await grokModelFor(undefined)).toBe('')
    expect(await workbenchModelFor(undefined)).toBe('wb-openrouter-anthropic-claude-sonnet-4-5')
    // The update keeps the providers.
    expect((await updateSettings({ conciseReplies: true })).providers).toEqual(saved.providers)
    await removeProvider('openrouter')
    expect(await workbenchModelFor(undefined)).toBe('')
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
