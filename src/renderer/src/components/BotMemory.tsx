import { useEffect, useRef, useState } from 'react'
import type { Bot, BotMemory as Memory } from '../../../shared/types'

function errorText(error: unknown, fallback: string): string {
  // IPC errors arrive as "Error invoking remote method '…': Error: <message>".
  const message = error instanceof Error ? error.message : ''
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || fallback
}

/** The bot's memory: the MEMORY.md index it reads at the start of every session, and the files it keeps. */
export function BotMemory({ bot }: { bot: Bot }): React.JSX.Element {
  const [memory, setMemory] = useState<Memory | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Unsaved edits, read by the focus listener without re-subscribing on every keystroke.
  const editing = useRef(false)
  editing.current = memory !== null && draft !== memory.index

  useEffect(() => {
    let current = true
    setMemory(null)
    setDraft('')
    setError(null)
    // The bot writes its memory as it works: read it again on coming back, unless the user is editing.
    const load = (): void => {
      if (editing.current) return
      window.workbench
        .getBotMemory(bot.id)
        .then((found) => {
          if (!current || editing.current) return
          setMemory(found)
          setDraft(found.index)
        })
        .catch((caught: unknown) => {
          if (current) setError(errorText(caught, 'Could not read the memory'))
        })
    }
    load()
    window.addEventListener('focus', load)
    return () => {
      current = false
      window.removeEventListener('focus', load)
    }
  }, [bot.id])

  const changed = editing.current

  async function save(): Promise<void> {
    if (!memory) return
    setBusy(true)
    setError(null)
    try {
      const latest = await window.workbench.getBotMemory(bot.id)
      if (
        latest.index !== memory.index &&
        !confirm(`${bot.name} changed its memory since you opened it. Save yours over it?`)
      ) {
        setMemory(latest)
        setDraft(latest.index)
        return
      }
      const saved = await window.workbench.saveBotMemory(bot.id, draft)
      setMemory(saved)
      setDraft(saved.index)
    } catch (caught) {
      setError(errorText(caught, 'Could not save the memory'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="bot-memory">
      <div className="text-[12px] text-muted">Memory</div>
      <textarea
        data-testid="bot-memory-index"
        value={draft}
        rows={6}
        disabled={memory === null}
        placeholder="Empty. The bot writes what it learns here, one line per memory."
        onChange={(event) => setDraft(event.target.value)}
        className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-5 text-ink outline-none focus:border-accent/60"
      />
      {memory && memory.files.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="bot-memory-files">
          {memory.files.map((file) => (
            <span key={file} className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
              {file}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] text-faint">
          The bot reads <span className="font-mono">memory/MEMORY.md</span> when a session starts and keeps it up to
          date itself, so each scheduled run knows what earlier runs found.
        </span>
        {changed && (
          <>
            <button
              className="shrink-0 rounded-md px-2.5 py-1 text-[12px] text-muted hover:text-ink"
              disabled={busy}
              onClick={() => setDraft(memory?.index ?? '')}
            >
              Discard
            </button>
            <button
              data-testid="bot-memory-save"
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
