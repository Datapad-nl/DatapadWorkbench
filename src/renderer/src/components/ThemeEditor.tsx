import { useEffect, useMemo, useRef, useState } from 'react'
import {
  COLOR_GROUPS,
  COLOR_LABELS,
  cloneTheme,
  isBuiltInThemeId,
  slugifyThemeId,
  type ThemeColors,
  type ThemeFile
} from '../../../shared/theme'
import { applyTheme } from '../theme/apply'
import { useTheme } from '../theme/ThemeProvider'

function hexForPicker(value: string): string {
  const hex = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    const [, r, g, b] = hex
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return '#888888'
}

function ThemeMock({ theme }: { theme: ThemeFile }): React.JSX.Element {
  return (
    <div
      className="overflow-hidden border border-line"
      style={{
        background: theme.colors.canvas,
        color: theme.colors.ink,
        fontFamily: theme.fonts.sans,
        borderRadius: theme.radii.md,
        display: 'grid',
        gridTemplateColumns: '88px 1fr',
        height: 104,
        borderColor: theme.colors.line
      }}
    >
      <div
        style={{
          background: theme.colors.sidebar,
          borderRight: `1px solid ${theme.colors.line}`,
          padding: 8
        }}
      >
        <div
          style={{
            background: theme.colors.active,
            color: theme.colors.ink,
            borderRadius: theme.radii.sm,
            fontSize: 9,
            padding: '4px 6px',
            marginBottom: 6
          }}
        >
          New chat
        </div>
        <div style={{ color: theme.colors.muted, fontSize: 9, padding: '0 6px' }}>Earlier</div>
      </div>
      <div style={{ padding: 10 }}>
        <div
          style={{
            fontFamily: theme.fonts.display,
            fontSize: 15,
            letterSpacing: '-0.03em',
            marginBottom: 8
          }}
        >
          {theme.name}
        </div>
        <div
          style={{
            background: theme.colors.surface,
            border: `1px solid ${theme.colors.line}`,
            borderRadius: theme.radii.md,
            height: 34,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '0 8px'
          }}
        >
          <span
            style={{
              background: theme.colors.accent,
              color: theme.colors.accentInk,
              borderRadius: theme.radii.sm,
              fontSize: 10,
              padding: '3px 8px',
              fontWeight: 500
            }}
          >
            Send
          </span>
        </div>
      </div>
    </div>
  )
}

function ColorField({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-2">
      <input
        type="color"
        className="h-7 w-7 shrink-0 cursor-pointer rounded border border-line bg-canvas p-0"
        value={hexForPicker(value)}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
      />
      <span className="w-[7.5rem] shrink-0 text-[11px] text-muted">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-accent/60"
      />
    </label>
  )
}

