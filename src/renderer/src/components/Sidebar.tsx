import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PROJECT_COLORS, resolveProjectColor } from '../../../shared/projectColor'
import type { ChatSummary, Project } from '../../../shared/types'
import { BotAvatar, useBots } from '../bots'
import { useStreamStatuses, useWorkspace } from '../workspace'
import wordmark from '../assets/wordmark.png'
import { Icon, IconButton } from './icons'
import { IndexStatus } from './OrientationCard'

const WIDTH_KEY = 'workbench.sidebarWidth'
const COLLAPSED_KEY = 'workbench.collapsedProjects'
const BLURRED_KEY = 'workbench.blurredProjects'
const BOTS_COLLAPSED_KEY = 'workbench.botsCollapsed'
const DEFAULT_WIDTH = 272
const MIN_WIDTH = 180
const MAX_WIDTH = 520

function readWidth(): number {
  const raw = Number(localStorage.getItem(WIDTH_KEY))
  if (!Number.isFinite(raw)) return DEFAULT_WIDTH
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw))
}

function readFlags(key: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, boolean>
  } catch {
    return {}
  }
}

function errorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

const projectIcons = new Map<string, Promise<string | null>>()

/** The favicon or app icon found in the project's folder, or null. */
function useProjectIcon(project: Project): string | null {
  const key = project.path ? `${project.id}:${project.path}` : null
  const [icon, setIcon] = useState<{ key: string; url: string | null } | null>(null)

  useEffect(() => {
    if (!key) return
    let cancelled = false
    let pending = projectIcons.get(key)
    if (!pending) {
      const request: Promise<string | null> = window.workbench.getProjectIcon(project.id).then(
        (url) => {
          // No icon yet: the next mount asks again (main caches the miss briefly).
          if (url === null && projectIcons.get(key) === request) projectIcons.delete(key)
          return url
        },
        () => {
          // Let the next mount try again.
          if (projectIcons.get(key) === request) projectIcons.delete(key)
          return null
        }
      )
      pending = request
      projectIcons.set(key, pending)
    }
    void pending.then((url) => {
      if (!cancelled) setIcon({ key, url })
    })
    return () => {
      cancelled = true
    }
  }, [key, project.id])

  return icon && icon.key === key ? icon.url : null
}

