import { useEffect, useRef, useState } from 'react'
import type { Bot } from '../../../shared/types'
import { useWorkspace } from '../workspace'

function errorText(error: unknown, fallback: string): string {
  // IPC errors arrive as "Error invoking remote method '…': Error: <message>".
  const message = error instanceof Error ? error.message : ''
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || fallback
}

/** The chief of staff's heartbeat setting and checklist. */
export function BotChief({ bot }: { bot: Bot }): React.JSX.Element {
  const { chats } = useWorkspace()
  const [checklist, setChecklist] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Deleting the Heartbeat chat turns the heartbeat off.
  const heartbeat = chats.some((chat) => chat.botId === bot.id && chat.schedule?.heartbeat)

  // Unsaved edits, read by the focus listener without re-subscribing on every keystroke.
  const editing = useRef(false)
  editing.current = checklist !== null && draft !== checklist

  useEffect(() => {
    let current = true
    setChecklist(null)
    setDraft('')
    // The chief edits its checklist too: read it again on coming back, unless the user is editing.
    const load = (): void => {
      if (editing.current) return
      window.workbench
        .getBotHeartbeat(bot.id)
        .then((found) => {
          if (!current || editing.current) return
          setChecklist(found)
          setDraft(found)
        })
        .catch((caught: unknown) => {
          if (current) setError(errorText(caught, 'Could not read the checklist'))
        })
    }
    load()
    window.addEventListener('focus', load)
    return () => {
      current = false
      window.removeEventListener('focus', load)
    }
  }, [bot.id])

  async function run(action: () => Promise<unknown>, fallback: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(errorText(caught, fallback))
    } finally {
      setBusy(false)
    }
  }

  function save(): Promise<void> {
    return run(async () => {
      const saved = await window.workbench.saveBotHeartbeat(bot.id, draft)
      setChecklist(saved)
      setDraft(saved)
    }, 'Could not save the checklist')
  }

  return (
    <div className="flex flex-col gap-2" data-testid="bot-chief">
      <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2 hover:text-ink">
        <input
          data-testid="bot-heartbeat-toggle"
          type="checkbox"
          className="shrink-0 accent-accent"
          checked={heartbeat}
          disabled={busy}
          onChange={(event) =>
            void run(() => window.workbench.setHeartbeat(bot.id, event.target.checked), 'Could not save the heartbeat')
          }
        />
        Heartbeat
      </label>
      <span className="text-[11px] text-faint">
        This bot is the chief of staff. On each heartbeat it checks its checklist and the other bots&apos; open work,
        hands due work to the right bot, and tells you only when something needs you. It also reviews what went wrong
        for each bot, in its <span className="font-mono">PROBLEMS.md</span>, and saves the lesson in that bot&apos;s{' '}
        <span className="font-mono">LESSONS.md</span>.
      </span>
      <div className="text-[12px] text-muted">Checklist</div>
      <textarea
        data-testid="bot-chief-checklist"
        value={draft}
        rows={5}
        disabled={checklist === null}
        placeholder="Empty. What the chief checks on each heartbeat, one item per line."
        onChange={(event) => setDraft(event.target.value)}
        className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-5 text-ink outline-none focus:border-accent/60"
      />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] text-faint">
          Saved as <span className="font-mono">memory/HEARTBEAT.md</span>. The bot adds to it too when you ask it to
          keep an eye on something. With nothing open here, in any bot&apos;s work or in any bot&apos;s problems, a heartbeat
          does not run.
        </span>
        {editing.current && (
          <>
            <button
              className="shrink-0 rounded-md px-2.5 py-1 text-[12px] text-muted hover:text-ink"
              disabled={busy}
              onClick={() => setDraft(checklist ?? '')}
            >
              Discard
            </button>
            <button
              data-testid="bot-chief-save"
              className="shrink-0 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-accent-ink disabled:opacity-50"
              disabled={busy}
              onClick={() => void save()}
            >
              Save
            </button>
          </>
        )}
      </div>
      {error && <div className="text-[12px] text-danger">{error}</div>}
    </div>
  )
}
