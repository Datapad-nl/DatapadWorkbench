import { net } from 'electron'
import { chmod, readFile, realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  normalizeReasoningEffort,
  providerModelKey,
  REASONING_EFFORTS,
  slugify,
  type ProviderBackend,
  type ProviderModel,
  type PublicSettings,
  type ReasoningEffort,
  type SaveProviderInput
} from '../shared/types'
import { resetGrokCliInfo } from './grokCli'
import { getProviders, getPublicSettings, updateProviders, type StoredProvider } from './store'
import { writeFileAtomic } from './storeIo'

const BLOCK_START = '# >>> Datapad Workbench providers'
const BLOCK_END = '# <<< Datapad Workbench providers'
const BACKENDS: ProviderBackend[] = ['chat_completions', 'responses', 'messages']
const LIST_TIMEOUT_MS = 15_000

/** The variable a provider's key reaches Grok in. The config names it; the key itself is never written there. */
export function providerKeyVar(providerId: string): string {
  return `WB_PROVIDER_${providerId.toUpperCase().replace(/-/g, '_')}_KEY`
}

/** Anthropic's own API takes the key in `x-api-key`; other Messages endpoints, such as OpenRouter's, a bearer token. */
function isAnthropicHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

/** A TOML basic string. */
export function tomlString(text: string): string {
  // eslint-disable-next-line no-control-regex -- TOML escapes control characters
  const escaped = text.replace(/[\\"\u0000-\u001f\u007f]/g, (char) => {
    const named: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' }
    return named[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  return `"${escaped}"`
}

function inlineTable(entries: Record<string, string>): string {
  return `{ ${Object.entries(entries)
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(', ')} }`
}

/** The providers as Grok Build's `[model_providers.*]` and `[model.*]` tables. Empty for none. */
export function renderProvidersToml(providers: StoredProvider[]): string {
  const tables = providers.flatMap((provider) => {
    const providerKey = `wb-${provider.id}`
    const keyVar = providerKeyVar(provider.id)
    const auth =
      provider.backend === 'messages' && isAnthropicHost(provider.baseUrl)
        ? [
            `env_http_headers = ${inlineTable({ 'x-api-key': keyVar })}`,
            `extra_headers = ${inlineTable({ 'anthropic-version': '2023-06-01' })}`
          ]
        : // Also without a key, as for Ollama: a model with a key variable of its own never gets the Grok login's token.
          [`env_key = ${tomlString(keyVar)}`]
    const head = [`[model_providers.${tomlString(providerKey)}]`, `base_url = ${tomlString(provider.baseUrl)}`, ...auth]
    const models = provider.models.map((model) =>
      [
        `[model.${tomlString(providerModelKey(provider.id, model.id))}]`,
        `model = ${tomlString(model.id)}`,
        `model_provider = ${tomlString(providerKey)}`,
        `api_backend = ${tomlString(provider.backend)}`,
        `name = ${tomlString(`${model.name} (${provider.name})`)}`,
        ...(model.contextWindow ? [`context_window = ${model.contextWindow}`] : []),
        ...(model.efforts.length > 0
          ? [`reasoning_efforts = [${model.efforts.map((effort) => `{ value = ${tomlString(effort)} }`).join(', ')}]`]
          : [])
      ].join('\n')
    )
    return [head.join('\n'), ...models]
  })
  return tables.join('\n\n')
}

/**
 * Puts the rendered tables into a config file's text, in the app's marked block: in place of an earlier
 * block, else at the end. No tables removes the block. Every other byte stays as it was.
 */
export function withProvidersBlock(config: string, toml: string): string {
  const start = findLine(config, BLOCK_START, 0)
  const end = start < 0 ? -1 : findLine(config, BLOCK_END, start)
  const block = toml
    ? `${BLOCK_START}\n# Datapad Workbench rewrites this block when its providers change. Edits here are lost.\n\n${toml}\n\n${BLOCK_END}\n`
    : ''
  if (end >= 0) {
    const lineEnd = config.indexOf('\n', end)
    const after = lineEnd < 0 ? '' : config.slice(lineEnd + 1)
    const before = config.slice(0, start)
    // The blank line put before a block at the end goes with it.
    if (!block && !after && before.endsWith('\n\n')) return before.slice(0, -1)
    return before + block + after
  }
  if (!block) return config
  if (!config) return block
  return `${config}${config.endsWith('\n') ? '' : '\n'}\n${block}`
}

/** Where a line that is exactly `line` starts, from `from` on, or -1. */
function findLine(text: string, line: string, from: number): number {
  let at = from
  while (at <= text.length) {
    const next = text.indexOf('\n', at)
    const current = text.slice(at, next < 0 ? text.length : next).replace(/\r$/, '')
    if (current === line) return at
    if (next < 0) return -1
    at = next + 1
  }
  return -1
}

/** Grok Build's config file: `$GROK_HOME/config.toml`, else `~/.grok/config.toml`. */
export function grokConfigPath(): string {
  return join(process.env.GROK_HOME?.trim() || join(homedir(), '.grok'), 'config.toml')
}

/** Writes the providers into Grok's config, only when that changes the file. */
export async function syncGrokConfig(providers?: StoredProvider[]): Promise<void> {
  const list = providers ?? (await getProviders())
  // A config kept as a link elsewhere, as in a dotfiles folder, is written where it points.
  const path = await realpath(grokConfigPath()).catch(() => grokConfigPath())
  const current = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const next = withProvidersBlock(current, renderProvidersToml(list))
  if (next === current) return
  const mode = await stat(path).then(
    (info) => info.mode & 0o777,
    () => null
  )
  await writeFileAtomic(path, next)
  // The user's config may hold keys of its own, so it keeps who may read it.
  if (mode !== null) await chmod(path, mode)
}

/**
 * What every Grok process gets from the providers: their keys as variables, and a stamp of the config
 * it reads at start. A process reads the config only then, so a changed stamp needs a process of its own.
 */
export async function providerEnv(): Promise<{ vars: Record<string, string>; stamp: string }> {
  const providers = await getProviders()
  const vars: Record<string, string> = {}
  for (const provider of providers) {
    if (provider.apiKey.trim()) vars[providerKeyVar(provider.id)] = provider.apiKey.trim()
  }
  return { vars, stamp: renderProvidersToml(providers) }
}

/** The effort levels of a provider's model by its catalog key, or null for a model that is none of theirs. */
export async function providerModelEfforts(modelKey: string): Promise<ReasoningEffort[] | null> {
  if (!modelKey.startsWith('wb-')) return null
  for (const provider of await getProviders()) {
    const model = provider.models.find((item) => providerModelKey(provider.id, item.id) === modelKey)
    if (model) return model.efforts
  }
  return null
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

/** Hears of every saved or removed provider, after Grok's config was written. */
export function onProvidersChanged(listener: () => void): void {
  listeners.push(listener)
}

async function providersChanged(providers: StoredProvider[]): Promise<PublicSettings> {
  await syncGrokConfig(providers)
  resetGrokCliInfo()
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
        efforts: REASONING_EFFORTS.filter((effort) => efforts.has(effort))
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
  const providers = await updateProviders((current) => {
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
  return providersChanged(providers)
}

export async function removeProvider(id: string): Promise<PublicSettings> {
  const providers = await updateProviders((current) => current.filter((provider) => provider.id !== id))
  return providersChanged(providers)
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
    } | null
    if (typeof item?.id !== 'string' || !item.id) return []
    const name = typeof item.name === 'string' ? item.name : typeof item.display_name === 'string' ? item.display_name : item.id
    const reasoning = Array.isArray(item.supported_parameters) && item.supported_parameters.includes('reasoning')
    return [
      {
        id: item.id,
        name,
        ...(typeof item.context_length === 'number' && item.context_length > 0 ? { contextWindow: item.context_length } : {}),
        efforts: reasoning ? (['low', 'medium', 'high'] as ReasoningEffort[]) : []
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
