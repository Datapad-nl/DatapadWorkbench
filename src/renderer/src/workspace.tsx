import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type {
  Attachment,
  Chat,
  ChatAgent,
  ChatContext,
  ChatEvent,
  ChatLiveState,
  ChatSummary,
  FileMention,
  GitSummary,
  IndexEvent,
  OrientationCard,
  PermissionMode,
  PermissionRequest,
  PlanVerdict,
  Project,
  UserQuestionRequest,
  ProjectIndex,
  PublicSettings,
  UpdateProjectInput,
  VoiceSettings,
  WorkspaceSnapshot
} from '../../shared/types'
import { normalizePermissionMode } from '../../shared/types'
import { streamStatuses, type StreamStatus } from './streamStatus'

type StreamState = {
  status: 'idle' | 'streaming' | 'error'
  draft: string
  error: string | null
  /** The turn this state belongs to. Events from an older turn are dropped. */
  turnId: number | null
}

type Pending = { requestId: string; chatId: string }

/** Requests waiting per chat, oldest first. */
function groupByChat<T extends Pending>(items: T[]): Record<string, T[]> {
  const out: Record<string, T[]> = {}
  for (const item of items) (out[item.chatId] ??= []).push(item)
  return out
}

function pushRequest<T extends Pending>(current: Record<string, T[]>, request: T): Record<string, T[]> {
  const queue = current[request.chatId] ?? []
  // The same request again is the card changing, such as an edit that now waits for another chat.
  if (queue.some((item) => item.requestId === request.requestId)) {
    return { ...current, [request.chatId]: queue.map((item) => (item.requestId === request.requestId ? request : item)) }
  }
  return { ...current, [request.chatId]: [...queue, request] }
}

function dropRequest<T extends Pending>(
  current: Record<string, T[]>,
  chatId: string,
  requestId: string
): Record<string, T[]> {
  const queue = current[chatId]
  if (!queue?.some((item) => item.requestId === requestId)) return current
  const next = { ...current }
  const rest = queue.filter((item) => item.requestId !== requestId)
  if (rest.length > 0) next[chatId] = rest
  else delete next[chatId]
  return next
}

/** The request each chat shows now: the oldest one still waiting. */
function heads<T>(queues: Record<string, T[]>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [chatId, queue] of Object.entries(queues)) if (queue[0]) out[chatId] = queue[0]
  return out
}

function omitKeys<T>(current: Record<string, T>, ids: string[]): Record<string, T> {
  if (!ids.some((id) => id in current)) return current
  const next = { ...current }
  for (const id of ids) delete next[id]
  return next
}

/** A saved copy of a chat has an aside reply that is still streaming as empty. Keep the text shown so far. */
function keepAsideText(prev: Chat | undefined, next: Chat, live: Set<string>): Chat {
  if (!prev || live.size === 0) return next
  const shown = new Map(
    prev.messages.filter((message) => live.has(message.id) && message.content).map((m) => [m.id, m.content])
  )
  if (shown.size === 0) return next
  return {
    ...next,
    messages: next.messages.map((message) =>
      !message.content && shown.has(message.id) ? { ...message, content: shown.get(message.id) ?? '' } : message
    )
  }
}

type WorkspaceContextValue = {
  projects: Project[]
  chats: ChatSummary[]
  settings: PublicSettings | null
  indexes: Record<string, ProjectIndex>
  openChatIds: string[]
  activeChatId: string | null
  activeProjectId: string | null
  chatsById: Record<string, Chat>
  showNewProject: boolean
  /** `'mcp'` opens Settings on the MCP tab. */
  showSettings: boolean | 'mcp'
  showUsage: boolean
  showActivity: boolean
  showBrowser: boolean
  showGit: boolean
  showKnowledge: boolean
  showSidebar: boolean
  gitSummaries: Record<string, GitSummary>
  /** How full each chat's context window is, as its agent last reported it. */
  contexts: Record<string, ChatContext>
  rightPaneOrder: RightPaneId[]
  setShowNewProject: (open: boolean) => void
  setShowSettings: (open: boolean | 'mcp') => void
  setShowUsage: (open: boolean) => void
  setShowActivity: (open: boolean) => void
  setShowBrowser: (open: boolean) => void
  setShowGit: (open: boolean) => void
  setShowKnowledge: (open: boolean) => void
  setShowSidebar: (open: boolean) => void
  swapRightPanes: () => void
  selectProject: (projectId: string) => void
  openChat: (chatId: string) => Promise<void>
  closeTab: (chatId: string) => void
  createProject: (name: string, path: string | null) => Promise<void>
  updateProject: (input: UpdateProjectInput) => Promise<void>
  pickFolder: () => Promise<string | null>
  deleteProject: (projectId: string) => Promise<void>
  indexProject: (projectId: string) => Promise<void>
  getOrientation: (projectId: string) => Promise<OrientationCard>
  createChat: (projectId: string) => Promise<void>
  deleteChat: (chatId: string) => Promise<void>
  renameChat: (chatId: string, title: string) => Promise<void>
  setChatAgent: (chatId: string, agent: ChatAgent) => Promise<void>
  sendMessage: (
    chatId: string,
    content: string,
    attachments?: Attachment[],
    mentions?: FileMention[],
    conversation?: string
  ) => Promise<boolean>
  stopChat: (chatId: string) => Promise<void>
  setChatMode: (chatId: string, mode: PermissionMode) => Promise<void>
  approvePlan: (chatId: string, verdict?: PlanVerdict) => Promise<void>
  resolvePermission: (requestId: string, decision: 'allow' | 'deny' | 'wait') => Promise<void>
  resolveQuestion: (
    requestId: string,
    decision: { type: 'skip' } | { type: 'submit'; answers: string[][] }
  ) => Promise<void>
  rewindChat: (chatId: string, checkpointId: string) => Promise<void>
  permissions: Record<string, PermissionRequest>
  questions: Record<string, UserQuestionRequest>
  saveSettings: (input: {
    apiKey?: string
    model?: string
    effort?: string | null
    voice?: Partial<VoiceSettings>
    defaultAgent?: ChatAgent
    claudeModel?: string
    orchestratorModel?: string
    subagentModel?: string
    maxSubagents?: number
  }) => Promise<void>
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)
const StreamContext = createContext<Record<string, StreamState> | null>(null)
const StreamStatusContext = createContext<Record<string, StreamStatus> | null>(null)

