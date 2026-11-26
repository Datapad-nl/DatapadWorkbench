import { useState } from 'react'
import {
  PROVIDER_PRESETS,
  type Provider,
  type ProviderBackend,
  type ProviderModel,
  type ReasoningEffort
} from '../../../shared/types'
import { useWorkspace } from '../workspace'
import { Toggle } from './Toggle'

const QUIET_BUTTON = 'rounded-lg px-3 py-2 text-[12px] text-muted hover:text-ink'
const PRIMARY_BUTTON =
  'rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px disabled:opacity-50'
const OUTLINE_BUTTON = 'rounded-lg border border-line px-3 py-2 text-[12px] text-ink hover:bg-raised disabled:opacity-50'
const INPUT =
  'mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px] text-ink outline-none placeholder:text-muted/60 focus:border-accent/60'
const SMALL_BUTTON = 'shrink-0 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-raised hover:text-ink'

const BACKENDS: Array<[ProviderBackend, string]> = [
  ['chat_completions', 'Chat Completions'],
  ['responses', 'Responses'],
  ['messages', 'Messages']
]

/** What the Reasoning effort switch turns on. */
const REASONING: ReasoningEffort[] = ['low', 'medium', 'high']

function errorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

function segment(on: boolean): string {
  return `rounded px-2.5 py-1 text-[11px] ${on ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`
}

/** Inference providers whose models Grok chats run on. The main process keeps the keys and writes Grok's config. */
export function ProviderSettings(): React.JSX.Element {
  const [editing, setEditing] = useState<Provider | 'new' | null>(null)
  if (editing) {
    return (
      <EditView
        key={editing === 'new' ? 'new' : editing.id}
        provider={editing === 'new' ? null : editing}
        onBack={() => setEditing(null)}
      />
    )
  }
  return <ListView onEdit={setEditing} />
}

