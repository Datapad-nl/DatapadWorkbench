import { useEffect, useRef, useState } from 'react'
import {
  CLAUDE_MODELS,
  type ClaudeUsage,
  DEFAULT_MODEL,
  GROK_REASONING_EFFORTS,
  REASONING_EFFORTS,
  type ClaudeOptions,
  reasoningEffortLabel,
  type ReasoningEffort,
  DEFAULT_VOICE,
  formatGrokCli,
  normalizeChatAgent,
  type PublicSettings,
  type UpdateState,
  type UsageSnapshot,
  type VoiceLanguage,
  type VoiceModelStatus,
  VOICE_LANGUAGES
} from '../../../shared/types'
import { MAX_SUBAGENTS_CHOICES } from '../../../shared/conductor'
import { useVoice } from '../voice/VoiceProvider'
import {
  isSpeaking,
  listMicInputs,
  listVoices,
  primeTtsOutput,
  speakAside,
  speakText,
  type MicInput
} from '../voice/engine'
import { useWorkspace } from '../workspace'
import { McpSettings } from './McpSettings'
import { ThemeEditor } from './ThemeEditor'
import { Toggle } from './Toggle'

function errorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

export function NewProjectModal(): React.JSX.Element | null {
  const { showNewProject, setShowNewProject, createProject, pickFolder } = useWorkspace()
  const [name, setName] = useState('')
  const [path, setPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!showNewProject) return null

  async function chooseFolder(): Promise<void> {
    const next = await pickFolder()
    if (!next) return
    setPath(next)
    if (!name.trim()) {
      const parts = next.split(/[/\\]/)
      setName(parts.at(-1) || '')
    }
  }

  async function submit(): Promise<void> {
    if (busy || (!name.trim() && !path)) return
    setBusy(true)
    setError(null)
    try {
      await createProject(name, path)
      setName('')
      setPath(null)
    } catch (caught) {
      setError(errorText(caught, 'Could not create the project'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay">
      <div className="w-[420px] rounded-2xl border border-line bg-surface p-5 shadow-2xl">
        <div className="text-[15px] font-semibold tracking-tight">New project</div>
        <p className="mt-1 text-[12.5px] text-muted">
          A project groups chats. Attach a local folder now, or leave it empty.
        </p>
        <label className="mt-4 block text-[12px] text-muted">Name</label>
        <input
          autoFocus
          data-testid="project-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] outline-none focus:border-accent/60"
          placeholder="Campaign Canvas"
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />
        <label className="mt-4 block text-[12px] text-muted">Folder</label>
        <div className="mt-1 flex gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] text-muted">
            {path ?? 'Optional'}
          </div>
          <button
            className="rounded-lg border border-line px-3 py-2 text-[12px] hover:bg-raised"
            onClick={() => void chooseFolder()}
          >
            Browse
          </button>
        </div>
        {error && <p className="mt-2 text-[11px] leading-4 text-red-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-2 text-[12px] text-muted hover:text-ink"
            onClick={() => {
              setShowNewProject(false)
              setName('')
              setPath(null)
              setError(null)
            }}
          >
            Cancel
          </button>
          <button
            data-testid="create-project"
            className="rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px disabled:opacity-40"
            disabled={busy || (!name.trim() && !path)}
            onClick={() => void submit()}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}

const SUPPORT_URL = 'https://buymeacoffee.com/datapad'

function CoffeeIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9h13v6.2A4.8 4.8 0 0 1 12.2 20H8.8A4.8 4.8 0 0 1 4 15.2V9Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M17 10.2h1.4a2.8 2.8 0 1 1 0 5.6H17"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M4 21.2h12.2M8 4.4c.25.9.25 1.8 0 2.7M11.2 4.4c.25.9.25 1.8 0 2.7M14.4 4.4c.25.9.25 1.8 0 2.7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MicAccessRow(): React.JSX.Element {
  const [status, setStatus] = useState<'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'>(
    'not-determined'
  )
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      setStatus(await window.workbench.getMicAccess())
    } catch {
      // preload from an older session
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const ok = status === 'granted'
  const blocked = status === 'denied' || status === 'restricted'

  async function requestAccess(): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      await window.workbench.ensureMic().catch(() => false)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      await refresh()
      setStatus('granted')
      setNote('Microphone is on.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not access the microphone'
      setNote(message)
      await refresh()
      try {
        await window.workbench.openMicSettings()
      } catch {
        setNote(`${message} Enable Datapad Workbench in System Settings → Privacy & Security → Microphone.`)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-start justify-between gap-3 text-[12px]">
      <div>
        <div className="font-medium text-ink">Microphone access</div>
        <p className="mt-0.5 text-[11px] leading-4 text-muted">
          {ok
            ? 'Allowed. Pick a device below.'
            : blocked
              ? 'Blocked in macOS. Enable Datapad Workbench under Privacy & Security → Microphone.'
              : 'macOS only prompts from a click. Use the button — check behind this window if nothing appears.'}
        </p>
        {note && <p className="mt-1 text-[11px] leading-4 text-ink">{note}</p>}
      </div>
      <button
        type="button"
        disabled={busy}
        className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] hover:bg-raised disabled:opacity-60"
        onClick={() => {
          if (blocked) {
            void window.workbench.openMicSettings()
            return
          }
          void requestAccess()
        }}
      >
        {busy ? 'Asking…' : blocked ? 'Open System Settings' : 'Request access'}
      </button>
    </div>
  )
}

function MicPicker({
  value,
  onChange
}: {
  value: string
  onChange: (deviceId: string) => void
}): React.JSX.Element {
  const [mics, setMics] = useState<MicInput[]>([])
  const [picked, setPicked] = useState(value)

  useEffect(() => {
    setPicked(value)
  }, [value])

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      await window.workbench.ensureMic()
      const next = await listMicInputs()
      if (!cancelled) setMics(next)
    }
    void load()
    function onDevices(): void {
      void load()
    }
    navigator.mediaDevices.addEventListener('devicechange', onDevices)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener('devicechange', onDevices)
    }
  }, [])

  const known = mics.some((item) => item.deviceId === picked)

  return (
    <label className="block text-[12px] text-muted">
      Microphone
      <select
        className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none"
        value={picked}
        onChange={(event) => {
          const next = event.target.value
          setPicked(next)
          onChange(next)
        }}
      >
        <option value="">System default</option>
        {mics.map((item) => (
          <option key={item.deviceId} value={item.deviceId}>
            {item.label}
          </option>
        ))}
        {picked && !known && <option value={picked}>Selected microphone</option>}
      </select>
    </label>
  )
}

