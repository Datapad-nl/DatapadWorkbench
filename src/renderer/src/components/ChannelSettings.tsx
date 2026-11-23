import { useEffect, useState } from 'react'
import type { TelegramStatus } from '../../../shared/channels'
import { useBots } from '../bots'
import { useWorkspace } from '../workspace'
import { SettingRow } from './Modals'
import { pairingCountdown } from './pairingCountdown'
import { Toggle } from './Toggle'

const PRIMARY_BUTTON =
  'rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px disabled:opacity-50'
const OUTLINE_BUTTON = 'rounded-lg border border-line px-3 py-2 text-[12px] text-ink hover:bg-raised'
const INPUT =
  'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px] text-ink outline-none placeholder:text-muted/60 focus:border-accent/60'

function errorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

/** Telegram: talk to the bots and projects from a phone. Everything runs in the main process; this only shows it. */
export function ChannelSettings(): React.JSX.Element {
  const [status, setStatus] = useState<TelegramStatus | null>(null)

  useEffect(() => {
    let live = true
    const channels = window.workbench.channels
    const off = channels.onEvent((next) => {
      if (live) setStatus(next)
    })
    void channels.get().then(
      (next) => {
        if (live) setStatus((current) => current ?? next)
      },
      () => {
        // No status to show: the section stays empty.
      }
    )
    return () => {
      live = false
      off()
    }
  }, [])

  if (!status) return <p className="text-[12px] leading-5 text-muted">Loading.</p>
  return (
    <div data-testid="settings-channels-body" className="divide-y divide-line">
      <TokenRow status={status} onStatus={setStatus} />
      {status.hasToken && <PairingRow status={status} onStatus={setStatus} />}
      {status.hasToken && status.paired && <Reachable status={status} onStatus={setStatus} />}
    </div>
  )
}

type Part = { status: TelegramStatus; onStatus: (status: TelegramStatus) => void }

function TokenRow({ status, onStatus }: Part): React.JSX.Element {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  async function run(next: string | null): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      onStatus(await window.workbench.channels.setToken(next))
      setToken('')
    } catch (caught) {
      setError(errorText(caught, 'Could not save the token'))
    } finally {
      setBusy(false)
      setConfirmRemove(false)
    }
  }

  if (!status.hasToken) {
    return (
      <SettingRow
        stacked
        label="Telegram bot token"
        help="In Telegram, ask @BotFather to make a bot, then copy its token and paste it here. Once it is saved it is not shown again."
      >
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (token.trim()) void run(token.trim())
          }}
        >
          <input
            type="password"
            data-testid="channels-token"
            aria-label="Telegram bot token"
            autoComplete="off"
            spellCheck={false}
            className={INPUT}
            placeholder="Bot token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="submit" data-testid="channels-save" className={`${PRIMARY_BUTTON} shrink-0`} disabled={busy || !token.trim()}>
            {busy ? 'Checking' : 'Save'}
          </button>
        </form>
        {error && <p className="mt-2 text-[11px] leading-4 text-red-400">{error}</p>}
      </SettingRow>
    )
  }

  const state =
    status.state === 'connected'
      ? 'Connected'
      : status.state === 'error'
        ? (status.error ?? 'Telegram could not be reached')
        : 'Connecting'
  return (
    <SettingRow
      label="Telegram bot token"
      help={
        <>
          {status.username ? <span className="font-mono text-ink">@{status.username}</span> : 'Checking the token'}
          {' · '}
          <span data-testid="channels-state" className={status.state === 'error' ? 'text-red-400' : undefined}>
            {state}
          </span>
        </>
      }
    >
      <div className="flex flex-col items-end gap-1">
        {confirmRemove ? (
          <button
            type="button"
            data-testid="channels-remove-confirm"
            className="rounded-md px-2 py-1 text-[11px] text-red-400 hover:bg-raised"
            onClick={() => void run(null)}
            onBlur={() => setConfirmRemove(false)}
            autoFocus
          >
            Remove and unpair?
          </button>
        ) : (
          <button
            type="button"
            data-testid="channels-remove"
            className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-raised hover:text-ink"
            onClick={() => setConfirmRemove(true)}
          >
            Remove
          </button>
        )}
        {error && <p className="text-[11px] leading-4 text-red-400">{error}</p>}
      </div>
    </SettingRow>
  )
}

