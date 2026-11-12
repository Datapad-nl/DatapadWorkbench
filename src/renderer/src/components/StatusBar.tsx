import { useEffect, useState } from 'react'
import { chatAgentLabel } from '../../../shared/types'
import { useBots } from '../bots'
import { useWorkspace } from '../workspace'
import { Icon } from './icons'

const USAGE_REFRESH_MS = 5 * 60 * 1000

type Usage = { percent: number; resets: string | null }

/** `2026-11-04T16:20:00Z` → `2h 14m`, or null once it has passed. */
function untilReset(iso: string | null): string | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return null
  const minutes = Math.round(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  if (days >= 1) return `${days}d ${Math.floor((minutes % 1440) / 60)}h`
  const hours = Math.floor(minutes / 60)
  return hours >= 1 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

const INDEX_LABEL: Partial<Record<string, string>> = {
  indexed: 'CodeGraph indexed',
  indexing: 'Indexing…',
  installing: 'Installing CodeGraph…',
  'not-indexed': 'Not indexed',
  error: 'Index failed'
}

export function StatusBar(): React.JSX.Element {
  const {
    showUsage,
    setShowUsage,
    settings,
    projects,
    indexes,
    activeProjectId,
    activeChatId,
    chatsById
  } = useWorkspace()
  const { bots } = useBots()
  const [usage, setUsage] = useState<Usage | null>(null)
  // Same order as the usage panel: the default agent's plan, or Claude's when it is the only one.
  const claudeOn = settings?.claude.signedIn === true
  const onClaude =
    claudeOn && (settings?.defaultAgent === 'claude' || settings?.grokBuildSignedIn !== true)

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      try {
        if (onClaude) {
          const next = await window.workbench.getClaudeUsage()
          const top = next.limits.reduce<(typeof next.limits)[number] | null>(
            (best, limit) => (!best || limit.usedPercent > best.usedPercent ? limit : best),
            null
          )
          if (!cancelled) setUsage(top ? { percent: top.usedPercent, resets: top.resets } : null)
          return
        }
        if (!window.workbench.getUsage) return
        const next = await window.workbench.getUsage()
        if (!cancelled) {
          setUsage(
            next.usedPercent == null
              ? null
              : { percent: next.usedPercent, resets: untilReset(next.periodEnd) }
          )
        }
      } catch {
        if (!cancelled) setUsage(null)
      }
    }

    void load()
    const timer = window.setInterval(() => {
      void load()
    }, USAGE_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [showUsage, onClaude])

  const activeChat = activeChatId ? chatsById[activeChatId] : undefined
  // A chat without an agent field predates Claude support, so it runs Grok.
  const agent = activeChat ? (activeChat.agent ?? 'grok') : settings?.defaultAgent
  const connected =
    agent === 'claude' ? claudeOn : agent === 'grok' ? settings?.grokBuildSignedIn === true : false
  // A bot's chat works in the bot's folder, whatever project the sidebar is on; a run asked with @ in its project's.
  const bot = activeChat?.botId ? bots.find((item) => item.id === activeChat.botId) : undefined
  const project = projects.find((item) => item.id === (bot ? activeChat?.projectId : activeProjectId)) ?? null
  const folder = project?.path ?? bot?.folder
  const indexLabel = project ? INDEX_LABEL[indexes[project.id]?.state ?? ''] : undefined
  const percent = usage ? Math.min(100, Math.max(0, usage.percent)) : null
  const usageText =
    percent == null
      ? null
      : `${Math.round(percent)}%${usage?.resets ? ` · resets ${usage.resets}` : ''}`

  return (
    <footer className="drag flex h-statusbar shrink-0 items-center gap-4 border-t border-line bg-sidebar px-3 text-[11px] text-muted">
      <span className="flex shrink-0 items-center gap-1.5" data-testid="agent-status">
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-ok' : 'bg-danger'}`} />
        {connected ? 'Connected' : 'Disconnected'}
        {agent && <span className="text-faint">· {chatAgentLabel(agent)} agent</span>}
      </span>
      {indexLabel && (
        <span className="flex shrink-0 items-center gap-1.5">
          <Icon name="database" size={12} className="text-faint" />
          {indexLabel}
        </span>
      )}
      {folder && (
        <span className="flex min-w-0 items-center gap-1.5" title={folder}>
          <Icon name="folder" size={12} className="shrink-0 text-faint" />
          <span className="truncate font-mono">{folder}</span>
        </span>
      )}
      <div className="flex-1" />
      <button
        type="button"
        data-testid="open-usage"
        className={`no-drag flex h-5 shrink-0 items-center gap-2 rounded-[5px] px-1.5 hover:bg-hover hover:text-ink ${
          showUsage ? 'bg-hover text-ink' : ''
        }`}
        title={usageText ? `Usage · ${usageText}` : 'Usage'}
        aria-expanded={showUsage}
        onClick={() => setShowUsage(!showUsage)}
      >
        Usage
        <span className="h-1 w-16 overflow-hidden rounded-full bg-line-strong">
          {percent != null && (
            <span
              className={`block h-full rounded-full ${percent >= 90 ? 'bg-danger' : 'bg-accent'}`}
              style={{ width: `${percent}%` }}
            />
          )}
        </span>
        {usageText && <span className="tabular-nums">{usageText}</span>}
      </button>
      <span className="flex shrink-0 items-center gap-1 text-faint">
        <Icon name="command" size={12} />K Search
      </span>
      <span className="shrink-0 tabular-nums text-faint" data-testid="app-version">
        v{__APP_VERSION__}
      </span>
    </footer>
  )
}
