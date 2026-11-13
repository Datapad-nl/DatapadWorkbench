import { BUILT_IN_MCP, type McpServerEntry } from './mcp'

/**
 * The parts of an MCP Registry `server.json` the Workbench reads.
 * Schema: https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
 */
export type RegistryInput = {
  description?: string
  isRequired?: boolean
  isSecret?: boolean
  format?: string
  value?: string
  default?: string
  placeholder?: string
  choices?: string[]
  variables?: Record<string, RegistryInput>
}

export type RegistryKeyValue = RegistryInput & { name: string }

export type RegistryArgument = RegistryInput & {
  type: 'positional' | 'named'
  /** The flag, for a named argument. */
  name?: string
  /** A label for a positional argument. Not part of the command line. */
  valueHint?: string
}

export type RegistryPackage = {
  registryType: string
  identifier: string
  version?: string
  transport?: { type: string }
  runtimeArguments?: RegistryArgument[]
  packageArguments?: RegistryArgument[]
  environmentVariables?: RegistryKeyValue[]
}

export type RegistryRemote = {
  type: string
  url: string
  headers?: RegistryKeyValue[]
  variables?: Record<string, RegistryInput>
}

export type RegistryServer = {
  name: string
  title?: string
  description?: string
  version?: string
  websiteUrl?: string
  repository?: { url?: string }
  icons?: Array<{ src: string; theme?: string }>
  packages?: RegistryPackage[]
  remotes?: RegistryRemote[]
}

export type RegistrySearchResult = { servers: RegistryServer[]; nextCursor: string | null }

/** The words of a search, split on spaces and the separators registry names use: "Meta Ads", "meta-ads" → meta, ads. */
export function searchWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[\s\-_./]+/).filter(Boolean))]
}

/**
 * The servers whose name, title or description contain every word, those with every word in
 * their name or title first. Each server once, by name.
 */
export function rankSearchResults(servers: RegistryServer[], words: string[]): RegistryServer[] {
  const seen = new Set<string>()
  const ranked: Array<{ server: RegistryServer; inName: boolean }> = []
  for (const server of servers) {
    if (seen.has(server.name)) continue
    seen.add(server.name)
    const name = `${server.name} ${server.title ?? ''}`.toLowerCase()
    const text = `${name} ${server.description ?? ''}`.toLowerCase()
    if (!words.every((word) => text.includes(word))) continue
    ranked.push({ server, inName: words.every((word) => name.includes(word)) })
  }
  return ranked.sort((a, b) => Number(b.inName) - Number(a.inName)).map((entry) => entry.server)
}

/** One way to run a registry server: a hosted endpoint, or a package started on this machine. */
export type InstallOption =
  | { kind: 'remote'; label: string; remote: RegistryRemote }
  | { kind: 'npm' | 'pypi' | 'oci'; label: string; pkg: RegistryPackage }

const PACKAGE_LABELS = { npm: 'npm (npx)', pypi: 'PyPI (uvx)', oci: 'Docker' } as const