function PairingRow({ status, onStatus }: Part): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [confirmUnpair, setConfirmUnpair] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const pairing = status.pairing
  const left = pairing ? pairingCountdown(pairing.expiresAt, now) : null

  useEffect(() => {
    if (!pairing) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing])

  async function run(call: () => Promise<TelegramStatus>, fallback: string): Promise<void> {
    setError(null)
    try {
      onStatus(await call())
    } catch (caught) {
      setError(errorText(caught, fallback))
    } finally {
      setConfirmUnpair(false)
    }
  }
  const channels = window.workbench.channels
  const bot = status.username ? `@${status.username}` : 'your bot'
  const open = pairing && left !== null

  const code = open ? (
    <div data-testid="channels-code" className="mt-3 rounded-lg border border-line bg-canvas px-4 py-3">
      <div className="font-mono text-[26px] font-medium tracking-[0.25em] text-ink">{pairing.code}</div>
      <p className="mt-1 text-[12px] leading-5 text-muted">
        Send <span className="font-mono text-ink">/pair {pairing.code}</span> to <span className="text-ink">{bot}</span> in
        Telegram. The code works for {left} more.
      </p>
    </div>
  ) : pairing ? (
    <p className="mt-3 text-[11.5px] leading-[17px] text-muted">That code has ended. Start a new one.</p>
  ) : null

  if (!status.paired) {
    return (
      <SettingRow stacked label="Pairing" help="Pair this app with your Telegram account. Only that account can talk to your bots.">
        <button type="button" data-testid="channels-pair" className={PRIMARY_BUTTON} onClick={() => void run(channels.startPairing, 'Could not start pairing')}>
          {open ? 'New code' : 'Pair'}
        </button>
        {code}
        {error && <p className="mt-2 text-[11px] leading-4 text-red-400">{error}</p>}
      </SettingRow>
    )
  }

  return (
    <SettingRow
      stacked
      label="Paired"
      help={
        status.group ? (
          <>
            Group: <span className="text-ink">{status.group}</span>
          </>
        ) : (
          'Direct message'
        )
      }
    >
      <div className="flex items-center gap-2">
        <button type="button" data-testid="channels-pair-group" className={OUTLINE_BUTTON} onClick={() => void run(channels.startPairing, 'Could not start pairing')}>
          Pair a group
        </button>
        {confirmUnpair ? (
          <button
            type="button"
            data-testid="channels-unpair-confirm"
            className="rounded-md px-2 py-1 text-[11px] text-red-400 hover:bg-raised"
            onClick={() => void run(channels.unpair, 'Could not unpair')}
            onBlur={() => setConfirmUnpair(false)}
            autoFocus
          >
            Unpair?
          </button>
        ) : (
          <button
            type="button"
            data-testid="channels-unpair"
            className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-raised hover:text-ink"
            onClick={() => setConfirmUnpair(true)}
          >
            Unpair
          </button>
        )}
      </div>
      {code}
      <ol className="mt-3 list-decimal pl-4 text-[11.5px] leading-[17px] text-muted">
        <li>In Telegram, make a group and turn on Topics.</li>
        <li>Add {bot} as an admin who may manage topics.</li>
        <li>Press Pair a group, then send the code in the group as /pair and the code.</li>
      </ol>
      <p className="mt-1 text-[11.5px] leading-[17px] text-muted">
        Each bot and project you switch on below then gets its own topic. Everyone in that group can read what the bots
        write.
      </p>
      {error && <p className="mt-2 text-[11px] leading-4 text-red-400">{error}</p>}
    </SettingRow>
  )
}

function Reachable({ status, onStatus }: Part): React.JSX.Element {
  const { bots } = useBots()
  const { projects } = useWorkspace()
  const [error, setError] = useState<string | null>(null)

  async function change(kind: 'bots' | 'projects', id: string): Promise<void> {
    const current = kind === 'bots' ? status.reachableBots : status.reachableProjects
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    setError(null)
    try {
      onStatus(
        await window.workbench.channels.setReachable({
          bots: kind === 'bots' ? next : status.reachableBots,
          projects: kind === 'projects' ? next : status.reachableProjects
        })
      )
    } catch (caught) {
      setError(errorText(caught, 'Could not save the change'))
    }
  }

  const list = (
    title: string,
    kind: 'bots' | 'projects',
    items: { id: string; name: string }[],
    on: string[],
    empty: string
  ): React.JSX.Element => (
    <div className="mt-3">
      <div className="text-[11px] text-faint">{title}</div>
      {items.length === 0 ? (
        <p className="mt-1 text-[11.5px] leading-[17px] text-muted">{empty}</p>
      ) : (
        items.map((item) => (
          <div key={item.id} className="mt-1 flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-[12px] text-ink">{item.name}</span>
            <Toggle
              on={on.includes(item.id)}
              label={`Reach ${item.name} from Telegram`}
              testId={`channels-${kind}-${item.id}`}
              onClick={() => void change(kind, item.id)}
            />
          </div>
        ))
      )}
    </div>
  )

  return (
    <SettingRow stacked label="Reachable from Telegram" help="Choose which bots and projects you can message from Telegram.">
      {list('Bots', 'bots', bots, status.reachableBots, 'No bots yet.')}
      {list('Projects', 'projects', projects, status.reachableProjects, 'No projects yet.')}
      {error && <p className="mt-2 text-[11px] leading-4 text-red-400">{error}</p>}
    </SettingRow>
  )
}