function modelOptions(ids: string[], current: string): string[] {
  const seen = new Set<string>()
  const list: string[] = []
  for (const id of [...ids, current, DEFAULT_MODEL]) {
    const value = id.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    list.push(value)
  }
  return list
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })
/** The languages the speech model reads, by English name. `na` is the auto fallback, not a choice. */
const SPEECH_LANGUAGES = VOICE_LANGUAGES.filter((code) => code !== 'na')
  .map((code) => ({ code, name: languageNames.of(code) ?? code }))
  .sort((a, b) => a.name.localeCompare(b.name))

/** What the Test button says, in the chosen language. Auto-detect uses English. */
const VOICE_TEST: Partial<Record<VoiceLanguage, string>> = {
  en: 'Voice is on. This is how replies will sound.',
  ko: '음성이 켜졌습니다. 답변은 이렇게 들립니다.',
  ja: '音声がオンになりました。返答はこのように聞こえます。',
  ar: 'الصوت مفعّل. هكذا ستبدو الردود.',
  bg: 'Гласът е включен. Така ще звучат отговорите.',
  cs: 'Hlas je zapnutý. Takto budou znít odpovědi.',
  da: 'Stemmen er slået til. Sådan kommer svarene til at lyde.',
  de: 'Die Stimme ist an. So klingen die Antworten.',
  el: 'Η φωνή είναι ενεργή. Έτσι θα ακούγονται οι απαντήσεις.',
  es: 'La voz está activada. Así sonarán las respuestas.',
  et: 'Hääl on sees. Nii kõlavad vastused.',
  fi: 'Ääni on päällä. Tältä vastaukset kuulostavat.',
  fr: 'La voix est activée. Voici comment les réponses sonneront.',
  hi: 'आवाज़ चालू है। जवाब ऐसे सुनाई देंगे।',
  hr: 'Glas je uključen. Ovako će zvučati odgovori.',
  hu: 'A hang be van kapcsolva. Így fognak szólni a válaszok.',
  id: 'Suara aktif. Beginilah balasan akan terdengar.',
  it: 'La voce è attiva. Ecco come suoneranno le risposte.',
  lt: 'Balsas įjungtas. Taip skambės atsakymai.',
  lv: 'Balss ir ieslēgta. Šādi skanēs atbildes.',
  nl: 'De stem staat aan. Zo klinken de antwoorden.',
  pl: 'Głos jest włączony. Tak będą brzmiały odpowiedzi.',
  pt: 'A voz está ativada. É assim que as respostas vão soar.',
  ro: 'Vocea este pornită. Așa vor suna răspunsurile.',
  ru: 'Голос включён. Так будут звучать ответы.',
  sk: 'Hlas je zapnutý. Takto budú znieť odpovede.',
  sl: 'Glas je vklopljen. Tako bodo zveneli odgovori.',
  sv: 'Rösten är på. Så här kommer svaren att låta.',
  tr: 'Ses açık. Yanıtlar böyle duyulacak.',
  uk: 'Голос увімкнено. Так звучатимуть відповіді.',
  vi: 'Giọng nói đã bật. Câu trả lời sẽ nghe như thế này.'
}

