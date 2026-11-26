import { net } from 'electron'
import {
  chatAgentLabel,
  normalizeReasoningEffort,
  providerModelKey,
  REASONING_EFFORTS,
  slugify,
  type ChatAgent,
  type ProviderBackend,
  type ProviderModel,
  type PublicSettings,
  type ReasoningEffort,
  type SaveProviderInput
} from '../shared/types'
import { getProviders, getPublicSettings, updateProviders, type StoredProvider } from './store'

const BACKENDS: ProviderBackend[] = ['chat_completions', 'responses', 'messages']
const LIST_TIMEOUT_MS = 15_000

/** Anthropic's own API takes the key in `x-api-key`; other Messages endpoints, such as OpenRouter's, a bearer token. */
function isAnthropicHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

/** The model as the app's own agent takes it in `_workbench/providers`. */
export type AgentProviderModel = {
  key: string
  id: string
  name: string
  contextWindow?: number
  efforts?: ReasoningEffort[]
  images?: boolean
}

/** A provider as the app's own agent takes it in `_workbench/providers`. `apiKey` is unsealed and goes only to that agent. */
export type AgentProvider = {
  id: string
  name: string
  backend: ProviderBackend
  baseUrl: string
  apiKey: string
  models: AgentProviderModel[]
}

/** Every provider for the app's own agent. That agent sets the auth headers itself, Anthropic's too. */
export async function agentProviders(): Promise<AgentProvider[]> {
  return (await getProviders()).map((provider) => ({
    id: provider.id,
    name: provider.name,
    backend: provider.backend,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey.trim(),
    models: provider.models.map((model) => ({
      key: providerModelKey(provider.id, model.id),
      id: model.id,
      name: model.name,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.efforts.length > 0 ? { efforts: model.efforts } : {}),
      ...(model.images === false ? { images: false } : {})
    }))
  }))
}

/** A provider's model by its catalog key, with its provider, or null for a model that is none of theirs. */
export async function findProviderModel(
  modelKey: string
): Promise<{ provider: StoredProvider; model: ProviderModel } | null> {
  if (!modelKey.startsWith('wb-')) return null
  for (const provider of await getProviders()) {
    const model = provider.models.find((item) => providerModelKey(provider.id, item.id) === modelKey)
    if (model) return { provider, model }
  }
  return null
}

/** The name a chat's replies go under: its provider's on the app's own agent, else Claude or Grok. */
export async function chatAgentName(agent: ChatAgent, model: string): Promise<string> {
  if (agent !== 'workbench') return chatAgentLabel(agent)
  return (await findProviderModel(model))?.provider.name ?? 'Assistant'
}

/** The effort levels of a provider's model by its catalog key, or null for a model that is none of theirs. */
export async function providerModelEfforts(modelKey: string): Promise<ReasoningEffort[] | null> {
  return (await findProviderModel(modelKey))?.model.efforts ?? null
}

/** The catalog key of the first provider's first model, or null when no provider has a model. */
export async function firstProviderModelKey(): Promise<string | null> {
  const provider = (await getProviders()).find((item) => item.models.length > 0)
  return provider ? providerModelKey(provider.id, provider.models[0].id) : null
}

/** The level nearest to `effort` that the model offers, the lower one on a tie. Null when it offers none. */
export function clampEffort(effort: ReasoningEffort, offered: ReasoningEffort[]): ReasoningEffort | null {
  if (offered.includes(effort)) return effort
  const rank = (value: ReasoningEffort): number => REASONING_EFFORTS.indexOf(value)
  let best: ReasoningEffort | null = null
  for (const value of [...offered].sort((a, b) => rank(a) - rank(b))) {
    if (!best || Math.abs(rank(value) - rank(effort)) < Math.abs(rank(best) - rank(effort))) best = value
  }
  return best
}

const listeners: Array<() => void> = []

/** Hears of every saved or removed provider. */
export function onProvidersChanged(listener: () => void): void {
  listeners.push(listener)
}

async function providersChanged(): Promise<PublicSettings> {
  for (const listener of listeners) listener()
  return getPublicSettings()
}

function cleanBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Enter the provider’s address, such as https://openrouter.ai/api/v1')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The address must start with http:// or https://')
  return trimmed
}

function cleanBackend(value: unknown): ProviderBackend {
  if (!BACKENDS.includes(value as ProviderBackend)) throw new Error('Pick the provider’s API')
  return value as ProviderBackend
}

