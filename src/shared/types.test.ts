import { describe, expect, it } from 'vitest'
import {
  GROK_REASONING_EFFORTS,
  chatProviderChoices,
  chatProviderOf,
  grokModelChoices,
  grokModelEfforts,
  normalizeChatAgent,
  providerModelKey,
  usageMeterPlan,
  usagePlans,
  type Provider
} from './types'

describe('providerModelKey', () => {
  it('is wb-, the provider id and the model id as a slug', () => {
    expect(providerModelKey('openrouter', 'anthropic/claude-sonnet-4.5')).toBe('wb-openrouter-anthropic-claude-sonnet-4-5')
    expect(providerModelKey('ollama', 'Llama3.1:8B')).toBe('wb-ollama-llama3-1-8b')
    expect(providerModelKey('my-host', '--odd__id--')).toBe('wb-my-host-odd-id')
  })
})

describe('grokModelChoices', () => {
  const provider: Provider = {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    backend: 'chat_completions',
    hasKey: true,
    keyPreview: 'sk-o…1234',
    models: [
      { id: 'anthropic/claude-sonnet-4.5', name: 'Sonnet 4.5', contextWindow: 200000, efforts: ['low', 'high'] },
      { id: 'meta/llama', name: 'Llama', efforts: [] }
    ]
  }

  it('lists Grok’s own models first, without the providers’ catalog keys, then each provider’s', () => {
    const choices = grokModelChoices(['grok-4.6', 'grok-4.5', 'wb-openrouter-meta-llama'], [provider])
    expect(choices).toEqual([
      { value: 'grok-4.6', name: 'grok-4.6', group: 'Grok', efforts: GROK_REASONING_EFFORTS },
      { value: 'grok-4.5', name: 'grok-4.5', group: 'Grok', efforts: GROK_REASONING_EFFORTS },
      {
        value: 'wb-openrouter-anthropic-claude-sonnet-4-5',
        name: 'Sonnet 4.5',
        group: 'OpenRouter',
        efforts: ['low', 'high']
      },
      { value: 'wb-openrouter-meta-llama', name: 'Llama', group: 'OpenRouter', efforts: [] }
    ])
  })

  it('is only Grok’s models without providers', () => {
    expect(grokModelChoices(['grok-4.6'], []).map((choice) => choice.value)).toEqual(['grok-4.6'])
  })

  it('gives each model’s own efforts, none for a provider model that is gone, and Grok’s for any other', () => {
    const choices = grokModelChoices(['grok-4.6'], [provider])
    expect(grokModelEfforts(choices, 'wb-openrouter-anthropic-claude-sonnet-4-5')).toEqual(['low', 'high'])
    expect(grokModelEfforts(choices, 'wb-openrouter-meta-llama')).toEqual([])
    expect(grokModelEfforts(choices, 'wb-gone-model')).toEqual([])
    expect(grokModelEfforts(choices, 'grok-4.6')).toEqual(GROK_REASONING_EFFORTS)
    expect(grokModelEfforts(choices, 'grok-code-fast')).toEqual(GROK_REASONING_EFFORTS)
    expect(grokModelEfforts(choices, '')).toEqual(GROK_REASONING_EFFORTS)
  })
})

