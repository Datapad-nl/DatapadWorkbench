import { useState } from 'react'
import { nextCronRun } from '../../../shared/cron'
import type { Bot } from '../../../shared/types'
import { useWorkspace } from '../workspace'

type Draft = { prompt: string; repeats: boolean; cron: string; at: string }

const field =
  'mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/60'

function errorText(error: unknown, fallback: string): string {
  // IPC errors arrive as "Error invoking remote method '…': Error: <message>".
  const message = error instanceof Error ? error.message : ''
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || fallback
}

/** When `cron` next comes up, or why it can't be read. */
function cronPreview(cron: string): string {
  if (!cron.trim()) return 'Five fields in local time: minute hour day month weekday. 0 9 * * 1-5 is 9:00 on weekdays.'
  try {
    const next = nextCronRun(cron.trim(), new Date())
    return next ? `Next run: ${next.toLocaleString()}` : 'This never comes up.'
  } catch (caught) {
    return caught instanceof Error ? caught.message : 'Cannot read this.'
  }
}

/** The bot's scheduled tasks. Each runs in a chat of its own, which keeps every run's answer. */
export function BotSchedules({ bot }: { bot: Bot }): React.JSX.Element {
  const { chats, openChat } = useWorkspace()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const scheduled = chats.filter((chat) => chat.botId === bot.id && chat.schedule)
  const followUps = chats.filter((chat) => chat.botId === bot.id && chat.wake)

  async function run(action: () => Promise<unknown>, fallback: string): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await action()
      return true
    } catch (caught) {
      setError(errorText(caught, fallback))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function save(current: Draft): Promise<void> {
    const ok = await run(
      () =>
        window.workbench.scheduleBot({
          botId: bot.id,
          prompt: current.prompt,
          ...(current.repeats
            ? { cron: current.cron }
            : { at: current.at ? new Date(current.at).toISOString() : '' })
        }),
      'Could not save the schedule'
    )
    if (ok) setDraft(null)
  }

  function editor(current: Draft): React.JSX.Element {
    const edit = (patch: Partial<Draft>): void => setDraft({ ...current, ...patch })
    const ready = current.prompt.trim() && (current.repeats ? current.cron.trim() : current.at)
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-line-strong bg-canvas/60 p-3" data-testid="bot-schedule-editor">
        <label className="block text-[12px] text-muted">
          What to do
          <textarea
            data-testid="bot-schedule-prompt"
            value={current.prompt}
            rows={4}
            placeholder="The message the bot gets each time this runs."
            onChange={(event) => edit({ prompt: event.target.value })}
            className={`${field} resize-y leading-5`}
          />
        </label>
        <div className="flex rounded-md bg-canvas p-0.5">
          {(
            [
              [true, 'Repeats'],
              [false, 'Once']
            ] as const
          ).map(([repeats, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={current.repeats === repeats}
              className={`flex-1 rounded px-2.5 py-1.5 text-[12px] ${
                current.repeats === repeats ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
              }`}
              onClick={() => edit({ repeats })}
            >
              {label}
            </button>
          ))}
        </div>
        {current.repeats ? (
          <label className="block text-[12px] text-muted">
            Cron
            <input
              data-testid="bot-schedule-cron"
              value={current.cron}
              placeholder="0 9 * * 1-5"
              onChange={(event) => edit({ cron: event.target.value })}
              className={`${field} font-mono text-[12px]`}
            />
            <span className="mt-1 block text-[11px] text-faint">{cronPreview(current.cron)}</span>
          </label>
        ) : (
          <label className="block text-[12px] text-muted">
            At
            <input
              data-testid="bot-schedule-at"
              type="datetime-local"
              value={current.at}
              onChange={(event) => edit({ at: event.target.value })}
              className={field}
            />
          </label>
        )}
        <div className="flex items-center gap-2">
          <div className="flex-1" />
          <button
            className="rounded-md px-2.5 py-1.5 text-[12px] text-muted hover:text-ink"
            disabled={busy}
            onClick={() => {
              setDraft(null)
              setError(null)
            }}
          >
            Cancel
          </button>
          <button
            data-testid="bot-schedule-save"
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink disabled:opacity-50"
            disabled={busy || !ready}
            onClick={() => void save(current)}
          >
            Save schedule
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2" data-testid="bot-schedules">
      <div className="flex items-center">
        <div className="text-[12px] text-muted">Schedules</div>
        <div className="flex-1" />
        {!draft && (
          <button
            data-testid="bot-schedule-new"
            className="rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-2 hover:border-line-strong hover:text-ink"
            onClick={() => {
              setError(null)
              setDraft({ prompt: '', repeats: true, cron: '', at: '' })
            }}
          >
            New schedule
          </button>
        )}
      </div>

      {draft && editor(draft)}

      {scheduled.length === 0 && !draft && (
        <div className="rounded-lg border border-dashed border-line px-3 py-3 text-[12px] text-faint">
          Nothing scheduled. Each schedule runs in a chat of its own, in the bot&apos;s folder.
        </div>
      )}

      {(scheduled.length > 0 || followUps.length > 0) && (
        <div className="text-[11px] text-faint">
          Runs are quiet: each starts a fresh session with the bot&apos;s memory, and you hear from the bot only when it
          has something new to tell you.
        </div>
      )}

      {scheduled.map((chat) => {
        const schedule = chat.schedule!
        return (
          <div
            key={chat.id}
            data-testid="bot-schedule-row"
            className="flex items-start gap-3 rounded-lg border border-line bg-canvas px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-[12.5px] text-ink">{schedule.prompt}</div>
              <div className="mt-0.5 text-[11.5px] text-muted">
                {schedule.cron ? <span className="font-mono">{schedule.cron}</span> : 'Once'}
                {schedule.nextRunAt && ` · next ${new Date(schedule.nextRunAt).toLocaleString()}`}
                {schedule.lastRunAt && ` · last ${new Date(schedule.lastRunAt).toLocaleString()}`}
              </div>
            </div>
            <button
              className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-2 hover:border-line-strong hover:text-ink"
              onClick={() => void openChat(chat.id)}
            >
              Open chat
            </button>
            <button
              data-testid="bot-schedule-stop"
              className="shrink-0 rounded-md px-2 py-0.5 text-[11.5px] text-muted hover:text-danger disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                if (!confirm('Stop this schedule? Its chat stays.')) return
                void run(() => window.workbench.stopSchedule(chat.id), 'Could not stop the schedule')
              }}
            >
              Stop
            </button>
          </div>
        )
      })}

      {followUps.map((chat) => {
        const wake = chat.wake!
        return (
          <div
            key={`wake-${chat.id}`}
            data-testid="bot-follow-up-row"
            className="flex items-start gap-3 rounded-lg border border-line bg-canvas px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-[12.5px] text-ink">{wake.note}</div>
              <div className="mt-0.5 text-[11.5px] text-muted">
                Follow-up {new Date(wake.at).toLocaleString()} · in “{chat.title}”
              </div>
            </div>
            <button
              className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-2 hover:border-line-strong hover:text-ink"
              onClick={() => void openChat(chat.id)}
            >
              Open chat
            </button>
            <button
              data-testid="bot-follow-up-cancel"
              className="shrink-0 rounded-md px-2 py-0.5 text-[11.5px] text-muted hover:text-danger disabled:opacity-50"
              disabled={busy}
              onClick={() => void run(() => window.workbench.cancelFollowUp(chat.id), 'Could not cancel the follow-up')}
            >
              Cancel
            </button>
          </div>
        )
      })}

      {error && <div className="text-[12px] text-danger">{error}</div>}
    </div>
  )
}
