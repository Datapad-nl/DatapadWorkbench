import { useEffect, useRef, useState } from 'react'
import type { Bot, BotMemory as Memory } from '../../../shared/types'

function errorText(error: unknown, fallback: string): string {
  // IPC errors arrive as "Error invoking remote method '…': Error: <message>".
  const message = error instanceof Error ? error.message : ''
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || fallback
}

/** The bot's memory: the MEMORY.md index it reads at the start of every session, and the files it keeps. */
export function BotMemory({ bot }: { bot: Bot }): React.JSX.Element {
  return <MemoryEditor bot={bot} />
}

/** The memory every bot reads: who the user is and what they work on. */
export function SharedMemory(): React.JSX.Element {
  return <MemoryEditor bot={null} />
}

/** One memory folder's index and files: a bot's own, or with no bot the shared one. */
function MemoryEditor({ bot }: { bot: Bot | null }): React.JSX.Element {
  const botId = bot?.id ?? null
  const testId = bot ? 'bot-memory' : 'shared-memory'
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
    // Bots write the memory as they work: read it again on coming back, unless the user is editing.
    const load = (): void => {
      if (editing.current) return
      const read = botId ? window.workbench.getBotMemory(botId) : window.workbench.getSharedMemory()
      read
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
  }, [botId])

  const changed = editing.current

  async function save(): Promise<void> {
    if (!memory) return
    setBusy(true)
    setError(null)
    try {
      const latest = await (bot ? window.workbench.getBotMemory(bot.id) : window.workbench.getSharedMemory())
      const question = bot
        ? `${bot.name} changed its memory since you opened it. Save yours over it?`
        : 'A bot changed the shared memory since you opened it. Save yours over it?'
      if (latest.index !== memory.index && !confirm(question)) {
        setMemory(latest)
        setDraft(latest.index)
        return
      }
      const saved = await (bot
        ? window.workbench.saveBotMemory(bot.id, draft)
        : window.workbench.saveSharedMemory(draft))
      setMemory(saved)
      setDraft(saved.index)
    } catch (caught) {
      setError(errorText(caught, 'Could not save the memory'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="text-[12px] text-muted">{bot ? 'Memory' : 'Shared memory'}</div>
      <textarea
        data-testid={`${testId}-index`}
        value={draft}
        rows={6}
        disabled={memory === null}
        placeholder={
          bot
            ? 'Empty. The bot writes what it learns here, one line per memory.'
            : 'Empty. What every bot should know about you and your work, one line per memory.'
        }
        onChange={(event) => setDraft(event.target.value)}
        className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] leading-5 text-ink outline-none focus:border-accent/60"
      />
      {memory && memory.files.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid={`${testId}-files`}>
          {memory.files.map((file) => (
            <span key={file} className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
              {file}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] text-faint">
          {bot ? (
            <>
              The bot reads <span className="font-mono">memory/MEMORY.md</span> when a session starts and keeps it up
              to date itself, so each scheduled run knows what earlier runs found. What every bot should know is in
              the shared memory, in Settings.
            </>
          ) : (
            <>
              Every bot reads this when a session starts, next to its own memory. A bot asks you before it writes
              here.
            </>
          )}
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
              data-testid={`${testId}-save`}
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
