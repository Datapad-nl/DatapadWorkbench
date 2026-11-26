import { app, safeStorage } from 'electron'
import { createHmac, randomBytes } from 'crypto'
import { join } from 'path'
import type { SecretScope } from '../shared/types'
import { readJsonFile, withLock, writeFileAtomic } from './storeIo'

/**
 * Secrets the user typed into a chat for an agent. Each value is encrypted with the OS keychain (Electron
 * safeStorage) and never goes to the model: an agent gets them as environment variables of its shell.
 * They are kept per scope, a project id or `bot:<id>`, by name.
 */
type SecretsFile = Record<string, Record<string, string>>

/** An environment variable name. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** Variables the agent itself runs on: its login, its runtime, the shell. A secret must not replace them. */
const RESERVED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'XAI_', 'GROK_', 'WB_PROVIDER_', 'NODE_', 'NPM_CONFIG_', 'ELECTRON_', 'DYLD_', 'LD_', 'GIT_']
const RESERVED_NAMES = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'PWD', 'LANG', 'TERM',
  // These change what a shell, interpreter or tool runs, or whom it trusts.
  'BASH_ENV', 'ENV', 'ZDOTDIR', 'PROMPT_COMMAND', 'SHELLOPTS', 'BASHOPTS', 'IFS', 'PS4',
  'PYTHONSTARTUP', 'PYTHONPATH', 'PYTHONHOME', 'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'RUBYOPT', 'RUBYLIB',
  'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'EDITOR', 'VISUAL', 'PAGER', 'LESSOPEN', 'BROWSER'
])
const PROXY_NAME = /^(HTTPS?|ALL|NO)_PROXY$/

/** Why a name cannot hold a secret, or null when it can. */
export function secretNameError(name: string): string | null {
  if (!SECRET_NAME.test(name)) return `${name} is not a valid environment variable name.`
  const upper = name.toUpperCase()
  if (RESERVED_NAMES.has(upper) || PROXY_NAME.test(upper) || RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    return `${name} is used by the agent itself, so it cannot hold a secret. Use another name, such as MY_${upper}.`
  }
  return null
}

const listeners = new Set<(scope: string) => void>()

function secretsPath(): string {
  return join(app.getPath('userData'), 'workbench', 'secrets.json')
}

function load(): Promise<SecretsFile> {
  return readJsonFile<SecretsFile>(secretsPath(), {})
}

/**
 * Where a secret a chat asks for is kept: with its bot, also on a bot's run in a project, else with its project.
 * Null when it has neither.
 */
export function secretScope(chat: { projectId: string; botId?: string }): string | null {
  if (chat.botId) return `bot:${chat.botId}`
  return chat.projectId || null
}

/** The scopes whose secrets a chat's shell gets: its project's, then its bot's own, which win on a clash. */
export function secretScopes(chat: { projectId: string; botId?: string }): string[] {
  return [chat.projectId, chat.botId ? `bot:${chat.botId}` : ''].filter(Boolean)
}

/** Called with the scope after a secret was saved or deleted. */
export function onSecretsChanged(listener: (scope: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function changed(scope: string): void {
  for (const listener of listeners) listener(scope)
}

export async function setSecret(scope: string, name: string, value: string): Promise<void> {
  const nameError = secretNameError(name)
  if (nameError) throw new Error(nameError)
  if (!value) throw new Error('The secret is empty.')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The system keychain is not available to encrypt the secret.')
  const sealed = safeStorage.encryptString(value).toString('base64')
  await withLock(secretsPath(), async () => {
    const file = await load()
    file[scope] = { ...file[scope], [name]: sealed }
    await writeFileAtomic(secretsPath(), JSON.stringify(file, null, 2))
  })
  changed(scope)
}

export async function deleteSecret(scope: string, name: string): Promise<void> {
  let removed = false
  await withLock(secretsPath(), async () => {
    const file = await load()
    if (!file[scope] || !(name in file[scope])) return
    delete file[scope][name]
    if (Object.keys(file[scope]).length === 0) delete file[scope]
    await writeFileAtomic(secretsPath(), JSON.stringify(file, null, 2))
    removed = true
  })
  if (removed) changed(scope)
}

/** The names of every scope's secrets, never their values. */
export async function listSecrets(): Promise<SecretScope[]> {
  const file = await load()
  return Object.entries(file).map(([scope, secrets]) => ({ scope, names: Object.keys(secrets).sort() }))
}

export async function secretNames(scope: string | null): Promise<string[]> {
  if (!scope) return []
  return Object.keys((await load())[scope] ?? {}).sort()
}

/**
 * The scopes' secrets, decrypted, as environment variables; a later scope's value wins on a clash.
 * One that no longer decrypts is left out.
 */
export async function secretEnv(...scopes: Array<string | null>): Promise<Record<string, string>> {
  const file = await load()
  const env: Record<string, string> = {}
  for (const scope of scopes) {
    if (!scope) continue
    for (const [name, sealed] of Object.entries(file[scope] ?? {})) {
      try {
        env[name] = safeStorage.decryptString(Buffer.from(sealed, 'base64'))
      } catch {
        // Encrypted under another keychain entry, e.g. after the app was reinstalled.
      }
    }
  }
  return env
}

/** Keys the fingerprints, so one seen in a process name or request id tells nothing about the values. */
const FINGERPRINT_KEY = randomBytes(32)

/** A short fingerprint of an environment, so a process can tell its secrets from changed ones. */
export function envFingerprint(env: Record<string, string>): string {
  const sorted = Object.keys(env)
    .sort()
    .map((name) => [name, env[name]])
  return createHmac('sha256', FINGERPRINT_KEY).update(JSON.stringify(sorted)).digest('hex').slice(0, 12)
}
