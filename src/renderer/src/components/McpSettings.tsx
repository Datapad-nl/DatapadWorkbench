import { useEffect, useMemo, useRef, useState } from 'react'
import { BUILT_IN_MCP, type McpServerEntry, type McpServers, parseMcpServers } from '../../../shared/mcp'
import {
  buildServerEntry,
  installFields,
  installOptions,
  missingFields,
  suggestServerName,
  type InstallValues,
  type RegistryServer
} from '../../../shared/mcpRegistry'
import { Toggle } from './Toggle'

type View =
  | { kind: 'list' }
  | { kind: 'browse' }
  | { kind: 'configure'; server: RegistryServer }
  | { kind: 'edit'; name: string | null }
  | { kind: 'json' }

/** Saves the whole list. Resolves to an error message, or null once saved. */
type SaveServers = (next: McpServers) => Promise<string | null>

const QUIET_BUTTON = 'rounded-lg px-3 py-2 text-[12px] text-muted hover:text-ink'
const PRIMARY_BUTTON =
  'rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px disabled:opacity-50'
const OUTLINE_BUTTON = 'rounded-lg border border-line px-3 py-2 text-[12px] text-ink hover:bg-raised'
const INPUT =
  'mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px] text-ink outline-none placeholder:text-muted/60 focus:border-accent/60'

function entrySummary(entry: McpServerEntry): string {
  return 'url' in entry ? `${entry.type} ${entry.url}` : [entry.command, ...(entry.args ?? [])].join(' ')
}

/** The list with `entry` under `name`, in the place of `previous` when renaming. */
function withServer(servers: McpServers, name: string, entry: McpServerEntry, previous: string | null): McpServers {
  const next: McpServers = {}
  for (const [key, value] of Object.entries(servers)) {
    if (key === previous) next[name] = entry
    else if (key !== name) next[key] = value
  }
  if (!(name in next)) next[name] = entry
  return next
}

function nameProblem(name: string, servers: McpServers, previous: string | null): string | null {
  if (!name) return 'Give the server a name'
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return 'Use letters, digits, ".", "-" and "_" in the name'
  if (name === BUILT_IN_MCP) return `"${BUILT_IN_MCP}" is the built-in server. Pick another name.`
  if (name !== previous && name in servers) return `There is already a server named "${name}"`
  return null
}

export function McpSettings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [servers, setServers] = useState<McpServers | null>(null)
  const [view, setView] = useState<View>({ kind: 'list' })
  const search = useRegistrySearch(view.kind === 'browse')

  useEffect(() => {
    void window.workbench.getMcpServers().then(setServers)
  }, [])

  const save: SaveServers = async (next) => {
    const result = await window.workbench.setMcpServers(JSON.stringify({ mcpServers: next }))
    if ('error' in result) return result.error
    setServers(result.servers)
    return null
  }

  const list = servers ?? {}
  const toList = (): void => setView({ kind: 'list' })
  if (view.kind === 'browse') {
    return (
      <BrowseView
        search={search}
        servers={list}
        onBack={toList}
        onPick={(server) => setView({ kind: 'configure', server })}
      />
    )
  }
  if (view.kind === 'configure') {
    return (
      <ConfigureView
        key={view.server.name}
        server={view.server}
        servers={list}
        save={save}
        onBack={() => setView({ kind: 'browse' })}
        onDone={toList}
      />
    )
  }
  if (view.kind === 'edit') {
    return <EditView key={view.name ?? ''} name={view.name} servers={list} save={save} onBack={toList} />
  }
  if (view.kind === 'json') return <JsonView servers={list} save={save} onBack={toList} />
  return (
    <ListView
      servers={servers}
      save={save}
      onBrowse={() => setView({ kind: 'browse' })}
      onEdit={(name) => setView({ kind: 'edit', name })}
      onJson={() => setView({ kind: 'json' })}
      onClose={onClose}
    />
  )
}

function SubHeader({ title, onBack }: { title: string; onBack: () => void }): React.JSX.Element {
  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        data-testid="mcp-back"
        className="rounded-md px-1.5 py-0.5 text-[12px] text-muted hover:bg-raised hover:text-ink"
        onClick={onBack}
      >
        ← Back
      </button>
      <div className="text-[13px] font-medium text-ink">{title}</div>
    </div>
  )
}

