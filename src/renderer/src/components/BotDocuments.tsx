import { useCallback, useEffect, useRef, useState } from 'react'
import type { Bot, BotDocument } from '../../../shared/types'

function errorText(error: unknown, fallback: string): string {
  // IPC errors arrive as "Error invoking remote method '…': Error: <message>".
  const message = error instanceof Error ? error.message : ''
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || fallback
}

/** The books and documents the bot works from, each split into chapters in `documents/<id>/` in its folder. */
export function BotDocuments({ bot }: { bot: Bot }): React.JSX.Element {
  const [documents, setDocuments] = useState<BotDocument[]>([])
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  // Reading a book takes a while: its list only shows if the page still shows that bot.
  const shown = useRef(bot.id)
  shown.current = bot.id

  const reload = useCallback(async () => {
    const botId = bot.id
    const found = await window.workbench.listBotDocuments(botId)
    if (shown.current === botId) setDocuments(found)
  }, [bot.id])

  useEffect(() => {
    setError(null)
    void reload().catch(() => setDocuments([]))
  }, [reload])

  async function add(): Promise<void> {
    setAdding(true)
    setBusy(true)
    setError(null)
    try {
      await window.workbench.pickBotDocuments(bot.id)
    } catch (caught) {
      setError(errorText(caught, 'Could not add the documents'))
    } finally {
      // Files that were read are added even when another one failed.
      await reload().catch(() => {})
      setAdding(false)
      setBusy(false)
    }
  }

  async function remove(doc: BotDocument): Promise<void> {
    if (!confirm(`Remove ${doc.title}?\n\nIts folder goes to the Trash.`)) return
    setBusy(true)
    setError(null)
    try {
      setDocuments(await window.workbench.removeBotDocument(bot.id, doc.id))
    } catch (caught) {
      setError(errorText(caught, 'Could not remove the document'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="bot-documents">
      <div className="flex items-center">
        <div className="text-[12px] text-muted">Documents</div>
        <div className="flex-1" />
        <button
          data-testid="bot-documents-add"
          className="rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-50"
          disabled={busy}
          onClick={() => void add()}
        >
          {adding ? 'Reading…' : 'Add documents…'}
        </button>
      </div>

      {documents.length === 0 && !adding && (
        <div className="rounded-lg border border-dashed border-line px-3 py-3 text-[12px] text-faint">
          No documents yet.
        </div>
      )}

      {documents.map((doc) => (
        <div
          key={doc.id}
          data-testid="bot-document-row"
          className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] text-ink">{doc.title}</div>
            <div className="truncate text-[11px] text-muted">
              {doc.chapters} {doc.chapters === 1 ? 'chapter' : 'chapters'} · {doc.source}
            </div>
          </div>
          <button
            data-testid="bot-document-remove"
            className="shrink-0 rounded-md px-2 py-0.5 text-[11.5px] text-muted hover:text-danger disabled:opacity-50"
            disabled={busy}
            onClick={() => void remove(doc)}
          >
            Remove
          </button>
        </div>
      ))}

      <span className="text-[11px] text-faint">
        PDF, EPUB, text and Markdown. A book is split into chapters the bot reads when a request needs them. After you
        add one, the bot writes an outline of it in a run of its own, listed under the bot.
      </span>
      {error && <div className="whitespace-pre-line text-[12px] text-danger">{error}</div>}
    </div>
  )
}