const emptyStream: StreamState = { status: 'idle', draft: '', error: null, turnId: null }

export type RightPaneId = 'git' | 'browser' | 'activity' | 'knowledge'

const SESSION_KEY = 'workbench.session'
const PANE_ORDER_KEY = 'workbench.rightPaneOrder'
const DEFAULT_PANE_ORDER: RightPaneId[] = ['git', 'browser', 'activity', 'knowledge']

function isPaneId(value: string): value is RightPaneId {
  return value === 'git' || value === 'browser' || value === 'activity' || value === 'knowledge'
}

function readPaneOrder(): RightPaneId[] {
  try {
    const raw = localStorage.getItem(PANE_ORDER_KEY)
    if (!raw) return DEFAULT_PANE_ORDER
    const parsed = raw.split(',').filter(isPaneId)
    const missing = DEFAULT_PANE_ORDER.filter((id) => !parsed.includes(id))
    return parsed.length > 0 ? [...parsed, ...missing] : DEFAULT_PANE_ORDER
  } catch {
    return DEFAULT_PANE_ORDER
  }
}

type UiSession = {
  openChatIds: string[]
  activeChatId: string | null
  activeProjectId: string | null
}

function readSession(): UiSession {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_KEY) ?? '') as Partial<UiSession>
    return {
      // Older builds could save a tab twice.
      openChatIds: Array.isArray(parsed.openChatIds)
        ? [...new Set(parsed.openChatIds.filter((id): id is string => typeof id === 'string'))]
        : [],
      activeChatId: typeof parsed.activeChatId === 'string' ? parsed.activeChatId : null,
      activeProjectId: typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : null
    }
  } catch {
    return { openChatIds: [], activeChatId: null, activeProjectId: null }
  }
}

/** Settings read while the CLI probes ran must not hide what a `settings:changed` push already told us. */
function keepCliInfo(current: PublicSettings | null, next: PublicSettings): PublicSettings {
  if (!next.cliChecking || !current || current.cliChecking) return next
  return { ...next, grokCli: current.grokCli, claude: current.claude, cliChecking: false }
}

function applySnapshot(
  snapshot: WorkspaceSnapshot,
  setProjects: (projects: Project[]) => void,
  setChats: (chats: ChatSummary[]) => void,
  setSettings: React.Dispatch<React.SetStateAction<PublicSettings | null>>,
  setIndexes: (indexes: Record<string, ProjectIndex>) => void
): void {
  setProjects(snapshot.projects)
  setChats(snapshot.chats)
  setSettings((current) => keepCliInfo(current, snapshot.settings))
  setIndexes(snapshot.indexes ?? {})
}

