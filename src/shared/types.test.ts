import { describe, expect, it } from 'vitest'
import { GROK_REASONING_EFFORTS, grokModelChoices, grokModelEfforts, providerModelKey, type Provider } from './types'

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