function voiceModelHint(voiceModel: VoiceModelStatus): string {
  if (voiceModel.state === 'downloading') return `Downloading speech model… ${voiceModel.file ?? ''}`
  if (voiceModel.state === 'ready') return 'Local speech model ready'
  if (voiceModel.error) return voiceModel.error
  return 'Will download local Whisper + TTS (~500MB) once, then stay offline'
}

/** Saves the speed once the slider rests, so a drag is not a save per step. */
function RateSlider({ value, onSave }: { value: number; onSave: (rate: number) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const pending = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef(onSave)
  saveRef.current = onSave

  // A value saved elsewhere shows unless a drag here is still waiting to save.
  useEffect(() => {
    if (pending.current === null) setDraft(value)
  }, [value])

  // Closing settings mid-drag still saves the last position.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (pending.current !== null) saveRef.current(pending.current)
    },
    []
  )

  return (
    <input
      type="range"
      min={0.7}
      max={2}
      step={0.05}
      value={draft}
      className="mt-1 w-full"
      onChange={(event) => {
        const next = Number(event.target.value)
        setDraft(next)
        pending.current = next
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          timer.current = null
          pending.current = null
          saveRef.current(next)
        }, 250)
      }}
    />
  )
}

function updateText(state: UpdateState): string {
  switch (state.status) {
    case 'unsupported':
      return 'This is a development build. Installed builds update themselves.'
    case 'idle':
      return 'Updates download in the background and install when you quit.'
    case 'checking':
      return 'Checking for updates…'
    case 'latest':
      return 'You are on the latest version.'
    case 'downloading':
      return `Downloading ${state.version}… ${Math.round(state.percent)}%`
    case 'ready':
      return `Version ${state.version} is ready. Restart to install it.`
    case 'error':
      return `Could not check for updates: ${state.message}`
  }
}

function UpdateSection(): React.JSX.Element {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  // Main pushes every change. A reply lands only if no push came after its request, so it cannot undo a newer state.
  const pushes = useRef(0)

  useEffect(() => {
    let live = true
    const seen = pushes.current
    void window.workbench.getUpdateState().then((next) => {
      if (live && pushes.current === seen) setState(next)
    })
    const off = window.workbench.onUpdateState((next) => {
      pushes.current += 1
      setState(next)
    })
    return () => {
      live = false
      off()
    }
  }, [])

  function check(): void {
    const seen = pushes.current
    void window.workbench.checkForUpdates().then((next) => {
      if (pushes.current === seen) setState(next)
    })
  }

  const busy = state.status === 'checking' || state.status === 'downloading'
  return (
    <div data-testid="settings-updates" className="mt-5 rounded-lg border border-line bg-canvas px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] font-medium text-ink">Updates</div>
        <span className="font-mono text-[11px] text-muted">v{__APP_VERSION__}</span>
      </div>
      <p
        data-testid="settings-update-status"
        className={`mt-1 text-[12px] leading-5 ${state.status === 'error' ? 'text-danger' : 'text-muted'}`}
      >
        {updateText(state)}
      </p>
      {state.status === 'unsupported' ? null : state.status === 'ready' ? (
        <button
          type="button"
          data-testid="settings-update-install"
          className="mt-3 rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px"
          onClick={() => void window.workbench.installUpdate()}
        >
          Restart to update
        </button>
      ) : (
        <button
          type="button"
          data-testid="settings-update-check"
          disabled={busy}
          className="mt-3 rounded-lg border border-line bg-raised px-3 py-2 text-[12px] font-medium text-ink hover:bg-surface active:translate-y-px disabled:opacity-50"
          onClick={check}
        >
          {busy ? 'Checking…' : 'Check for updates'}
        </button>
      )}
    </div>
  )
}

