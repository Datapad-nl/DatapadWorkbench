import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../shared/types'

const fake = vi.hoisted(() => ({
  grokSignedIn: false,
  claudeSignedIn: false,
  defaultAgent: 'grok' as 'grok' | 'claude' | 'workbench',
  apiKey: null as string | null,
  model: 'grok-4.6',
  /** The providers' models by catalog key. */
  providerModels: [] as string[],
  apiCalls: [] as string[],
  agentCalls: [] as Array<{ agent?: string; tools?: boolean }>
}))

vi.mock('electron', () => ({
  net: {
    fetch: async (_url: string, init: { body: string }) => {
      fake.apiCalls.push((JSON.parse(init.body) as { model: string }).model)
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'from api' } }] }) }
    }
  }
}))
vi.mock('./acp', () => ({
  promptIsolated: async (_cwd: string, _text: string, _images: unknown, _onText: unknown, _signal: unknown, options: { agent?: string; tools?: boolean }) => {
    fake.agentCalls.push({ agent: options.agent, tools: options.tools })
    return `from ${options.agent}`
  }
}))
vi.mock('./claudeCli', () => ({ getClaudeCliInfo: async () => ({ signedIn: fake.claudeSignedIn }) }))
vi.mock('./sessions', () => ({ grokBuildSignedIn: () => fake.grokSignedIn }))
vi.mock('./providers', () => ({
  findProviderModel: async (key: string) => (fake.providerModels.includes(key) ? { provider: {}, model: {} } : null),
  firstProviderModelKey: async () => fake.providerModels[0] ?? null
}))
vi.mock('./store', () => ({
  getApiKey: async () => fake.apiKey,
  getDefaultAgent: async () => fake.defaultAgent,
  getModel: async () => fake.model
}))

import { askOnce } from './askOnce'

const project = { id: 'p1', name: 'P', path: '/project' } as Project

afterEach(() => {
  fake.grokSignedIn = false
  fake.claudeSignedIn = false
  fake.defaultAgent = 'grok'
  fake.apiKey = null
  fake.model = 'grok-4.6'
  fake.providerModels = []
  fake.apiCalls = []
  fake.agentCalls = []
})

describe('askOnce', () => {
  it('asks the xAI API first and then the signed-in agent, as before, for a model of Grok', async () => {
    fake.grokSignedIn = true
    fake.apiKey = 'xai-key'
    fake.providerModels = ['wb-openrouter-nemotron']
    expect(await askOnce(project, 'q')).toBe('from api')
    expect(fake.apiCalls).toEqual(['grok-4.6'])
    expect(fake.agentCalls).toEqual([])
  })

  it("runs on the app's own agent, without tools, when a provider's model is picked in Settings, never on the xAI API", async () => {
    fake.grokSignedIn = true
    fake.apiKey = 'xai-key'
    fake.defaultAgent = 'workbench'
    fake.model = 'wb-openrouter-nemotron'
    fake.providerModels = ['wb-openrouter-other', 'wb-openrouter-nemotron']
    expect(await askOnce(project, 'q')).toBe('from workbench')
    expect(fake.apiCalls).toEqual([])
    expect(fake.agentCalls).toEqual([{ agent: 'workbench', tools: false }])
  })

  it("runs on the app's own agent when neither Grok nor Claude is signed in and a provider has a model", async () => {
    fake.providerModels = ['wb-openrouter-nemotron', 'wb-ollama-llama']
    expect(await askOnce(project, 'q')).toBe('from workbench')
    expect(fake.agentCalls).toEqual([{ agent: 'workbench', tools: false }])
  })

  it('falls back to a signed-in Grok when the provider picked in Settings is gone', async () => {
    fake.grokSignedIn = true
    fake.defaultAgent = 'workbench'
    fake.model = 'wb-openrouter-gone'
    expect(await askOnce(project, 'q')).toBe('from grok')
  })

  it('keeps a Claude default on Claude', async () => {
    fake.claudeSignedIn = true
    fake.defaultAgent = 'claude'
    fake.providerModels = ['wb-openrouter-nemotron']
    expect(await askOnce(project, 'q')).toBe('from claude')
    expect(fake.agentCalls).toEqual([{ agent: 'claude', tools: false }])
  })

  it('is null with nothing signed in and no provider', async () => {
    expect(await askOnce(project, 'q')).toBeNull()
  })
})
