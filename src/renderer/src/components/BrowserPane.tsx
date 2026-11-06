import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Attachment, BrowserAnnotationHit, BrowserState } from '../../../shared/types'
import { parseYoutubeVideoId } from '../../../shared/youtube'
import type { YoutubeTranscriptResult } from '../../../shared/youtube'
import { useStreams, useWorkspace } from '../workspace'
import { Icon } from './icons'
import { ReorderGrip } from './ReorderGrip'

type AnnotateMode = 'off' | 'picking' | 'comment'

type QueuedNote = {
  chatId: string
  content: string
  attachments: Attachment[]
}

type TranscriptView =
  | { status: 'loading'; videoId: string }
  | { status: 'done'; videoId: string; result: YoutubeTranscriptResult }

// Notes waiting to send live outside the pane, so a remount neither drops them nor sends one twice.
let noteQueue: QueuedNote[] = []
let noteFlushing = false
const noteListeners = new Set<() => void>()

function setNoteQueue(update: (current: QueuedNote[]) => QueuedNote[]): void {
  noteQueue = update(noteQueue)
  for (const listener of noteListeners) listener()
}

function subscribeNotes(listener: () => void): () => void {
  noteListeners.add(listener)
  return () => {
    noteListeners.delete(listener)
  }
}

const empty: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  visible: false,
  error: null
}