/** Sign-in state for the agent new chats run on. The other agent stays out of sight. */
function AgentStatus({ settings }: { settings: PublicSettings }): React.JSX.Element {
  let ok: boolean
  let text: string
  let detail: string | null = null
  if (settings.cliChecking) {
    ok = true
    text = 'Checking the CLI…'
  } else if (settings.defaultAgent === 'claude') {
    const { signedIn, subscription, email } = settings.claude
    ok = signedIn
    text = signedIn
      ? `Signed in${email ? ` as ${email}` : ''}${
          subscription ? ` · ${subscription.charAt(0).toUpperCase()}${subscription.slice(1)}` : ''
        }`
      : 'Not signed in. Run claude auth login in a terminal.'
  } else if (!settings.grokCli.version) {
    ok = false
    text = 'Grok Build CLI not found. Install it and restart, or set GROK_BIN.'
  } else {
    ok = settings.hasKey
    text = settings.grokBuildSignedIn
      ? 'Signed in with grok login'
      : settings.hasKey
        ? `Using xAI API key${settings.keySource === 'env' ? ' from XAI_API_KEY' : ''} ${settings.keyPreview ?? ''}`
        : 'Not signed in. Run grok login in a terminal, or add an xAI API key below.'
    detail = `CLI ${formatGrokCli(settings.grokCli)}`
  }
  return (
    <div data-testid="settings-agent-status" className="mt-2 flex items-start gap-2 text-[12px] leading-5">
      <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${ok ? 'bg-ok' : 'bg-danger'}`} />
      <span className={ok ? 'text-muted' : 'text-ink'}>{text}</span>
      {detail ? (
        <span
          data-testid="settings-grok-cli"
          className="ml-auto shrink-0 font-mono text-[11px] text-muted"
          title={settings.grokCli.path}
        >
          {detail}
        </span>
      ) : null}
    </div>
  )
}

export function SettingsModal(): React.JSX.Element | null {
  const { showSettings, setShowSettings, settings, saveSettings } = useWorkspace()
  const { model: voiceModel } = useVoice()
  const [tab, setTab] = useState<'general' | 'mcp' | 'appearance'>('general')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(settings?.model || DEFAULT_MODEL)
  const [effort, setEffort] = useState<ReasoningEffort | ''>(settings?.effort ?? '')
  const [claudeModel, setClaudeModel] = useState(settings?.claudeModel ?? '')
  const [claudeOptions, setClaudeOptions] = useState<ClaudeOptions | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const voices = listVoices()
  const voice = settings?.voice ?? DEFAULT_VOICE

  useEffect(() => {
    if (!showSettings) return
    setTab(showSettings === 'mcp' ? 'mcp' : 'general')
    setSaved(false)
    setSaveError(null)
  }, [showSettings])

  // This dialog stays mounted from the first frame, while settings are still
  // null. Seed the select from the saved model each time it opens, otherwise
  // a restart shows the grok-4.6 fallback even after Save wrote grok-4.7.
  useEffect(() => {
    if (!showSettings) return
    setModel(settings?.model || DEFAULT_MODEL)
    setEffort(settings?.effort ?? '')
    setClaudeModel(settings?.claudeModel ?? '')
  }, [showSettings, settings?.model, settings?.effort, settings?.claudeModel])

  // Claude Code names the models this plan offers, and each model has its own effort levels.
  // The subagent models are Claude Code's too, whichever agent new chats run on.
  const askClaude = showSettings && (settings?.defaultAgent === 'claude' || settings?.claude.signedIn)
  useEffect(() => {
    if (!askClaude) return
    let cancelled = false
    void window.workbench.getClaudeOptions(claudeModel).then((options) => {
      if (!cancelled && options) setClaudeOptions(options)
    })
    return () => {
      cancelled = true
    }
  }, [askClaude, claudeModel])

  if (!showSettings || !settings) return null
  // The model row follows the agent new chats run on. The xAI key only serves Grok.
  const onClaude = settings.defaultAgent === 'claude'
  const claudeModels: ClaudeOptions['models'] =
    claudeOptions?.models ?? CLAUDE_MODELS.map((option) => ({ value: option.value, name: option.label }))
  const efforts: readonly ReasoningEffort[] = onClaude ? (claudeOptions?.efforts ?? REASONING_EFFORTS) : GROK_REASONING_EFFORTS

  // A toggle saves at once. A failed save shows below, like the Save button's own error.
  function save(patch: Parameters<typeof saveSettings>[0]): void {
    setSaveError(null)
    void saveSettings(patch).catch((caught: unknown) => setSaveError(errorText(caught, 'Could not save settings')))
  }

  async function submit(): Promise<void> {
    if (busy) return
    setBusy(true)
    setSaveError(null)
    try {
      await saveSettings(
        onClaude
          ? { claudeModel, effort: effort || null }
          : { apiKey: apiKey.trim() ? apiKey.trim() : undefined, model, effort: effort || null }
      )
      setApiKey('')
      setSaved(true)
    } catch (caught) {
      setSaveError(errorText(caught, 'Could not save settings'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay">
      <div
        className={`flex flex-col rounded-2xl border border-line bg-surface p-5 shadow-2xl ${
          tab === 'appearance'
            ? 'h-[86vh] w-[880px]'
            : tab === 'mcp'
              ? 'max-h-[86vh] w-[560px] overflow-y-auto'
              : 'max-h-[86vh] w-[460px] overflow-y-auto'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[15px] font-semibold tracking-tight">Settings</div>
          </div>
          <div className="flex rounded-md bg-canvas p-0.5">
            <button
              className={`rounded px-2.5 py-1 text-[11px] ${
                tab === 'general' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
              }`}
              onClick={() => setTab('general')}
            >
              General
            </button>
            <button
              data-testid="settings-mcp"
              className={`rounded px-2.5 py-1 text-[11px] ${
                tab === 'mcp' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
              }`}
              onClick={() => setTab('mcp')}
            >
              MCP
            </button>
            <button
              data-testid="settings-appearance"
              className={`rounded px-2.5 py-1 text-[11px] ${
                tab === 'appearance' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
              }`}
              onClick={() => setTab('appearance')}
            >
              Appearance
            </button>
          </div>
        </div>

        {tab === 'general' ? (
          <>
            <div className="mt-4 rounded-lg border border-line bg-canvas px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[12px] font-medium text-ink">Agent for new chats</div>
                <div data-testid="settings-default-agent" className="flex rounded-md bg-surface p-0.5">
                  {(
                    [
                      ['grok', 'Grok Build'],
                      ['claude', 'Claude Code']
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={settings.defaultAgent === value}
                      className={`rounded px-2.5 py-1 text-[11px] ${
                        settings.defaultAgent === value ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
                      }`}
                      onClick={() => save({ defaultAgent: normalizeChatAgent(value) })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <AgentStatus settings={settings} />
              <div className="mt-3 grid grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)] gap-3">
                <div className="min-w-0">
                  <label className="block text-[12px] text-muted">Model</label>
                  {onClaude ? (
                    <select
                      data-testid="settings-claude-model"
                      value={claudeModel}
                      onChange={(event) => {
                        setClaudeModel(event.target.value)
                        setSaved(false)
                      }}
                      className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] outline-none focus:border-accent/60"
                    >
                      {claudeModels.some((option) => option.value === claudeModel) ? null : (
                        <option value={claudeModel}>{claudeModel}</option>
                      )}
                      {claudeModels.map((option) => (
                        <option key={option.value} value={option.value} title={option.description}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select
                      data-testid="settings-model"
                      value={model}
                      onChange={(event) => {
                        setModel(event.target.value)
                        setSaved(false)
                      }}
                      className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[13px] outline-none focus:border-accent/60"
                    >
                      {modelOptions(settings.grokCli.models, model).map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="min-w-0">
                  <label className="block text-[12px] text-muted">Effort</label>
                  <select
                    data-testid="settings-effort"
                    value={effort}
                    onChange={(event) => {
                      setEffort(event.target.value as ReasoningEffort | '')
                      setSaved(false)
                    }}
                    className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] outline-none focus:border-accent/60"
                  >
                    <option value="">Default</option>
                    {effort && !efforts.includes(effort) ? (
                      <option value={effort}>{reasoningEffortLabel(effort)}</option>
                    ) : null}
                    {efforts.map((id) => (
                      <option key={id} value={id}>
                        {reasoningEffortLabel(id)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {onClaude || settings.grokBuildSignedIn ? null : (
                <>
                  <label className="mt-3 block text-[12px] text-muted">xAI API key (instead of grok login)</label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value)
                      setSaved(false)
                    }}
                    className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[13px] outline-none focus:border-accent/60"
                    placeholder={settings.keyPreview ?? 'xai-…'}
                  />
                </>
              )}
            </div>
            <div className="mt-5 rounded-lg border border-line bg-canvas px-3 py-3">
              <div className="text-[12px] font-medium text-ink">Subagents</div>
              <p className="mt-1 text-[12px] leading-5 text-muted">
                Type /conduct and a job to make a chat the conductor: it plans, gives each task to a subagent in
                its own chat, and checks what comes back. These are Claude Code models, and a subagent with a
                model runs on Claude Code.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                {(
                  [
                    ['orchestratorModel', 'Orchestrator model', 'Same as the chat'],
                    ['subagentModel', 'Subagent model', 'Auto: the orchestrator picks']
                  ] as const
                ).map(([key, label, unset]) => (
                  <div key={key} className="min-w-0">
                    <label className="block text-[12px] text-muted">{label}</label>
                    <select
                      data-testid={`settings-${key}`}
                      value={settings[key]}
                      onChange={(event) => save({ [key]: event.target.value })}
                      className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] outline-none focus:border-accent/60"
                    >
                      <option value="">{unset}</option>
                      {settings[key] && !claudeModels.some((option) => option.value === settings[key]) ? (
                        <option value={settings[key]}>{settings[key]}</option>
                      ) : null}
                      {claudeModels
                        .filter((option) => option.value)
                        .map((option) => (
                          <option key={option.value} value={option.value} title={option.description}>
                            {option.name}
                          </option>
                        ))}
                    </select>
                  </div>
                ))}
                <div className="min-w-0">
                  <label className="block text-[12px] text-muted">Most subagents at once</label>
                  <select
                    data-testid="settings-maxSubagents"
                    value={settings.maxSubagents}
                    onChange={(event) => save({ maxSubagents: Number(event.target.value) })}
                    className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] outline-none focus:border-accent/60"
                  >
                    {MAX_SUBAGENTS_CHOICES.map((count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="min-w-0 self-end pb-2 text-[12px] leading-5 text-muted">
                  A chat that reaches this waits for a subagent to report back before it starts the next.
                </p>
              </div>
            </div>
            <div className="mt-5 rounded-lg border border-line bg-canvas px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[12px] font-medium text-ink">Voice</div>
                  <p className="mt-1 text-[12px] leading-5 text-muted">
                    Talk to the agent on this machine. Listening uses a local Whisper model. Replies use
                    a local Supertonic voice. Audio never leaves the computer.
                  </p>
                </div>
                <Toggle
                  label="Enable voice"
                  on={voice.enabled}
                  onClick={() => {
                    const next = !voice.enabled
                    save({ voice: { enabled: next } })
                    if (next) {
                      void window.workbench.ensureMic()
                      void window.workbench.ensureVoiceModel()
                    }
                  }}
                />
              </div>
              {voice.enabled && (
                <div className="mt-3 space-y-3 border-t border-line pt-3">
                  <MicAccessRow />
                  <label className="flex items-center justify-between gap-3 text-[12px] text-ink">
                    <span>
                      Conversation mode
                      <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                        Show the Conversation button in the chat. That button starts a live voice
                        loop: listen, send as you talk, speak replies, interrupt.
                      </span>
                    </span>
                    <Toggle
                      label="Conversation mode"
                      on={voice.conversation}
                      onClick={() => {
                        const next = !voice.conversation
                        save({
                          voice: next
                            ? { conversation: true, speakReplies: true, autoSend: true }
                            : { conversation: false }
                        })
                      }}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3 text-[12px] text-ink">
                    Speak replies
                    <Toggle
                      label="Speak replies"
                      on={voice.speakReplies}
                      onClick={() => save({ voice: { speakReplies: !voice.speakReplies } })}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3 text-[12px] text-ink">
                    Send after I stop talking
                    <Toggle
                      label="Send after I stop talking"
                      on={voice.autoSend}
                      onClick={() => save({ voice: { autoSend: !voice.autoSend } })}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3 text-[12px] text-ink">
                    Keep listening after replies
                    <Toggle
                      label="Keep listening after replies"
                      on={voice.handsFree}
                      onClick={() => save({ voice: { handsFree: !voice.handsFree } })}
                    />
                  </label>
                  <MicPicker
                    value={voice.micDeviceId}
                    onChange={(deviceId) => save({ voice: { micDeviceId: deviceId } })}
                  />
                  <label className="block text-[12px] text-muted">
                    Voice
                    <select
                      className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none"
                      value={voice.voiceURI}
                      onChange={(event) => save({ voice: { voiceURI: event.target.value } })}
                    >
                      {voices.map((item) => (
                        <option key={item.voiceURI} value={item.voiceURI}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-[12px] text-muted">
                    Language
                    <select
                      className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none"
                      value={voice.language}
                      onChange={(event) => save({ voice: { language: event.target.value } })}
                    >
                      <option value="auto">Auto-detect</option>
                      {SPEECH_LANGUAGES.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-[12px] text-muted">
                    Speed
                    <RateSlider value={voice.rate} onSave={(rate) => save({ voice: { rate } })} />
                  </label>
                  {testError && (
                    <p className="text-[11px] leading-4 text-red-400">{testError}</p>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] leading-4 text-muted">
                      {voiceModelHint(voiceModel)}
                    </div>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] hover:bg-raised"
                      onClick={() => {
                        setTestError(null)
                        primeTtsOutput()
                        const line = VOICE_TEST[voice.language as VoiceLanguage] ?? VOICE_TEST.en ?? ''
                        // A reply being read pauses for the test line and then goes on, instead of being cut off.
                        const run = isSpeaking()
                          ? speakAside(line, voice)
                          : // The same line every time, so skip the check that drops lines already spoken.
                            speakText(line, voice, { repeat: true })
                        void run.catch((err) => {
                          setTestError(err instanceof Error ? err.message : 'Could not play a test clip')
                        })
                      }}
                    >
                      Test
                    </button>
                  </div>
                </div>
              )}
            </div>
            <UpdateSection />
            <div className="mt-5 rounded-lg border border-line bg-canvas px-3 py-3">
              <div className="text-[12px] font-medium text-ink">Support</div>
              <p className="mt-1 text-[12px] leading-5 text-muted">
                Datapad Workbench is free. If it helps your work, you can buy me a coffee.
              </p>
              <button
                type="button"
                data-testid="settings-support"
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-[12px] font-medium text-ink hover:bg-surface active:translate-y-px"
                onClick={() => {
                  void window.workbench.openExternal(SUPPORT_URL)
                }}
              >
                <CoffeeIcon />
                Buy me a coffee
              </button>
            </div>
            {saveError && <p className="mt-2 text-[11px] leading-4 text-red-400">{saveError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-lg px-3 py-2 text-[12px] text-muted hover:text-ink"
                onClick={() => setShowSettings(false)}
              >
                Close
              </button>
              <button
                className="rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px disabled:opacity-40"
                disabled={busy}
                onClick={() => void submit()}
              >
                {saved ? 'Saved' : 'Save'}
              </button>
            </div>
          </>
        ) : tab === 'mcp' ? (
          <McpSettings onClose={() => setShowSettings(false)} />
        ) : (
          <>
            <p className="mt-1 shrink-0 text-[12.5px] leading-5 text-muted">
              Switch a built-in look, or edit every surface, typeface, and radius. Save as a theme
              file you can load later.
            </p>
            <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden">
              <ThemeEditor />
            </div>
            <div className="mt-4 flex justify-end">
              <button
                className="rounded-lg px-3 py-2 text-[12px] text-muted hover:text-ink"
                onClick={() => setShowSettings(false)}
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const USAGE_URL = 'https://grok.com/?_s=usage'

function formatReset(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function money(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`
}

function periodLabel(period: UsageSnapshot['period']): string {
  if (period === 'weekly') return 'Weekly limit'
  if (period === 'monthly') return 'Monthly limit'
  return 'Usage limit'
}

const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage'

function ClaudeUsageSection({ heading }: { heading: boolean }): React.JSX.Element {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.workbench
      .getClaudeUsage()
      .then((next) => {
        if (!cancelled) setUsage(next)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load Claude usage')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div data-testid="usage-claude" className="mt-4">
      {heading ? <div className="text-[12.5px] font-medium text-ink">Claude Code</div> : null}
      <p className="mt-1 text-[12.5px] text-muted">
        {usage?.plan ? `Claude ${usage.plan} plan` : 'Claude subscription limits'}
      </p>
      {error ? (
        <p className="mt-3 text-[12.5px] text-ink">{error}</p>
      ) : !usage ? (
        <p className="mt-3 text-[12.5px] text-muted">Loading usage…</p>
      ) : (
        usage.limits.map((limit) => {
          const bar = Math.min(100, Math.max(0, Math.round(limit.usedPercent)))
          return (
            <div key={limit.label} className="mt-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-[12px] text-muted">{limit.label}</div>
                <div className="text-[13px] font-medium tabular-nums text-ink">{bar}% used</div>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
                <div
                  className={`h-full rounded-full ${bar >= 90 ? 'bg-red-400' : 'bg-accent'}`}
                  style={{ width: `${bar}%` }}
                />
              </div>
              {limit.resets ? (
                <div className="mt-1.5 text-[12px] text-muted">Resets {limit.resets}</div>
              ) : null}
            </div>
          )
        })
      )}
    </div>
  )
}

export function UsageModal(): React.JSX.Element | null {
  const { showUsage, setShowUsage, settings } = useWorkspace()
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const claudeOn = settings?.claude.signedIn === true
  const grokOn = !claudeOn || settings?.grokBuildSignedIn === true
  const claudeFirst = claudeOn && (settings?.defaultAgent === 'claude' || !grokOn)

  useEffect(() => {
    if (!showUsage || !grokOn) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.workbench
      .getUsage()
      .then((next) => {
        if (cancelled) return
        setUsage(next)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setUsage(null)
        setError(err instanceof Error ? err.message : 'Could not load usage')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [showUsage, grokOn])

  useEffect(() => {
    if (!showUsage) return
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setShowUsage(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showUsage, setShowUsage])

  if (!showUsage) return null

  const used = usage?.usedPercent
  const left = used === null || used === undefined ? null : Math.max(0, Math.round(100 - used))
  const reset = formatReset(usage?.periodEnd ?? null)
  const bar = used === null || used === undefined ? 0 : Math.round(used)
  const hot = bar >= 90
  const showCredits = (usage?.prepaidBalance ?? 0) > 0
  const showOnDemand = (usage?.onDemandCap ?? 0) > 0

  const grokSection = grokOn ? (
    <div data-testid="usage-grok" className="mt-4">
      {claudeOn ? <div className="text-[12.5px] font-medium text-ink">Grok Build</div> : null}
      <p className="mt-1 text-[12.5px] text-muted">
        {usage?.tier ?? (loading ? 'Loading subscription limits' : 'Grok Build allowance')}
      </p>

      {loading ? (
        <p className="mt-4 text-[12.5px] text-muted">Loading usage…</p>
      ) : error ? (
        <p className="mt-4 text-[12.5px] text-ink">{error}</p>
      ) : !usage || usage.usedPercent === null ? (
        <p className="mt-4 text-[12.5px] text-ink">Couldn&apos;t load usage.</p>
      ) : (
        <div className="mt-4">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-[12px] text-muted">{periodLabel(usage.period)}</div>
            <div className="text-[13px] font-medium tabular-nums text-ink">{bar}% used</div>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
            <div
              className={`h-full rounded-full ${hot ? 'bg-red-400' : 'bg-accent'}`}
              style={{ width: `${bar}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
            {left !== null && <span>{left}% left</span>}
            {reset && <span>Next reset: {reset}</span>}
          </div>
          {showCredits && (
            <div className="mt-3 text-[12px] text-ink">
              Credits: {money(usage.prepaidBalance ?? 0)}
            </div>
          )}
          {showOnDemand && (
            <div className="mt-1 text-[12px] text-ink">
              Pay-as-you-go: {money(usage.onDemandUsed ?? 0)} used of {money(usage.onDemandCap ?? 0)}{' '}
              limit
            </div>
          )}
        </div>
      )}
    </div>
  ) : null
  const claudeSection = claudeOn ? <ClaudeUsageSection heading={grokOn} /> : null

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay">
      <div className="max-h-[85vh] w-[420px] overflow-y-auto rounded-2xl border border-line bg-surface p-5 shadow-2xl">
        <div className="text-[15px] font-semibold tracking-tight">Usage</div>
        {claudeFirst ? claudeSection : grokSection}
        {claudeFirst ? grokSection : claudeSection}

        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-2 text-[12px] text-muted hover:text-ink"
            onClick={() => setShowUsage(false)}
          >
            Close
          </button>
          <button
            className="rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px"
            onClick={() => void window.workbench.openExternal(claudeFirst ? CLAUDE_USAGE_URL : USAGE_URL)}
          >
            Manage billing
          </button>
        </div>
      </div>
    </div>
  )
}