/** Models with an id, each once by catalog key, with known efforts in order. */
function cleanModels(providerId: string, models: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>()
  return models.flatMap((model) => {
    const id = String(model.id ?? '').trim()
    const key = providerModelKey(providerId, id)
    if (!id || seen.has(key)) return []
    seen.add(key)
    const efforts = new Set((model.efforts ?? []).map(normalizeReasoningEffort))
    const contextWindow = Number(model.contextWindow)
    return [
      {
        id,
        name: String(model.name ?? '').trim() || id,
        ...(Number.isInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
        efforts: REASONING_EFFORTS.filter((effort) => efforts.has(effort)),
        ...(model.images === false ? { images: false } : {})
      }
    ]
  })
}

/** A new provider's id: its name as a slug, made unique. */
function newProviderId(name: string, taken: StoredProvider[]): string {
  const base = slugify(name) || 'provider'
  let id = base
  for (let n = 2; taken.some((provider) => provider.id === id); n++) id = `${base}-${n}`
  return id
}

export async function saveProvider(input: SaveProviderInput): Promise<PublicSettings> {
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('Give the provider a name')
  const baseUrl = cleanBaseUrl(String(input.baseUrl ?? ''))
  const backend = cleanBackend(input.backend)
  await updateProviders((current) => {
    const existing = input.id ? current.find((provider) => provider.id === input.id) : undefined
    if (input.id && !existing) throw new Error('That provider was removed')
    const id = existing?.id ?? newProviderId(name, current)
    const saved: StoredProvider = {
      id,
      name,
      baseUrl,
      backend,
      // A new key replaces the sealed one, also when it is empty.
      apiKey: input.apiKey !== undefined ? String(input.apiKey).trim() : (existing?.apiKey ?? ''),
      apiKeySealed: input.apiKey !== undefined ? undefined : existing?.apiKeySealed,
      models: cleanModels(id, input.models ?? [])
    }
    return existing ? current.map((provider) => (provider === existing ? saved : provider)) : [...current, saved]
  })
  return providersChanged()
}

export async function removeProvider(id: string): Promise<PublicSettings> {
  await updateProviders((current) => current.filter((provider) => provider.id !== id))
  return providersChanged()
}

/** OpenRouter's rows carry a name, context length and parameters; Anthropic's a display name; others only an id. */
export function parseProviderModels(body: unknown): ProviderModel[] {
  const rows = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(rows)) throw new Error('The provider’s model list has no models')
  return rows.flatMap((row: unknown) => {
    const item = row as {
      id?: unknown
      name?: unknown
      display_name?: unknown
      context_length?: unknown
      supported_parameters?: unknown
      architecture?: { input_modalities?: unknown }
    } | null
    if (typeof item?.id !== 'string' || !item.id) return []
    const name = typeof item.name === 'string' ? item.name : typeof item.display_name === 'string' ? item.display_name : item.id
    const reasoning = Array.isArray(item.supported_parameters) && item.supported_parameters.includes('reasoning')
    // OpenRouter lists what a model takes in; a text-only one would fail on an attached image.
    const inputs = item.architecture?.input_modalities
    const textOnly = Array.isArray(inputs) && !inputs.includes('image')
    return [
      {
        id: item.id,
        name,
        ...(typeof item.context_length === 'number' && item.context_length > 0 ? { contextWindow: item.context_length } : {}),
        efforts: reasoning ? (['low', 'medium', 'high'] as ReasoningEffort[]) : [],
        ...(textOnly ? { images: false } : {})
      }
    ]
  })
}

/** Fetches the provider's model list. With an id and no key given, it uses the stored key. */
export async function listProviderModels(input: {
  id?: string
  baseUrl: string
  backend: ProviderBackend
  apiKey?: string
}): Promise<ProviderModel[]> {
  const baseUrl = cleanBaseUrl(String(input.baseUrl ?? ''))
  const stored = input.id ? (await getProviders()).find((provider) => provider.id === input.id)?.apiKey : ''
  const key = String(input.apiKey ?? '').trim() || stored?.trim() || ''
  const anthropic = input.backend === 'messages' && isAnthropicHost(baseUrl)
  const headers: Record<string, string> = anthropic
    ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
    : key
      ? { Authorization: `Bearer ${key}` }
      : {}
  const host = new URL(baseUrl).host
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), LIST_TIMEOUT_MS)
  let response: Response
  try {
    // Anthropic lists 20 models a page unless asked for more.
    response = await net.fetch(`${baseUrl}/models${anthropic ? '?limit=1000' : ''}`, {
      credentials: 'omit',
      headers,
      signal: abort.signal
    })
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`${host} did not answer within ${LIST_TIMEOUT_MS / 1000} seconds`)
    throw new Error(`Could not reach ${host}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text().catch(() => '')
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    // Said below, by status or as no list.
  }
  if (!response.ok) {
    const error = (body as { error?: { message?: unknown } | string } | null)?.error
    const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : ''
    throw new Error(`${host} answered ${response.status}${message ? `: ${message}` : ''}`)
  }
  return parseProviderModels(body)
}