/** The ways the Workbench can run this server. Hosted endpoints first, since they need nothing installed. */
export function installOptions(server: RegistryServer): InstallOption[] {
  const remotes: InstallOption[] = (server.remotes ?? [])
    .filter((remote) => (remote.type === 'streamable-http' || remote.type === 'sse') && /^https?:\/\//.test(remote.url))
    .map((remote) => ({ kind: 'remote', label: remote.type === 'sse' ? 'Remote (SSE)' : 'Remote', remote }))
  const packages: InstallOption[] = []
  for (const pkg of server.packages ?? []) {
    const kind = pkg.registryType
    // A package that serves HTTP itself would need starting and stopping outside the agent.
    if ((pkg.transport?.type ?? 'stdio') !== 'stdio' || !pkg.identifier) continue
    if (kind === 'npm' || kind === 'pypi' || kind === 'oci') packages.push({ kind, label: PACKAGE_LABELS[kind], pkg })
  }
  return [...remotes, ...packages]
}

/** A value the user fills in before the server is added. */
export type InstallField = {
  key: string
  label: string
  description?: string
  required: boolean
  secret: boolean
  placeholder?: string
  default?: string
  choices?: string[]
}

function field(key: string, label: string, input: RegistryInput): InstallField {
  return {
    key,
    label,
    description: input.description,
    required: !!input.isRequired,
    secret: !!input.isSecret,
    placeholder: input.placeholder,
    default: input.default,
    choices: input.choices?.length ? input.choices : undefined
  }
}

/** A fixed value asks only for its `{variables}`. A value left open asks for itself. */
function inputFields(key: string, label: string, input: RegistryInput): InstallField[] {
  if (input.value === undefined) return [field(key, label, input)]
  return Object.entries(input.variables ?? {}).map(([name, variable]) =>
    field(`${key}/${name}`, `${label}: ${name}`, variable)
  )
}

function argumentLabel(arg: RegistryArgument): string {
  return arg.type === 'named' ? (arg.name ?? 'argument') : (arg.valueHint ?? 'argument')
}

export function installFields(option: InstallOption): InstallField[] {
  if (option.kind === 'remote') {
    const { remote } = option
    return [
      ...Object.entries(remote.variables ?? {}).map(([name, input]) => field(`url/${name}`, name, input)),
      ...(remote.headers ?? []).flatMap((header) => inputFields(`header/${header.name}`, header.name, header))
    ]
  }
  const { pkg } = option
  return [
    ...(pkg.environmentVariables ?? []).flatMap((env) => inputFields(`env/${env.name}`, env.name, env)),
    ...(pkg.runtimeArguments ?? []).flatMap((arg, index) => inputFields(`runtime/${index}`, argumentLabel(arg), arg)),
    ...(pkg.packageArguments ?? []).flatMap((arg, index) => inputFields(`arg/${index}`, argumentLabel(arg), arg))
  ]
}

export type InstallValues = Record<string, string>

function valueOf(key: string, input: RegistryInput, values: InstallValues): string {
  return (values[key] ?? input.default ?? '').trim()
}

function fillTemplate(template: string, keyPrefix: string, variables: Record<string, RegistryInput>, values: InstallValues): string {
  return template.replace(/\{([^{}]+)\}/g, (match, name: string) =>
    variables[name] ? valueOf(`${keyPrefix}/${name}`, variables[name], values) : match
  )
}

/** The input's final text, or undefined when it was left empty. */
function resolve(key: string, input: RegistryInput, values: InstallValues): string | undefined {
  const text =
    input.value === undefined ? valueOf(key, input, values) : fillTemplate(input.value, key, input.variables ?? {}, values)
  return text === '' ? undefined : text
}

function resolveArgs(args: RegistryArgument[] | undefined, keyPrefix: string, values: InstallValues): string[] {
  return (args ?? []).flatMap((arg, index) => {
    const value = resolve(`${keyPrefix}/${index}`, arg, values)
    if (arg.type === 'named') {
      if (!arg.name) return []
      // A flag declared without a value is a plain switch.
      if (arg.value === undefined && !arg.variables && value === undefined) return arg.isRequired ? [arg.name] : []
      return value === undefined ? [] : [arg.name, value]
    }
    return value === undefined ? [] : [value]
  })
}

function resolvePairs(items: RegistryKeyValue[] | undefined, keyPrefix: string, values: InstallValues): Record<string, string> | undefined {
  const pairs = Object.fromEntries(
    (items ?? []).flatMap((item) => {
      const value = resolve(`${keyPrefix}/${item.name}`, item, values)
      return value === undefined ? [] : [[item.name, value]]
    })
  )
  return Object.keys(pairs).length ? pairs : undefined
}

function dockerImage(pkg: RegistryPackage): string {
  const tail = pkg.identifier.split('/').pop() ?? ''
  if (tail.includes(':') || tail.includes('@') || !pkg.version) return pkg.identifier
  return `${pkg.identifier}:${pkg.version}`
}

/** The `mcpServers` entry this option and these values make. */
export function buildServerEntry(option: InstallOption, values: InstallValues): McpServerEntry {
  if (option.kind === 'remote') {
    const { remote } = option
    const headers = resolvePairs(remote.headers, 'header', values)
    return {
      type: remote.type === 'sse' ? 'sse' : 'http',
      url: fillTemplate(remote.url, 'url', remote.variables ?? {}, values),
      ...(headers ? { headers } : {})
    }
  }
  const { pkg } = option
  const env = resolvePairs(pkg.environmentVariables, 'env', values)
  const runtime = resolveArgs(pkg.runtimeArguments, 'runtime', values)
  const packageArgs = resolveArgs(pkg.packageArguments, 'arg', values)
  const withEnv = env ? { env } : {}
  if (option.kind === 'npm') {
    // Without -y, npx stops to ask before it downloads, and an agent can't answer.
    const flags = runtime.includes('-y') || runtime.includes('--yes') ? runtime : ['-y', ...runtime]
    const spec = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier
    return { command: 'npx', args: [...flags, spec, ...packageArgs], ...withEnv }
  }
  if (option.kind === 'pypi') {
    const spec = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier
    return { command: 'uvx', args: [...runtime, spec, ...packageArgs], ...withEnv }
  }
  // `-e NAME` hands the variable from the agent's environment into the container.
  const passEnv = Object.keys(env ?? {}).flatMap((name) => ['-e', name])
  return {
    command: 'docker',
    args: ['run', '-i', '--rm', ...runtime, ...passEnv, dockerImage(pkg), ...packageArgs],
    ...withEnv
  }
}

/** Labels of required fields that are still empty. */
export function missingFields(option: InstallOption, values: InstallValues): string[] {
  return installFields(option)
    .filter((item) => item.required && !(values[item.key] ?? item.default ?? '').trim())
    .map((item) => item.label)
}

const GENERIC_NAMES = new Set(['mcp', 'server', 'mcp-server', 'server-mcp', 'remote', 'api'])

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** A short, free key for this server, like `notion` for `com.notion/mcp`. */
export function suggestServerName(server: RegistryServer, taken: Iterable<string>): string {
  const [namespace = '', part = ''] = server.name.split('/')
  let base = slug(part)
    .replace(/^(mcp-server-|server-mcp-|mcp-|server-)/, '')
    .replace(/(-mcp-server|-server-mcp|-mcp|-server)$/, '')
  if (!base || GENERIC_NAMES.has(base)) {
    const labels = namespace.split('.').filter((label) => !['io', 'com', 'ai', 'dev', 'app', 'net', 'org', 'github'].includes(label))
    base = slug(labels.pop() ?? '') || slug(server.title ?? '') || 'server'
  }
  const used = new Set(taken)
  used.add(BUILT_IN_MCP)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`
}
