import { useEffect, useState } from 'react'
import { BotsProvider, useBots } from './bots'
import { ActivityApp } from './components/ActivityApp'
import { BotPage } from './components/BotPage'
import { BrowserPane } from './components/BrowserPane'
import { ChatPane } from './components/ChatPane'
import { GitPane } from './components/GitPane'
import { GraphPane } from './components/GraphPane'
import { NewProjectModal, SettingsModal, UsageModal } from './components/Modals'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { ThemeProvider } from './theme/ThemeProvider'
import { VoiceProvider } from './voice/VoiceProvider'
import { useWorkspace, WorkspaceProvider, type RightPaneId } from './workspace'

const ACTIVITY_WIDTH_KEY = 'workbench.activityWidth'
const BROWSER_WIDTH_KEY = 'workbench.browserWidth'
const GIT_WIDTH_KEY = 'workbench.gitWidth'
const KNOWLEDGE_WIDTH_KEY = 'workbench.knowledgeWidth'
const DEFAULT_ACTIVITY_WIDTH = 360
const DEFAULT_BROWSER_WIDTH = 420
const DEFAULT_GIT_WIDTH = 380
const DEFAULT_KNOWLEDGE_WIDTH = 420
const MIN_ACTIVITY_WIDTH = 260
const MAX_ACTIVITY_WIDTH = 720
const MIN_BROWSER_WIDTH = 320
const MIN_GIT_WIDTH = 300
const MAX_GIT_WIDTH = 720
const MIN_KNOWLEDGE_WIDTH = 300
const MAX_KNOWLEDGE_WIDTH = 900

function maxBrowserWidth(): number {
  return Math.max(MIN_BROWSER_WIDTH, Math.round(window.innerWidth * 0.5))
}

const COLLAPSE_ACTIVITY_WIDTH = 200
const COLLAPSE_BROWSER_WIDTH = 200
const COLLAPSE_GIT_WIDTH = 200
const COLLAPSE_KNOWLEDGE_WIDTH = 200

type DragKind = 'activity' | 'browser' | 'git' | 'knowledge'

function readWidth(key: string, fallback: number, min: number, max: number): number {
  const raw = Number(localStorage.getItem(key))
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, raw))
}