function ListView({
  servers,
  save,
  onBrowse,
  onEdit,
  onJson,
  onClose
}: {
  servers: McpServers | null
  save: SaveServers
  onBrowse: () => void
  onEdit: (name: string | null) => void
  onJson: () => void
  onClose: () => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const list = servers ?? {}

  async function apply(next: McpServers): Promise<void> {
    setError(await save(next))
  }

  function toggle(name: string, entry: McpServerEntry): void {
    const { disabled, ...rest } = entry
    void apply({ ...list, [name]: disabled ? rest : { ...rest, disabled: true } } as McpServers)
  }

  function remove(name: string): void {
    const next = { ...list }
    delete next[name]
    setConfirmRemove(null)
    void apply(next)
  }

  return (
    <>
      <p className="mt-1 text-[12.5px] leading-5 text-muted">
        Every Grok Build and Claude Code chat gets these servers, next to the built-in browser. New chats
        pick up a change right away; chats already running get it after a restart. Servers in each
        agent&apos;s own config still load as well.
      </p>
      <ul data-testid="mcp-installed" className="mt-4 divide-y divide-line rounded-lg border border-line bg-canvas">
        <li className="flex items-center gap-2 px-3 py-2.5 text-[12px]">
          <span className="font-medium text-ink">{BUILT_IN_MCP}</span>
          <span className="text-[11px] text-muted">built in</span>
        </li>
        {Object.entries(list).map(([name, entry]) => (
          <li key={name} data-testid={`mcp-server-${name}`} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className={`text-[12px] font-medium ${entry.disabled ? 'text-muted line-through' : 'text-ink'}`}>
                {name}
              </div>
              <div className="truncate font-mono text-[11px] text-muted" title={entrySummary(entry)}>
                {entrySummary(entry)}
              </div>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-raised hover:text-ink"
              onClick={() => onEdit(name)}
            >
              Edit
            </button>
            {confirmRemove === name ? (
              <button
                type="button"
                className="shrink-0 rounded-md px-2 py-1 text-[11px] text-red-400 hover:bg-raised"
                onClick={() => remove(name)}
                onBlur={() => setConfirmRemove(null)}
                autoFocus
              >
                Remove?
              </button>
            ) : (
              <button
                type="button"
                aria-label={`Remove ${name}`}
                className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-raised hover:text-ink"
                onClick={() => setConfirmRemove(name)}
              >
                Remove
              </button>
            )}
            <Toggle label={`Load ${name}`} on={!entry.disabled} onClick={() => toggle(name, entry)} />
          </li>
        ))}
      </ul>
      {servers && !Object.keys(list).length ? (
        <p className="mt-2 text-[11.5px] text-muted">
          No servers of your own yet. Browse the MCP Registry to find one.
        </p>
      ) : null}
      {error ? <p className="mt-2 text-[11px] leading-4 text-red-400">{error}</p> : null}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" data-testid="mcp-browse" className={PRIMARY_BUTTON} onClick={onBrowse}>
          Browse servers
        </button>
        <button type="button" data-testid="mcp-add-custom" className={OUTLINE_BUTTON} onClick={() => onEdit(null)}>
          Add custom
        </button>
        <button type="button" data-testid="mcp-json" className={`${QUIET_BUTTON} ml-auto`} onClick={onJson}>
          Edit as JSON
        </button>
      </div>
      <div className="mt-5 flex justify-end">
        <button className={QUIET_BUTTON} onClick={onClose}>
          Close
        </button>
      </div>
    </>
  )
}

type RegistrySearch = {
  query: string
  setQuery: (query: string) => void
  results: RegistryServer[]
  loading: boolean
  error: string | null
  more: (() => void) | null
  retry: () => void
}

/** Searches the registry while the browse view is open, and keeps the results when it closes. */
function useRegistrySearch(active: boolean): RegistrySearch {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RegistryServer[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null)
  const request = useRef(0)

  async function load(text: string, after: string | null): Promise<void> {
    const id = ++request.current
    setLoading(true)
    setError(null)
    const result = await window.workbench
      .searchMcpRegistry(text, after ?? undefined)
      .catch((caught: unknown) => ({ error: caught instanceof Error ? caught.message : String(caught) }))
    if (id !== request.current) return
    setLoading(false)
    if ('error' in result) {
      setError(`Could not reach the MCP Registry. ${result.error}`)
      return
    }
    setResults((previous) => (after ? [...previous, ...result.servers] : result.servers))
    setCursor(result.nextCursor)
    setLoadedQuery(text)
  }

  const loadRef = useRef(load)
  loadRef.current = load
  const wanted = query.trim()
  useEffect(() => {
    if (!active || wanted === loadedQuery) return
    const timer = setTimeout(() => void loadRef.current(wanted, null), wanted ? 300 : 0)
    return () => clearTimeout(timer)
  }, [active, wanted, loadedQuery])

  return {
    query,
    setQuery,
    results,
    loading,
    error,
    more: cursor && !loading && wanted === loadedQuery ? () => void load(wanted, cursor) : null,
    retry: () => void load(wanted, wanted === loadedQuery ? cursor : null)
  }
}

function alreadyAdded(server: RegistryServer, servers: McpServers): boolean {
  const urls = new Set((server.remotes ?? []).map((remote) => remote.url))
  const ids = (server.packages ?? []).map((pkg) => pkg.identifier)
  return Object.values(servers).some((entry) =>
    'url' in entry
      ? urls.has(entry.url)
      : (entry.args ?? []).some((arg) =>
          ids.some((id) => arg === id || arg.startsWith(`${id}@`) || arg.startsWith(`${id}:`))
        )
  )
}

const KIND_BADGES = { remote: 'Remote', npm: 'npm', pypi: 'PyPI', oci: 'Docker' } as const

function serverTitle(server: RegistryServer): string {
  return server.title || suggestServerName(server, [])
}

function ServerIcon({ server }: { server: RegistryServer }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  const icons = (server.icons ?? []).filter((icon) => icon.src.startsWith('https://'))
  const src = (icons.find((icon) => icon.theme === 'dark') ?? icons.find((icon) => !icon.theme) ?? icons[0])?.src
  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setBroken(true)}
        className="h-8 w-8 shrink-0 rounded-md bg-raised object-contain p-1"
      />
    )
  }
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-raised text-[13px] font-semibold uppercase text-muted">
      {serverTitle(server).charAt(0)}
    </div>
  )
}