describe('chatProviderOf', () => {
  const provider = (id: string, name: string, models: string[]): Provider => ({
    id,
    name,
    baseUrl: 'https://example.com/v1',
    backend: 'chat_completions',
    hasKey: true,
    keyPreview: null,
    models: models.map((model) => ({ id: model, name: model, efforts: [] }))
  })
  const providers = [provider('open', 'Open', ['a']), provider('open-router', 'OpenRouter', ['x/y']), provider('empty', 'Empty', [])]

  it('offers Claude, Grok and each provider with models, on the app’s own agent', () => {
    expect(chatProviderChoices(providers).map((choice) => [choice.key, choice.agent, choice.name])).toEqual([
      ['claude', 'claude', 'Claude'],
      ['grok', 'grok', 'Grok'],
      ['provider-open', 'workbench', 'Open'],
      ['provider-open-router', 'workbench', 'OpenRouter']
    ])
  })

  it('finds the provider of a chat on the app’s own agent from its model key', () => {
    expect(chatProviderOf('workbench', 'wb-open-router-x-y', providers).name).toBe('OpenRouter')
    expect(chatProviderOf('workbench', 'wb-open-a', providers).name).toBe('Open')
    // A model no longer listed stays with its provider.
    expect(chatProviderOf('workbench', 'wb-open-router-gone', providers).name).toBe('OpenRouter')
  })

  it('is the first provider for no model, and a bare entry with no provider', () => {
    expect(chatProviderOf('workbench', '', providers).key).toBe('provider-open')
    expect(chatProviderOf('workbench', '', [])).toEqual({
      key: 'workbench',
      agent: 'workbench',
      provider: null,
      name: 'Workbench'
    })
  })

  it('is no provider for a model whose provider was removed', () => {
    expect(chatProviderOf('workbench', 'wb-gone-a', providers)).toEqual({
      key: 'workbench',
      agent: 'workbench',
      provider: null,
      name: 'Removed provider'
    })
    expect(chatProviderOf('workbench', 'wb-open-a', []).name).toBe('Removed provider')
  })

  it('is Grok for Grok and Claude for Claude, whatever the model', () => {
    expect(chatProviderOf('grok', '', providers).key).toBe('grok')
    expect(chatProviderOf('grok', 'grok-4.6', providers).key).toBe('grok')
    expect(chatProviderOf('grok', 'wb-open-a', providers).key).toBe('grok')
    expect(chatProviderOf('claude', 'wb-open-a', providers).key).toBe('claude')
  })
})

describe('normalizeChatAgent', () => {
  it('keeps Claude and the app’s own agent', () => {
    expect(normalizeChatAgent('claude', 'wb-open-a')).toBe('claude')
    expect(normalizeChatAgent('workbench')).toBe('workbench')
  })

  it('reads a provider’s model saved under Grok as the app’s own agent', () => {
    expect(normalizeChatAgent('grok', 'wb-open-a')).toBe('workbench')
    expect(normalizeChatAgent(undefined, 'wb-open-a')).toBe('workbench')
  })

  it('is Grok for anything else', () => {
    expect(normalizeChatAgent('grok', 'grok-4.6')).toBe('grok')
    expect(normalizeChatAgent(undefined)).toBe('grok')
    expect(normalizeChatAgent('other', 42)).toBe('grok')
  })
})

describe('usage plans', () => {
  const claudeIn = { signedIn: true } as Parameters<typeof usagePlans>[0]['claude']
  const claudeOut = { signedIn: false } as Parameters<typeof usagePlans>[0]['claude']
  const provider = { id: 'openrouter' } as Provider
  const base = { claude: claudeOut, grokBuildSignedIn: false, defaultAgent: 'grok' as const, hasKey: false, providers: [] as Provider[] }

  it('shows Grok and Claude as before', () => {
    expect(usagePlans({ ...base, grokBuildSignedIn: true })).toEqual({ grok: true, claude: false, claudeFirst: false })
    expect(usagePlans({ ...base, claude: claudeIn })).toEqual({ grok: false, claude: true, claudeFirst: true })
    expect(usagePlans({ ...base, claude: claudeIn, grokBuildSignedIn: true })).toEqual({ grok: true, claude: true, claudeFirst: false })
    expect(usagePlans(base).grok).toBe(true)
    expect(usagePlans({ ...base, hasKey: true, providers: [provider] }).grok).toBe(true)
    expect(usagePlans({ ...base, grokBuildSignedIn: true, providers: [provider] }).grok).toBe(true)
  })

  it('shows no plan to a user with only providers', () => {
    expect(usagePlans({ ...base, providers: [provider] })).toEqual({ grok: false, claude: false, claudeFirst: false })
    expect(usageMeterPlan(usagePlans({ ...base, providers: [provider] }), 'grok')).toBeNull()
  })

  it('shows no plan meter for a provider chat', () => {
    const plans = usagePlans({ ...base, grokBuildSignedIn: true, claude: claudeIn })
    expect(usageMeterPlan(plans, 'workbench')).toBeNull()
    expect(usageMeterPlan(plans, 'grok')).toBe('grok')
    expect(usageMeterPlan(usagePlans({ ...base, claude: claudeIn }), 'claude')).toBe('claude')
  })
})
