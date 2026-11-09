import { useEffect, useMemo, useState } from 'react'
import type { ActivityEvent, ActivitySnapshot } from '../../../shared/types'
import { sideBySideDiff } from '../lineDiff'
import { useWorkspace } from '../workspace'
import { CodeDiff } from './CodeDiff'
import { Icon, IconButton, type IconName } from './icons'
import { ReorderGrip } from './ReorderGrip'

function clock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function duration(from: string, to: string | undefined): string | null {
  if (!to) return null
  const ms = new Date(to).getTime() - new Date(from).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/** `select:mcp__browser__get_state` → `browser.get_state`. */
function cleanToolName(name: string): string {
  return name
    .replace(/^select:/, '')
    .replace(/^mcp__/, '')
    .replace(/__/g, '.')
}

const RAW_NAME = /^[\w:.-]+$/

const LOOKUP_KINDS = new Set(['search', 'read', 'fetch'])

type Filter = 'all' | 'tools' | 'edits' | 'replies'

function isEdit(event: ActivityEvent): boolean {
  return (event.diffs?.length ?? 0) > 0
}

function matches(event: ActivityEvent, filter: Filter): boolean {
  if (filter === 'edits') return isEdit(event)
  if (filter === 'tools') return event.kind === 'tool' && !isEdit(event)
  if (filter === 'replies') return event.kind === 'write'
  return true
}

function eventLabel(event: ActivityEvent): React.ReactNode {
  const running = event.status === 'running'
  if (event.kind === 'tool') {
    const title = event.title.trim()
    if (title.startsWith('select:')) {
      return (
        <>
          Loaded tool <code className="font-mono text-[11.5px]">{cleanToolName(title)}</code>
        </>
      )
    }
    if (RAW_NAME.test(title) && event.toolKind !== 'progress') {
      return (
        <>
          {running ? 'Calling' : 'Called'}{' '}
          <code className="font-mono text-[11.5px]">{cleanToolName(title)}</code>
        </>
      )
    }
    return title
  }
  if (event.kind === 'thought') return running ? event.title || 'Thinking' : 'Thought it through'
  if (event.kind === 'write') return running ? 'Writing reply' : 'Wrote reply'
  if (event.kind === 'plan') return event.title && event.title !== 'Plan' ? event.title : 'Planned the turn'
  return event.title
}

function nodeStyle(event: ActivityEvent): { icon: IconName; tone: 'accent' | 'ok' | 'danger' | 'default' } {
  if (event.status === 'error' || event.kind === 'error') return { icon: 'close', tone: 'danger' }
  if (event.kind === 'plan' || event.kind === 'goal' || event.kind === 'thought') {
    return { icon: 'sparkle', tone: 'accent' }
  }
  if (event.kind === 'permission') return { icon: 'shield', tone: 'accent' }
  if (event.kind === 'write') return { icon: 'bubble', tone: 'default' }
  if (isEdit(event)) return { icon: 'pencil', tone: 'default' }
  if (event.kind === 'tool') {
    if (event.title.startsWith('select:') || LOOKUP_KINDS.has(event.toolKind ?? '')) {
      return { icon: 'search', tone: 'default' }
    }
    if (event.toolKind === 'progress') return { icon: 'pulse', tone: 'default' }
    return { icon: 'check', tone: event.status === 'done' ? 'ok' : 'default' }
  }
  return { icon: 'more', tone: 'default' }
}

const TONE: Record<'accent' | 'ok' | 'danger' | 'default', string> = {
  accent: 'border-accent-line bg-accent-soft text-accent',
  ok: 'border-line-strong bg-raised text-ok',
  danger: 'border-danger/40 bg-danger/10 text-danger',
  default: 'border-line-strong bg-raised text-muted'
}

function diffStats(event: ActivityEvent): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const diff of event.diffs ?? []) {
    for (const row of sideBySideDiff(diff.oldText, diff.newText)) {
      if (row.left?.kind === 'del') removed += 1
      if (row.right?.kind === 'add') added += 1
    }
  }
  return { added, removed }
}

const EXCERPT_LINES = 6
const EXCERPT_CHARS = 320

