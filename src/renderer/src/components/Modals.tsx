import { Fragment, useEffect, useRef, useState } from 'react'
import {
  CLAUDE_MODELS,
  type ClaudeUsage,
  DEFAULT_MODEL,
  type GrokModelChoice,
  grokModelChoices,
  grokModelEfforts,
  REASONING_EFFORTS,
  type ClaudeOptions,
  reasoningEffortLabel,
  type ReasoningEffort,
  DEFAULT_VOICE,
  formatGrokCli,
  chatProviderChoices,
  chatProviderOf,
  providerModelKey,
  type PublicSettings,
  type SecretScope,
  type UpdateState,
  type UsageSnapshot,
  type VoiceLanguage,
  type VoiceModelStatus,
  usagePlans,
  VOICE_LANGUAGES
} from '../../../shared/types'
import { MAX_SUBAGENTS_CHOICES, weakOrchestrator } from '../../../shared/conductor'
import { CHAT_WIDTHS, readChatWidth, saveChatWidth } from '../chatWidth'
import { useVoice } from '../voice/VoiceProvider'
import {
  isSpeaking,
  listMicInputs,
  listVoices,
  micLevel,
  openMicStream,
  primeTtsOutput,
  speakAside,
  speakText,
  type MicInput
} from '../voice/engine'
import { useWorkspace } from '../workspace'
import { SharedMemory } from './BotMemory'
import { Icon } from './icons'
import { ChannelSettings } from './ChannelSettings'
import { McpSettings } from './McpSettings'
import { ProviderSettings } from './ProviderSettings'
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
      <div className="corner-marks w-[420px] rounded-2xl border border-line bg-surface p-5 shadow-2xl">
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
  const [noSignal, setNoSignal] = useState(false)
  const fillRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setPicked(value)
  }, [value])

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let frame = 0
    let shown = 0
    setNoSignal(false)
    if (fillRef.current) fillRef.current.style.transform = 'scaleX(0)'
    async function open(): Promise<void> {
      let next: MediaStream
      try {
        next = await openMicStream(picked || undefined)
      } catch {
        if (!stopped) setNoSignal(true)
        return
      }
      // The picker may have closed or switched device while the mic was opening.
      if (stopped) {
        next.getTracks().forEach((track) => track.stop())
        return
      }
      stream = next
      let analyser: AnalyserNode
      try {
        context = new AudioContext()
        analyser = context.createAnalyser()
        analyser.fftSize = 1024
        // Not connected to the destination, so the user does not hear themselves.
        context.createMediaStreamSource(next).connect(analyser)
      } catch {
        setNoSignal(true)
        return
      }
      const samples = new Float32Array(analyser.fftSize)
      function draw(): void {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (let i = 0; i < samples.length; i++) sum += (samples[i] ?? 0) * (samples[i] ?? 0)
        const level = micLevel(Math.sqrt(sum / samples.length))
        // Quick rise, slow fall.
        shown += (level - shown) * (level > shown ? 0.6 : 0.08)
        if (fillRef.current) fillRef.current.style.transform = `scaleX(${shown})`
        frame = requestAnimationFrame(draw)
      }
      frame = requestAnimationFrame(draw)
    }
    void open()
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((track) => track.stop())
      void context?.close().catch(() => undefined)
    }
  }, [picked])

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
    <>
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
      {noSignal ? (
        <div className="mt-2 text-[11px] text-muted">No signal from this microphone.</div>
      ) : (
        <div
          data-testid="settings-mic-level"
          role="meter"
          aria-label="Microphone input level"
          aria-valuemin={0}
          aria-valuemax={1}
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-canvas"
        >
          <div
            ref={fillRef}
            className="h-full w-full origin-left rounded-full bg-accent"
            style={{ transform: 'scaleX(0)' }}
          />
        </div>
      )}
    </>
  )
}