function ProjectColorButton({ project, blurred }: { project: Project; blurred: boolean }): React.JSX.Element {
  const { updateProject } = useWorkspace()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const colorTimer = useRef<number | undefined>(undefined)
  const color = resolveProjectColor(project)
  const icon = useProjectIcon(project)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  function placePopover(rect: DOMRect): void {
    const width = 168
    const height = 132
    const left = Math.min(rect.left, window.innerWidth - width - 8)
    const top = rect.bottom + height + 8 > window.innerHeight ? rect.top - height - 6 : rect.bottom + 6
    setPos({ top, left: Math.max(8, left) })
  }

  useEffect(() => {
    if (!open) return

    function place(): void {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (rect) placePopover(rect)
    }

    function onDown(event: MouseEvent): void {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }

    place()
    window.addEventListener('resize', place)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function setColor(next: string): Promise<void> {
    try {
      await updateProject({ id: project.id, color: next })
    } catch (caught) {
      window.alert(errorText(caught, 'Could not change the color'))
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        data-testid="project-color"
        type="button"
        className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] text-[10.5px] font-semibold text-[#141414] active:scale-95 ${
          blurred ? 'blur-[3px]' : ''
        }`}
        style={icon ? undefined : { background: color }}
        title="Change project color"
        aria-label={`Change color for ${project.name}`}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          placePopover(event.currentTarget.getBoundingClientRect())
          setOpen((current) => !current)
        }}
      >
        {icon ? (
          <img src={icon} alt="" draggable={false} className="h-full w-full rounded-[5px] object-contain" />
        ) : (
          project.name.trim().slice(0, 1).toUpperCase() || '·'
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-50 w-[168px] rounded-lg border border-line bg-surface p-2 shadow-2xl"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="grid grid-cols-5 gap-1.5">
              {PROJECT_COLORS.map((swatch) => {
                const selected = swatch === color
                return (
                  <button
                    key={swatch}
                    type="button"
                    className={`h-6 w-6 rounded-full ring-1 transition hover:scale-105 active:scale-95 ${
                      selected ? 'ring-2 ring-ink' : 'ring-white/15 hover:ring-white/40'
                    }`}
                    style={{ background: swatch }}
                    title={swatch}
                    onClick={() => {
                      window.clearTimeout(colorTimer.current)
                      void setColor(swatch)
                      setOpen(false)
                    }}
                  />
                )
              })}
            </div>
            <label className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted">
              Custom
              <input
                type="color"
                defaultValue={color}
                className="h-6 w-10 cursor-pointer rounded border border-line bg-transparent p-0"
                onChange={(event) => {
                  // The picker fires on every drag step; save once it settles.
                  const next = event.target.value
                  window.clearTimeout(colorTimer.current)
                  colorTimer.current = window.setTimeout(() => void setColor(next), 200)
                }}
              />
            </label>
          </div>,
          document.body
        )}
    </>
  )
}

function clampMenuPos(x: number, y: number, width: number, height: number): { top: number; left: number } {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    top: Math.max(8, y + height + 8 > window.innerHeight ? y - height : y)
  }
}

function ProjectRenameInput({
  project,
  onDone
}: {
  project: Project
  onDone: () => void
}): React.JSX.Element {
  const { updateProject } = useWorkspace()
  const [draft, setDraft] = useState(project.name)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const finished = useRef(false)

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  function finish(): void {
    if (finished.current) return
    finished.current = true
    onDone()
  }

  async function commit(): Promise<void> {
    if (finished.current) return
    finished.current = true
    const name = draft.trim()
    if (name && name !== project.name) {
      try {
        await updateProject({ id: project.id, name })
      } catch (caught) {
        // Keep the editor open so the name isn't lost.
        finished.current = false
        setError(errorText(caught, 'Could not rename the project'))
        return
      }
    }
    onDone()
  }

  return (
    <input
      ref={inputRef}
      autoFocus
      data-testid="rename-project"
      value={draft}
      aria-label={`Rename ${project.name}`}
      aria-invalid={error ? true : undefined}
      title={error ?? undefined}
      className={`min-w-0 flex-1 rounded-sm bg-canvas px-1 text-[12px] font-medium text-ink outline-none ring-1 ${
        error ? 'ring-danger' : 'ring-accent/60'
      }`}
      onChange={(event) => {
        setDraft(event.target.value)
        setError(null)
      }}
      onBlur={() => void commit()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void commit()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          finish()
        }
      }}
    />
  )
}

function ProjectMenu({
  project,
  pos,
  blurred,
  onRename,
  onToggleBlur,
  onClose
}: {
  project: Project
  pos: { top: number; left: number }
  blurred: boolean
  onRename: () => void
  onToggleBlur: () => void
  onClose: () => void
}): React.JSX.Element {
  const { updateProject, pickFolder, deleteProject } = useWorkspace()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(event: MouseEvent): void {
      const target = event.target as HTMLElement
      if (menuRef.current?.contains(target)) return
      if (target.closest('[data-testid="project-options"]')) return
      onClose()
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  async function changeFolder(): Promise<void> {
    onClose()
    try {
      const next = await pickFolder()
      if (next) await updateProject({ id: project.id, path: next })
    } catch (caught) {
      window.alert(errorText(caught, 'Could not change the folder'))
    }
  }

  function remove(): void {
    onClose()
    if (
      confirm(
        `Remove ${project.name} from the Workbench?\n\nIts chats are kept and come back when you add the folder again. Files on disk are not touched.`
      )
    ) {
      deleteProject(project.id).catch((caught: unknown) =>
        window.alert(errorText(caught, 'Could not remove the project'))
      )
    }
  }

  const itemClass =
    'flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12px] text-ink hover:bg-raised'

  return createPortal(
    <div
      ref={menuRef}
      data-testid="project-menu"
      role="menu"
      className="fixed z-50 min-w-[168px] rounded-lg border border-line bg-surface p-1 shadow-2xl"
      style={{ top: pos.top, left: pos.left }}
    >
      <button
        type="button"
        role="menuitem"
        data-testid="project-menu-rename"
        className={itemClass}
        onClick={() => {
          onClose()
          onRename()
        }}
      >
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="project-menu-folder"
        className={itemClass}
        onClick={() => void changeFolder()}
      >
        Change folder
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="project-menu-blur"
        className={itemClass}
        onClick={() => {
          onClose()
          onToggleBlur()
        }}
      >
        {blurred ? 'Unblur name and icon' : 'Blur name and icon'}
      </button>
      <div className="my-1 border-t border-line" />
      <button
        type="button"
        role="menuitem"
        data-testid="project-menu-delete"
        className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12px] text-danger hover:bg-raised"
        onClick={remove}
      >
        Remove from Workbench
      </button>
    </div>,
    document.body
  )
}

const WORKTREE_MARKERS = ['/.grokcode-worktrees/', '/.workbench-worktrees/']
const VISIBLE_CHATS = 5

function isWorktree(project: Project): boolean {
  return Boolean(project.path && WORKTREE_MARKERS.some((marker) => project.path!.includes(marker)))
}

/** Worktrees live at `<dir>/.workbench-worktrees/<repo>-<id>` next to `<dir>/<repo>`. */
function worktreeParent(project: Project, projects: Project[]): Project | null {
  const path = project.path ?? ''
  const repo = (path.split('/').pop() ?? project.name).replace(/-[0-9a-f]{6,}$/i, '')
  const marker = WORKTREE_MARKERS.find((item) => path.includes(item))
  const parentPath = marker ? `${path.slice(0, path.indexOf(marker))}/${repo}` : null
  return projects.find((item) => item.path === parentPath) ?? null
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(0, (Date.now() - then) / 1000)
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

function initials(text: string): string {
  const words = text
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (words.length === 0) return '·'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function KeyHint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="shrink-0 rounded-[4px] border border-line px-1 font-sans text-[10.5px] leading-4 text-faint">
      {children}
    </kbd>
  )
}

function SectionLabel({
  label,
  onAdd,
  addLabel,
  addTestId,
  open,
  onToggle
}: {
  label: string
  onAdd?: () => void
  addLabel?: string
  addTestId?: string
  /** With onToggle, the label folds the section open and shut. */
  open?: boolean
  onToggle?: () => void
}): React.JSX.Element {
  return (
    <div className="mt-3 mb-1 flex h-6 items-center justify-between pr-1 pl-2">
      {onToggle ? (
        <button
          className="flex items-center gap-1 text-[11px] font-semibold text-faint hover:text-ink"
          aria-expanded={open}
          title={open ? `Collapse ${label.toLowerCase()}` : `Expand ${label.toLowerCase()}`}
          onClick={onToggle}
        >
          {label}
          <Icon
            name="chevron"
            size={10}
            strokeWidth={1.6}
            className={`transition-transform ${open ? 'rotate-90' : ''}`}
          />
        </button>
      ) : (
        <span className="text-[11px] font-semibold text-faint">{label}</span>
      )}
      {onAdd && <IconButton icon="plus" label={addLabel ?? 'Add'} size={22} onClick={onAdd} testId={addTestId} />}
    </div>
  )
}

/** "5m" / "3h" / "2d" until a scheduled run. */
function untilTime(iso: string): string {
  const minutes = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function scheduleTitle(schedule: NonNullable<ChatSummary['schedule']>): string {
  const when = schedule.cron ? `Repeats: ${schedule.cron}` : 'Runs once'
  const next = schedule.nextRunAt ? `\nNext run: ${new Date(schedule.nextRunAt).toLocaleString()}` : ''
  return `${when}${next}\n\n${schedule.prompt}`
}

function ChatRow({
  chat,
  project,
  worktreeBranch
}: {
  chat: ChatSummary
  /** None for a bot's chat. */
  project?: Project
  /** Branch of the worktree project this chat runs in, when it is folded under its parent. */
  worktreeBranch?: string | null
}): React.JSX.Element {
  const { activeChatId, openChat, deleteChat } = useWorkspace()
  const streaming = useStreamStatuses()[chat.id]?.status === 'streaming'
  const active = activeChatId === chat.id
  const branch = chat.worktreeBranch ?? worktreeBranch ?? null
  return (
    <div className="relative">
      {active && <span className="absolute top-1 bottom-1 -left-[9px] w-[2px] rounded-full bg-accent" />}
      <div
        className={`group flex h-[30px] items-center rounded-[7px] ${
          active
            ? 'bg-raised text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)]'
            : 'text-ink-2 hover:bg-hover hover:text-ink'
        }`}
      >
        <button
          className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left"
          title={chat.title}
          data-project={project?.id}
          onClick={() => void openChat(chat.id)}
        >
          <span className="truncate text-[12.5px]">{chat.title}</span>
          {chat.agent === 'claude' && (
            <span data-testid="chat-agent-tag" className="shrink-0 text-[10.5px] text-faint">
              Claude
            </span>
          )}
          {branch && (
            <span
              className="min-w-0 shrink truncate font-mono text-[10.5px] text-faint"
              title={chat.worktreePath || branch}
            >
              {branch.replace(/^workbench\//, '')}
            </span>
          )}
        </button>
        <span className={`flex ${chat.schedule ? 'w-14' : 'w-9'} shrink-0 items-center justify-end pr-2`}>
          {streaming ? (
            <span className="streaming-dot h-1.5 w-1.5 rounded-full bg-accent" title="Working" />
          ) : chat.schedule?.nextRunAt ? (
            <span
              data-testid="chat-schedule"
              className="flex items-center gap-0.5 text-[11px] text-faint tabular-nums group-hover:hidden group-focus-within:hidden"
              title={scheduleTitle(chat.schedule)}
            >
              <Icon name="clock" size={11} />
              {untilTime(chat.schedule.nextRunAt)}
            </span>
          ) : (
            <span className="text-[11px] text-faint tabular-nums group-hover:hidden group-focus-within:hidden">
              {relativeTime(chat.updatedAt)}
            </span>
          )}
          {!streaming && chat.schedule && (
            <button
              className="hidden h-5 w-5 items-center justify-center rounded text-muted group-hover:flex group-focus-within:flex hover:text-danger"
              title="Stop schedule"
              aria-label={`Stop the schedule of ${chat.title}`}
              onClick={() => {
                if (confirm('Stop this schedule? The chat stays.')) void window.workbench.stopSchedule(chat.id)
              }}
            >
              <Icon name="clock" size={12} />
            </button>
          )}
          {!streaming && (
            <button
              className="hidden h-5 w-5 items-center justify-center rounded text-muted group-hover:flex group-focus-within:flex hover:text-danger"
              title="Delete chat"
              aria-label={`Delete ${chat.title}`}
              onClick={() => {
                if (
                  confirm(
                    chat.worktreePath
                      ? 'Delete this chat?\n\nIts worktree is removed only if it has no uncommitted changes. Its branch is kept.'
                      : 'Delete this chat?'
                  )
                )
                  deleteChat(chat.id).catch((caught: unknown) =>
                    window.alert(errorText(caught, 'Could not delete the chat'))
                  )
              }}
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </span>
      </div>
    </div>
  )
}

export function Sidebar(): React.JSX.Element | null {
  const {
    projects,
    chats,
    activeProjectId,
    settings,
    selectProject,
    createChat,
    setShowNewProject,
    setShowSettings,
    gitSummaries,
    showSidebar,
    setShowSidebar,
    activeBotId,
    openBot
  } = useWorkspace()
  const { bots, createBot } = useBots()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readFlags(COLLAPSED_KEY))
  // Names hidden for screen recordings; kept across restarts.
  const [blurred, setBlurred] = useState<Record<string, boolean>>(() => readFlags(BLURRED_KEY))
  const [botsCollapsed, setBotsCollapsed] = useState(() => localStorage.getItem(BOTS_COLLAPSED_KEY) === 'true')
  const [width, setWidth] = useState(readWidth)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ projectId: string; top: number; left: number } | null>(null)
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const [resizing, setResizing] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width))
  }, [width])

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
  }, [collapsed])

  useEffect(() => {
    localStorage.setItem(BOTS_COLLAPSED_KEY, String(botsCollapsed))
  }, [botsCollapsed])

  useEffect(() => {
    localStorage.setItem(BLURRED_KEY, JSON.stringify(blurred))
  }, [blurred])

  const newChatProjectId = activeProjectId ?? projects[0]?.id ?? null

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (!event.metaKey && !event.ctrlKey) return
      if (event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key === 'k') {
        event.preventDefault()
        setShowSidebar(true)
        requestAnimationFrame(() => searchRef.current?.focus())
      } else if (key === 'n' && newChatProjectId) {
        event.preventDefault()
        void createChat(newChatProjectId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [createChat, newChatProjectId, setShowSidebar])

  function toggleProject(projectId: string): void {
    setCollapsed((current) => ({ ...current, [projectId]: !current[projectId] }))
  }

  function expandProject(projectId: string): void {
    setCollapsed((current) => {
      if (!current[projectId]) return current
      return { ...current, [projectId]: false }
    })
  }

  function openMenu(projectId: string, x: number, y: number): void {
    setMenu({ projectId, ...clampMenuPos(x, y, 168, 144) })
  }

  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    setResizing(true)

    function onMove(move: PointerEvent): void {
      const next = startWidth + (move.clientX - startX)
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)))
    }

    function onUp(): void {
      setResizing(false)
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      target.removeEventListener('lostpointercapture', onUp)
    }

    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
    target.addEventListener('lostpointercapture', onUp)
  }

  // A worktree folds into its parent project: its chats list there, and the Git window shows the worktree.
  const ownerOf = useMemo(() => {
    const owner: Record<string, string> = {}
    for (const project of projects) {
      owner[project.id] = (isWorktree(project) && worktreeParent(project, projects)?.id) || project.id
    }
    return owner
  }, [projects])

  const chatsByProject = useMemo(() => {
    const grouped: Record<string, typeof chats> = {}
    for (const chat of chats) {
      // A bot's chats are reached from the bot's window.
      if (chat.botId) continue
      const owner = ownerOf[chat.projectId] ?? chat.projectId
      grouped[owner] ??= []
      grouped[owner].push(chat)
    }
    return grouped
  }, [chats, ownerOf])

  const needle = query.trim().toLowerCase()

  // Chats whose messages mention the query, looked up once typing pauses.
  const [contentHits, setContentHits] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!needle) {
      setContentHits(new Set())
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void window.workbench.searchChats(needle).then((ids) => {
        if (live) setContentHits(new Set(ids))
      })
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [needle])

  // While searching, a project shows when its name matches or when any of its chats does.
  const filtered = useMemo(() => {
    return projects
      .filter((project) => ownerOf[project.id] === project.id)
      .map((project) => {
        const all = chatsByProject[project.id] ?? []
        if (!needle) return { project, chats: all }
        const nameHit = project.name.toLowerCase().includes(needle)
        const hits = all.filter((chat) => chat.title.toLowerCase().includes(needle) || contentHits.has(chat.id))
        if (!nameHit && hits.length === 0) return null
        return { project, chats: nameHit && hits.length === 0 ? all : hits }
      })
      .filter((item): item is { project: Project; chats: ChatSummary[] } => item !== null)
  }, [projects, ownerOf, chatsByProject, needle, contentHits])

  // A bot's scheduled chats list under the bot; its other chats are reached from the bot's window.
  const schedulesByBot = useMemo(() => {
    const grouped: Record<string, ChatSummary[]> = {}
    for (const chat of chats) {
      if (!chat.botId || !chat.schedule) continue
      grouped[chat.botId] ??= []
      grouped[chat.botId].push(chat)
    }
    return grouped
  }, [chats])

  // While searching, a bot shows when its name matches or when any of its scheduled chats does.
  const shownBots = bots
    .map((bot) => {
      const all = schedulesByBot[bot.id] ?? []
      if (!needle) return { bot, schedules: all }
      const nameHit = bot.name.toLowerCase().includes(needle)
      const hits = all.filter((chat) => chat.title.toLowerCase().includes(needle) || contentHits.has(chat.id))
      if (!nameHit && hits.length === 0) return null
      return { bot, schedules: nameHit && hits.length === 0 ? all : hits }
    })
    .filter((item): item is { bot: (typeof bots)[number]; schedules: ChatSummary[] } => item !== null)

  const menuProject = menu ? (projects.find((item) => item.id === menu.projectId) ?? null) : null

  if (!showSidebar) return null

  const account = settings?.claude.email ?? null
  const plans = [
    settings?.grokBuildSignedIn ? 'SuperGrok' : settings?.hasKey ? 'xAI API key' : null,
    settings?.claude.signedIn
      ? `Claude${settings.claude.subscription ? ` ${settings.claude.subscription}` : ''} connected`
      : null
  ].filter(Boolean)
  const accountName = account ?? (plans.length ? 'Signed in' : 'Not signed in')
  // A search shows matching bots even in a collapsed section, as it does in a collapsed project.
  const botsOpen = Boolean(needle) || !botsCollapsed

  function renderProject(project: Project, projectChats: ChatSummary[]): React.JSX.Element {
    // Only a worktree whose parent project is not in the sidebar still shows as its own row.
    const worktree = isWorktree(project)
    const open = needle ? true : !collapsed[project.id]
    const selected = activeProjectId != null && ownerOf[activeProjectId] === project.id
    const git = gitSummaries[project.id]
    const branch = git?.available ? (git.branch ?? 'HEAD') : null
    const limit = showAll[project.id] || needle ? projectChats.length : VISIBLE_CHATS
    const shown = projectChats.slice(0, limit)
    const hidden = projectChats.length - shown.length
    const nameBlurred = Boolean(blurred[project.id])
    return (
      <div key={project.id} className="mb-px">
        <div
          className={`group flex h-[30px] items-center gap-1.5 rounded-[7px] pr-1 ${
            selected && !open ? 'bg-hover' : 'hover:bg-hover'
          }`}
          onContextMenu={(event) => {
            event.preventDefault()
            openMenu(project.id, event.clientX, event.clientY)
          }}
        >
          <button
            className="flex h-[30px] w-5 shrink-0 items-center justify-center rounded-sm pl-1 text-faint hover:text-ink"
            aria-expanded={open}
            title={open ? 'Collapse project' : 'Expand project'}
            onClick={() => toggleProject(project.id)}
          >
            <Icon
              name="chevron"
              size={12}
              strokeWidth={1.6}
              className={`transition-transform ${open ? 'rotate-90' : ''}`}
            />
          </button>
          {worktree ? (
            <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-faint">
              <Icon name="branch" size={13} />
            </span>
          ) : (
            <ProjectColorButton project={project} blurred={nameBlurred} />
          )}
          {renamingId === project.id ? (
            <ProjectRenameInput project={project} onDone={() => setRenamingId(null)} />
          ) : (
            <button
              className="flex h-full min-w-0 flex-1 items-center text-left"
              title={nameBlurred ? undefined : worktree ? `${project.name} · ${project.path ?? ''}` : project.name}
              onClick={() => {
                selectProject(project.id)
                expandProject(project.id)
              }}
              onDoubleClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setRenamingId(project.id)
              }}
            >
              <span
                data-testid={nameBlurred ? 'project-name-blurred' : undefined}
                className={`truncate text-[13px] ${
                  worktree ? 'text-muted' : open ? 'font-medium text-ink' : 'text-ink-2'
                } ${nameBlurred ? 'blur-[5px] select-none' : ''}`}
              >
                {project.name}
              </span>
            </button>
          )}
          <span className="flex min-w-0 shrink items-center group-hover:hidden group-focus-within:hidden">
            {open && !worktree && projectChats.length > 0 ? (
              <span className="rounded-full bg-raised px-1.5 text-[10.5px] leading-4 text-muted tabular-nums">
                {projectChats.length}
              </span>
            ) : branch ? (
              <span className="max-w-[110px] truncate pr-1 font-mono text-[10.5px] text-faint" title={branch}>
                {branch}
              </span>
            ) : null}
          </span>
          <span className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
            <IconButton
              icon="plus"
              label="New chat"
              size={24}
              onClick={() => {
                expandProject(project.id)
                void createChat(project.id)
              }}
            />
            <IconButton
              icon="more"
              label="Project options"
              size={24}
              testId="project-options"
              onClick={(event) => {
                event.stopPropagation()
                if (menu?.projectId === project.id) {
                  setMenu(null)
                  return
                }
                const rect = event.currentTarget.getBoundingClientRect()
                openMenu(project.id, rect.left, rect.bottom + 4)
              }}
            />
          </span>
        </div>
        {open && (
          <div className="mb-1 pl-[26px]">
            {!worktree && (
              <div className="mb-0.5 pl-[24px]">
                <IndexStatus projectId={project.id} compact />
              </div>
            )}
            <div className="ml-[9px] border-l border-line pl-2">
              {projectChats.length === 0 ? (
                <button
                  className="flex h-[30px] w-full items-center rounded-[7px] px-2 text-left text-[12.5px] text-faint hover:bg-hover hover:text-ink"
                  onClick={() => void createChat(project.id)}
                >
                  No chats yet · start one
                </button>
              ) : (
                shown.map((chat) => (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    project={project}
                    worktreeBranch={chat.projectId === project.id ? null : gitSummaries[chat.projectId]?.branch}
                  />
                ))
              )}
              {hidden > 0 && (
                <button
                  className="flex h-7 w-full items-center rounded-[7px] px-2 text-left text-[12px] text-faint hover:bg-hover hover:text-muted"
                  onClick={() => setShowAll((current) => ({ ...current, [project.id]: true }))}
                >
                  Show {hidden} more
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <aside className="relative flex h-full shrink-0 flex-col border-r border-line bg-sidebar" style={{ width }}>
      <header className="drag flex h-titlebar shrink-0 items-center gap-2 border-b border-line pl-traffic pr-2">
        <img
          src={wordmark}
          alt="Datapad Workbench"
          draggable={false}
          className="h-5 min-w-0 shrink translate-y-px object-contain object-left"
        />
        <div className="flex-1" />
        <IconButton icon="sidebar" label="Hide sidebar" onClick={() => setShowSidebar(false)} />
      </header>

      <div className="no-drag shrink-0 px-2 pt-3">
        <label className="flex h-8 items-center gap-2 rounded-[8px] border border-line bg-surface px-2.5 text-faint focus-within:border-line-strong">
          <Icon name="search" size={13} />
          <input
            ref={searchRef}
            data-testid="sidebar-search"
            value={query}
            placeholder="Search projects, chats and messages"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-faint"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('')
                event.currentTarget.blur()
              }
            }}
          />
          {query ? (
            <button className="text-faint hover:text-ink" aria-label="Clear search" onClick={() => setQuery('')}>
              <Icon name="close" size={12} />
            </button>
          ) : (
            <KeyHint>⌘K</KeyHint>
          )}
        </label>
        <button
          data-testid="sidebar-new-chat"
          className="mt-2 flex h-[30px] w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-50"
          disabled={!newChatProjectId}
          onClick={() => {
            if (!newChatProjectId) return
            expandProject(newChatProjectId)
            void createChat(newChatProjectId)
          }}
        >
          <Icon name="plus" size={13} className="text-muted" />
          <span className="flex-1">New chat</span>
          <KeyHint>⌘N</KeyHint>
        </button>
      </div>

      <div className="no-drag min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SectionLabel
          label="Bots"
          onAdd={() =>
            void createBot('New bot')
              .then((bot) => {
                setBotsCollapsed(false)
                openBot(bot.id)
              })
              .catch((caught: unknown) => window.alert(errorText(caught, 'Could not create the bot')))
          }
          addLabel="New bot"
          addTestId="new-bot"
          open={botsOpen}
          onToggle={() => setBotsCollapsed((current) => !current)}
        />
        {!botsOpen ? null : bots.length === 0 ? (
          <div className="px-2 pb-1 text-[12px] text-faint">No bots yet.</div>
        ) : (
          shownBots.map(({ bot, schedules }) => {
            const active = activeBotId === bot.id
            const unread = bot.unread ?? 0
            const open = schedules.length > 0 && (needle ? true : !collapsed[bot.id])
            return (
              <div key={bot.id} className="mb-px">
                <div
                  className={`flex h-[30px] items-center gap-1.5 rounded-[7px] pr-2 ${
                    active
                      ? 'bg-raised text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)]'
                      : 'text-ink-2 hover:bg-hover hover:text-ink'
                  }`}
                >
                  {schedules.length > 0 ? (
                    <button
                      data-testid="bot-schedules-toggle"
                      className="flex h-[30px] w-5 shrink-0 items-center justify-center rounded-sm pl-1 text-faint hover:text-ink"
                      aria-expanded={open}
                      title={open ? 'Hide schedules' : 'Show schedules'}
                      onClick={() => toggleProject(bot.id)}
                    >
                      <Icon
                        name="chevron"
                        size={12}
                        strokeWidth={1.6}
                        className={`transition-transform ${open ? 'rotate-90' : ''}`}
                      />
                    </button>
                  ) : (
                    <span className="w-5 shrink-0" />
                  )}
                  <button
                    data-testid="bot-row"
                    className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
                    title={bot.name}
                    onClick={() => openBot(bot.id)}
                  >
                    <BotAvatar bot={bot} size={18} />
                    <span className="truncate text-[13px]">{bot.name}</span>
                    {unread > 0 && (
                      <span
                        data-testid="bot-unread"
                        className="ml-auto flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-[5px] text-[11px] font-bold text-accent-ink tabular-nums"
                        title={`${unread} new`}
                      >
                        {unread}
                      </span>
                    )}
                  </button>
                </div>
                {open && (
                  <div className="mb-1 pl-[26px]">
                    <div className="ml-[9px] border-l border-line pl-2">
                      {schedules.map((chat) => (
                        <ChatRow key={chat.id} chat={chat} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
        <SectionLabel
          label="Projects"
          onAdd={() => setShowNewProject(true)}
          addLabel="New project"
          addTestId="new-project"
        />
        {projects.length === 0 ? (
          <button
            className="w-full rounded-[8px] border border-dashed border-line px-3 py-5 text-left text-[12.5px] leading-5 text-muted transition hover:border-line-strong hover:text-ink"
            onClick={() => setShowNewProject(true)}
          >
            Add a project folder to start chatting.
          </button>
        ) : filtered.length === 0 ? (
          <div className="px-2 py-2 text-[12.5px] text-faint">Nothing matches “{query.trim()}”.</div>
        ) : (
          filtered.map((item) => renderProject(item.project, item.chats))
        )}
      </div>

      <div className="no-drag flex h-14 shrink-0 items-center gap-2.5 border-t border-line px-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
          {initials(account ?? 'Workbench')}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink" title={accountName}>
            {accountName}
          </div>
          <div className="truncate text-[11px] text-faint" title={plans.join(' · ')}>
            {plans.length ? plans.join(' · ') : 'Open settings to sign in'}
          </div>
        </div>
        <IconButton icon="gear" label="Settings" testId="open-settings" onClick={() => setShowSettings(true)} />
      </div>
      <div
        className={`no-drag absolute top-0 -right-[3px] z-20 h-full w-1.5 cursor-col-resize after:absolute after:inset-y-0 after:left-[2px] after:w-px hover:after:bg-accent-line ${
          resizing ? 'after:bg-accent-line' : ''
        }`}
        onPointerDown={startResize}
      />
      {menu && menuProject && (
        <ProjectMenu
          project={menuProject}
          pos={{ top: menu.top, left: menu.left }}
          blurred={Boolean(blurred[menuProject.id])}
          onRename={() => setRenamingId(menuProject.id)}
          onToggleBlur={() => setBlurred((current) => ({ ...current, [menuProject.id]: !current[menuProject.id] }))}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  )
}