export function ThemeEditor(): React.JSX.Element {
  const { active, themes, activeId, activateTheme, saveTheme, deleteTheme, importTheme, exportTheme } =
    useTheme()
  const [draft, setDraft] = useState<ThemeFile>(active)
  const [saveName, setSaveName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  /** The active theme the draft was last synced with. */
  const synced = useRef(active)

  useEffect(() => {
    const previous = synced.current
    synced.current = active
    const edited = JSON.stringify(draftRef.current)
    if (edited !== JSON.stringify(previous) && edited !== JSON.stringify(active)) {
      // The theme changed under unsaved edits: keep them. This editor's own actions set the draft themselves.
      applyTheme(draftRef.current)
      return
    }
    setDraft(active)
    setSaveName('')
    setError(null)
  }, [active])

  useEffect(() => {
    applyTheme(draft)
  }, [draft])

  useEffect(() => {
    return () => {
      applyTheme(synced.current)
    }
  }, [])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(active), [draft, active])
  const builtIn = isBuiltInThemeId(draft.id)

  function patchColors(key: keyof ThemeColors, value: string): void {
    setDraft((current) => ({ ...current, colors: { ...current.colors, [key]: value } }))
    setNotice(null)
  }

  async function selectTheme(id: string): Promise<void> {
    if (dirty && !confirm('Discard unsaved theme edits?')) return
    setBusy(true)
    setError(null)
    try {
      setDraft((await activateTheme(id)).active)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch theme')
    } finally {
      setBusy(false)
    }
  }

  async function saveCurrent(): Promise<void> {
    if (builtIn) {
      await saveCopy()
      return
    }
    setBusy(true)
    setError(null)
    try {
      setDraft((await saveTheme(draft)).active)
      setNotice('Theme saved')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save theme')
    } finally {
      setBusy(false)
    }
  }

  async function saveCopy(): Promise<void> {
    const name = (saveName.trim() || `${draft.name} copy`).trim()
    const id = slugifyThemeId(name)
    const next = cloneTheme(draft, { id, name })
    setBusy(true)
    setError(null)
    try {
      setDraft((await saveTheme(next)).active)
      setSaveName('')
      setNotice(`Saved as ${name}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save theme')
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (builtIn) return
    if (!confirm(`Delete theme “${draft.name}”?`)) return
    setBusy(true)
    setError(null)
    try {
      setDraft((await deleteTheme(draft.id)).active)
      setNotice('Theme deleted')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete theme')
    } finally {
      setBusy(false)
    }
  }

  async function loadFile(): Promise<void> {
    if (dirty && !confirm('Discard unsaved theme edits?')) return
    setBusy(true)
    setError(null)
    try {
      const state = await importTheme()
      if (state) {
        setDraft(state.active)
        setNotice(`Loaded ${state.active.name}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load theme file')
    } finally {
      setBusy(false)
    }
  }

  async function exportFile(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const saved = await exportTheme(draft.id)
      if (saved) setNotice('Theme file written')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export theme')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <aside className="flex w-[200px] shrink-0 flex-col">
        <div className="text-[11px] font-medium text-muted">Themes</div>
        <div className="mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {themes.map((theme) => {
            const selected = theme.id === activeId
            return (
              <button
                key={theme.id}
                disabled={busy}
                onClick={() => void selectTheme(theme.id)}
                className={`flex w-full flex-col rounded-md px-2 py-1.5 text-left ${
                  selected ? 'bg-active text-ink' : 'text-muted hover:bg-raised hover:text-ink'
                }`}
              >
                <span className="truncate text-[12px] font-medium">{theme.name}</span>
                <span className="truncate text-[11px] opacity-70">
                  {theme.builtIn ? 'Built-in' : 'User'}
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-3 flex flex-col gap-1">
          <button
            disabled={busy}
            onClick={() => void loadFile()}
            className="rounded-md border border-line px-2 py-1.5 text-[11px] text-muted hover:bg-raised hover:text-ink"
          >
            Load theme file…
          </button>
          <button
            disabled={busy}
            onClick={() => void exportFile()}
            className="rounded-md border border-line px-2 py-1.5 text-[11px] text-muted hover:bg-raised hover:text-ink"
          >
            Export theme…
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto pr-1">
        <ThemeMock theme={draft} />

        <label className="mt-4 block text-[11px] text-muted">Name</label>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          className="mt-1 w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-[13px] outline-none focus:border-accent/60"
        />

        <label className="mt-3 block text-[11px] text-muted">Description</label>
        <input
          value={draft.description ?? ''}
          onChange={(event) =>
            setDraft((current) => ({ ...current, description: event.target.value || undefined }))
          }
          className="mt-1 w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent/60"
        />

        {COLOR_GROUPS.map((group) => (
          <section key={group.label} className="mt-4">
            <div className="mb-2 text-[11px] font-medium text-muted">
              {group.label}
            </div>
            <div className="space-y-1.5">
              {group.keys.map((key) => (
                <ColorField
                  key={key}
                  label={COLOR_LABELS[key]}
                  value={draft.colors[key]}
                  onChange={(value) => patchColors(key, value)}
                />
              ))}
            </div>
          </section>
        ))}

        <section className="mt-4">
          <div className="mb-2 text-[11px] font-medium text-muted">Type</div>
          <label className="block text-[11px] text-muted">Sans</label>
          <input
            value={draft.fonts.sans}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                fonts: { ...current.fonts, sans: event.target.value }
              }))
            }
            className="mt-1 w-full rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent/60"
          />
          <label className="mt-2 block text-[11px] text-muted">Mono</label>
          <input
            value={draft.fonts.mono}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                fonts: { ...current.fonts, mono: event.target.value }
              }))
            }
            className="mt-1 w-full rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent/60"
          />
          <label className="mt-2 block text-[11px] text-muted">Display</label>
          <input
            value={draft.fonts.display}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                fonts: { ...current.fonts, display: event.target.value }
              }))
            }
            className="mt-1 w-full rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent/60"
          />
          <p className="mt-1 text-[10px] leading-4 text-muted">
            Display is used for empty-state and project titles. That is what gives Warm Atelier its serif
            dossier.
          </p>
          <label className="mt-2 block text-[11px] text-muted">Font URLs (one per line, https)</label>
          <textarea
            value={draft.fonts.urls.join('\n')}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                fonts: {
                  ...current.fonts,
                  urls: event.target.value
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                }
              }))
            }
            rows={3}
            className="mt-1 w-full resize-y rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent/60"
          />
        </section>

        <section className="mt-4">
          <div className="mb-2 text-[11px] font-medium text-muted">Radii</div>
          <div className="grid grid-cols-3 gap-2">
            {(['sm', 'md', 'lg'] as const).map((key) => (
              <label key={key} className="block">
                <span className="text-[11px] text-muted">{key}</span>
                <input
                  type="number"
                  min={0}
                  max={32}
                  value={draft.radii[key]}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      radii: { ...current.radii, [key]: Number(event.target.value) || 0 }
                    }))
                  }
                  className="mt-1 w-full rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[12px] outline-none focus:border-accent/60"
                />
              </label>
            ))}
          </div>
        </section>

        <div className="mt-4 rounded-md border border-dashed border-line px-3 py-2">
          <div className="text-[11px] text-muted">
            {builtIn
              ? 'Built-in theme. Save a copy to keep your edits.'
              : dirty
                ? 'Unsaved edits apply live until you close Settings.'
                : 'This user theme is saved.'}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={saveName}
              onChange={(event) => setSaveName(event.target.value)}
              placeholder={builtIn ? `${draft.name} copy` : 'New name for Save as'}
              className="min-w-[160px] flex-1 rounded-md border border-line bg-canvas px-2 py-1.5 text-[12px] outline-none focus:border-accent/60"
            />
            <button
              disabled={busy}
              onClick={() => void saveCopy()}
              className="rounded-md border border-line px-2.5 py-1.5 text-[11px] text-muted hover:bg-raised hover:text-ink"
            >
              Save as
            </button>
            <button
              disabled={busy}
              onClick={() => void saveCurrent()}
              className="rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px"
            >
              {builtIn ? 'Save as copy' : 'Save theme'}
            </button>
            {!builtIn && (
              <button
                disabled={busy}
                onClick={() => void remove()}
                className="rounded-md px-2.5 py-1.5 text-[11px] text-muted hover:text-danger"
              >
                Delete
              </button>
            )}
          </div>
        </div>

        {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
        {notice && !error && <div className="mt-2 text-[12px] text-muted">{notice}</div>}
      </div>
    </div>
  )
}