/** The choices, then each of `extra` not among them, such as the current model. */
function modelOptions(choices: GrokModelChoice[], extra: string[]): GrokModelChoice[] {
  const list: GrokModelChoice[] = []
  for (const choice of choices) if (!list.some((item) => item.value === choice.value)) list.push(choice)
  for (const id of extra) {
    const value = id.trim()
    if (!value || list.some((item) => item.value === value)) continue
    list.push({ value, name: value, group: 'Grok', efforts: grokModelEfforts(list, value) })
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

/** The secrets agents asked for in chats, by project or bot. Names only: values never leave the main process. */
function SecretsSection(): React.JSX.Element {
  const { projects } = useWorkspace()
  const [scopes, setScopes] = useState<SecretScope[]>([])
  const [botNames, setBotNames] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void Promise.all([window.workbench.listSecrets(), window.workbench.listBots()]).then(
      ([next, bots]) => {
        if (!live) return
        setScopes(next)
        setBotNames(Object.fromEntries(bots.map((bot) => [`bot:${bot.id}`, bot.name])))
      },
      () => {
        // No list to show: the pane says there are none.
      }
    )
    return () => {
      live = false
    }
  }, [])

  if (scopes.length === 0) {
    return (
      <p className="text-[12px] leading-5 text-muted">
        No secrets yet. When an agent asks for one in a chat, it is kept here.
      </p>
    )
  }
  const label = (scope: string): string =>
    projects.find((project) => project.id === scope)?.name ?? botNames[scope] ?? 'Removed project'

  return (
    <div data-testid="settings-secrets">
      <p className="text-[12px] leading-5 text-muted">
        Kept encrypted with the system keychain. Agents get them as environment variables, never the values.
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {scopes.map((item) => (
          <div key={item.scope}>
            <div className="text-[11px] text-faint">{label(item.scope)}</div>
            {item.names.map((name) => (
              <div key={name} className="mt-1 flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[12px] text-ink">{name}</span>
                <button
                  type="button"
                  className="text-[11px] text-muted hover:text-danger"
                  onClick={() => {
                    setError(null)
                    window.workbench
                      .deleteSecret(item.scope, name)
                      .then(setScopes)
                      .catch((caught) => setError(errorText(caught, 'Could not delete the secret')))
                  }}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-[11px] leading-4 text-red-400">{error}</p>}
    </div>
  )
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
    <div data-testid="settings-updates" className="py-3">
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

/** Sign-in state for the agent new chats run on. The others stay out of sight. `provider` names the provider new chats on the app's own agent run on. */
function AgentStatus({ settings, provider }: { settings: PublicSettings; provider: string | null }): React.JSX.Element {
  let ok: boolean
  let text: string
  let detail: string | null = null
  if (settings.defaultAgent === 'workbench') {
    // The app's own agent needs no CLI and no sign-in, only a provider's key.
    ok = provider != null
    text = provider ? `Runs on ${provider} with its own key. No sign-in needed.` : 'Add a provider with a model under Providers.'
  } else if (settings.cliChecking) {
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

/** The sections of Settings, in nav order. A new section is one entry here and one case in `SettingsModal`. */
const SETTINGS_SECTIONS = [
  { id: 'agent', label: 'Agent', group: 'Chats', description: 'The provider, model, and effort new chats start with.' },
  {
    id: 'providers',
    label: 'Providers',
    group: 'Chats',
    description: 'Models from OpenRouter, OpenAI, Anthropic, Ollama or your own endpoint, on your key.',
    testId: 'settings-providers'
  },
  {
    id: 'subagents',
    label: 'Subagents',
    group: 'Chats',
    description: 'How a chat hands work to subagents, and on which models.'
  },
  {
    id: 'voice',
    label: 'Voice',
    group: 'Chats',
    description: 'Talk to the agent and hear its replies, all on this computer.'
  },
  { id: 'memory', label: 'Memory', group: 'Context', description: 'What every bot should know about you and your work.' },
  { id: 'secrets', label: 'Secrets', group: 'Context', description: 'Secrets agents asked for in chats, by project or bot.' },
  {
    id: 'mcp',
    label: 'MCP servers',
    group: 'Context',
    description: 'Servers that give every chat more tools.',
    testId: 'settings-mcp'
  },
  {
    id: 'channels',
    label: 'Channels',
    group: 'Context',
    description: 'Talk to your bots and projects from Telegram.',
    testId: 'settings-channels'
  },
  {
    id: 'appearance',
    label: 'Appearance',
    group: 'Workbench',
    description:
      'Switch a built-in look, or edit every surface, typeface, and radius. Save as a theme file you can load later.',
    testId: 'settings-appearance'
  },
  { id: 'about', label: 'About', group: 'Workbench', description: 'Version, updates, and support.' }
] as const satisfies readonly { id: string; label: string; group: string; description: string; testId?: string }[]

type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

/** One setting: label and help on the left, the control on the right, or under them when `stacked`. */
export function SettingRow({
  label,
  help,
  stacked,
  children
}: {
  label: React.ReactNode
  help?: React.ReactNode
  stacked?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`py-3 ${stacked ? '' : 'flex items-center justify-between gap-6'}`}>
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-ink">{label}</div>
        {help ? <div className="mt-0.5 text-[11.5px] leading-[17px] text-muted">{help}</div> : null}
      </div>
      <div className={stacked ? 'mt-2' : 'shrink-0'}>{children}</div>
    </div>
  )
}

const SETTINGS_SELECT =
  'w-64 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] outline-none focus:border-accent/60'

export function SettingsModal(): React.JSX.Element | null {
  const { showSettings, setShowSettings, settings, saveSettings } = useWorkspace()
  const { model: voiceModel } = useVoice()
  const [section, setSection] = useState<SettingsSectionId>('agent')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(settings?.model || DEFAULT_MODEL)
  const [effort, setEffort] = useState<ReasoningEffort | ''>(settings?.effort ?? '')
  const [claudeModel, setClaudeModel] = useState(settings?.claudeModel ?? '')
  const [claudeOptions, setClaudeOptions] = useState<ClaudeOptions | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [chatWidth, setChatWidth] = useState(readChatWidth)
  const voices = listVoices()
  const voice = settings?.voice ?? DEFAULT_VOICE

  useEffect(() => {
    if (!showSettings) return
    setSection(showSettings === 'mcp' ? 'mcp' : 'agent')
    setSaved(false)
    setSaveError(null)
  }, [showSettings])

  useEffect(() => {
    if (!showSettings) return
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setShowSettings(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showSettings, setShowSettings])

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
  // A subagent can also run on a provider's model, on that provider.
  const subagentProviderModels = grokModelChoices([], settings.providers)
  // Claude, Grok or a provider: a provider runs on the app's own agent and lists only its own models.
  const runsOn = chatProviderOf(settings.defaultAgent, model, settings.providers)
  const grokOwn = grokModelChoices(settings.grokCli.models, [])
  const grokChoices = runsOn.provider
    ? modelOptions(grokModelChoices([], [runsOn.provider]), [model])
    : modelOptions(grokOwn, [model, DEFAULT_MODEL])
  const efforts: readonly ReasoningEffort[] = onClaude
    ? (claudeOptions?.efforts ?? REASONING_EFFORTS)
    : grokModelEfforts(grokChoices, model)
  const noEffort = !onClaude && efforts.length === 0
  const current = SETTINGS_SECTIONS.find((item) => item.id === section) ?? SETTINGS_SECTIONS[0]

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

  const body = (): React.JSX.Element => {
    switch (section) {
      case 'agent':
        return (
          <div className="divide-y divide-line">
            <div className="pb-3">
              <div className="flex items-center justify-between gap-6">
                <div className="text-[12px] font-medium text-ink">Provider for new chats</div>
                <div data-testid="settings-default-agent" className="flex flex-wrap justify-end rounded-md bg-canvas p-0.5">
                  {chatProviderChoices(settings.providers).map((choice) => (
                    <button
                      key={choice.key}
                      type="button"
                      data-testid={`settings-default-${choice.key}`}
                      aria-pressed={runsOn.key === choice.key}
                      className={`rounded px-2.5 py-1 text-[11px] ${
                        runsOn.key === choice.key ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
                      }`}
                      onClick={() => {
                        if (runsOn.key === choice.key) return
                        if (choice.agent === 'claude') return save({ defaultAgent: 'claude' })
                        // Grok or a provider: a model of that entry, saved at once with the agent.
                        const next = choice.provider
                          ? providerModelKey(choice.provider.id, choice.provider.models[0].id)
                          : model.startsWith('wb-')
                            ? (grokOwn[0]?.value ?? DEFAULT_MODEL)
                            : model
                        setModel(next)
                        save({ defaultAgent: choice.agent, model: next })
                      }}
                    >
                      {choice.name}
                    </button>
                  ))}
                </div>
              </div>
              <AgentStatus settings={settings} provider={runsOn.provider?.name ?? null} />
            </div>
            <SettingRow label="Model">
              {onClaude ? (
                <select
                  data-testid="settings-claude-model"
                  value={claudeModel}
                  onChange={(event) => {
                    setClaudeModel(event.target.value)
                    setSaved(false)
                  }}
                  className={SETTINGS_SELECT}
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
                  className={`${SETTINGS_SELECT} font-mono`}
                >
                  {grokChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.name}
                    </option>
                  ))}
                </select>
              )}
            </SettingRow>
            <SettingRow label="Effort" help={noEffort ? 'This model takes no effort setting.' : undefined}>
              <select
                data-testid="settings-effort"
                value={effort}
                disabled={noEffort}
                onChange={(event) => {
                  setEffort(event.target.value as ReasoningEffort | '')
                  setSaved(false)
                }}
                className={`${SETTINGS_SELECT} disabled:opacity-50`}
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
            </SettingRow>
            {settings.defaultAgent !== 'grok' || settings.grokBuildSignedIn ? null : (
              <SettingRow label="xAI API key (instead of grok login)">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value)
                    setSaved(false)
                  }}
                  className="w-64 rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[13px] outline-none focus:border-accent/60"
                  placeholder={settings.keyPreview ?? 'xai-…'}
                />
              </SettingRow>
            )}
            <SettingRow
              label="Short replies"
              help="Chats answer briefly: the result first, steps numbered, one question at the end. Holds for chats started or reopened after the change."
            >
              <Toggle
                label="Short replies"
                testId="settings-conciseReplies"
                on={settings.conciseReplies}
                onClick={() => save({ conciseReplies: !settings.conciseReplies })}
              />
            </SettingRow>
          </div>
        )
      case 'subagents':
        return (
          <>
            <p className="text-[12px] leading-5 text-muted">
              Type /conduct and a job to make a chat the conductor: it plans, writes each task with the checks it
              must pass, gives it to a subagent in its own chat, and checks what comes back against them. It does
              not change files itself. A subagent on a Claude model runs on Claude Code, and one on a provider’s
              model runs on that provider.
            </p>
            <div className="mt-2 divide-y divide-line">
              {(
                [
                  ['orchestratorModel', 'Orchestrator model', 'Same as the chat'],
                  ['subagentModel', 'Subagent model', 'Auto: the orchestrator picks']
                ] as const
              ).map(([key, label, unset]) => (
                <SettingRow key={key} label={label}>
                  <select
                    data-testid={`settings-${key}`}
                    value={settings[key]}
                    onChange={(event) => save({ [key]: event.target.value })}
                    className={SETTINGS_SELECT}
                  >
                    <option value="">{unset}</option>
                    {settings[key] &&
                    !claudeModels.some((option) => option.value === settings[key]) &&
                    !(key === 'subagentModel' && subagentProviderModels.some((option) => option.value === settings[key])) ? (
                      <option value={settings[key]}>{settings[key]}</option>
                    ) : null}
                    {claudeModels
                      .filter((option) => option.value)
                      .map((option) => (
                        <option key={option.value} value={option.value} title={option.description}>
                          {option.name}
                        </option>
                      ))}
                    {key === 'subagentModel' &&
                      settings.providers
                        .filter((provider) => provider.models.length > 0)
                        .map((provider) => (
                          <optgroup key={provider.id} label={provider.name}>
                            {provider.models.map((item) => (
                              <option key={item.id} value={providerModelKey(provider.id, item.id)}>
                                {item.name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                  </select>
                  {key === 'orchestratorModel' && weakOrchestrator(settings[key]) && (
                    <p
                      data-testid="settings-orchestrator-warning"
                      className="mt-1 w-64 text-[11.5px] leading-4 text-danger"
                    >
                      {weakOrchestrator(settings[key])} A conductor on it will not orchestrate well.
                    </p>
                  )}
                </SettingRow>
              ))}
              <SettingRow
                label="Most subagents at once"
                help="A Claude Code chat plans the work and gives it to subagents; one that reaches this waits for a subagent to report back. At None it does the work itself."
              >
                <select
                  data-testid="settings-maxSubagents"
                  value={settings.maxSubagents}
                  onChange={(event) => save({ maxSubagents: Number(event.target.value) })}
                  className="w-28 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] outline-none focus:border-accent/60"
                >
                  {MAX_SUBAGENTS_CHOICES.map((count) => (
                    <option key={count} value={count}>
                      {count === 0 ? 'None' : count}
                    </option>
                  ))}
                </select>
              </SettingRow>
            </div>
          </>
        )
      case 'voice':
        return (
          <div className="divide-y divide-line">
            <SettingRow
              label="Enable voice"
              help="Talk to the agent on this machine. Listening uses a local Whisper model. Replies use a local Supertonic voice. Audio never leaves the computer."
            >
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
            </SettingRow>
            {voice.enabled && (
              <>
                <div className="py-3">
                  <MicAccessRow />
                </div>
                <SettingRow
                  label="Conversation mode"
                  help="Show the Conversation button in the chat. That button starts a live voice loop: listen, send as you talk, speak replies, interrupt."
                >
                  <Toggle
                    label="Conversation mode"
                    on={voice.conversation}
                    onClick={() => {
                      const next = !voice.conversation
                      save({
                        voice: next ? { conversation: true, speakReplies: true, autoSend: true } : { conversation: false }
                      })
                    }}
                  />
                </SettingRow>
                <SettingRow label="Speak replies">
                  <Toggle
                    label="Speak replies"
                    on={voice.speakReplies}
                    onClick={() => save({ voice: { speakReplies: !voice.speakReplies } })}
                  />
                </SettingRow>
                <SettingRow label="Send after I stop talking">
                  <Toggle
                    label="Send after I stop talking"
                    on={voice.autoSend}
                    onClick={() => save({ voice: { autoSend: !voice.autoSend } })}
                  />
                </SettingRow>
                <SettingRow label="Keep listening after replies">
                  <Toggle
                    label="Keep listening after replies"
                    on={voice.handsFree}
                    onClick={() => save({ voice: { handsFree: !voice.handsFree } })}
                  />
                </SettingRow>
                <div className="py-3">
                  <MicPicker
                    value={voice.micDeviceId}
                    onChange={(deviceId) => save({ voice: { micDeviceId: deviceId } })}
                  />
                </div>
                <div className="py-3">
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
                </div>
                <div className="py-3">
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
                </div>
                <div className="py-3">
                  <label className="block text-[12px] text-muted">
                    Speed
                    <RateSlider value={voice.rate} onSave={(rate) => save({ voice: { rate } })} />
                  </label>
                </div>
                <div className="py-3">
                  {testError && <p className="mb-2 text-[11px] leading-4 text-red-400">{testError}</p>}
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] leading-4 text-muted">{voiceModelHint(voiceModel)}</div>
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
              </>
            )}
          </div>
        )
      case 'memory':
        return <SharedMemory />
      case 'secrets':
        return <SecretsSection />
      case 'providers':
        return <ProviderSettings />
      case 'mcp':
        return <McpSettings />
      case 'channels':
        return <ChannelSettings />
      case 'appearance':
        return (
          <>
            <div className="shrink-0 border-b border-line">
              <SettingRow label="Chat width" help="How wide messages and the composer may grow.">
                <div data-testid="settings-chat-width" className="flex rounded-md bg-canvas p-0.5">
                  {CHAT_WIDTHS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={chatWidth === option.id}
                      title={option.id === 'full' ? 'Fill the chat pane' : option.width}
                      className={`rounded px-2.5 py-1 text-[11px] ${
                        chatWidth === option.id ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
                      }`}
                      onClick={() => {
                        saveChatWidth(option.id)
                        setChatWidth(option.id)
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </SettingRow>
            </div>
            <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden">
              <ThemeEditor />
            </div>
          </>
        )
      case 'about':
        return (
          <div className="divide-y divide-line">
            <UpdateSection />
            <SettingRow
              label="Support"
              help="Datapad Workbench is free. If it helps your work, you can buy me a coffee."
            >
              <button
                type="button"
                data-testid="settings-support"
                className="inline-flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-[12px] font-medium text-ink hover:bg-surface active:translate-y-px"
                onClick={() => {
                  void window.workbench.openExternal(SUPPORT_URL)
                }}
              >
                <CoffeeIcon />
                Buy me a coffee
              </button>
            </SettingRow>
          </div>
        )
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="corner-marks flex h-[86vh] w-[920px] max-w-[94vw] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div className="text-[15px] font-semibold tracking-tight">Settings</div>
          <button
            type="button"
            data-testid="settings-close"
            aria-label="Close settings"
            title="Close settings"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink"
            onClick={() => setShowSettings(false)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Settings sections" className="w-[190px] shrink-0 overflow-y-auto border-r border-line px-2 py-3">
            {SETTINGS_SECTIONS.map((item, index) => (
              <Fragment key={item.id}>
                {item.group !== SETTINGS_SECTIONS[index - 1]?.group && (
                  <div className={`px-2.5 pb-1 text-[11px] font-medium text-faint ${index ? 'pt-4' : ''}`}>
                    {item.group}
                  </div>
                )}
                <button
                  type="button"
                  data-testid={'testId' in item ? item.testId : `settings-nav-${item.id}`}
                  aria-current={section === item.id ? 'page' : undefined}
                  className={`block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] ${
                    section === item.id ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
                  }`}
                  onClick={() => setSection(item.id)}
                >
                  {item.label}
                </button>
              </Fragment>
            ))}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0 px-6 pt-5">
              <h2 className="text-[14px] font-semibold tracking-tight text-ink">{current.label}</h2>
              <p className="mt-0.5 text-[12px] leading-5 text-muted">{current.description}</p>
            </div>
            <div
              key={section}
              className={`min-h-0 flex-1 px-6 pb-5 pt-4 ${
                section === 'appearance' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'
              }`}
            >
              {body()}
            </div>
            {section === 'agent' || saveError ? (
              <div className="flex shrink-0 items-center justify-end gap-3 border-t border-line px-6 py-3">
                {saveError && <p className="mr-auto text-[11px] leading-4 text-red-400">{saveError}</p>}
                {section === 'agent' && (
                  <button
                    className="rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void submit()}
                  >
                    {saved ? 'Saved' : 'Save'}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>
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
  const plans = settings ? usagePlans(settings) : { grok: true, claude: false, claudeFirst: false }
  const claudeOn = plans.claude
  const grokOn = plans.grok
  const claudeFirst = plans.claudeFirst

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
      <div className="corner-marks max-h-[85vh] w-[420px] overflow-y-auto rounded-2xl border border-line bg-surface p-5 shadow-2xl">
        <div className="text-[15px] font-semibold tracking-tight">Usage</div>
        {claudeFirst ? claudeSection : grokSection}
        {claudeFirst ? grokSection : claudeSection}
        {!grokOn && !claudeOn ? (
          <p data-testid="usage-none" className="mt-4 text-[12.5px] text-muted">
            Your providers bill your own key, so there is no plan limit to show. Their own sites show what you used.
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-2 text-[12px] text-muted hover:text-ink"
            onClick={() => setShowUsage(false)}
          >
            Close
          </button>
          {grokOn || claudeOn ? (
            <button
              className="rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px"
              onClick={() => void window.workbench.openExternal(claudeFirst ? CLAUDE_USAGE_URL : USAGE_URL)}
            >
              Manage billing
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