function ListView({ onEdit }: { onEdit: (provider: Provider | 'new') => void }): React.JSX.Element {
  const { settings, removeProvider } = useWorkspace()
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const providers = settings?.providers ?? []

  function remove(id: string): void {
    setConfirmRemove(null)
    setError(null)
    void removeProvider(id).catch((caught: unknown) => setError(errorText(caught, 'Could not remove the provider')))
  }

  return (
    <>
      <p className="mt-1 text-[12.5px] leading-5 text-muted">
        Models from providers run through Grok Build. The app writes them to a marked block in Grok&apos;s config file (
        <span className="font-mono">~/.grok/config.toml</span>).
      </p>
      {providers.length ? (
        <ul data-testid="providers-list" className="mt-4 divide-y divide-line rounded-lg border border-line bg-canvas">
          {providers.map((provider) => (
            <li
              key={provider.id}
              data-testid={`provider-${provider.id}`}
              className="flex min-w-0 items-center gap-3 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-ink">{provider.name}</div>
                <div className="truncate font-mono text-[11px] text-muted" title={provider.baseUrl}>
                  {provider.baseUrl}
                </div>
                <div className="text-[11px] text-muted">
                  {provider.hasKey ? (
                    <span className="font-mono">{provider.keyPreview ?? 'Key saved'}</span>
                  ) : (
                    'No key'
                  )}
                  {' · '}
                  {provider.models.length === 1 ? '1 model' : `${provider.models.length} models`}
                </div>
              </div>
              <button
                type="button"
                data-testid={`provider-edit-${provider.id}`}
                className={SMALL_BUTTON}
                onClick={() => onEdit(provider)}
              >
                Edit
              </button>
              {confirmRemove === provider.id ? (
                <button
                  type="button"
                  data-testid={`provider-remove-confirm-${provider.id}`}
                  className="shrink-0 rounded-md px-2 py-1 text-[11px] text-red-400 hover:bg-raised"
                  onClick={() => remove(provider.id)}
                  onBlur={() => setConfirmRemove(null)}
                  autoFocus
                >
                  Remove?
                </button>
              ) : (
                <button
                  type="button"
                  data-testid={`provider-remove-${provider.id}`}
                  aria-label={`Remove ${provider.name}`}
                  className={SMALL_BUTTON}
                  onClick={() => setConfirmRemove(provider.id)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-[11.5px] text-muted">No providers yet.</p>
      )}
      {error ? <p className="mt-2 text-[11px] leading-4 text-red-400">{error}</p> : null}
      <div className="mt-3">
        <button type="button" data-testid="provider-add" className={PRIMARY_BUTTON} onClick={() => onEdit('new')}>
          Add provider
        </button>
      </div>
    </>
  )
}

function EditView({ provider, onBack }: { provider: Provider | null; onBack: () => void }): React.JSX.Element {
  const { saveProvider } = useWorkspace()
  const first = PROVIDER_PRESETS[0]
  // A new provider starts on the first preset; '' is Custom.
  const [preset, setPreset] = useState(provider ? '' : first.name)
  const [name, setName] = useState(provider?.name ?? first.name)
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? first.baseUrl)
  const [backend, setBackend] = useState<ProviderBackend>(provider?.backend ?? first.backend)
  const [apiKey, setApiKey] = useState('')
  const [chosen, setChosen] = useState<ProviderModel[]>(provider?.models ?? [])
  const [fetched, setFetched] = useState<ProviderModel[] | null>(null)
  const [filter, setFilter] = useState('')
  const [manualId, setManualId] = useState('')
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsKey = PROVIDER_PRESETS.find((item) => item.name === preset)?.needsKey ?? false
  const keyMissing = needsKey && !provider?.hasKey && !apiKey.trim()
  const query = filter.trim().toLowerCase()
  const shown = (fetched ?? []).filter(
    (model) => !query || model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query)
  )

  function pickPreset(next: string): void {
    setPreset(next)
    const item = PROVIDER_PRESETS.find((option) => option.name === next)
    if (!item) return
    setName(item.name)
    setBaseUrl(item.baseUrl)
    setBackend(item.backend)
  }

  function toggleModel(model: ProviderModel): void {
    setChosen((current) =>
      current.some((item) => item.id === model.id)
        ? current.filter((item) => item.id !== model.id)
        : [...current, model]
    )
  }

  function addManual(): void {
    const id = manualId.trim()
    if (id && !chosen.some((item) => item.id === id)) setChosen([...chosen, { id, name: id, efforts: [] }])
    setManualId('')
  }

  async function loadModels(): Promise<void> {
    setLoading(true)
    setListError(null)
    try {
      setFetched(
        await window.workbench.listProviderModels({
          id: provider?.id,
          baseUrl,
          backend,
          apiKey: apiKey.trim() || undefined
        })
      )
    } catch (caught) {
      setListError(errorText(caught, 'Could not load the models'))
    } finally {
      setLoading(false)
    }
  }

  async function save(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await saveProvider({
        id: provider?.id,
        name,
        baseUrl,
        backend,
        apiKey: apiKey.trim() ? apiKey.trim() : undefined,
        models: chosen
      })
      onBack()
    } catch (caught) {
      setError(errorText(caught, 'Could not save the provider'))
      setBusy(false)
    }
  }

  return (
    <div data-testid="provider-editor">
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          data-testid="provider-back"
          className="rounded-md px-1.5 py-0.5 text-[12px] text-muted hover:bg-raised hover:text-ink"
          onClick={onBack}
        >
          ← Back
        </button>
        <div className="text-[13px] font-medium text-ink">{provider ? provider.name : 'Add a provider'}</div>
      </div>

      {provider ? null : (
        <div data-testid="provider-preset" className="mt-4 inline-flex flex-wrap rounded-md bg-canvas p-0.5">
          {[...PROVIDER_PRESETS.map((item) => item.name), ''].map((option) => (
            <button
              key={option || 'custom'}
              type="button"
              aria-pressed={preset === option}
              className={segment(preset === option)}
              onClick={() => pickPreset(option)}
            >
              {option || 'Custom'}
            </button>
          ))}
        </div>
      )}

      <label className="mt-4 block text-[12px] text-muted">
        Name
        <input
          data-testid="provider-name"
          className={INPUT}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="mt-3 block text-[12px] text-muted">
        Base URL
        <input
          data-testid="provider-base-url"
          className={`${INPUT} font-mono`}
          spellCheck={false}
          placeholder="https://example.com/v1"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </label>
      <div className="mt-3 text-[12px] text-muted">API</div>
      <div data-testid="provider-backend" className="mt-1 inline-flex rounded-md bg-canvas p-0.5">
        {BACKENDS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={backend === value}
            className={segment(backend === value)}
            onClick={() => setBackend(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="mt-3 block text-[12px] text-muted">
        API key
        {needsKey ? <span className="text-red-400"> *</span> : null}
        {provider?.hasKey ? (
          <span className="mt-0.5 block text-[11px] leading-4">Leave empty to keep the saved key.</span>
        ) : null}
        <input
          type="password"
          data-testid="provider-key"
          autoComplete="off"
          spellCheck={false}
          className={`${INPUT} font-mono`}
          placeholder={provider?.keyPreview ?? (needsKey ? 'API key' : 'Optional')}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>

      <div className="mt-5 flex items-center gap-2">
        <div className="text-[12px] font-medium text-ink">Models</div>
        <button
          type="button"
          data-testid="provider-load-models"
          className={`${OUTLINE_BUTTON} ml-auto`}
          disabled={loading || !baseUrl.trim()}
          onClick={() => void loadModels()}
        >
          {loading ? 'Loading…' : 'Load models'}
        </button>
      </div>
      {listError ? (
        <p data-testid="provider-models-error" className="mt-2 text-[11px] leading-4 text-red-400">
          {listError}
        </p>
      ) : null}
      {fetched ? (
        <>
          <input
            data-testid="provider-models-filter"
            aria-label="Filter models"
            className={INPUT}
            placeholder={`Filter ${fetched.length} models`}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <ul
            data-testid="provider-models-fetched"
            className="mt-2 max-h-[240px] divide-y divide-line overflow-y-auto rounded-lg border border-line bg-canvas"
          >
            {shown.map((model) => (
              <li key={model.id}>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-raised">
                  <input
                    type="checkbox"
                    data-testid={`provider-fetched-${model.id}`}
                    checked={chosen.some((item) => item.id === model.id)}
                    onChange={() => toggleModel(model)}
                  />
                  <span className="truncate text-[12px] text-ink">{model.name}</span>
                  {model.name !== model.id ? (
                    <span className="truncate font-mono text-[10.5px] text-muted">{model.id}</span>
                  ) : null}
                </label>
              </li>
            ))}
            {shown.length ? null : <li className="px-3 py-3 text-[12px] text-muted">No models match.</li>}
          </ul>
        </>
      ) : null}

      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          addManual()
        }}
      >
        <input
          data-testid="provider-model-id"
          aria-label="Model id"
          spellCheck={false}
          className={`${INPUT} font-mono`}
          placeholder="Add a model by id, such as llama3.1:8b"
          value={manualId}
          onChange={(event) => setManualId(event.target.value)}
        />
        <button type="submit" data-testid="provider-model-add" className={`${OUTLINE_BUTTON} mt-1 shrink-0`} disabled={!manualId.trim()}>
          Add
        </button>
      </form>

      <ul data-testid="provider-models-chosen" className="mt-3 divide-y divide-line rounded-lg border border-line bg-canvas">
        {chosen.map((model) => (
          <li key={model.id} data-testid={`provider-model-${model.id}`} className="flex min-w-0 items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] text-ink">{model.name}</div>
              {model.name !== model.id ? <div className="truncate font-mono text-[10.5px] text-muted">{model.id}</div> : null}
            </div>
            <span className="shrink-0 text-[11px] text-muted">Reasoning effort</span>
            <Toggle
              label={`Reasoning effort for ${model.name}`}
              testId={`provider-model-effort-${model.id}`}
              on={model.efforts.length > 0}
              onClick={() =>
                setChosen((current) =>
                  current.map((item) =>
                    item.id === model.id ? { ...item, efforts: item.efforts.length ? [] : REASONING } : item
                  )
                )
              }
            />
            <button
              type="button"
              data-testid={`provider-model-remove-${model.id}`}
              aria-label={`Remove ${model.name}`}
              className={SMALL_BUTTON}
              onClick={() => toggleModel(model)}
            >
              Remove
            </button>
          </li>
        ))}
        {chosen.length ? null : <li className="px-3 py-3 text-[12px] text-muted">No models chosen yet.</li>}
      </ul>

      {error ? <p data-testid="provider-error" className="mt-3 text-[11px] leading-4 text-red-400">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={QUIET_BUTTON} onClick={onBack}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="provider-save"
          className={PRIMARY_BUTTON}
          disabled={busy || !name.trim() || !baseUrl.trim() || keyMissing}
          onClick={() => void save()}
        >
          {busy ? 'Saving' : 'Save'}
        </button>
      </div>
    </div>
  )
}