function detailExcerpt(text: string, fromEnd: boolean): { preview: string; hidden: number } {
  const normalized = text.replace(/\s+$/u, '')
  const lines = normalized.split('\n')
  if (lines.length > EXCERPT_LINES) {
    const slice = fromEnd ? lines.slice(-EXCERPT_LINES) : lines.slice(0, EXCERPT_LINES)
    return { preview: slice.join('\n'), hidden: lines.length - EXCERPT_LINES }
  }
  if (normalized.length > EXCERPT_CHARS) {
    const preview = fromEnd
      ? normalized.slice(-EXCERPT_CHARS).trimStart()
      : normalized.slice(0, EXCERPT_CHARS).trimEnd()
    return { preview, hidden: 0 }
  }
  return { preview: normalized, hidden: -1 }
}

/** Pretty-prints JSON tool output, or returns null when the text is not JSON. */
function asJson(text: string): string | null {
  const trimmed = text.trim()
  if (!/^[[{]/.test(trimmed)) return null
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return null
  }
}

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

function JsonText({ text }: { text: string }): React.JSX.Element {
  const parts: React.ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(JSON_TOKEN)) {
    const at = match.index ?? 0
    if (at > last) parts.push(text.slice(last, at))
    const [whole, str, colon, keyword, num] = match
    if (str && colon) {
      parts.push(
        <span key={at} className="text-[#9fb4c7]">
          {str}
        </span>,
        colon
      )
    } else if (str) {
      parts.push(
        <span key={at} className="text-[#a8c99a]">
          {str}
        </span>
      )
    } else {
      parts.push(
        <span key={at} className="text-[#d9a066]">
          {keyword ?? num}
        </span>
      )
    }
    last = at + whole.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

function ResultCard({ text, live }: { text: string; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const json = useMemo(() => asJson(text), [text])
  const body = json ?? text
  const { preview, hidden } = useMemo(() => detailExcerpt(body, false), [body])
  const expanded = open || live || hidden < 0
  return (
    <div className="mt-2 overflow-hidden rounded-[8px] border border-line bg-code-block">
      <div className="flex h-7 items-center gap-1.5 border-b border-line px-2.5 text-[11px] text-faint">
        <Icon name="globe" size={12} />
        Result · {json ? 'JSON' : 'Text'}
        <button
          type="button"
          title={copied ? 'Copied' : 'Copy result'}
          aria-label="Copy result"
          className="ml-auto flex h-5 w-5 items-center justify-center rounded hover:bg-hover hover:text-muted"
          onClick={() => {
            void navigator.clipboard.writeText(body).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            })
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-5 whitespace-pre-wrap break-words text-ink-2">
        {json ? <JsonText text={expanded ? body : preview} /> : expanded ? body : preview}
        {!expanded && hidden === 0 ? '…' : null}
      </pre>
      {hidden >= 0 && !live && (
        <button
          type="button"
          className="flex h-7 w-full items-center gap-1.5 border-t border-dashed border-line px-3 text-[11px] text-faint hover:text-muted"
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="chevronDown" size={11} className={open ? 'rotate-180' : ''} />
          {open ? 'Show less' : hidden > 0 ? `Show ${hidden} more line${hidden === 1 ? '' : 's'}` : 'Show all'}
        </button>
      )}
    </div>
  )
}

function TextDetail({ text, fromEnd, live }: { text: string; fromEnd: boolean; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { preview, hidden } = useMemo(() => detailExcerpt(text, fromEnd), [text, fromEnd])
  const expanded = open || live || hidden < 0
  return (
    <div className="mt-0.5">
      <p className="text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-muted">
        {!expanded && fromEnd ? '…' : null}
        {expanded ? text : preview}
        {!expanded && !fromEnd ? '…' : null}
      </p>
      {hidden >= 0 && !live && (
        <button
          type="button"
          className="mt-0.5 text-[11px] text-faint hover:text-muted"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

function EventRow({ event }: { event: ActivityEvent }): React.JSX.Element {
  const running = event.status === 'running'
  const { icon, tone } = nodeStyle(event)
  const time = duration(event.at, event.endedAt) ?? clock(event.at)
  const edit = isEdit(event)
  const stats = edit ? diffStats(event) : null
  const toolResult = event.kind === 'tool' && !edit && event.toolKind !== 'progress'
  return (
    <article className="relative flex gap-2.5 pb-3.5 not-last:before:absolute not-last:before:top-[21px] not-last:before:bottom-0 not-last:before:left-[9px] not-last:before:w-px not-last:before:bg-line">
      <span
        className={`relative z-[1] flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-[5px] border ${TONE[tone]} ${
          running ? 'animate-pulse' : ''
        }`}
      >
        <Icon name={icon} size={11} strokeWidth={1.6} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-[19px] items-center gap-2">
          <div
            className={`min-w-0 flex-1 truncate text-[12.5px] ${
              event.status === 'error' ? 'text-danger' : 'text-ink'
            }`}
            title={typeof eventLabel(event) === 'string' ? event.title : cleanToolName(event.title)}
          >
            {eventLabel(event)}
          </div>
          {stats && (
            <span className="shrink-0 font-mono text-[11px] tabular-nums">
              <span className="text-diff-add">+{stats.added}</span>{' '}
              <span className="text-diff-del">−{stats.removed}</span>
            </span>
          )}
          <span className="shrink-0 text-[11px] tabular-nums text-faint">{running ? '' : time}</span>
        </div>
        {event.detail &&
          (toolResult ? (
            <ResultCard text={event.detail} live={running} />
          ) : (
            <TextDetail text={event.detail} fromEnd={event.kind === 'thought'} live={running} />
          ))}
        {event.diffs?.map((diff, index) => (
          <CodeDiff key={`${diff.path}:${index}`} diff={diff} />
        ))}
      </div>
    </article>
  )
}

type TurnGroup = {
  id: string
  turn: ActivityEvent | null
  number: number
  events: ActivityEvent[]
}

/** Splits the feed into turns: each `turn` event opens a group for its chat. */
function groupTurns(events: ActivityEvent[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  const current = new Map<string, TurnGroup>()
  const counts = new Map<string, number>()
  let loose: TurnGroup | null = null
  for (const event of events) {
    const chat = event.chatId ?? ''
    if (event.kind === 'turn') {
      const number = (counts.get(chat) ?? 0) + 1
      counts.set(chat, number)
      const group: TurnGroup = { id: event.id, turn: event, number, events: [] }
      current.set(chat, group)
      groups.push(group)
      continue
    }
    const group = current.get(chat)
    if (group) {
      group.events.push(event)
      continue
    }
    if (!loose) {
      loose = { id: 'loose', turn: null, number: 0, events: [] }
      groups.push(loose)
    }
    loose.events.push(event)
  }
  return groups.reverse()
}

function TurnHeader({
  group,
  expanded,
  onToggle
}: {
  group: TurnGroup
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const turn = group.turn
  const failed = turn?.status === 'error'
  const prompt = turn?.detail?.split('\n').find((line) => line.trim()) ?? turn?.title ?? 'Earlier activity'
  const time = turn
    ? turn.status === 'running'
      ? 'running'
      : (duration(turn.at, turn.endedAt) ?? clock(turn.at))
    : ''
  return (
    <button
      type="button"
      aria-expanded={expanded}
      title={turn?.chatTitle ? `${turn.chatTitle} · ${prompt}` : prompt}
      className="flex h-[30px] w-full items-center gap-2 text-left"
      onClick={onToggle}
    >
      {!expanded && <Icon name="chevron" size={12} className="text-faint" />}
      {turn && (
        <span
          className={`flex h-5 shrink-0 items-center rounded-[5px] border px-1.5 text-[11px] tabular-nums ${
            expanded ? 'border-accent-line bg-accent-soft text-accent' : 'border-line-strong text-muted'
          }`}
        >
          Turn {group.number}
        </span>
      )}
      <span
        className={`min-w-0 flex-1 truncate text-[12.5px] font-medium ${
          failed ? 'text-danger' : expanded ? 'text-ink' : 'text-ink-2'
        }`}
      >
        {prompt}
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-faint">{time}</span>
    </button>
  )
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'tools', label: 'Tools' },
  { id: 'edits', label: 'Edits' },
  { id: 'replies', label: 'Replies' }
]

export function ActivityApp(): React.JSX.Element {
  const { activeChatId, showBrowser, showGit, showKnowledge, setShowActivity, swapRightPanes } =
    useWorkspace()
  const [allEvents, setEvents] = useState<ActivityEvent[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    let reset = false
    void window.workbench.getActivity().then((snapshot: ActivitySnapshot) => {
      if (cancelled || reset) return
      // Upserts that arrived first are at least as new as the snapshot, so they win.
      setEvents((current) => {
        const live = new Map(current.map((event) => [event.id, event]))
        const known = new Set(snapshot.events.map((event) => event.id))
        return [
          ...snapshot.events.map((event) => live.get(event.id) ?? event),
          ...current.filter((event) => !known.has(event.id))
        ]
      })
    })
    const off = window.workbench.onActivityEvent((feed) => {
      if (feed.type === 'reset') {
        reset = true
        setEvents(feed.events)
        setToggled({})
        return
      }
      setEvents((current) => {
        const index = current.findIndex((event) => event.id === feed.event.id)
        if (index >= 0) {
          const next = current.slice()
          next[index] = feed.event
          return next
        }
        return [...current, feed.event]
      })
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  // The pane follows the chat that is open: every chat's events are kept, only the active one's show.
  const events = useMemo(
    () => allEvents.filter((event) => event.chatId === activeChatId),
    [allEvents, activeChatId]
  )
  const groups = useMemo(() => groupTurns(events), [events])
  const counts = useMemo(() => {
    const result: Record<Filter, number> = { all: 0, tools: 0, edits: 0, replies: 0 }
    for (const event of events) {
      if (event.kind === 'turn') continue
      for (const item of FILTERS) if (matches(event, item.id)) result[item.id] += 1
    }
    return result
  }, [events])
  const working = events.some((event) => event.status === 'running')
  const newest = groups[0]?.id

  return (
    <div className="flex h-full flex-col bg-sidebar text-ink">
      <header className="drag flex h-titlebar shrink-0 items-center gap-2 border-b border-line px-3">
        {(showBrowser || showGit || showKnowledge) && (
          <ReorderGrip onSwap={swapRightPanes} label="Reorder panes" />
        )}
        <h1 className="shrink-0 text-[13px] font-semibold text-ink">Activity</h1>
        <span
          data-testid="activity-status"
          className="flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-line px-2 text-[11px] text-muted"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${working ? 'streaming-dot bg-accent' : 'bg-ok'}`}
          />
          {working ? 'Working' : 'Idle'}
        </span>
        <div className="flex-1" />
        <div className="no-drag flex shrink-0 items-center gap-0.5">
          <IconButton
            icon="trash"
            label="Clear activity"
            onClick={() => void window.workbench.clearActivity()}
          />
          <IconButton icon="close" label="Close Activity" onClick={() => setShowActivity(false)} />
        </div>
      </header>
      <div className="no-drag shrink-0 border-b border-line px-3 py-2">
        <div className="inline-flex gap-0.5 rounded-[8px] border border-line bg-canvas p-0.5">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              className={`flex h-6 items-center gap-1.5 rounded-[6px] px-2 text-[12px] ${
                filter === item.id
                  ? 'bg-raised text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)]'
                  : 'text-muted hover:text-ink'
              }`}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
              <span className="text-[11px] tabular-nums text-faint">{counts[item.id]}</span>
            </button>
          ))}
        </div>
      </div>
      <div
        key={activeChatId ?? ''}
        className="select-text min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {groups.length === 0 ? (
          <div className="pt-6 text-center">
            <div className="text-[13px] font-semibold text-ink-2">Waiting for a chat</div>
            <p className="mx-auto mt-1 max-w-[260px] text-[12px] leading-[1.55] text-faint">
              Send a message. Thinking, tool calls, edits and the plan show up here as the agent
              works.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {groups.map((group) => {
              const visible = group.events.filter((event) => matches(event, filter))
              if (filter !== 'all' && visible.length === 0) return null
              const expanded = toggled[group.id] ?? group.id === newest
              return (
                <section
                  key={group.id}
                  className={expanded ? 'pb-1' : 'rounded-[8px] border border-line bg-surface px-2.5'}
                >
                  <TurnHeader
                    group={group}
                    expanded={expanded}
                    onToggle={() =>
                      setToggled((current) => ({ ...current, [group.id]: !expanded }))
                    }
                  />
                  {expanded && (
                    <div className="mt-1.5">
                      {visible.length === 0 ? (
                        <div className="pb-2 text-[12px] text-faint">
                          {group.turn?.status === 'running' ? 'Starting…' : 'Nothing recorded'}
                        </div>
                      ) : (
                        visible.map((event) => <EventRow key={event.id} event={event} />)
                      )}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