function BrowseView({
  search,
  servers,
  onBack,
  onPick
}: {
  search: RegistrySearch
  servers: McpServers
  onBack: () => void
  onPick: (server: RegistryServer) => void
}): React.JSX.Element {
  const { query, setQuery, results, loading, error, more, retry } = search
  return (
    <>
      <SubHeader title="Browse the MCP Registry" onBack={onBack} />
      <input
        data-testid="mcp-search"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name: github, postgres, notion…"
        className={`${INPUT} mt-3`}
      />
      <ul data-testid="mcp-results" className="mt-3 max-h-[50vh] min-h-[120px] space-y-1 overflow-y-auto">
        {results.map((server) => {
          const kinds = [...new Set(installOptions(server).map((option) => KIND_BADGES[option.kind]))]
          const added = alreadyAdded(server, servers)
          return (
            <li key={server.name}>
              <button
                type="button"
                className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-raised"
                onClick={() => onPick(server)}
              >
                <ServerIcon server={server} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-[12.5px] font-medium text-ink">{serverTitle(server)}</span>
                    <span className="truncate font-mono text-[10.5px] text-muted">{server.name}</span>
                  </div>
                  {server.description ? (
                    <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-muted">{server.description}</div>
                  ) : null}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {kinds.map((kind) => (
                      <span key={kind} className="rounded bg-canvas px-1.5 py-px text-[10px] text-muted">
                        {kind}
                      </span>
                    ))}
                    {added ? (
                      <span className="rounded bg-accent/15 px-1.5 py-px text-[10px] text-accent">Added</span>
                    ) : null}
                  </div>
                </div>
              </button>
            </li>
          )
        })}
        {!loading && !error && !results.length ? (
          <li className="px-2 py-6 text-center text-[12px] text-muted">
            {query.trim() ? `No server names contain "${query.trim()}".` : 'No servers found.'}
          </li>
        ) : null}
      </ul>
      <div className="mt-2 flex min-h-[28px] items-center justify-between gap-2">
        <span className="text-[11px] text-muted">{loading ? 'Searching…' : null}</span>
        {more ? (
          <button type="button" className={QUIET_BUTTON} onClick={more}>
            Load more
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="text-[11px] leading-4 text-red-400">
          {error}{' '}
          <button type="button" className="text-accent hover:underline" onClick={retry}>
            Try again
          </button>
        </p>
      ) : null}
      <p className="mt-2 text-[11px] leading-4 text-muted">
        Listings come from the official MCP Registry. Anyone can publish there, so check a server before
        you give it a key.
      </p>
    </>
  )
}