export function BrowserPane(): React.JSX.Element {
  const {
    showBrowser,
    showActivity,
    showGit,
    showKnowledge,
    showNewProject,
    showSettings,
    showUsage,
    setShowBrowser,
    swapRightPanes,
    activeChatId,
    activeProjectId,
    openChat,
    sendMessage
  } = useWorkspace()
  const streams = useStreams()
  const hostRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const pickGen = useRef(0)
  const navGen = useRef(0)
  const sendingNote = useRef(false)
  const transcriptGen = useRef(0)
  const [state, setState] = useState<BrowserState>(empty)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptView | null>(null)
  const [mode, setMode] = useState<AnnotateMode>('off')
  const [hit, setHit] = useState<BrowserAnnotationHit | null>(null)
  const [note, setNote] = useState('')
  const [annotateError, setAnnotateError] = useState<string | null>(null)
  const queue = useSyncExternalStore(subscribeNotes, () => noteQueue)
  const [cardPos, setCardPos] = useState<{ left: number; top: number } | null>(null)
  const [pasted, setPasted] = useState<Attachment[]>([])
  const overlay = showBrowser && !showNewProject && !showSettings && !showUsage
  const videoId = parseYoutubeVideoId(state.url)
  const showWebview = overlay && !transcript && mode !== 'comment'
  const busy = Boolean(activeChatId && streams[activeChatId]?.status === 'streaming')

  useEffect(() => {
    if (!transcript) return
    if (videoId !== transcript.videoId) {
      transcriptGen.current += 1
      setTranscript(null)
    }
  }, [videoId, transcript])

  useEffect(() => {
    let cancelled = false
    void window.workbench.getBrowserState().then((next) => {
      if (cancelled) return
      setState(next)
      if (!editing) setDraft(next.url)
    })
    const off = window.workbench.onBrowserState((next) => {
      setState(next)
      if (!editing) setDraft(next.url)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [editing])

  useEffect(() => {
    void window.workbench.setBrowserVisible(showWebview)
    return () => {
      void window.workbench.setBrowserVisible(false)
    }
  }, [showWebview])

  useEffect(() => {
    const el = hostRef.current
    if (!el || !showWebview) return

    let last = ''

    function report(): void {
      const rect = el!.getBoundingClientRect()
      const next = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
      const key = `${next.x}|${next.y}|${next.width}|${next.height}`
      if (key === last) return
      last = key
      void window.workbench.setBrowserBounds(next)
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    const timer = window.setInterval(report, 250)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      window.clearInterval(timer)
    }
  }, [showWebview, showActivity, showGit, showKnowledge])

  useEffect(() => {
    if (overlay) return
    pickGen.current += 1
    void window.workbench.cancelBrowserAnnotate()
    setMode('off')
    setHit(null)
    setNote('')
    setPasted([])
  }, [overlay])

  useEffect(() => {
    if (mode === 'comment') noteRef.current?.focus()
  }, [mode])

  useEffect(() => {
    if (noteFlushing || queue.length === 0) return
    const next = queue[0]
    if (!next) return
    if (streams[next.chatId]?.status === 'streaming') return
    noteFlushing = true
    void sendMessage(next.chatId, next.content, next.attachments)
      .then((sent) => {
        if (!sent) setAnnotateError('Could not send annotation')
      })
      .catch((error) => {
        const raw = error instanceof Error ? error.message : 'Could not send annotation'
        setAnnotateError(raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
      })
      .finally(() => {
        // The lock clears before the queue changes, so the render that follows can send the next note.
        noteFlushing = false
        setNoteQueue((current) => current.slice(1))
      })
  }, [queue, streams, sendMessage])

  async function beginPick(): Promise<void> {
    const gen = ++pickGen.current
    setMode('picking')
    setHit(null)
    setNote('')
    setPasted([])
    setAnnotateError(null)
    try {
      const next = await window.workbench.startBrowserAnnotate()
      if (gen !== pickGen.current) return
      if (!next) {
        setMode('off')
        return
      }
      setHit(next)
      setCardPos(null)
      setMode('comment')
    } catch (error) {
      if (gen !== pickGen.current) return
      const raw = error instanceof Error ? error.message : 'Could not start annotate'
      setAnnotateError(raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
      setMode('off')
    }
  }

  function stopAnnotate(): void {
    pickGen.current += 1
    void window.workbench.cancelBrowserAnnotate()
    setMode('off')
    setHit(null)
    setNote('')
    setPasted([])
    setAnnotateError(null)
  }

  async function sendAnnotation(): Promise<void> {
    if (!hit || sendingNote.current) return
    const gen = pickGen.current
    let chatId = activeChatId
    if (!chatId) {
      if (!activeProjectId) {
        setAnnotateError('Open a project chat first')
        return
      }
      sendingNote.current = true
      try {
        const chat = await window.workbench.createChat(activeProjectId)
        await openChat(chat.id)
        chatId = chat.id
      } catch (error) {
        if (gen !== pickGen.current) return
        const raw = error instanceof Error ? error.message : 'Could not create a chat'
        setAnnotateError(raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
        return
      } finally {
        sendingNote.current = false
      }
    }
    if (!chatId) return
    const attachments: Attachment[] = [
      ...(hit.screenshotData
        ? [{ id: crypto.randomUUID(), mimeType: 'image/png', data: hit.screenshotData }]
        : []),
      ...pasted
    ]
    setNoteQueue((current) => [
      ...current,
      { chatId, content: annotationMessage(hit, note, pasted.length), attachments }
    ])
    // Annotate was stopped or restarted while the chat was created: the note still goes out.
    if (gen !== pickGen.current) return
    setHit(null)
    setNote('')
    setPasted([])
    setAnnotateError(null)
    void beginPick()
  }

  async function go(input: string): Promise<void> {
    const gen = ++navGen.current
    setEditing(false)
    const next = await window.workbench.navigateBrowser(input)
    // A newer navigation started while this one loaded. Its result is the one to show.
    if (gen !== navGen.current) return
    setState(next)
    setDraft(next.url)
  }

  async function transcribeCurrent(): Promise<void> {
    if (!videoId) return
    const gen = ++transcriptGen.current
    if (transcript) {
      setTranscript(null)
      return
    }
    setTranscript({ status: 'loading', videoId })
    let result: YoutubeTranscriptResult
    try {
      result = await window.workbench.transcribeYoutube(state.url)
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Could not fetch captions'
      result = {
        ok: false,
        videoId,
        error: raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
      }
    }
    if (gen !== transcriptGen.current) return
    setTranscript({ status: 'done', videoId, result })
  }

  async function clearLogins(): Promise<void> {
    if (!confirm('Forget saved logins and cookies in this browser?')) return
    const next = await window.workbench.clearBrowserData()
    setState(next)
    setDraft('')
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-canvas">
      <div className="drag flex h-titlebar shrink-0 items-center gap-1 border-b border-line bg-sidebar px-2">
        <div className="no-drag flex min-w-0 flex-1 items-center gap-1">
          {(showActivity || showGit || showKnowledge) && (
            <ReorderGrip onSwap={swapRightPanes} label="Reorder panes" />
          )}
          <IconButton
            label="Back"
            disabled={!state.canGoBack}
            onClick={() => void window.workbench.browserBack()}
          >
            <Icon name="chevron" className="rotate-180" />
          </IconButton>
          <IconButton
            label="Forward"
            disabled={!state.canGoForward}
            onClick={() => void window.workbench.browserForward()}
          >
            <Icon name="chevron" />
          </IconButton>
          <IconButton
            label={state.loading ? 'Stop' : 'Reload'}
            onClick={() =>
              void (state.loading ? window.workbench.stopBrowser() : window.workbench.reloadBrowser())
            }
          >
            {state.loading ? <Icon name="close" /> : <Icon name="retry" />}
          </IconButton>
          <IconButton
            label={mode === 'off' ? 'Annotate for agent' : 'Stop annotating'}
            disabled={!state.url || Boolean(transcript)}
            active={mode !== 'off'}
            testId="browser-annotate"
            onClick={() => {
              if (mode === 'off') void beginPick()
              else stopAnnotate()
            }}
          >
            <CrosshairIcon />
          </IconButton>
          <form
            className="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault()
              void go(draft)
            }}
          >
            <input
              data-testid="browser-url"
              type="text"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="https://"
              value={draft}
              className="h-7 w-full rounded-[7px] border border-line bg-surface px-2 font-mono text-[11px] text-ink outline-none placeholder:text-faint focus:border-accent-line"
              onFocus={() => setEditing(true)}
              onChange={(event) => {
                setEditing(true)
                setDraft(event.target.value)
              }}
              onBlur={() => {
                setEditing(false)
                setDraft(state.url)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setEditing(false)
                  setDraft(state.url)
                  event.currentTarget.blur()
                }
              }}
            />
          </form>
          {videoId && (
            <button
              type="button"
              className="h-7 shrink-0 rounded-[7px] px-1.5 text-[11px] text-muted hover:bg-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
              title="Fetch YouTube captions"
              disabled={mode !== 'off'}
              onClick={() => void transcribeCurrent()}
            >
              {transcript ? 'Video' : 'Transcript'}
            </button>
          )}
          <button
            type="button"
            className="h-7 shrink-0 rounded-[7px] px-1.5 text-[11px] text-muted hover:bg-hover hover:text-ink"
            title="Forget cookies and logins"
            onClick={() => void clearLogins()}
          >
            Clear
          </button>
          <IconButton label="Close Browser" onClick={() => setShowBrowser(false)}>
            <Icon name="close" />
          </IconButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" data-testid="browser-host" />
        {mode === 'comment' && hit && (
          <AnnotationLayer
            hit={hit}
            note={note}
            noteRef={noteRef}
            cardPos={cardPos}
            busy={busy}
            queue={queue.length}
            error={annotateError}
            onNote={setNote}
            onCardPos={setCardPos}
            onSend={() => void sendAnnotation()}
            onBack={() => void beginPick()}
            hostRef={hostRef}
            pasted={pasted}
            onPasted={setPasted}
          />
        )}
        {transcript && <TranscriptPanel view={transcript} />}
        {!state.url && !transcript && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-[12px] text-muted">
            Enter a site to browse. Logins and cookies stay saved here.
          </div>
        )}
        {state.error && !transcript && (
          <div className="absolute bottom-2 left-2 right-2 rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] text-danger">
            {state.error}
          </div>
        )}
      </div>
    </section>
  )
}

const CARD_W = 340
const CARD_H = 176

function placeCard(
  rect: BrowserAnnotationHit['rect'],
  hostW: number,
  hostH: number
): { left: number; top: number } {
  const gap = 10
  let top = rect.y + rect.height + gap
  let left = rect.x
  if (top + CARD_H > hostH - 8) top = rect.y - CARD_H - gap
  if (top < 8) top = 8
  if (left + CARD_W > hostW - 8) left = hostW - CARD_W - 8
  if (left < 8) left = 8
  return { left: Math.max(8, left), top: Math.max(8, top) }
}

const MAX_PASTE_IMAGES = 5
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

async function blobToAttachment(file: Blob, mimeType: string): Promise<Attachment | null> {
  if (file.size > MAX_IMAGE_BYTES) return null
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { id: crypto.randomUUID(), mimeType, data: btoa(binary) }
}

async function imagesFromClipboard(event: ClipboardEvent | React.ClipboardEvent): Promise<Attachment[]> {
  const data = event.clipboardData
  if (!data) return []
  const items = [...data.items]
  const next: Attachment[] = []
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (!file) continue
    const attachment = await blobToAttachment(file, item.type || 'image/png')
    if (attachment) next.push(attachment)
  }
  return next
}

async function imagesFromDrop(event: React.DragEvent): Promise<Attachment[]> {
  const next: Attachment[] = []
  for (const file of [...event.dataTransfer.files]) {
    if (!file.type.startsWith('image/')) continue
    const attachment = await blobToAttachment(file, file.type || 'image/png')
    if (attachment) next.push(attachment)
  }
  return next
}

function AnnotationLayer({
  hit,
  note,
  noteRef,
  cardPos,
  busy,
  queue,
  error,
  onNote,
  onCardPos,
  onSend,
  onBack,
  hostRef,
  pasted,
  onPasted
}: {
  hit: BrowserAnnotationHit
  note: string
  noteRef: React.RefObject<HTMLTextAreaElement | null>
  cardPos: { left: number; top: number } | null
  busy: boolean
  queue: number
  error: string | null
  onNote: (value: string) => void
  onCardPos: (pos: { left: number; top: number }) => void
  onSend: () => void
  onBack: () => void
  hostRef: React.RefObject<HTMLDivElement | null>
  pasted: Attachment[]
  onPasted: (value: Attachment[] | ((current: Attachment[]) => Attachment[])) => void
}): React.JSX.Element {
  const drag = useRef<{ px: number; py: number; left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (cardPos) return
    const host = hostRef.current
    if (!host) return
    onCardPos(placeCard(hit.rect, host.clientWidth, host.clientHeight))
  }, [cardPos, hit.rect, hostRef, onCardPos])

  const addImages = useCallback(
    (incoming: Attachment[]): void => {
      if (incoming.length === 0) return
      onPasted((current) => {
        const room = MAX_PASTE_IMAGES - current.length
        return room > 0 ? [...current, ...incoming.slice(0, room)] : current
      })
    },
    [onPasted]
  )

  useEffect(() => {
    function onPaste(event: ClipboardEvent): void {
      const target = event.target
      if (target instanceof HTMLInputElement) return
      const hasImage = [...(event.clipboardData?.items ?? [])].some((item) =>
        item.type.startsWith('image/')
      )
      if (!hasImage) return
      event.preventDefault()
      void imagesFromClipboard(event).then(addImages)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addImages])

  const pos = cardPos ?? { left: 16, top: 16 }

  return (
    <div className="absolute inset-0 z-10" data-testid="browser-annotate-layer">
      {hit.screenshotData && (
        <img
          src={`data:image/png;base64,${hit.screenshotData}`}
          alt=""
          className="absolute inset-0 h-full w-full"
        />
      )}
      <button
        type="button"
        className="absolute inset-0 bg-black/30"
        aria-label="Pick a different element"
        onClick={onBack}
      />
      <div
        className="pointer-events-none absolute border-2 border-accent bg-accent/20"
        style={{
          left: hit.rect.x,
          top: hit.rect.y,
          width: Math.max(0, hit.rect.width),
          height: Math.max(0, hit.rect.height)
        }}
      />
      <form
        className="absolute z-20 w-[340px] rounded-lg border border-line bg-surface p-2 shadow-lg shadow-black/40"
        style={{ left: pos.left, top: pos.top }}
        onSubmit={(event) => {
          event.preventDefault()
          onSend()
        }}
        onClick={(event) => event.stopPropagation()}
        onDragOver={(event) => {
          event.preventDefault()
        }}
        onDrop={(event) => {
          event.preventDefault()
          void imagesFromDrop(event).then(addImages)
        }}
      >
        <div
          className="mb-1.5 flex cursor-grab items-center gap-2 active:cursor-grabbing"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { px: event.clientX, py: event.clientY, left: pos.left, top: pos.top }
          }}
          onPointerMove={(event) => {
            const start = drag.current
            const host = hostRef.current
            if (!start || !host) return
            const next = {
              left: start.left + event.clientX - start.px,
              top: start.top + event.clientY - start.py
            }
            next.left = Math.min(host.clientWidth - CARD_W - 8, Math.max(8, next.left))
            next.top = Math.min(host.clientHeight - 72, Math.max(8, next.top))
            onCardPos(next)
          }}
          onPointerUp={() => {
            drag.current = null
          }}
        >
          <span className="text-[11px] text-muted">⠿</span>
          <div className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
            {hit.tag}
            {hit.selector ? ` · ${hit.selector}` : ''}
          </div>
        </div>
        <textarea
          ref={noteRef}
          data-testid="browser-annotate-note"
          rows={3}
          placeholder="What's wrong with this element…"
          value={note}
          className="h-16 w-full resize-none rounded-md border border-line bg-canvas px-2 py-1 text-[12px] text-ink outline-none placeholder:text-muted focus:border-accent"
          onChange={(event) => onNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onBack()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              onSend()
            }
          }}
        />
        {pasted.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {pasted.map((item) => (
              <div key={item.id} className="relative">
                <img
                  src={`data:${item.mimeType};base64,${item.data}`}
                  alt="Pasted reference"
                  className="h-12 w-12 rounded border border-line object-cover"
                />
                <button
                  type="button"
                  className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-raised text-[10px] text-ink hover:bg-danger"
                  aria-label="Remove screenshot"
                  onClick={() => onPasted((current) => current.filter((row) => row.id !== item.id))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-[10px] text-muted">Optional: ⌘V or drop a reference screenshot</p>
        )}
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[12px] text-muted hover:bg-raised hover:text-ink"
            onClick={onBack}
          >
            Back
          </button>
          <button
            type="submit"
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px"
          >
            {busy ? 'Queue' : 'Send'}
          </button>
        </div>
        {queue > 0 && (
          <p className="mt-1.5 text-[10px] text-muted">
            {queue} queued{busy ? ' — sending when this turn ends' : ''}
          </p>
        )}
        {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
      </form>
    </div>
  )
}

function TranscriptPanel({ view }: { view: TranscriptView }): React.JSX.Element {
  const result = view.status === 'done' ? view.result : null
  const ok = result?.ok === true ? result : null
  const error = result && !result.ok ? result.error : null

  async function copy(): Promise<void> {
    if (!ok) return
    await navigator.clipboard.writeText(`${ok.title}\n${ok.url}\n\n${ok.text}`)
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-canvas">
      {view.status === 'loading' && (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[12px] text-muted">
          Fetching captions…
        </div>
      )}
      {error && (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[12px] text-danger">
          {error}
        </div>
      )}
      {ok && (
        <>
          <div className="flex items-start justify-between gap-3 border-b border-line px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-ink">{ok.title}</div>
              <div className="truncate text-[11px] text-muted">
                {ok.author}
                {ok.author ? ' · ' : ''}
                {ok.languageName}
                {ok.autoGenerated ? ' · auto' : ''}
              </div>
            </div>
            <button
              type="button"
              className="h-7 shrink-0 rounded-[7px] px-1.5 text-[11px] text-muted hover:bg-hover hover:text-ink"
              onClick={() => void copy()}
            >
              Copy
            </button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-sans text-[13px] leading-6 text-ink whitespace-pre-wrap">
            {ok.text}
          </pre>
        </>
      )}
    </div>
  )
}

function annotationMessage(hit: BrowserAnnotationHit, note: string, extraCount: number): string {
  const lines = [
    'Browser annotation — inspect this element and fix the issue described below.',
    '',
    `Page: ${hit.title || '(untitled)'}`,
    `URL: ${hit.url}`,
    `Element: <${hit.tag}> \`${hit.selector || '(unknown)'}\``
  ]
  if (hit.text) lines.push(`Visible text: ${hit.text}`)
  if (hit.html) {
    lines.push('', '```html', hit.html, '```')
  }
  const trimmed = note.trim()
  if (trimmed) {
    lines.push('', 'Note:', trimmed)
  }
  lines.push('', 'The first screenshot is the live page with this element outlined.')
  if (extraCount > 0) {
    lines.push(
      `The next ${extraCount} image${extraCount === 1 ? ' is a' : 's are'} design/reference screenshot${extraCount === 1 ? '' : 's'}. Match the live HTML to ${extraCount === 1 ? 'it' : 'them'}.`
    )
  }
  return lines.join('\n')
}

function CrosshairIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="3.25" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M7 1.25v2.75M7 10v2.75M1.25 7h2.75M10 7h2.75"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function IconButton({
  label,
  disabled,
  active,
  testId,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  active?: boolean
  testId?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      aria-pressed={active}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] disabled:opacity-40 disabled:hover:bg-transparent ${
        active
          ? 'bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--color-accent-line)]'
          : 'text-muted hover:bg-hover hover:text-ink'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