function Shell(): React.JSX.Element {
  const { showActivity, showBrowser, showGit, showKnowledge, rightPaneOrder, activeBotId } = useWorkspace()
  const { bots } = useBots()
  const activeBot = activeBotId ? (bots.find((bot) => bot.id === activeBotId) ?? null) : null
  const [activityWidth, setActivityWidth] = useState(() =>
    readWidth(ACTIVITY_WIDTH_KEY, DEFAULT_ACTIVITY_WIDTH, MIN_ACTIVITY_WIDTH, MAX_ACTIVITY_WIDTH)
  )
  const [browserWidth, setBrowserWidth] = useState(() =>
    readWidth(BROWSER_WIDTH_KEY, DEFAULT_BROWSER_WIDTH, MIN_BROWSER_WIDTH, maxBrowserWidth())
  )
  const [gitWidth, setGitWidth] = useState(() =>
    readWidth(GIT_WIDTH_KEY, DEFAULT_GIT_WIDTH, MIN_GIT_WIDTH, MAX_GIT_WIDTH)
  )
  const [knowledgeWidth, setKnowledgeWidth] = useState(() =>
    readWidth(KNOWLEDGE_WIDTH_KEY, DEFAULT_KNOWLEDGE_WIDTH, MIN_KNOWLEDGE_WIDTH, MAX_KNOWLEDGE_WIDTH)
  )
  const [dragging, setDragging] = useState<DragKind | null>(null)

  useEffect(() => {
    localStorage.setItem(ACTIVITY_WIDTH_KEY, String(activityWidth))
  }, [activityWidth])

  useEffect(() => {
    localStorage.setItem(BROWSER_WIDTH_KEY, String(browserWidth))
  }, [browserWidth])

  useEffect(() => {
    localStorage.setItem(GIT_WIDTH_KEY, String(gitWidth))
  }, [gitWidth])

  useEffect(() => {
    localStorage.setItem(KNOWLEDGE_WIDTH_KEY, String(knowledgeWidth))
  }, [knowledgeWidth])

  function startResize(event: React.PointerEvent<HTMLDivElement>, kind: DragKind): void {
    event.preventDefault()
    const startX = event.clientX
    const startWidth =
      kind === 'activity'
        ? activityWidth
        : kind === 'browser'
          ? browserWidth
          : kind === 'git'
            ? gitWidth
            : knowledgeWidth
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    setDragging(kind)

    function onMove(move: PointerEvent): void {
      const next = startWidth - (move.clientX - startX)
      if (kind === 'activity') {
        setActivityWidth(Math.min(MAX_ACTIVITY_WIDTH, Math.max(MIN_ACTIVITY_WIDTH, next)))
      } else if (kind === 'browser') {
        setBrowserWidth(Math.min(maxBrowserWidth(), Math.max(MIN_BROWSER_WIDTH, next)))
      } else if (kind === 'git') {
        setGitWidth(Math.min(MAX_GIT_WIDTH, Math.max(MIN_GIT_WIDTH, next)))
      } else {
        setKnowledgeWidth(Math.min(MAX_KNOWLEDGE_WIDTH, Math.max(MIN_KNOWLEDGE_WIDTH, next)))
      }
    }

    function onUp(): void {
      setDragging(null)
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

  const panes: Record<RightPaneId, React.JSX.Element> = {
    git: (
      <aside
        key="git"
        className={`corner-marks-over relative [--marks-top:var(--spacing-titlebar)] overflow-hidden border-l border-line bg-sidebar ${
          dragging === 'git' ? '' : 'transition-[width] duration-200 ease-out'
        }`}
        style={{
          width: showGit ? gitWidth : 0,
          minWidth: showGit ? COLLAPSE_GIT_WIDTH : 0,
          flexShrink: showGit ? 1 : 0,
          borderLeftWidth: showGit ? 1 : 0
        }}
        aria-hidden={!showGit}
      >
        <div className="flex h-full flex-col" style={{ width: gitWidth }}>
          <GitPane />
        </div>
        {showGit && (
          <div
            className={`no-drag absolute top-0 left-0 z-10 h-full w-1.5 cursor-col-resize after:absolute after:inset-y-0 after:left-0 after:w-px hover:after:bg-accent-line ${
              dragging === 'git' ? 'after:bg-accent-line' : ''
            }`}
            onPointerDown={(event) => startResize(event, 'git')}
          />
        )}
      </aside>
    ),
    browser: (
      <aside
        key="browser"
        className={`corner-marks-over relative [--marks-top:var(--spacing-titlebar)] overflow-hidden border-l border-line bg-canvas ${
          dragging === 'browser' ? '' : 'transition-[width] duration-200 ease-out'
        }`}
        style={{
          width: showBrowser ? browserWidth : 0,
          minWidth: showBrowser ? COLLAPSE_BROWSER_WIDTH : 0,
          flexShrink: showBrowser ? 1 : 0,
          borderLeftWidth: showBrowser ? 1 : 0
        }}
        aria-hidden={!showBrowser}
      >
        <div className="flex h-full flex-col" style={{ width: browserWidth }}>
          <BrowserPane />
        </div>
        {showBrowser && (
          <div
            className={`no-drag absolute top-0 left-0 z-10 h-full w-1.5 cursor-col-resize after:absolute after:inset-y-0 after:left-0 after:w-px hover:after:bg-accent-line ${
              dragging === 'browser' ? 'after:bg-accent-line' : ''
            }`}
            onPointerDown={(event) => startResize(event, 'browser')}
          />
        )}
      </aside>
    ),
    activity: (
      <aside
        key="activity"
        className={`corner-marks-over relative [--marks-top:var(--spacing-titlebar)] overflow-hidden border-l border-line bg-sidebar ${
          dragging === 'activity' ? '' : 'transition-[width] duration-200 ease-out'
        }`}
        style={{
          width: showActivity ? activityWidth : 0,
          minWidth: showActivity ? COLLAPSE_ACTIVITY_WIDTH : 0,
          flexShrink: showActivity ? 1 : 0,
          borderLeftWidth: showActivity ? 1 : 0
        }}
        aria-hidden={!showActivity}
      >
        <div className="flex h-full flex-col" style={{ width: activityWidth }}>
          <ActivityApp />
        </div>
        {showActivity && (
          <div
            className={`no-drag absolute top-0 left-0 z-10 h-full w-1.5 cursor-col-resize after:absolute after:inset-y-0 after:left-0 after:w-px hover:after:bg-accent-line ${
              dragging === 'activity' ? 'after:bg-accent-line' : ''
            }`}
            onPointerDown={(event) => startResize(event, 'activity')}
          />
        )}
      </aside>
    ),
    knowledge: (
      <aside
        key="knowledge"
        className={`relative overflow-hidden border-l border-line bg-sidebar ${
          dragging === 'knowledge' ? '' : 'transition-[width] duration-200 ease-out'
        }`}
        style={{
          width: showKnowledge ? knowledgeWidth : 0,
          minWidth: showKnowledge ? COLLAPSE_KNOWLEDGE_WIDTH : 0,
          flexShrink: showKnowledge ? 1 : 0,
          borderLeftWidth: showKnowledge ? 1 : 0
        }}
        aria-hidden={!showKnowledge}
      >
        <div className="flex h-full flex-col" style={{ width: knowledgeWidth }}>
          <GraphPane />
        </div>
        {showKnowledge && (
          <div
            className={`no-drag absolute top-0 left-0 z-10 h-full w-1.5 cursor-col-resize after:absolute after:inset-y-0 after:left-0 after:w-px hover:after:bg-accent-line ${
              dragging === 'knowledge' ? 'after:bg-accent-line' : ''
            }`}
            onPointerDown={(event) => startResize(event, 'knowledge')}
          />
        )}
      </aside>
    )
  }

  return (
    <>
      <div className="flex h-full flex-col overflow-hidden bg-canvas text-ink">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar />
          {activeBot && <BotPage bot={activeBot} />}
          {/* Stays mounted under an open bot, so drafts and scroll positions are kept. */}
          <div className={activeBot ? 'hidden' : 'contents'}>
            <ChatPane />
          </div>
          {rightPaneOrder.map((id) => panes[id])}
        </div>
        <StatusBar />
      </div>
      <NewProjectModal />
      <SettingsModal />
      <UsageModal />
    </>
  )
}

export default function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <WorkspaceProvider>
        <BotsProvider>
          <VoiceProvider>
            <Shell />
          </VoiceProvider>
        </BotsProvider>
      </WorkspaceProvider>
    </ThemeProvider>
  )
}