function ConfigureView({
  server,
  servers,
  save,
  onBack,
  onDone
}: {
  server: RegistryServer
  servers: McpServers
  save: SaveServers
  onBack: () => void
  onDone: () => void
}): React.JSX.Element {
  const options = useMemo(() => installOptions(server), [server])
  const [optionIndex, setOptionIndex] = useState(0)
  const option = options[optionIndex] ?? options[0]
  const fields = useMemo(() => installFields(option), [option])
  const [values, setValues] = useState<InstallValues>({})
  const [name, setName] = useState(() => suggestServerName(server, Object.keys(servers)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const entry = buildServerEntry(option, values)
  const missing = missingFields(option, values)
  const problem = nameProblem(name.trim(), servers, null)
  // Secrets stay hidden in the preview.
  const preview = fields
    .filter((item) => item.secret && values[item.key]?.trim())
    .reduce((text, item) => text.split(values[item.key].trim()).join('•••'), entrySummary(entry))

  async function add(): Promise<void> {
    if (busy || problem || missing.length) return
    setBusy(true)
    const failure = await save(withServer(servers, name.trim(), entry, null))
    setBusy(false)
    if (failure) setError(failure)
    else onDone()
  }

  const links = [
    server.websiteUrl ? { label: 'Website', url: server.websiteUrl } : null,
    server.repository?.url ? { label: 'Source', url: server.repository.url } : null
  ].filter((link): link is { label: string; url: string } => !!link)

  return (
    <>
      <SubHeader title="Add server" onBack={onBack} />
      <div className="mt-3 flex items-start gap-3 rounded-lg border border-line bg-canvas px-3 py-3">
        <ServerIcon server={server} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink">{serverTitle(server)}</div>
          <div className="font-mono text-[10.5px] text-muted">
            {server.name}
            {server.version ? ` · ${server.version}` : ''}
          </div>
          {server.description ? (
            <p className="mt-1 text-[12px] leading-[18px] text-muted">{server.description}</p>
          ) : null}
          {links.length ? (
            <div className="mt-1.5 flex gap-3">
              {links.map((link) => (
                <button
                  key={link.label}
                  type="button"
                  className="text-[11px] text-accent hover:underline"
                  onClick={() => void window.workbench.openExternal(link.url)}
                >
                  {link.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {options.length > 1 ? (
        <div className="mt-4">
          <div className="text-[12px] text-muted">Run it as</div>
          <div data-testid="mcp-install-options" className="mt-1 inline-flex flex-wrap rounded-md bg-canvas p-0.5">
            {options.map((item, index) => (
              <button
                key={index}
                type="button"
                aria-pressed={index === optionIndex}
                className={`rounded px-2.5 py-1 text-[11px] ${
                  index === optionIndex ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
                }`}
                onClick={() => setOptionIndex(index)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <label className="mt-4 block text-[12px] text-muted">
        Name
        <input
          data-testid="mcp-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          spellCheck={false}
          className={`${INPUT} font-mono`}
        />
      </label>

      {fields.map((item) => (
        <label key={item.key} className="mt-3 block text-[12px] text-muted">
          <span className="font-mono text-ink">{item.label}</span>
          {item.required ? <span className="text-red-400"> *</span> : null}
          {item.description ? <span className="mt-0.5 block text-[11px] leading-4">{item.description}</span> : null}
          {item.choices ? (
            <select
              value={values[item.key] ?? item.default ?? ''}
              onChange={(event) => setValues({ ...values, [item.key]: event.target.value })}
              className={INPUT}
            >
              {item.required && item.default === undefined ? <option value="">Choose…</option> : null}
              {!item.required ? <option value="">Leave out</option> : null}
              {item.choices.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={item.secret ? 'password' : 'text'}
              value={values[item.key] ?? item.default ?? ''}
              onChange={(event) => setValues({ ...values, [item.key]: event.target.value })}
              placeholder={item.placeholder}
              spellCheck={false}
              autoComplete="off"
              className={`${INPUT} font-mono`}
            />
          )}
        </label>
      ))}

      <div className="mt-4 text-[12px] text-muted">{option.kind === 'remote' ? 'Connects to' : 'Runs'}</div>
      <div
        data-testid="mcp-preview"
        className="mt-1 break-all rounded-lg bg-canvas px-3 py-2 font-mono text-[11px] leading-4 text-muted"
      >
        {preview}
      </div>

      {error || problem || missing.length ? (
        <p className="mt-2 text-[11px] leading-4 text-red-400">
          {error ?? problem ?? `Fill in ${missing.join(', ')}`}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <button className={QUIET_BUTTON} onClick={onBack}>
          Cancel
        </button>
        <button
          data-testid="mcp-add"
          disabled={busy || !!problem || missing.length > 0}
          className={PRIMARY_BUTTON}
          onClick={() => void add()}
        >
          Add server
        </button>
      </div>
    </>
  )
}

type Pair = { name: string; value: string }

function toPairs(record: Record<string, string> | undefined): Pair[] {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))
}

function fromPairs(pairs: Pair[]): Record<string, string> | undefined {
  const kept = pairs.filter((pair) => pair.name.trim())
  return kept.length ? Object.fromEntries(kept.map((pair) => [pair.name.trim(), pair.value])) : undefined
}

const SECRET_NAME = /(key|token|secret|password|auth|authorization)$/i

function PairsEditor({
  label,
  addLabel,
  pairs,
  onChange
}: {
  label: string
  addLabel: string
  pairs: Pair[]
  onChange: (pairs: Pair[]) => void
}): React.JSX.Element {
  const set = (index: number, patch: Partial<Pair>): void =>
    onChange(pairs.map((pair, at) => (at === index ? { ...pair, ...patch } : pair)))
  return (
    <div className="mt-3">
      <div className="text-[12px] text-muted">{label}</div>
      {pairs.map((pair, index) => (
        <div key={index} className="mt-1 grid grid-cols-[2fr_3fr_auto] gap-2">
          <input
            value={pair.name}
            onChange={(event) => set(index, { name: event.target.value })}
            placeholder="NAME"
            spellCheck={false}
            className={`${INPUT} mt-0 font-mono`}
          />
          <input
            type={SECRET_NAME.test(pair.name) ? 'password' : 'text'}
            value={pair.value}
            onChange={(event) => set(index, { value: event.target.value })}
            placeholder="value"
            spellCheck={false}
            autoComplete="off"
            className={`${INPUT} mt-0 font-mono`}
          />
          <button
            type="button"
            aria-label="Remove"
            className="shrink-0 rounded-md px-2 text-[13px] text-muted hover:bg-raised hover:text-ink"
            onClick={() => onChange(pairs.filter((_, at) => at !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="mt-1.5 text-[11.5px] text-accent hover:underline"
        onClick={() => onChange([...pairs, { name: '', value: '' }])}
      >
        {addLabel}
      </button>
    </div>
  )
}

function EditView({
  name: previous,
  servers,
  save,
  onBack
}: {
  name: string | null
  servers: McpServers
  save: SaveServers
  onBack: () => void
}): React.JSX.Element {
  const existing = previous ? servers[previous] : undefined
  const local = existing && 'command' in existing ? existing : undefined
  const remote = existing && 'url' in existing ? existing : undefined
  const [name, setName] = useState(previous ?? '')
  const [kind, setKind] = useState<'command' | 'url'>(remote ? 'url' : 'command')
  const [command, setCommand] = useState(local?.command ?? '')
  const [args, setArgs] = useState((local?.args ?? []).join('\n'))
  const [env, setEnv] = useState(toPairs(local?.env))
  const [url, setUrl] = useState(remote?.url ?? '')
  const [type, setType] = useState<'http' | 'sse'>(remote?.type ?? 'http')
  const [headers, setHeaders] = useState(toPairs(remote?.headers))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function build(): McpServerEntry {
    const disabled = existing?.disabled ? { disabled: true } : {}
    if (kind === 'url') {
      const pairs = fromPairs(headers)
      return { type, url: url.trim(), ...(pairs ? { headers: pairs } : {}), ...disabled }
    }
    const list = args
      .split('\n')
      .map((arg) => arg.trim())
      .filter(Boolean)
    const pairs = fromPairs(env)
    return { command: command.trim(), ...(list.length ? { args: list } : {}), ...(pairs ? { env: pairs } : {}), ...disabled }
  }

  async function submit(): Promise<void> {
    if (busy) return
    const key = name.trim()
    const problem = nameProblem(key, servers, previous)
    if (problem) {
      setError(problem)
      return
    }
    let entry: McpServerEntry
    try {
      entry = parseMcpServers(JSON.stringify({ [key]: build() }))[key]
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      return
    }
    setBusy(true)
    const failure = await save(withServer(servers, key, entry, previous))
    setBusy(false)
    if (failure) setError(failure)
    else onBack()
  }

  return (
    <>
      <SubHeader title={previous ? `Edit ${previous}` : 'Add a custom server'} onBack={onBack} />
      <label className="mt-3 block text-[12px] text-muted">
        Name
        <input
          data-testid="mcp-edit-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          spellCheck={false}
          autoFocus={!previous}
          className={`${INPUT} font-mono`}
        />
      </label>
      <div className="mt-3 inline-flex rounded-md bg-canvas p-0.5">
        {(
          [
            ['command', 'Command on this computer'],
            ['url', 'Remote URL']
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={kind === value}
            className={`rounded px-2.5 py-1 text-[11px] ${kind === value ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}
            onClick={() => setKind(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {kind === 'command' ? (
        <>
          <label className="mt-3 block text-[12px] text-muted">
            Command
            <input
              data-testid="mcp-edit-command"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npx"
              spellCheck={false}
              className={`${INPUT} font-mono`}
            />
          </label>
          <label className="mt-3 block text-[12px] text-muted">
            Arguments, one per line
            <textarea
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder={'-y\n@modelcontextprotocol/server-github'}
              spellCheck={false}
              rows={3}
              className={`${INPUT} resize-y font-mono leading-5`}
            />
          </label>
          <PairsEditor label="Environment variables" addLabel="+ Add variable" pairs={env} onChange={setEnv} />
        </>
      ) : (
        <>
          <div className="mt-3 flex gap-2">
            <label className="block flex-1 text-[12px] text-muted">
              URL
              <input
                data-testid="mcp-edit-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://mcp.example.com/mcp"
                spellCheck={false}
                className={`${INPUT} font-mono`}
              />
            </label>
            <label className="block w-[110px] text-[12px] text-muted">
              Transport
              <select value={type} onChange={(event) => setType(event.target.value as 'http' | 'sse')} className={INPUT}>
                <option value="http">HTTP</option>
                <option value="sse">SSE</option>
              </select>
            </label>
          </div>
          <PairsEditor label="Headers" addLabel="+ Add header" pairs={headers} onChange={setHeaders} />
        </>
      )}
      {error ? <p className="mt-3 text-[11px] leading-4 text-red-400">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button className={QUIET_BUTTON} onClick={onBack}>
          Cancel
        </button>
        <button data-testid="mcp-edit-save" disabled={busy} className={PRIMARY_BUTTON} onClick={() => void submit()}>
          {previous ? 'Save' : 'Add server'}
        </button>
      </div>
    </>
  )
}

const MCP_EXAMPLE = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" }
    },
    "linear": { "url": "https://mcp.linear.app/mcp" }
  }
}`

function mcpText(servers: McpServers): string {
  return Object.keys(servers).length ? JSON.stringify({ mcpServers: servers }, null, 2) : ''
}

function JsonView({
  servers,
  save,
  onBack
}: {
  servers: McpServers
  save: SaveServers
  onBack: () => void
}): React.JSX.Element {
  const [text, setText] = useState(() => mcpText(servers))
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  let parseError: string | null = null
  let parsed: McpServers = {}
  try {
    parsed = parseMcpServers(text)
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error)
  }

  async function submit(): Promise<void> {
    const failure = await save(parsed)
    setSaveError(failure)
    if (!failure) {
      setText(mcpText(parsed))
      setSaved(true)
    }
  }

  const error = parseError ?? saveError
  return (
    <>
      <SubHeader title="Edit as JSON" onBack={onBack} />
      <p className="mt-2 text-[12.5px] leading-5 text-muted">
        Paste the <code>mcpServers</code> JSON from a server&apos;s docs. Add{' '}
        <code>&quot;disabled&quot;: true</code> to keep one without loading it.
      </p>
      <textarea
        data-testid="settings-mcp-json"
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setSaved(false)
          setSaveError(null)
        }}
        placeholder={MCP_EXAMPLE}
        spellCheck={false}
        rows={14}
        className="mt-3 w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[11.5px] leading-5 text-ink outline-none placeholder:text-muted/60 focus:border-accent/60"
      />
      {error ? <p className="mt-2 text-[11px] leading-4 text-red-400">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button className={QUIET_BUTTON} onClick={onBack}>
          Back
        </button>
        <button
          data-testid="settings-mcp-save"
          disabled={!!parseError}
          className={PRIMARY_BUTTON}
          onClick={() => void submit()}
        >
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>
    </>
  )
}
