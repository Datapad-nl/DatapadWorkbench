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
  ChatEvent,
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

type StreamState = {
  status: 'idle' | 'streaming' | 'error'
  draft: string
  error: string | null
}

type WorkspaceContextValue = {
  ready: boolean
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
    mentions?: FileMention[]
  ) => Promise<void>
  stopChat: (chatId: string) => Promise<void>
  setChatMode: (chatId: string, mode: PermissionMode) => Promise<void>
  approvePlan: (chatId: string, verdict?: PlanVerdict) => Promise<void>
  resolvePermission: (requestId: string, decision: 'allow' | 'deny') => Promise<void>
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
  }) => Promise<void>
  refresh: () => Promise<WorkspaceSnapshot>
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)
const StreamContext = createContext<Record<string, StreamState> | null>(null)

const emptyStream: StreamState = { status: 'idle', draft: '', error: null }

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
      openChatIds: Array.isArray(parsed.openChatIds)
        ? parsed.openChatIds.filter((id): id is string => typeof id === 'string')
        : [],
      activeChatId: typeof parsed.activeChatId === 'string' ? parsed.activeChatId : null,
      activeProjectId: typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : null
    }
  } catch {
    return { openChatIds: [], activeChatId: null, activeProjectId: null }
  }
}

function applySnapshot(
  snapshot: WorkspaceSnapshot,
  setProjects: (projects: Project[]) => void,
  setChats: (chats: ChatSummary[]) => void,
  setSettings: (settings: PublicSettings) => void,
  setIndexes: (indexes: Record<string, ProjectIndex>) => void
): void {
  setProjects(snapshot.projects)
  setChats(snapshot.chats)
  setSettings(snapshot.settings)
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
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [chatsById, setChatsById] = useState<Record<string, Chat>>({})
  const [streams, setStreams] = useState<Record<string, StreamState>>({})
  const streamsRef = useRef(streams)
  streamsRef.current = streams
  const sending = useRef(new Set<string>())
  const openChatRef = useRef<((chatId: string) => Promise<void>) | null>(null)
  const deltaBuf = useRef<Record<string, string>>({})
  const asideBuf = useRef<Record<string, { messageId: string; text: string }>>({})
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
          const text = deltas[chatId]
          if (!text) continue
          if (next === current) next = { ...current }
          const prev = next[chatId] ?? emptyStream
          next[chatId] = { status: 'streaming', draft: prev.draft + text, error: null }
        }
        return next
      })
    }
    const asideIds = Object.keys(asides)
    if (asideIds.length > 0) {
      setChatsById((current) => {
        let next = current
        for (const chatId of asideIds) {
          const pending = asides[chatId]
          const chat = next[chatId]
          if (!pending || !chat) continue
          if (next === current) next = { ...current }
          next[chatId] = {
            ...chat,
            messages: chat.messages.map((message) =>
              message.id === pending.messageId
                ? { ...message, content: message.content + pending.text }
                : message
            )
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
  const [permissions, setPermissions] = useState<Record<string, PermissionRequest>>({})
  const [questions, setQuestions] = useState<Record<string, UserQuestionRequest>>({})
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

  useEffect(() => {
    void window.workbench.getGitSummaries().then(setGitSummaries)
    return window.workbench.onGitSummaries(setGitSummaries)
  }, [])

  useEffect(() => {
    void (async () => {
      const snapshot = await refresh()
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
        const loaded = await Promise.all(open.map((id) => window.workbench.getChat(id)))
        setChatsById((current) => {
          const next = { ...current }
          for (const chat of loaded) next[chat.id] = chat
          return next
        })
        setOpenChatIds(open)
        setActiveChatId(activeChat)
      }
      setActiveProjectId(activeProject)
      setReady(true)
    })()
  }, [refresh])

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
    return window.workbench.onChatEvent((event: ChatEvent) => {
      // ChatPane reads the agent's commands itself.
      if (event.type === 'commands') return
      if (event.type === 'open') {
        void openChatRef.current?.(event.chatId)
        return
      }
      if (event.type === 'delta') {
        deltaBuf.current[event.chatId] = (deltaBuf.current[event.chatId] ?? '') + event.text
        queueStreamFlush()
        return
      }
      if (event.type === 'done') {
        flushStreamBuf()
        setChatsById((current) => ({ ...current, [event.chatId]: event.chat }))
        setStreams((current) => ({
          ...current,
          [event.chatId]: emptyStream
        }))
        void refresh()
        return
      }
      if (event.type === 'aside-delta') {
        const prev = asideBuf.current[event.chatId]
        if (prev && prev.messageId === event.messageId) {
          prev.text += event.text
        } else {
          asideBuf.current[event.chatId] = { messageId: event.messageId, text: event.text }
        }
        queueStreamFlush()
        return
      }
      if (event.type === 'aside-done') {
        flushStreamBuf()
        setChatsById((current) => ({ ...current, [event.chatId]: event.chat }))
        return
      }
      if (event.type === 'plan') {
        setChatsById((current) => {
          const chat = current[event.chatId]
          if (!chat) return current
          return { ...current, [event.chatId]: { ...chat, plan: event.plan } }
        })
        return
      }
      if (event.type === 'permission') {
        setPermissions((current) => ({ ...current, [event.chatId]: event.request }))
        return
      }
      if (event.type === 'permission-clear') {
        setPermissions((current) => {
          const existing = current[event.chatId]
          if (!existing || existing.requestId !== event.requestId) return current
          const next = { ...current }
          delete next[event.chatId]
          return next
        })
        return
      }
      if (event.type === 'question') {
        setQuestions((current) => ({ ...current, [event.chatId]: event.request }))
        return
      }
      if (event.type === 'question-clear') {
        setQuestions((current) => {
          const existing = current[event.chatId]
          if (!existing || existing.requestId !== event.requestId) return current
          const next = { ...current }
          delete next[event.chatId]
          return next
        })
        return
      }
      if (event.type === 'chat') {
        setChatsById((current) => ({ ...current, [event.chatId]: event.chat }))
        setChats((current) =>
          current.map((item) =>
            item.id === event.chatId
              ? {
                  ...item,
                  worktreePath: event.chat.worktreePath ?? null,
                  worktreeBranch: event.chat.worktreeBranch ?? null
                }
              : item
          )
        )
        setStreams((current) => {
          if (!current[event.chatId] || current[event.chatId].status !== 'streaming') {
            return { ...current, [event.chatId]: emptyStream }
          }
          return current
        })
        return
      }
      flushStreamBuf()
      setStreams((current) => ({
        ...current,
        [event.chatId]: {
          status: 'error',
          draft: current[event.chatId]?.draft ?? '',
          error: event.error
        }
      }))
    })
  }, [flushStreamBuf, queueStreamFlush, refresh])

  const openChat = useCallback(async (chatId: string) => {
    const chat = chatsById[chatId] ?? (await window.workbench.getChat(chatId))
    setChatsById((current) => ({ ...current, [chatId]: chat }))
    setActiveChatId(chatId)
    setActiveProjectId(chat.projectId)
    setOpenChatIds((current) => (current.includes(chatId) ? current : [...current, chatId]))
  }, [chatsById])
  useEffect(() => {
    openChatRef.current = openChat
  }, [openChat])

  useEffect(() => {
    if (!ready || !activeChatId || !activeProjectId) return
    void window.workbench.ensureProjectIntake(activeProjectId, activeChatId)
  }, [ready, activeChatId, activeProjectId])

  const closeTab = useCallback((chatId: string) => {
    setOpenChatIds((current) => {
      const next = current.filter((id) => id !== chatId)
      setActiveChatId((active) => {
        if (active !== chatId) return active
        return next.at(-1) ?? null
      })
      return next
    })
  }, [])

  const selectProject = useCallback((projectId: string) => {
    setActiveProjectId(projectId)
  }, [])

  const createProject = useCallback(
    async (name: string, path: string | null) => {
      const { project, chat } = await window.workbench.createProject({ name, path })
      await refresh()
      setActiveProjectId(project.id)
      setChatsById((current) => ({ ...current, [chat.id]: chat }))
      setOpenChatIds((current) => [...current, chat.id])
      setActiveChatId(chat.id)
      setShowNewProject(false)
    },
    [refresh]
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
      setChatsById((current) => {
        const next = { ...current }
        for (const id of removed) delete next[id]
        return next
      })
      const snapshot = await refresh()
      const nextProject = snapshot.projects[0]?.id ?? null
      setActiveProjectId(nextProject)
      setActiveChatId((active) => (active && removed.includes(active) ? null : active))
    },
    [chats, refresh]
  )

  const createChat = useCallback(
    async (projectId: string) => {
      const chat = await window.workbench.createChat(projectId)
      await refresh()
      setChatsById((current) => ({ ...current, [chat.id]: chat }))
      setOpenChatIds((current) => [...current, chat.id])
      setActiveChatId(chat.id)
      setActiveProjectId(projectId)
    },
    [refresh]
  )

  const deleteChat = useCallback(
    async (chatId: string) => {
      await window.workbench.deleteChat(chatId)
      closeTab(chatId)
      setChatsById((current) => {
        const next = { ...current }
        delete next[chatId]
        return next
      })
      await refresh()
    },
    [closeTab, refresh]
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
    async (chatId: string, content: string, attachments?: Attachment[], mentions?: FileMention[]) => {
      const asAside = streamsRef.current[chatId]?.status === 'streaming'
      if (!asAside) {
        if (sending.current.has(chatId)) return
        sending.current.add(chatId)
        setStreams((current) => ({
          ...current,
          [chatId]: { status: 'streaming', draft: '', error: null }
        }))
      }
      try {
        const chat = await window.workbench.sendMessage(chatId, content, attachments, mentions)
        setChatsById((current) => ({ ...current, [chatId]: chat }))
        if (!asAside) await refresh()
      } catch (error) {
        if (asAside) return
        const raw = error instanceof Error ? error.message : 'Could not send'
        const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
        setStreams((current) => ({
          ...current,
          [chatId]: { status: 'error', draft: '', error: message }
        }))
      } finally {
        if (!asAside) sending.current.delete(chatId)
      }
    },
    [refresh]
  )

  const stopChat = useCallback(async (chatId: string) => {
    await window.workbench.stopChat(chatId)
    setStreams((current) => ({ ...current, [chatId]: emptyStream }))
    setPermissions((current) => {
      if (!current[chatId]) return current
      const next = { ...current }
      delete next[chatId]
      return next
    })
    setQuestions((current) => {
      if (!current[chatId]) return current
      const next = { ...current }
      delete next[chatId]
      return next
    })
  }, [])

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
      const continued = await window.workbench.resolvePlanApproval(chatId, verdict)
      const chat = await window.workbench.getChat(chatId)
      setChatsById((current) => ({ ...current, [chatId]: chat }))
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
        streamsRef.current[chatId]?.status !== 'streaming'
      ) {
        await sendMessage(chatId, 'Implement the approved plan. Start now.')
      }
    },
    [sendMessage]
  )

  const resolvePermission = useCallback(async (requestId: string, decision: 'allow' | 'deny') => {
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

  const rewindChat = useCallback(async (chatId: string, checkpointId: string) => {
    const chat = await window.workbench.rewindChat(chatId, checkpointId)
    setChatsById((current) => ({ ...current, [chatId]: chat }))
    setStreams((current) => ({ ...current, [chatId]: emptyStream }))
    setPermissions((current) => {
      if (!current[chatId]) return current
      const next = { ...current }
      delete next[chatId]
      return next
    })
    setQuestions((current) => {
      if (!current[chatId]) return current
      const next = { ...current }
      delete next[chatId]
      return next
    })
    await refresh()
  }, [refresh])

  const saveSettings = useCallback(
    async (input: {
      apiKey?: string
      model?: string
      effort?: string | null
      voice?: Partial<VoiceSettings>
      defaultAgent?: ChatAgent
      claudeModel?: string
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
      ready,
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
      saveSettings,
      refresh
    }),
    [
      ready,
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
      saveSettings,
      refresh
    ]
  )

  return (
    <WorkspaceContext.Provider value={value}>
      <StreamContext.Provider value={streams}>{children}</StreamContext.Provider>
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return value
}

export function useStreams(): Record<string, StreamState> {
  const value = useContext(StreamContext)
  if (!value) throw new Error('useStreams must be used inside WorkspaceProvider')
  return value
}