export function WorkspaceProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [indexes, setIndexes] = useState<Record<string, ProjectIndex>>({})
  const [openChatIds, setOpenChatIds] = useState<string[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const activeChatIdRef = useRef(activeChatId)
  activeChatIdRef.current = activeChatId
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [chatsById, setChatsById] = useState<Record<string, Chat>>({})
  const chatsByIdRef = useRef(chatsById)
  chatsByIdRef.current = chatsById
  const openChatIdsRef = useRef(openChatIds)
  openChatIdsRef.current = openChatIds
  const [streams, setStreams] = useState<Record<string, StreamState>>({})
  // Follows `streams`, but stays the same object while only reply text arrives.
  const [statuses, setStatuses] = useState<Record<string, StreamStatus>>({})
  const nextStatuses = streamStatuses(statuses, streams)
  if (nextStatuses !== statuses) setStatuses(nextStatuses)
  const sending = useRef(new Set<string>())
  const approving = useRef(new Set<string>())
  const openChatRef = useRef<((chatId: string) => Promise<void>) | null>(null)
  /** The newest turn main told us about per chat, updated as events arrive (state lags a render). */
  const turnsRef = useRef<Record<string, { turnId: number; live: boolean }>>({})
  const deltaBuf = useRef<Record<string, { turnId: number; text: string }>>({})
  /** Aside text not yet shown, by the message it streams into. */
  const asideBuf = useRef<Record<string, { chatId: string; text: string }>>({})
  /** Aside messages still streaming. A saved chat has them empty until the aside ends. */
  const liveAsides = useRef(new Set<string>())
  const streamFlush = useRef(0)

  const flushStreamBuf = useCallback(() => {
    if (streamFlush.current) {
      window.clearTimeout(streamFlush.current)
      streamFlush.current = 0
    }
    const deltas = deltaBuf.current
    deltaBuf.current = {}
    const asides = asideBuf.current
    asideBuf.current = {}
    const deltaIds = Object.keys(deltas)
    if (deltaIds.length > 0) {
      setStreams((current) => {
        let next = current
        for (const chatId of deltaIds) {
          const { turnId, text } = deltas[chatId]
          if (!text) continue
          const prev = next[chatId] ?? emptyStream
          if (prev.turnId !== null && turnId < prev.turnId) continue
          // This turn already ended here; its last text came with done.
          if (prev.turnId === turnId && prev.status !== 'streaming') continue
          if (next === current) next = { ...current }
          next[chatId] = {
            status: 'streaming',
            draft: prev.turnId === turnId ? prev.draft + text : text,
            // A steer that failed during this turn keeps its message; a new turn clears it.
            error: prev.turnId === turnId ? prev.error : null,
            turnId
          }
        }
        return next
      })
    }
    const byChat = new Map<string, Map<string, string>>()
    for (const [messageId, pending] of Object.entries(asides)) {
      if (!pending.text) continue
      const texts = byChat.get(pending.chatId) ?? new Map<string, string>()
      texts.set(messageId, pending.text)
      byChat.set(pending.chatId, texts)
    }
    if (byChat.size > 0) {
      setChatsById((current) => {
        let next = current
        for (const [chatId, texts] of byChat) {
          const chat = next[chatId]
          if (!chat) continue
          if (next === current) next = { ...current }
          next[chatId] = {
            ...chat,
            messages: chat.messages.map((message) => {
              const text = texts.get(message.id)
              return text ? { ...message, content: message.content + text } : message
            })
          }
        }
        return next
      })
    }
  }, [])

  const queueStreamFlush = useCallback(() => {
    if (streamFlush.current) return
    streamFlush.current = window.setTimeout(flushStreamBuf, 50)
  }, [flushStreamBuf])

  const applyChat = useCallback((chatId: string, chat: Chat) => {
    setChatsById((current) => ({
      ...current,
      [chatId]: keepAsideText(current[chatId], chat, liveAsides.current)
    }))
  }, [])

  const [permissionQueues, setPermissionQueues] = useState<Record<string, PermissionRequest[]>>({})
  const [questionQueues, setQuestionQueues] = useState<Record<string, UserQuestionRequest[]>>({})
  const [contexts, setContexts] = useState<Record<string, ChatContext>>({})
  const permissions = useMemo(() => heads(permissionQueues), [permissionQueues])
  const questions = useMemo(() => heads(questionQueues), [questionQueues])

  /**
   * Takes main's own list of waiting prompts, and with `withTurns` its running turns too.
   * Replies come after every event sent before them, so the list replaces ours as it is.
   */
  const syncLive = useCallback(
    async (withTurns = false) => {
      let state: ChatLiveState
      try {
        state = await window.workbench.getLiveState()
      } catch {
        return
      }
      setPermissionQueues(groupByChat(state.permissions))
      setQuestionQueues(groupByChat(state.questions))
      setContexts(state.contexts ?? {})
      if (!withTurns || state.turns.length === 0) return
      flushStreamBuf()
      for (const turn of state.turns) {
        const known = turnsRef.current[turn.chatId]
        if (!known || turn.turnId >= known.turnId) {
          turnsRef.current[turn.chatId] = { turnId: turn.turnId, live: true }
        }
      }
      setStreams((current) => {
        const next = { ...current }
        for (const turn of state.turns) {
          const prev = current[turn.chatId]
          if (prev?.turnId != null && prev.turnId > turn.turnId) continue
          next[turn.chatId] = { status: 'streaming', draft: turn.draft, error: null, turnId: turn.turnId }
        }
        return next
      })
    },
    [flushStreamBuf]
  )
  const [showNewProject, setShowNewProject] = useState(false)
  const [showSettings, setShowSettings] = useState<boolean | 'mcp'>(false)
  const [showUsage, setShowUsage] = useState(false)
  const [showActivity, setShowActivityState] = useState(() => {
    return localStorage.getItem('workbench.showActivity') === '1'
  })
  const setShowActivity = useCallback((open: boolean) => {
    setShowActivityState(open)
    localStorage.setItem('workbench.showActivity', open ? '1' : '0')
  }, [])
  const [showBrowser, setShowBrowserState] = useState(() => {
    return localStorage.getItem('workbench.showBrowser') === '1'
  })
  const setShowBrowser = useCallback((open: boolean) => {
    setShowBrowserState(open)
    localStorage.setItem('workbench.showBrowser', open ? '1' : '0')
  }, [])
  const [showGit, setShowGitState] = useState(() => {
    return localStorage.getItem('workbench.showGit') === '1'
  })
  const setShowGit = useCallback((open: boolean) => {
    setShowGitState(open)
    localStorage.setItem('workbench.showGit', open ? '1' : '0')
  }, [])
  const [showKnowledge, setShowKnowledgeState] = useState(() => {
    return localStorage.getItem('workbench.showKnowledge') === '1'
  })
  const setShowKnowledge = useCallback((open: boolean) => {
    setShowKnowledgeState(open)
    localStorage.setItem('workbench.showKnowledge', open ? '1' : '0')
  }, [])
  const [showSidebar, setShowSidebarState] = useState(() => {
    return localStorage.getItem('workbench.showSidebar') !== '0'
  })
  const setShowSidebar = useCallback((open: boolean) => {
    setShowSidebarState(open)
    localStorage.setItem('workbench.showSidebar', open ? '1' : '0')
  }, [])
  const [gitSummaries, setGitSummaries] = useState<Record<string, GitSummary>>({})
  const [rightPaneOrder, setRightPaneOrder] = useState<RightPaneId[]>(readPaneOrder)
  const swapRightPanes = useCallback(() => {
    setRightPaneOrder((current) => {
      const next = [...current.slice(1), current[0]]
      localStorage.setItem(PANE_ORDER_KEY, next.join(','))
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    const snapshot = (await window.workbench.getWorkspace()) as WorkspaceSnapshot
    applySnapshot(snapshot, setProjects, setChats, setSettings, setIndexes)
    return snapshot
  }, [])

  /** The lists after a change main already made. A failed read is not a failed change; the next refresh catches up. */
  const refreshAfterChange = useCallback(async () => {
    try {
      return await refresh()
    } catch (error) {
      console.error('Could not refresh the workspace', error)
      return null
    }
  }, [refresh])

  useEffect(
    () => window.workbench.onBrowserRequestShow?.(() => setShowBrowser(true)),
    [setShowBrowser]
  )

  useEffect(() => {
    function onClick(event: MouseEvent): void {
      if (event.defaultPrevented || event.button !== 0) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      let url: URL
      try {
        url = new URL(anchor.href)
      } catch {
        return
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return
      if (url.origin === window.location.origin) return
      event.preventDefault()
      void window.workbench.navigateBrowser(url.href)
    }

    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  useEffect(() => window.workbench.onGitSummaries(setGitSummaries), [])

  // The CLI probes finish after the first snapshot. Only their part of the push is news.
  useEffect(
    () =>
      window.workbench.onSettingsChanged((next) =>
        setSettings((current) =>
          current ? { ...current, grokCli: next.grokCli, claude: next.claude, cliChecking: next.cliChecking } : next
        )
      ),
    []
  )

  useEffect(() => {
    let cancelled = false
    // A reloaded window would otherwise miss turns that are running and prompts still waiting.
    void syncLive(true)
    void (async () => {
      // A failed first read would leave an empty window that never fills in, so it is retried.
      let snapshot: WorkspaceSnapshot | null = null
      for (let attempt = 0; !snapshot; attempt++) {
        try {
          snapshot = await refresh()
        } catch (error) {
          console.error('Could not read the workspace, retrying', error)
          await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)))
        }
        if (cancelled) return
      }
      // Read once the workspace is readable, so a failed first try doesn't leave the sidebar without branches.
      void window.workbench
        .getGitSummaries()
        .then(setGitSummaries)
        .catch((error: unknown) => console.error('Could not read git status', error))
      const session = readSession()
      const projectIds = new Set(snapshot.projects.map((project) => project.id))
      const chatById = new Map(snapshot.chats.map((chat) => [chat.id, chat] as const))
      const open = session.openChatIds.filter((id) => chatById.has(id))
      const activeChat =
        (session.activeChatId && open.includes(session.activeChatId) && session.activeChatId) ||
        open.at(-1) ||
        null
      const restoredChat = activeChat ? chatById.get(activeChat) : undefined
      const activeProject =
        (session.activeProjectId && projectIds.has(session.activeProjectId) && session.activeProjectId) ||
        restoredChat?.projectId ||
        snapshot.projects[0]?.id ||
        null

      if (open.length > 0) {
        // One chat that fails to load must not keep the whole window from starting.
        const loaded = (
          await Promise.all(open.map((id) => window.workbench.getChat(id).catch(() => null)))
        ).filter((chat): chat is Chat => chat !== null)
        const openIds = open.filter((id) => loaded.some((chat) => chat.id === id))
        setChatsById((current) => {
          const next = { ...current }
          // A chat event that came in while loading is newer than what was loaded.
          for (const chat of loaded) next[chat.id] ??= chat
          return next
        })
        // Keep a tab opened while loading, such as a chat main asked to show.
        setOpenChatIds((current) => [...new Set([...openIds, ...current])])
        // It also stays in front.
        setActiveChatId(
          (current) => current ?? (activeChat && openIds.includes(activeChat) ? activeChat : (openIds.at(-1) ?? null))
        )
      }
      setActiveProjectId((current) => current ?? activeProject)
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [refresh, syncLive])

  useEffect(() => {
    if (!ready) return
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        openChatIds,
        activeChatId,
        activeProjectId
      } satisfies UiSession)
    )
  }, [ready, openChatIds, activeChatId, activeProjectId])

  useEffect(() => {
    return () => {
      if (streamFlush.current) window.clearTimeout(streamFlush.current)
    }
  }, [])

  useEffect(() => {
    return window.workbench.onIndexEvent((event: IndexEvent) => {
      setIndexes((current) => ({ ...current, [event.projectId]: event.index }))
    })
  }, [])

  useEffect(() => {
    /** False for an event from a turn that is older than, or ended before, the one we know. */
    function isCurrent(chatId: string, turnId: number): boolean {
      const known = turnsRef.current[chatId]
      return !known || turnId > known.turnId || (turnId === known.turnId && known.live)
    }

    return window.workbench.onChatEvent((event: ChatEvent) => {
      switch (event.type) {
        // ChatPane reads the agent's commands itself.
        case 'commands':
          return
        case 'open':
          void openChatRef.current?.(event.chatId)
          return
        case 'context':
          setContexts((current) => ({ ...current, [event.chatId]: event.context }))
          return
        case 'turn-start': {
          const known = turnsRef.current[event.chatId]
          if (known && event.turnId <= known.turnId) return
          turnsRef.current[event.chatId] = { turnId: event.turnId, live: true }
          flushStreamBuf()
          setStreams((current) => ({
            ...current,
            [event.chatId]: { status: 'streaming', draft: '', error: null, turnId: event.turnId }
          }))
          return
        }
        case 'delta': {
          if (!isCurrent(event.chatId, event.turnId)) return
          turnsRef.current[event.chatId] = { turnId: event.turnId, live: true }
          if (deltaBuf.current[event.chatId] && deltaBuf.current[event.chatId].turnId !== event.turnId) {
            flushStreamBuf()
          }
          const pending = deltaBuf.current[event.chatId]
          if (pending) pending.text += event.text
          else deltaBuf.current[event.chatId] = { turnId: event.turnId, text: event.text }
          queueStreamFlush()
          return
        }
        case 'done': {
          if (!isCurrent(event.chatId, event.turnId)) return
          turnsRef.current[event.chatId] = { turnId: event.turnId, live: false }
          flushStreamBuf()
          applyChat(event.chatId, event.chat)
          setStreams((current) => {
            const prev = current[event.chatId]
            // A steer that failed during the turn keeps its message until the next send.
            const error = prev?.turnId === event.turnId ? prev.error : null
            return { ...current, [event.chatId]: { ...emptyStream, error, turnId: event.turnId } }
          })
          void refresh()
          void syncLive()
          return
        }
        case 'error': {
          if (!isCurrent(event.chatId, event.turnId)) return
          turnsRef.current[event.chatId] = { turnId: event.turnId, live: false }
          flushStreamBuf()
          setStreams((current) => {
            const prev = current[event.chatId]
            return {
              ...current,
              [event.chatId]: {
                status: 'error',
                draft: prev?.turnId === event.turnId ? prev.draft : '',
                error: event.error,
                turnId: event.turnId
              }
            }
          })
          void syncLive()
          return
        }
        case 'aside-delta': {
          liveAsides.current.add(event.messageId)
          const pending = asideBuf.current[event.messageId]
          if (pending) pending.text += event.text
          else asideBuf.current[event.messageId] = { chatId: event.chatId, text: event.text }
          queueStreamFlush()
          return
        }
        case 'aside-done': {
          flushStreamBuf()
          // An aside is over once its saved message has text; one still empty may still be streaming.
          for (const message of event.chat.messages) {
            if (message.content) liveAsides.current.delete(message.id)
          }
          applyChat(event.chatId, event.chat)
          return
        }
        case 'plan':
          setChatsById((current) => {
            const chat = current[event.chatId]
            if (!chat) return current
            return { ...current, [event.chatId]: { ...chat, plan: event.plan } }
          })
          return
        case 'permission':
          setPermissionQueues((current) => pushRequest(current, event.request))
          return
        case 'permission-clear':
          setPermissionQueues((current) => dropRequest(current, event.chatId, event.requestId))
          return
        case 'question':
          setQuestionQueues((current) => pushRequest(current, event.request))
          return
        case 'question-clear':
          setQuestionQueues((current) => dropRequest(current, event.chatId, event.requestId))
          return
        case 'chat': {
          // The chat on screen handed off: follow the work to the chat that continues it.
          const handedTo = event.chat.handoffTo
          if (
            handedTo &&
            !chatsByIdRef.current[event.chatId]?.handoffTo &&
            activeChatIdRef.current === event.chatId
          ) {
            queueMicrotask(() => void openChatRef.current?.(handedTo))
          }
          // Only the chat changes here. The stream, and an error it shows, belong to the turn.
          applyChat(event.chatId, event.chat)
          setChats((current) => {
            // An agent opened this chat (start_chat, delegate): load it into the sidebar.
            if (!current.some((item) => item.id === event.chatId)) queueMicrotask(() => void refresh())
            return current.map((item) =>
              item.id === event.chatId
                ? {
                    ...item,
                    worktreePath: event.chat.worktreePath ?? null,
                    worktreeBranch: event.chat.worktreeBranch ?? null,
                    schedule: event.chat.schedule ?? null,
                    pr: event.chat.pr ?? null
                  }
                : item
            )
          })
          return
        }
        default:
          // An event this window does not know yet changes nothing.
          return
      }
    })
  }, [applyChat, flushStreamBuf, queueStreamFlush, refresh, syncLive])

  const openChat = useCallback(async (chatId: string) => {
    const chat = chatsByIdRef.current[chatId] ?? (await window.workbench.getChat(chatId))
    // Events may have brought a newer copy while it loaded.
    setChatsById((current) => (current[chatId] ? current : { ...current, [chatId]: chat }))
    setActiveChatId(chatId)
    setActiveProjectId(chat.projectId)
    setOpenChatIds((current) => (current.includes(chatId) ? current : [...current, chatId]))
  }, [])
  useEffect(() => {
    openChatRef.current = openChat
  }, [openChat])

  useEffect(() => {
    if (!ready || !activeChatId || !activeProjectId) return
    void window.workbench.ensureProjectIntake(activeProjectId, activeChatId)
  }, [ready, activeChatId, activeProjectId])

  const closeTab = useCallback((chatId: string) => {
    // The ref moves on now, so closing several tabs before a render picks a tab still open.
    const remaining = openChatIdsRef.current.filter((id) => id !== chatId)
    openChatIdsRef.current = remaining
    setOpenChatIds((current) => current.filter((id) => id !== chatId))
    setActiveChatId((active) => (active !== chatId ? active : (remaining.at(-1) ?? null)))
  }, [])

  /** Drops what this window holds for chats that no longer exist. */
  const forgetChats = useCallback((ids: string[]) => {
    for (const id of ids) {
      delete turnsRef.current[id]
      delete deltaBuf.current[id]
      sending.current.delete(id)
      approving.current.delete(id)
    }
    setChatsById((current) => omitKeys(current, ids))
    setStreams((current) => omitKeys(current, ids))
    setPermissionQueues((current) => omitKeys(current, ids))
    setQuestionQueues((current) => omitKeys(current, ids))
  }, [])

  const selectProject = useCallback((projectId: string) => {
    setActiveProjectId(projectId)
  }, [])

  const createProject = useCallback(
    async (name: string, path: string | null) => {
      const { project, chat } = await window.workbench.createProject({ name, path })
      await refreshAfterChange()
      setActiveProjectId(project.id)
      setChatsById((current) => ({ ...current, [chat.id]: chat }))
      setOpenChatIds((current) => (current.includes(chat.id) ? current : [...current, chat.id]))
      setActiveChatId(chat.id)
      setShowNewProject(false)
    },
    [refreshAfterChange]
  )

  const updateProject = useCallback(async (input: UpdateProjectInput) => {
    const project = await window.workbench.updateProject(input)
    setProjects((current) => current.map((item) => (item.id === project.id ? project : item)))
  }, [])

  const pickFolder = useCallback(async () => {
    return window.workbench.pickFolder()
  }, [])

  const indexProject = useCallback(async (projectId: string) => {
    await window.workbench.indexProject(projectId)
  }, [])

  const getOrientation = useCallback(async (projectId: string) => {
    return window.workbench.getOrientation(projectId)
  }, [])

  const deleteProject = useCallback(
    async (projectId: string) => {
      const removed = chats.filter((chat) => chat.projectId === projectId).map((chat) => chat.id)
      await window.workbench.deleteProject(projectId)
      setOpenChatIds((current) => current.filter((id) => !removed.includes(id)))
      forgetChats(removed)
      const snapshot = await refreshAfterChange()
      const nextProject = snapshot?.projects[0]?.id ?? null
      setActiveProjectId(nextProject)
      setActiveChatId((active) => (active && removed.includes(active) ? null : active))
    },
    [chats, forgetChats, refreshAfterChange]
  )

  const createChat = useCallback(
    async (projectId: string) => {
      const chat = await window.workbench.createChat(projectId)
      await refreshAfterChange()
      setChatsById((current) => ({ ...current, [chat.id]: chat }))
      setOpenChatIds((current) => (current.includes(chat.id) ? current : [...current, chat.id]))
      setActiveChatId(chat.id)
      setActiveProjectId(projectId)
    },
    [refreshAfterChange]
  )

  const deleteChat = useCallback(
    async (chatId: string) => {
      await window.workbench.deleteChat(chatId)
      closeTab(chatId)
      forgetChats([chatId])
      await refreshAfterChange()
    },
    [closeTab, forgetChats, refreshAfterChange]
  )

  const renameChat = useCallback(async (chatId: string, title: string) => {
    const chat = await window.workbench.renameChat(chatId, title)
    setChatsById((current) => ({ ...current, [chatId]: chat }))
    setChats((current) => current.map((item) => (item.id === chatId ? { ...item, title: chat.title } : item)))
  }, [])

  const setChatAgent = useCallback(async (chatId: string, agent: ChatAgent) => {
    const chat = await window.workbench.setChatAgent(chatId, agent)
    setChatsById((current) => ({ ...current, [chatId]: chat }))
    setChats((current) => current.map((item) => (item.id === chatId ? { ...item, agent: chat.agent } : item)))
  }, [])

  const sendMessage = useCallback(
    async (
      chatId: string,
      content: string,
      attachments?: Attachment[],
      mentions?: FileMention[],
      conversation?: string
    ) => {
      const atSend = turnsRef.current[chatId]
      const asAside = atSend?.live === true
      if (!asAside) {
        if (sending.current.has(chatId)) return false
        sending.current.add(chatId)
        setStreams((current) => ({
          ...current,
          [chatId]: { status: 'streaming', draft: '', error: null, turnId: current[chatId]?.turnId ?? null }
        }))
      }
      try {
        // Ending the conversation takes back a correction to the running turn. A new turn shows as started at once, so it goes.
        const chat = await window.workbench.sendMessage(
          chatId,
          content,
          attachments,
          mentions,
          asAside ? conversation : undefined
        )
        // The turn's done can come before this reply; its chat is newer than this one.
        const now = turnsRef.current[chatId]
        if (!(now && !now.live && now !== atSend)) applyChat(chatId, chat)
        if (!asAside) await refreshAfterChange()
        return true
      } catch (error) {
        const raw = error instanceof Error ? error.message : 'Could not send'
        const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
        // A turn running now (this one's or another's) keeps its stream; only the message shows.
        const live = turnsRef.current[chatId]?.live === true
        setStreams((current) => {
          const prev = current[chatId] ?? emptyStream
          return {
            ...current,
            [chatId]: live
              ? { ...prev, error: message }
              : { status: 'error', draft: '', error: message, turnId: prev.turnId }
          }
        })
        return false
      } finally {
        if (!asAside) sending.current.delete(chatId)
      }
    },
    [applyChat, refreshAfterChange]
  )

  const stopChat = useCallback(
    async (chatId: string) => {
      // A running turn saves what it has and then sends done, which settles the stream.
      const stopping = await window.workbench.stopChat(chatId)
      if (!stopping) {
        const known = turnsRef.current[chatId]
        if (known) turnsRef.current[chatId] = { ...known, live: false }
        setStreams((current) => {
          const prev = current[chatId]
          if (!prev || prev.status !== 'streaming') return current
          return { ...current, [chatId]: { ...emptyStream, turnId: prev.turnId } }
        })
      }
      // Main cancelled the turn's prompts and kept intake's; take its list rather than guess.
      await syncLive()
    },
    [syncLive]
  )

  const setChatMode = useCallback(async (chatId: string, mode: PermissionMode) => {
    const next = normalizePermissionMode(mode)
    const chat = await window.workbench.setChatMode(chatId, next)
    setChatsById((current) => ({ ...current, [chatId]: chat }))
    setChats((current) =>
      current.map((item) => (item.id === chatId ? { ...item, mode: chat.mode } : item))
    )
  }, [])

  const approvePlan = useCallback(
    async (chatId: string, verdict: PlanVerdict = 'approve') => {
      // A second click while the first is settling would send the follow-up twice.
      if (approving.current.has(chatId)) return
      approving.current.add(chatId)
      try {
        const continued = await window.workbench.resolvePlanApproval(chatId, verdict)
        const chat = await window.workbench.getChat(chatId)
        applyChat(chatId, chat)
        setChats((current) =>
          current.map((item) =>
            item.id === chatId ? { ...item, mode: chat.mode, plan: chat.plan } : item
          )
        )
        const hasBody = Boolean(chat.plan?.markdown?.trim() || (chat.plan?.entries && chat.plan.entries.length > 0))
        if (
          verdict === 'approve' &&
          !continued &&
          hasBody &&
          turnsRef.current[chatId]?.live !== true
        ) {
          await sendMessage(chatId, 'Implement the approved plan. Start now.')
        }
      } finally {
        approving.current.delete(chatId)
      }
    },
    [applyChat, sendMessage]
  )

  const resolvePermission = useCallback(async (requestId: string, decision: 'allow' | 'deny' | 'wait') => {
    await window.workbench.resolvePermission(requestId, decision)
  }, [])

  const resolveQuestion = useCallback(
    async (
      requestId: string,
      decision: { type: 'skip' } | { type: 'submit'; answers: string[][] }
    ) => {
      await window.workbench.resolveQuestion(requestId, decision)
    },
    []
  )

  // Main stops the turn first and refuses while it is still stopping; that error reaches the caller.
  const rewindChat = useCallback(
    async (chatId: string, checkpointId: string) => {
      const chat = await window.workbench.rewindChat(chatId, checkpointId)
      setChatsById((current) => ({ ...current, [chatId]: chat }))
      setStreams((current) => ({
        ...current,
        [chatId]: { ...emptyStream, turnId: current[chatId]?.turnId ?? null }
      }))
      await syncLive()
      await refreshAfterChange()
    },
    [refreshAfterChange, syncLive]
  )

  const saveSettings = useCallback(
    async (input: {
      apiKey?: string
      model?: string
      effort?: string | null
      voice?: Partial<VoiceSettings>
      defaultAgent?: ChatAgent
      claudeModel?: string
      orchestratorModel?: string
      subagentModel?: string
      maxSubagents?: number
    }) => {
      const next = await window.workbench.setSettings(input)
      setSettings(
        input.voice
          ? { ...next, voice: { ...next.voice, ...input.voice } }
          : next
      )
    },
    []
  )

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      projects,
      chats,
      settings,
      indexes,
      openChatIds,
      activeChatId,
      activeProjectId,
      chatsById,
      showNewProject,
      showSettings,
      showUsage,
      showActivity,
      showBrowser,
      showGit,
      showKnowledge,
      showSidebar,
      gitSummaries,
      contexts,
      rightPaneOrder,
      setShowNewProject,
      setShowSettings,
      setShowUsage,
      setShowActivity,
      setShowBrowser,
      setShowGit,
      setShowKnowledge,
      setShowSidebar,
      swapRightPanes,
      selectProject,
      openChat,
      closeTab,
      createProject,
      updateProject,
      pickFolder,
      deleteProject,
      indexProject,
      getOrientation,
      createChat,
      deleteChat,
      renameChat,
      setChatAgent,
      sendMessage,
      stopChat,
      setChatMode,
      approvePlan,
      resolvePermission,
      resolveQuestion,
      rewindChat,
      permissions,
      questions,
      saveSettings
    }),
    [
      projects,
      chats,
      settings,
      indexes,
      openChatIds,
      activeChatId,
      activeProjectId,
      chatsById,
      showNewProject,
      showSettings,
      showUsage,
      showActivity,
      showBrowser,
      showGit,
      showKnowledge,
      showSidebar,
      gitSummaries,
      contexts,
      rightPaneOrder,
      setShowActivity,
      setShowBrowser,
      setShowGit,
      setShowKnowledge,
      setShowSidebar,
      swapRightPanes,
      selectProject,
      openChat,
      closeTab,
      createProject,
      updateProject,
      pickFolder,
      deleteProject,
      indexProject,
      getOrientation,
      createChat,
      deleteChat,
      renameChat,
      setChatAgent,
      sendMessage,
      stopChat,
      setChatMode,
      approvePlan,
      resolvePermission,
      resolveQuestion,
      rewindChat,
      permissions,
      questions,
      saveSettings
    ]
  )

  return (
    <WorkspaceContext.Provider value={value}>
      <StreamStatusContext.Provider value={statuses}>
        <StreamContext.Provider value={streams}>{children}</StreamContext.Provider>
      </StreamStatusContext.Provider>
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return value
}

/** Every chat's stream with its reply text. Changes many times a second while a reply arrives. */
export function useStreams(): Record<string, StreamState> {
  const value = useContext(StreamContext)
  if (!value) throw new Error('useStreams must be used inside WorkspaceProvider')
  return value
}

/** Which chats are streaming or failed. Changes only when one of them starts, stops or fails. */
export function useStreamStatuses(): Record<string, StreamStatus> {
  const value = useContext(StreamStatusContext)
  if (!value) throw new Error('useStreamStatuses must be used inside WorkspaceProvider')
  return value
}
