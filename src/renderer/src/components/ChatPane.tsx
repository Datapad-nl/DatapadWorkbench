import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Attachment,
  ChatPlan,
  ChatPullRequest,
  ChatSummary,
  Checkpoint,
  FileHit,
  FileMention,
  Message,
  PermissionMode,
  PermissionRequest,
  PlanEntry,
  PlanVerdict,
  Project,
  ProjectIndex,
  UserQuestionRequest,
  AgentCommand
} from '../../../shared/types'
import {
  commandAt,
  completeSlash,
  filterSlashCommands,
  matchedSlashAlias,
  parseSlashLine,
  slashCommandsFor,
  type SlashDef
} from '../../../shared/slash'
import { plainReply } from '../../../shared/steps'
import {
  chatAgentLabel,
  formatGrokCli,
  nextPermissionMode,
  normalizeChatAgent,
  normalizePermissionMode,
  normalizeReasoningEffort,
  reasoningEffortLabel,
  type ChatAgent
} from '../../../shared/types'
import { useChatProgress } from '../progress'
import { VoiceBlob } from '../voice/VoiceBlob'
import { useVoice } from '../voice/VoiceProvider'
import { useStreams, useWorkspace, type RightPaneId } from '../workspace'
import { AgentReply } from './AgentReply'
import { AgentGlyph, Icon, IconButton, type IconName } from './icons'
import { Markdown } from './Markdown'
import { ProjectOrientation } from './OrientationCard'
import wordmark from '../assets/wordmark.png'

const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

function planStillOpen(plan: ChatPlan | null | undefined): boolean {
  return Boolean(plan?.awaitingApproval)
}

const DOCS_URL = 'https://docs.x.ai/build/overview'
const USAGE_URL = 'https://grok.com/?_s=usage'

type SlashRun = {
  def: SlashDef
  args: string
  draft: { attachments: Attachment[]; mentions: FileMention[] }
  chatId: string
  projectId: string
  agent: ChatAgent
  title: string
  sessionHint: string | null
  messages: Message[]
  createChat: (projectId: string) => Promise<void>
  deleteChat: (chatId: string) => Promise<void>
  renameChat: (chatId: string, title: string) => Promise<void>
  sendMessage: (
    chatId: string,
    content: string,
    attachments?: Attachment[],
    mentions?: FileMention[]
  ) => Promise<boolean>
  setChatMode: (chatId: string, mode: PermissionMode) => Promise<void>
  saveSettings: (input: { model?: string; claudeModel?: string; effort?: string | null }) => Promise<void>
  setShowSettings: (open: boolean | 'mcp') => void
  setShowUsage: (open: boolean) => void
  openRewind: () => void
}

function errorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function conversationMarkdown(messages: Message[]): string {
  return messages
    .map((message) => {
      const who = message.role === 'user' ? 'You' : 'Agent'
      const extras = (message.mentions ?? []).map((item) => `@${item.path}`).join(' ')
      return `## ${who}\n\n${plainReply(message.content)}${extras ? `\n\n${extras}` : ''}`
    })
    .join('\n\n')
}

async function sendSlash(input: SlashRun, content: string): Promise<void> {
  const ok = await input.sendMessage(input.chatId, content, input.draft.attachments, input.draft.mentions)
  if (!ok) throw new Error(`Could not send /${input.def.id}`)
}

async function runSlash(input: SlashRun): Promise<string | null> {
  const { def, args } = input
  if (def.kind === 'unavailable') {
    return `/${def.id} is a ${chatAgentLabel(input.agent)} terminal command. Not available in Datapad Workbench.`
  }
  if (def.kind === 'agent') {
    await sendSlash(input, args ? `/${def.id} ${args}` : `/${def.id}`)
    return null
  }
  if (def.kind === 'prompt') {
    const body = args ? `${def.prompt ?? ''} ${args}`.trim() : (def.prompt ?? '').trim()
    if (!body) return `Usage: /${def.id} <args>`
    await sendSlash(input, body)
    return null
  }
  switch (def.id) {
    case 'new':
      await input.createChat(input.projectId)
      return null
    case 'rewind':
      input.openRewind()
      return null
    case 'plan':
      await input.setChatMode(input.chatId, 'plan')
      if (args) await sendSlash(input, args)
      return args ? null : 'Plan mode on'
    case 'ask':
      await input.setChatMode(input.chatId, 'ask')
      return 'Ask mode on'
    case 'always-approve':
      await input.setChatMode(input.chatId, 'accept')
      return 'Auto-approve on'
    case 'copy': {
      const replies = input.messages.filter((message) => message.role === 'assistant')
      const offset = args && /^\d+$/.test(args) ? Number(args) : 1
      const reply = replies.at(-offset)
      if (!reply?.content) return 'No reply to copy'
      return (await copyText(plainReply(reply.content))) ? 'Copied last reply' : 'Could not copy'
    }
    case 'export': {
      const text = conversationMarkdown(input.messages)
      if (!text.trim()) return 'Nothing to export'
      const saved = await window.workbench.exportChatMarkdown(input.title, text).catch(() => undefined)
      if (saved === undefined) return 'Could not save the export'
      return saved ? `Saved ${saved}` : 'Export cancelled'
    }
    case 'rename':
      if (!args) return 'Usage: /rename <title>'
      await input.renameChat(input.chatId, args)
      return `Renamed to ${args}`
    case 'delete':
      if (!confirm(`Delete “${input.title}”?`)) return null
      await input.deleteChat(input.chatId)
      return null
    case 'model':
      if (!args) {
        input.setShowSettings(true)
        return 'Opened settings — set the model there, or /model <id>'
      }
      // Each agent keeps its own model setting.
      await input.saveSettings(input.agent === 'claude' ? { claudeModel: args } : { model: args })
      return `Model set to ${args}`
    case 'effort': {
      if (!args) {
        input.setShowSettings(true)
        return 'Opened settings — set effort next to the model, or /effort low|medium|high|xhigh|max'
      }
      const effort = normalizeReasoningEffort(args)
      if (!effort) return 'Usage: /effort low | medium | high | xhigh | max'
      await input.saveSettings({ effort })
      return `Effort set to ${reasoningEffortLabel(effort)}`
    }
    case 'settings':
    case 'theme':
      input.setShowSettings(true)
      return null
    case 'mcps':
      input.setShowSettings('mcp')
      return null
    case 'docs':
      await window.workbench.openExternal(args.toLowerCase() === 'web' || !args ? DOCS_URL : DOCS_URL)
      return 'Opened docs'
    case 'usage':
      if (args.toLowerCase() === 'manage' && input.agent === 'grok') {
        await window.workbench.openExternal(USAGE_URL)
        return 'Opened billing'
      }
      input.setShowUsage(true)
      return null
    case 'login':
      input.setShowSettings(true)
      return 'Run `grok login` in a terminal, then come back'
    case 'logout':
      return 'Run `grok logout` in a terminal'
    case 'quit':
      await window.workbench.quitApp()
      return null
    case 'view-plan':
      return 'The plan card is in the thread when the agent writes one'
    case 'session-info':
      return [input.title, input.sessionHint].filter(Boolean).join(' · ') || 'Session'
    default:
      return `/${def.id} is not implemented`
  }
}

export function ChatPane(): React.JSX.Element {
  const {
    projects,
    chats,
    indexes,
    openChatIds,
    activeChatId,
    activeProjectId,
    chatsById,
    openChat,
    closeTab,
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
    settings,
    saveSettings,
    setShowSettings,
    setShowUsage,
    setShowNewProject,
    showSidebar,
    setShowSidebar,
    gitSummaries
  } = useWorkspace()
  const { stopAll } = useVoice()
  const streams = useStreams()
  const [rewind, setRewind] = useState<{ chatId: string; selected: string | null } | null>(null)
  const [rewindBusy, setRewindBusy] = useState(false)
  const [rewindError, setRewindError] = useState<string | null>(null)
  const drafts = useRef(new Map<string, ComposerDraft>())
  const restorers = useRef(new Map<string, (sent: ComposerDraft) => void>())

  if (rewind && rewind.chatId !== activeChatId && !rewindBusy && !rewindError) setRewind(null)
  const rewindTarget = rewind ? chatsById[rewind.chatId] : undefined

  function openRewind(chatId: string, checkpointId: string | null): void {
    if (rewindBusy) return
    setRewind({ chatId, selected: checkpointId })
    setRewindError(null)
  }

  const activeChat = activeChatId ? chatsById[activeChatId] : null
  const activeProject = projects.find(
    (project) => project.id === (activeChat?.projectId ?? activeProjectId)
  )
  const stream = activeChatId ? streams[activeChatId] : undefined
  const streamingNow = stream?.status === 'streaming'
  const progress = useChatProgress(activeChat?.id ?? null, Boolean(streamingNow))

  return (
    <section className="flex min-w-[320px] flex-1 flex-col bg-surface">
      <header className="drag flex h-titlebar shrink-0 items-center gap-2 border-b border-line bg-canvas px-3">
        {!showSidebar && (
          <div className="flex shrink-0 items-center pl-traffic">
            <IconButton icon="sidebar" label="Show sidebar" onClick={() => setShowSidebar(true)} />
          </div>
        )}
        <Icon name="folder" className="text-faint" />
        <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <span className="max-w-[200px] truncate text-muted" title={activeProject?.path ?? undefined}>
            {activeProject?.name ?? 'No project'}
          </span>
          {activeChat && (
            <>
              <span className="text-faint">/</span>
              <span className="truncate font-semibold text-ink" title={activeChat.title}>
                {activeChat.title}
              </span>
            </>
          )}
        </div>
        {activeProject && (
          <BranchChip
            branch={
              gitSummaries[activeProject.id]?.available
                ? (activeChat?.worktreeBranch ?? gitSummaries[activeProject.id]?.branch ?? null)
                : null
            }
          />
        )}
        {activeChat?.pr && <PrChip chatId={activeChat.id} pr={activeChat.pr} />}
        <div className="min-w-2 flex-1" />
        <PaneToggles />
      </header>
      <TabBar
        openChatIds={openChatIds}
        activeChatId={activeChatId}
        chats={chats}
        projects={projects}
        streams={streams}
        onOpen={(id) => void openChat(id)}
        onClose={closeTab}
        onNew={() => {
          if (activeProject) void createChat(activeProject.id)
          else setShowNewProject(true)
        }}
      />
      {!activeChat ? (
        <EmptyState
          projectId={activeProject?.id ?? null}
          projectName={activeProject?.name ?? null}
          agent={normalizeChatAgent(settings?.defaultAgent)}
          index={activeProject ? indexes[activeProject.id] : undefined}
          onNewChat={() => {
            if (activeProject) void createChat(activeProject.id)
          }}
          onNewProject={() => setShowNewProject(true)}
        />
      ) : (
        <>
          <MessageList
            chat={activeChat}
            chatId={activeChat.id}
            agent={normalizeChatAgent(activeChat.agent)}
            projectId={activeChat.projectId}
            projectName={activeProject?.name ?? 'this project'}
            index={indexes[activeChat.projectId]}
            draft={streamingNow ? stream?.draft ?? '' : ''}
            streaming={Boolean(streamingNow)}
            progress={progress.label}
            error={stream?.error ?? null}
            plan={planStillOpen(activeChat.plan) ? (activeChat.plan ?? null) : null}
            checkpoints={activeChat.checkpoints ?? []}
            canApprove={Boolean(activeChat.plan?.awaitingApproval)}
            onApprove={(verdict) => approvePlan(activeChat.id, verdict)}
            onRewind={(checkpointId) => openRewind(activeChat.id, checkpointId)}
            onSuggest={(text) => void sendMessage(activeChat.id, text)}
          />
          <Composer
            key={activeChat.id}
            streaming={Boolean(streamingNow)}
            progress={streamingNow ? progress.label : ''}
            mode={normalizePermissionMode(activeChat.mode)}
            permission={permissions[activeChat.id] ?? null}
            question={questions[activeChat.id] ?? null}
            history={activeChat.messages
              .filter((message) => message.role === 'user' && message.content.trim())
              .map((message) => message.content)}
            projectId={activeChat.projectId}
            chatId={activeChat.id}
            hasFolder={Boolean(activeProject?.path)}
            drafts={drafts}
            restorers={restorers}
            onSend={(text, attachments, mentions) =>
              sendMessage(activeChat.id, text, attachments, mentions)
            }
            onSlash={(def, args, draft) =>
              runSlash({
                def,
                args,
                draft,
                chatId: activeChat.id,
                projectId: activeChat.projectId,
                agent: normalizeChatAgent(activeChat.agent),
                title: activeChat.title,
                sessionHint: settings
                  ? (normalizeChatAgent(activeChat.agent) === 'claude'
                      ? [
                          'Claude Code',
                          settings.effort ? reasoningEffortLabel(settings.effort) : null,
                          settings.claude.subscription
                        ]
                      : [
                          settings.model,
                          settings.effort ? reasoningEffortLabel(settings.effort) : null,
                          settings.grokBuildSignedIn ? 'Grok Build' : settings.keySource,
                          settings.cliChecking ? null : formatGrokCli(settings.grokCli)
                        ]
                    )
                      .filter(Boolean)
                      .join(' · ')
                  : null,
                messages: activeChat.messages,
                createChat,
                deleteChat,
                renameChat,
                sendMessage,
                setChatMode,
                saveSettings,
                setShowSettings,
                setShowUsage,
                openRewind: () => openRewind(activeChat.id, activeChat.checkpoints?.at(-1)?.id ?? null)
              })
            }
            onStop={() => {
              stopAll()
              void stopChat(activeChat.id)
            }}
            onMode={(mode) => void setChatMode(activeChat.id, mode)}
            agent={normalizeChatAgent(activeChat.agent)}
            onAgent={
              !activeChat.grokSessionId &&
              activeChat.messages.length === 0 &&
              (settings?.claude.signedIn || normalizeChatAgent(activeChat.agent) === 'claude')
                ? (agent) => void setChatAgent(activeChat.id, agent)
                : null
            }
            onPermission={resolvePermission}
            onQuestion={resolveQuestion}
            onRewindMenu={() => openRewind(activeChat.id, activeChat.checkpoints?.at(-1)?.id ?? null)}
          />
        </>
      )}
      {rewind && rewindTarget && (
        <RewindModal
          checkpoints={[...(rewindTarget.checkpoints ?? [])].reverse()}
          selectedId={rewind.selected}
          busy={rewindBusy}
          error={rewindError}
          onSelect={(selected) => {
            setRewind({ ...rewind, selected })
            setRewindError(null)
          }}
          onClose={() => {
            if (rewindBusy) return
            setRewind(null)
            setRewindError(null)
          }}
          onRewind={() => {
            if (!rewind.selected || rewindBusy) return
            setRewindBusy(true)
            setRewindError(null)
            void rewindChat(rewind.chatId, rewind.selected)
              .then(() => setRewind(null))
              .catch((error: unknown) => setRewindError(errorText(error, 'Could not rewind')))
              .finally(() => setRewindBusy(false))
          }}
        />
      )}
    </section>
  )
}

function BranchChip({ branch }: { branch: string | null }): React.JSX.Element {
  return (
    <span
      title={branch ?? 'Not a git repository'}
      className="flex h-[22px] max-w-[220px] shrink-0 items-center gap-1 rounded-md border border-line-strong px-1.5 font-mono text-[11px] text-muted"
    >
      <Icon name="branch" size={12} className="text-faint" />
      <span className="truncate">{branch ?? 'no git'}</span>
    </span>
  )
}

const PR_REVIEW: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'needs review'
}

/** The pull request linked to the chat: checks as a dot, review state, click to open it. */
function PrChip({ chatId, pr }: { chatId: string; pr: ChatPullRequest }): React.JSX.Element {
  const open = pr.state === 'OPEN'
  const dot = !open
    ? 'bg-faint'
    : pr.checks === 'failing'
      ? 'bg-danger'
      : pr.checks === 'pending'
        ? 'bg-accent animate-pulse'
        : pr.checks === 'passing'
          ? 'bg-ok'
          : 'bg-line-strong'
  const label = open ? (pr.isDraft ? 'draft' : pr.review ? PR_REVIEW[pr.review] : null) : pr.state.toLowerCase()
  const title = [
    `#${pr.number} ${pr.title}`,
    `Checks: ${pr.checksSummary}`,
    `Review: ${pr.review ? (PR_REVIEW[pr.review] ?? pr.review.toLowerCase()) : 'none required'}`,
    pr.watch ? 'Watching: this chat gets a message when checks finish or a review comes in' : 'Not watching',
    'Click to open it in the browser'
  ].join('\n')
  return (
    <span
      data-testid="chat-pr"
      className="no-drag group/pr flex h-[22px] max-w-[260px] shrink-0 items-center rounded-md border border-line-strong text-[11px] text-muted"
    >
      <button
        type="button"
        title={title}
        onClick={() => void window.workbench.navigateBrowser(pr.url)}
        className="flex min-w-0 items-center gap-1.5 px-1.5 hover:text-ink"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="font-mono">#{pr.number}</span>
        {label && <span className="truncate">{label}</span>}
        {pr.watch && <Icon name="eye" size={11} className="shrink-0 text-faint" />}
      </button>
      <button
        type="button"
        title="Unlink this pull request"
        aria-label="Unlink pull request"
        onClick={() => {
          if (window.confirm(`Unlink #${pr.number} from this chat and stop watching it?`)) void window.workbench.unlinkPr(chatId)
        }}
        className="hidden pr-1 text-faint hover:text-ink group-hover/pr:block"
      >
        <Icon name="close" size={10} />
      </button>
    </span>
  )
}

const PANE_BUTTONS: { id: RightPaneId; icon: IconName; label: string; testId: string }[] = [
  { id: 'git', icon: 'commit', label: 'Git', testId: 'open-git' },
  { id: 'browser', icon: 'globe', label: 'Browser', testId: 'open-browser' },
  { id: 'activity', icon: 'pulse', label: 'Activity', testId: 'open-activity' },
  { id: 'knowledge', icon: 'book', label: 'Knowledge', testId: 'open-knowledge' }
]

/** The segmented group that opens and closes the right panes. */
function PaneToggles(): React.JSX.Element {
  const {
    showGit,
    showBrowser,
    showActivity,
    showKnowledge,
    setShowGit,
    setShowBrowser,
    setShowActivity,
    setShowKnowledge
  } = useWorkspace()
  const state: Record<RightPaneId, [boolean, (open: boolean) => void]> = {
    git: [showGit, setShowGit],
    browser: [showBrowser, setShowBrowser],
    activity: [showActivity, setShowActivity],
    knowledge: [showKnowledge, setShowKnowledge]
  }
  return (
    <div className="no-drag flex shrink-0 items-center gap-0.5 rounded-[9px] border border-line bg-sidebar p-0.5">
      {PANE_BUTTONS.map((pane) => {
        const [open, setOpen] = state[pane.id]
        return (
          <IconButton
            key={pane.id}
            icon={pane.icon}
            label={`${open ? 'Hide' : 'Show'} ${pane.label}`}
            testId={pane.testId}
            active={open}
            size={26}
            onClick={() => setOpen(!open)}
          />
        )
      })}
    </div>
  )
}

function TabBar({
  openChatIds,
  activeChatId,
  chats,
  projects,
  streams,
  onOpen,
  onClose,
  onNew
}: {
  openChatIds: string[]
  activeChatId: string | null
  chats: ChatSummary[]
  projects: Project[]
  streams: Record<string, { status: string }>
  onOpen: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}): React.JSX.Element {
  const tabs = useMemo(() => {
    const projectById = new Map(projects.map((project) => [project.id, project]))
    return new Map(
      chats.map((chat) => [
        chat.id,
        { title: chat.title, projectName: projectById.get(chat.projectId)?.name ?? 'Project' }
      ])
    )
  }, [chats, projects])

  return (
    <div className="relative flex h-10 shrink-0 items-end bg-canvas px-3 before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-line">
      <div className="flex min-w-0 items-end gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
        {openChatIds.map((id) => {
          const active = id === activeChatId
          const streaming = streams[id]?.status === 'streaming'
          const tab = tabs.get(id)
          return (
            <div
              key={id}
              title={tab ? `${tab.projectName} · ${tab.title}` : 'Chat'}
              className={`group relative z-[1] flex h-[34px] max-w-[240px] shrink-0 items-center gap-1 rounded-t-lg border border-b-0 pr-1 pl-3 ${
                active
                  ? 'border-line bg-surface text-ink'
                  : 'border-transparent text-muted hover:bg-hover hover:text-ink'
              }`}
            >
              <button className="flex min-w-0 items-center gap-2" onClick={() => onOpen(id)}>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    active || streaming ? 'bg-accent' : 'bg-faint'
                  } ${streaming ? 'streaming-dot' : ''}`}
                />
                <span className={`truncate text-[12.5px] ${active ? 'font-medium' : ''}`}>
                  {tab?.title ?? 'Chat'}
                </span>
              </button>
              <button
                aria-label="Close tab"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:bg-hover hover:text-ink focus-visible:opacity-100 ${
                  active ? '' : 'opacity-0 group-hover:opacity-100'
                }`}
                onClick={() => onClose(id)}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="mb-[5px] ml-1">
        <IconButton icon="plus" label="New chat" size={24} onClick={onNew} testId="tab-new-chat" />
      </div>
    </div>
  )
}

const SUGGESTIONS = [
  'Give me a tour of this codebase',
  'Find likely bugs in the recent changes',
  'Suggest tests for the least covered code'
]

function AgentTile({ agent, size = 28 }: { agent: ChatAgent; size?: number }): React.JSX.Element {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-[8px] bg-ink text-canvas"
      style={{ width: size, height: size }}
    >
      <AgentGlyph agent={agent} size={Math.round(size * 0.5)} />
    </div>
  )
}

function EmptyHero({
  agent,
  projectName,
  children
}: {
  agent: ChatAgent
  projectName: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center text-center">
      <AgentTile agent={agent} size={40} />
      <h1 className="mt-4 text-[20px] font-semibold tracking-tight text-ink">
        What should we build in <span className="text-accent">{projectName}</span>?
      </h1>
      {children}
    </div>
  )
}

function EmptyState({
  projectId,
  projectName,
  agent,
  index,
  onNewChat,
  onNewProject
}: {
  projectId: string | null
  projectName: string | null
  agent: ChatAgent
  index: ProjectIndex | undefined
  onNewChat: () => void
  onNewProject: () => void
}): React.JSX.Element {
  if (!projectId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-5">
        <img src={wordmark} alt="Datapad Workbench" className="h-11 w-auto select-none" draggable={false} />
        <p className="mt-5 max-w-md text-center text-[14.5px] leading-[1.6] text-muted">
          Open a project folder, then start as many chats as you need. Chats keep working when you
          switch tabs.
        </p>
        <button
          data-testid="empty-new-project"
          className="mt-6 flex h-8 items-center gap-1.5 rounded-[10px] bg-accent px-3.5 text-[13px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px"
          onClick={onNewProject}
        >
          <Icon name="plus" size={13} />
          New project
        </button>
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-[min(720px,100%-40px)] flex-col gap-8 py-16">
        <EmptyHero agent={agent} projectName={projectName ?? 'this project'}>
          <button
            data-testid="empty-new-chat"
            className="mt-6 flex h-8 items-center gap-1.5 rounded-[10px] bg-accent px-3.5 text-[13px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px"
            onClick={onNewChat}
          >
            <Icon name="plus" size={13} />
            New chat
          </button>
        </EmptyHero>
        <ProjectOrientation projectId={projectId} index={index} />
      </div>
    </div>
  )
}

function dayLabel(date: Date): string {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (date.toDateString() === today.toDateString()) return `Today · ${time}`
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`
  const day = date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  })
  return `${day} · ${time}`
}

function clockTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function DayDivider({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 text-[11px] tabular-nums text-faint">
      <span className="h-px flex-1 bg-line" />
      {label}
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

function ReplyAction({
  icon,
  label,
  onClick
}: {
  icon: IconName
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-muted"
    >
      <Icon name={icon} size={13} />
    </button>
  )
}

function CopyAction({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <ReplyAction
      icon={copied ? 'check' : 'copy'}
      label={copied ? 'Copied' : 'Copy reply'}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setCopied(false), 1200)
        })
      }}
    />
  )
}

function AssistantHeader({ agent, meta }: { agent: ChatAgent; meta?: string }): React.JSX.Element {
  return (
    <div className="flex h-7 items-center gap-2">
      <span className="text-[13px] font-semibold text-ink">{chatAgentLabel(agent)}</span>
      {meta && <span className="text-[11px] tabular-nums text-faint">{meta}</span>}
    </div>
  )
}

function MessageList({
  chat,
  chatId,
  agent,
  projectId,
  projectName,
  index,
  draft,
  streaming,
  progress,
  error,
  plan,
  checkpoints,
  canApprove,
  onApprove,
  onRewind,
  onSuggest
}: {
  chat: { messages: Message[] }
  chatId: string
  agent: ChatAgent
  projectId: string
  projectName: string
  index: ProjectIndex | undefined
  draft: string
  streaming: boolean
  progress: string
  error: string | null
  plan: ChatPlan | null
  checkpoints: Checkpoint[]
  canApprove: boolean
  onApprove: (verdict: PlanVerdict) => Promise<void>
  onRewind: (checkpointId: string) => void
  onSuggest: (text: string) => void
}): React.JSX.Element {
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [chat.messages, draft, plan, progress, streaming])

  const empty =
    chat.messages.length === 0 &&
    !draft &&
    !streaming &&
    !(plan && (plan.entries.length > 0 || plan.awaitingApproval || plan.markdown?.trim()))

  let lastDay = ''

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {empty ? (
        <div className="mx-auto flex w-[min(720px,100%-40px)] flex-col gap-8 py-16">
          <EmptyHero agent={agent} projectName={projectName}>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((text) => (
                <button
                  key={text}
                  type="button"
                  data-testid="empty-suggestion"
                  className="rounded-[14px_14px_4px_14px] border border-line-strong bg-raised px-3.5 py-2 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
                  onClick={() => onSuggest(text)}
                >
                  {text}
                </button>
              ))}
            </div>
          </EmptyHero>
          <ProjectOrientation projectId={projectId} index={index} />
        </div>
      ) : (
        <div className="mx-auto flex w-[min(720px,100%-40px)] flex-col gap-7 py-8">
          {chat.messages.map((message) => {
            const checkpoint = checkpoints.find((item) => item.messageId === message.id)
            const date = new Date(message.createdAt)
            const day = Number.isNaN(date.getTime()) ? '' : date.toDateString()
            const divider = day && day !== lastDay ? dayLabel(date) : null
            if (day) lastDay = day
            const side = message.kind === 'btw' ? 'btw' : message.kind === 'steer' ? 'steer' : null
            const extras = (
              <>
                {message.mentions && message.mentions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {message.mentions.map((mention) => (
                      <MentionChip key={mention.path} mention={mention} />
                    ))}
                  </div>
                )}
                {message.attachments && message.attachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {message.attachments.map((attachment) => (
                      <img
                        key={attachment.id}
                        src={`data:${attachment.mimeType};base64,${attachment.data}`}
                        alt="Screenshot"
                        className="max-h-64 max-w-full rounded-[8px] border border-line"
                      />
                    ))}
                  </div>
                )}
              </>
            )
            return (
              <div key={message.id} className="flex flex-col gap-7">
                {divider && <DayDivider label={divider} />}
                {message.role === 'user' ? (
                  <article className="group flex flex-col items-end">
                    {side && <div className="mb-1 text-[11px] text-faint">{side}</div>}
                    <div className="max-w-[560px] rounded-[14px_14px_4px_14px] border border-line-strong bg-raised px-4 py-2.5 text-[14.5px] leading-[1.6] whitespace-pre-wrap text-ink">
                      {message.content}
                    </div>
                    <div className="flex max-w-[560px] flex-col items-end">{extras}</div>
                    <div className="mt-1 flex h-5 items-center gap-1 text-[11px] tabular-nums text-faint">
                      {checkpoint && (
                        <button
                          type="button"
                          title="Rewind to before this message"
                          className="flex items-center gap-1 rounded px-1 opacity-0 group-hover:opacity-100 hover:text-muted focus-visible:opacity-100"
                          onClick={() => onRewind(checkpoint.id)}
                        >
                          <Icon name="retry" size={11} />
                          Rewind
                        </button>
                      )}
                      {clockTime(message.createdAt)}
                    </div>
                  </article>
                ) : (
                  <article className="flex gap-3">
                    <AgentTile agent={agent} />
                    <div className="min-w-0 flex-1">
                      <AssistantHeader agent={agent} meta={side === 'btw' ? 'side answer' : undefined} />
                      <div className="mt-1 text-[14.5px] leading-[1.65]">
                        {message.content ? <AgentReply text={message.content} chatId={chatId} /> : null}
                        {message.kind === 'btw' && !message.content ? <span className="cursor" /> : null}
                      </div>
                      {extras}
                      {message.content && (
                        <div className="mt-2 flex items-center gap-0.5">
                          <CopyAction text={plainReply(message.content)} />
                          {checkpoint && (
                            <ReplyAction
                              icon="retry"
                              label="Rewind to here"
                              onClick={() => onRewind(checkpoint.id)}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                )}
              </div>
            )
          })}
          {(draft || streaming) && (
            <article className="flex gap-3">
              <AgentTile agent={agent} />
              <div className="min-w-0 flex-1">
                <AssistantHeader agent={agent} />
                <div className="mt-1 text-[14.5px] leading-[1.65]">
                  {draft ? <AgentReply text={draft} chatId={chatId} live /> : null}
                </div>
                {streaming && (
                  <div
                    data-testid="chat-progress"
                    className={`flex items-start gap-2 ${draft ? 'mt-3' : 'mt-1'}`}
                  >
                    <span className="streaming-dot mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <div className="text-[13px] leading-6 text-muted">{progress}</div>
                  </div>
                )}
                {draft ? <span className="cursor" /> : null}
              </div>
            </article>
          )}
          {error && <div className="text-[13px] text-danger">{error}</div>}
          {plan && (plan.entries.length > 0 || plan.awaitingApproval || plan.markdown?.trim()) && (
            <PlanCard key={chatId} plan={plan} chatId={chatId} canApprove={canApprove} onApprove={onApprove} />
          )}
        </div>
      )}
      <div ref={bottom} />
    </div>
  )
}

async function fileToAttachment(file: Blob, mimeType: string): Promise<Attachment | null> {
  if (file.size > MAX_IMAGE_BYTES) return null
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return {
    id: crypto.randomUUID(),
    mimeType,
    data: btoa(binary)
  }
}

async function attachmentsFromClipboard(event: React.ClipboardEvent): Promise<Attachment[]> {
  const next: Attachment[] = []
  const items = [...event.clipboardData.items]
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (!file) continue
    const attachment = await fileToAttachment(file, item.type || 'image/png')
    if (attachment) next.push(attachment)
  }
  return next
}

function caretOnFirstLine(el: HTMLTextAreaElement): boolean {
  return !el.value.slice(0, el.selectionStart).includes('\n')
}

function caretOnLastLine(el: HTMLTextAreaElement): boolean {
  return !el.value.slice(el.selectionStart).includes('\n')
}

const MODE_LABEL: Record<PermissionMode, string> = {
  ask: 'Ask',
  accept: 'Auto',
  plan: 'Plan'
}

const MODE_HINT: Record<PermissionMode, string> = {
  ask: 'Tools wait for Allow',
  accept: 'Tools auto-approved',
  plan: 'Read-only until you approve'
}

const CARD = 'rounded-[8px] border border-line-strong bg-raised px-4 py-3'
const PRIMARY_BUTTON =
  'flex h-8 shrink-0 items-center rounded-[10px] bg-accent px-3.5 text-[12.5px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px disabled:opacity-45'
const QUIET_BUTTON =
  'flex h-8 items-center rounded-[10px] px-3 text-[12.5px] text-muted hover:bg-hover hover:text-ink disabled:opacity-45'

function usePending(fallback: string): {
  busy: boolean
  error: string | null
  run: (action: () => Promise<void>) => void
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  function run(action: () => Promise<void>): void {
    if (busy) return
    setBusy(true)
    setError(null)
    void action()
      .catch((caught: unknown) => setError(errorText(caught, fallback)))
      .finally(() => setBusy(false))
  }
  return { busy, error, run }
}

function PlanMark({ status }: { status: PlanEntry['status'] }): React.JSX.Element {
  if (status === 'completed') return <span className="text-accent">✓</span>
  if (status === 'in_progress') return <span className="text-accent">→</span>
  return <span className="text-muted">○</span>
}

function PlanCard({
  plan,
  chatId,
  canApprove,
  onApprove
}: {
  plan: ChatPlan
  chatId: string
  canApprove: boolean
  onApprove: (verdict: PlanVerdict) => Promise<void>
}): React.JSX.Element {
  const { busy, error, run } = usePending('Could not answer the plan')
  const markdown = plan.markdown?.trim()
  return (
    <div className={CARD}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] text-faint">{plan.awaitingApproval ? 'Plan ready' : 'Plan'}</div>
          <div className="mt-0.5 text-[13px] font-semibold text-ink">{plan.title}</div>
        </div>
      </div>
      {markdown ? (
        <div className="mt-3 max-h-[min(50vh,420px)] overflow-y-auto rounded-[8px] border border-line bg-surface px-3 py-2">
          <Markdown text={markdown} chatId={chatId} />
        </div>
      ) : plan.entries.length > 0 ? (
        <ol className="mt-3 flex flex-col gap-1.5">
          {plan.entries.map((entry, index) => (
            <li
              key={`${index}:${entry.content}`}
              className={`flex gap-2 text-[13px] leading-5 ${
                entry.status === 'completed' ? 'text-muted line-through' : 'text-ink-2'
              }`}
            >
              <span className="w-4 shrink-0 text-center font-mono text-[11px]">
                <PlanMark status={entry.status} />
              </span>
              <span>{entry.content}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="mt-3 text-[13px] text-muted">No plan written yet.</div>
      )}
      {canApprove && error && <div className="mt-3 text-[13px] text-danger">{error}</div>}
      {canApprove && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className={QUIET_BUTTON}
            disabled={busy}
            onClick={() => run(() => onApprove('abandon'))}
          >
            Quit plan
          </button>
          <button
            type="button"
            className={QUIET_BUTTON}
            disabled={busy}
            onClick={() => run(() => onApprove('revise'))}
          >
            Request changes
          </button>
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={busy}
            onClick={() => run(() => onApprove('approve'))}
          >
            Approve & implement
          </button>
        </div>
      )}
    </div>
  )
}

function PermissionBar({
  request,
  onDecision
}: {
  request: PermissionRequest
  onDecision: (decision: 'allow' | 'deny') => Promise<void>
}): React.JSX.Element {
  const { busy, error, run } = usePending('Could not answer the request')
  return (
    <div className={`mb-3 ${CARD}`}>
      <div className="flex items-center gap-1.5 text-[11px] text-faint">
        <Icon name="shield" size={12} className="text-accent" />
        Permission
      </div>
      <div className="mt-1 text-[13px] font-semibold text-ink">{request.title}</div>
      {request.detail && (
        <div className="mt-1 line-clamp-2 font-mono text-[11.5px] text-muted">{request.detail}</div>
      )}
      {error && <div className="mt-2 text-[13px] text-danger">{error}</div>}
      <div className="mt-3 flex justify-end gap-2">
        <button className={QUIET_BUTTON} disabled={busy} onClick={() => run(() => onDecision('deny'))}
        >
          Deny
        </button>
        <button className={PRIMARY_BUTTON} disabled={busy} onClick={() => run(() => onDecision('allow'))}
        >
          Allow
        </button>
      </div>
    </div>
  )
}

const OTHER_LABEL = 'Other'

function QuestionCard({
  request,
  onDecision
}: {
  request: UserQuestionRequest
  onDecision: (
    requestId: string,
    decision: { type: 'skip' } | { type: 'submit'; answers: string[][] }
  ) => Promise<void>
}): React.JSX.Element {
  const { busy, error, run } = usePending('Could not send the answer')
  const [picked, setPicked] = useState<string[][]>(() => request.questions.map(() => []))
  const [other, setOther] = useState<string[]>(() => request.questions.map(() => ''))
  const [usingOther, setUsingOther] = useState<boolean[]>(() => request.questions.map(() => false))

  function toggle(index: number, label: string, multi: boolean): void {
    setUsingOther((current) => current.map((item, i) => (i === index ? false : item)))
    setPicked((current) =>
      current.map((selected, i) => {
        if (i !== index) return selected
        if (multi) {
          return selected.includes(label)
            ? selected.filter((item) => item !== label)
            : [...selected, label]
        }
        return [label]
      })
    )
  }

  function answers(): string[][] {
    return request.questions.map((_, index) => {
      if (usingOther[index]) {
        const text = other[index]?.trim()
        return text ? [text] : []
      }
      return picked[index] ?? []
    })
  }

  const ready = answers().every((item) => item.length > 0)
  const count = request.questions.length

  return (
    <div
      data-testid="question-card"
      className={`mb-3 max-h-[min(70vh,560px)] overflow-y-auto ${CARD}`}
    >
      <div className="text-[11px] text-faint">
        {request.title?.trim() || `Ask ${count} question${count === 1 ? '' : 's'}`}
      </div>
      <div className="mt-3 flex flex-col gap-5">
        {request.questions.map((question, index) => {
          const selected = picked[index] ?? []
          const otherOn = usingOther[index]
          return (
            <div key={`${index}:${question.question}`}>
              {question.header && question.header !== question.question && (
                <div className="mb-1 text-[11px] text-faint">
                  {question.header}
                </div>
              )}
              <div className="text-[13px] leading-5 font-semibold text-ink">{question.question}</div>
              <div className="mt-2 flex flex-col gap-1.5">
                {question.options.map((option) => {
                  const on = !otherOn && selected.includes(option.label)
                  const recommended = /\(recommended\)/i.test(option.label)
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={`rounded-[8px] border px-3 py-2 text-left transition active:translate-y-px ${
                        on
                          ? 'border-accent-line bg-accent-soft'
                          : 'border-line bg-surface hover:border-line-strong hover:bg-hover'
                      }`}
                      onClick={() => toggle(index, option.label, question.multiSelect)}
                    >
                      <div className={`text-[13px] ${recommended ? 'font-medium text-ink' : 'text-ink'}`}>
                        {option.label}
                      </div>
                      {option.description && (
                        <div className="mt-0.5 text-[12px] leading-4 text-muted">{option.description}</div>
                      )}
                    </button>
                  )
                })}
                <button
                  type="button"
                  className={`rounded-[8px] border px-3 py-2 text-left transition ${
                    otherOn
                      ? 'border-accent-line bg-accent-soft'
                      : 'border-line bg-surface hover:border-line-strong hover:bg-hover'
                  }`}
                  onClick={() => {
                    setUsingOther((current) => current.map((item, i) => (i === index ? true : item)))
                    setPicked((current) => current.map((item, i) => (i === index ? [] : item)))
                  }}
                >
                  <div className="text-[13px] text-ink">{OTHER_LABEL}</div>
                  {otherOn && (
                    <input
                      autoFocus
                      className="mt-2 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-muted focus:border-accent/50"
                      placeholder="Type your answer"
                      value={other[index] ?? ''}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        const value = event.target.value
                        setOther((current) => current.map((item, i) => (i === index ? value : item)))
                      }}
                    />
                  )}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {error && <div className="mt-3 text-[13px] text-danger">{error}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className={QUIET_BUTTON}
          disabled={busy}
          onClick={() => run(() => onDecision(request.requestId, { type: 'skip' }))}
        >
          Skip
        </button>
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={!ready || busy}
          onClick={() => run(() => onDecision(request.requestId, { type: 'submit', answers: answers() }))}
        >
          Submit
        </button>
      </div>
    </div>
  )
}

function ModeToggle({
  mode,
  onMode
}: {
  mode: PermissionMode
  onMode: (mode: PermissionMode) => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 gap-0.5 rounded-[8px] bg-surface p-0.5">
      {(['ask', 'accept', 'plan'] as const).map((item) => (
        <button
          key={item}
          type="button"
          aria-pressed={mode === item}
          className={`h-6 rounded-[6px] px-2 text-[12.5px] ${
            mode === item
              ? 'bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--color-accent-line)]'
              : 'text-muted hover:text-ink'
          }`}
          onClick={() => onMode(item)}
        >
          {MODE_LABEL[item]}
        </button>
      ))}
    </div>
  )
}

function AgentToggle({
  agent,
  onAgent
}: {
  agent: ChatAgent
  onAgent: ((agent: ChatAgent) => void) | null
}): React.JSX.Element {
  if (!onAgent) {
    return (
      <div
        data-testid="chat-agent"
        className="flex h-7 shrink-0 items-center gap-1.5 px-1.5 text-[12.5px] text-muted"
      >
        <AgentGlyph agent={agent} size={12} />
        {chatAgentLabel(agent)}
      </div>
    )
  }
  return (
    <label
      data-testid="chat-agent"
      className="relative flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-[7px] px-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink"
    >
      <AgentGlyph agent={agent} size={12} />
      {chatAgentLabel(agent)}
      <Icon name="chevronDown" size={11} className="text-faint" />
      <select
        aria-label="Agent"
        className="absolute inset-0 cursor-pointer opacity-0"
        value={agent}
        onChange={(event) => onAgent(event.target.value as ChatAgent)}
      >
        {(['grok', 'claude'] as const).map((item) => (
          <option key={item} value={item}>
            {chatAgentLabel(item)}
          </option>
        ))}
      </select>
    </label>
  )
}

function recentsKey(projectId: string): string {
  return `workbench.mentions.${projectId}`
}

function loadRecents(projectId: string): FileMention[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(recentsKey(projectId)) ?? '') as FileMention[]
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.path === 'string')
      : []
  } catch {
    return []
  }
}

function saveRecent(projectId: string, mention: FileMention): void {
  const next = [mention, ...loadRecents(projectId).filter((item) => item.path !== mention.path)].slice(
    0,
    12
  )
  localStorage.setItem(recentsKey(projectId), JSON.stringify(next))
}

function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null
  const query = before.slice(at + 1)
  if (query.includes('\n')) return null
  return { start: at, query }
}

function MicIcon({ listening }: { listening: boolean }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      {listening && <circle cx="12" cy="8.5" r="1.4" fill="currentColor" />}
    </svg>
  )
}

function SlashLabel({ id, query }: { id: string; query: string }): React.JSX.Element {
  const q = query.toLowerCase()
  if (q && id.startsWith(q)) {
    return (
      <>
        /<span className="text-accent">{id.slice(0, q.length)}</span>
        {id.slice(q.length)}
      </>
    )
  }
  return <>/{id}</>
}

function MentionChip({
  mention,
  onRemove
}: {
  mention: FileMention
  onRemove?: () => void
}): React.JSX.Element {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-canvas px-2 py-0.5 font-mono text-[11px] text-ink">
      <span className="truncate">
        {mention.path}
        {mention.kind === 'folder' ? '/' : ''}
      </span>
      {onRemove && (
        <button
          type="button"
          className="text-muted hover:text-ink"
          onClick={onRemove}
          aria-label={`Remove ${mention.path}`}
        >
          ×
        </button>
      )}
    </span>
  )
}

type ComposerDraft = { value: string; attachments: Attachment[]; mentions: FileMention[] }

/** A failed send's text, put back ahead of what was typed since. */
function joinText(sent: string, typed: string): string {
  return typed.trim() ? `${sent.trimEnd()}\n\n${typed}` : sent
}

function joinBy<T>(sent: T[], typed: T[], key: (item: T) => string): T[] {
  const seen = new Set(sent.map(key))
  return [...sent, ...typed.filter((item) => !seen.has(key(item)))]
}

function Composer({
  streaming,
  progress,
  mode,
  permission,
  question,
  projectId,
  chatId,
  hasFolder,
  history,
  drafts,
  restorers,
  onSend,
  onSlash,
  onStop,
  onMode,
  agent,
  onAgent,
  onPermission,
  onQuestion,
  onRewindMenu
}: {
  streaming: boolean
  progress: string
  mode: PermissionMode
  permission: PermissionRequest | null
  question: UserQuestionRequest | null
  projectId: string
  chatId: string
  hasFolder: boolean
  history: string[]
  drafts: React.RefObject<Map<string, ComposerDraft>>
  /** By chat: puts a failed send back in the composer showing that chat now. */
  restorers: React.RefObject<Map<string, (sent: ComposerDraft) => void>>
  onSend: (text: string, attachments: Attachment[], mentions: FileMention[]) => Promise<boolean>
  onSlash: (def: SlashDef, args: string, draft: { attachments: Attachment[]; mentions: FileMention[] }) => Promise<string | null>
  onStop: () => void
  onMode: (mode: PermissionMode) => void
  agent: ChatAgent
  /** Null once the chat started, or when only one agent is signed in. */
  onAgent: ((agent: ChatAgent) => void) | null
  onPermission: (requestId: string, decision: 'allow' | 'deny') => Promise<void>
  onQuestion: (
    requestId: string,
    decision: { type: 'skip' } | { type: 'submit'; answers: string[][] }
  ) => Promise<void>
  onRewindMenu: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(() => drafts.current.get(chatId)?.value ?? '')
  const [attachments, setAttachments] = useState<Attachment[]>(
    () => drafts.current.get(chatId)?.attachments ?? []
  )
  const [mentions, setMentions] = useState<FileMention[]>(() => drafts.current.get(chatId)?.mentions ?? [])
  const [hits, setHits] = useState<FileHit[]>([])
  const [hitsQuery, setHitsQuery] = useState<string | null>(null)
  const [hitIndex, setHitIndex] = useState(0)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [command, setCommand] = useState<{ start: number; query: string } | null>(null)
  const [cmdIndex, setCmdIndex] = useState(0)
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [announced, setAnnounced] = useState<AgentCommand[]>([])
  const draftRef = useRef('')
  const historyRef = useRef<string[]>([])
  const lastEscAt = useRef(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const selectedCmd = useRef<HTMLButtonElement>(null)
  const {
    enabled: voiceOn,
    conversation: voiceConversation,
    live: voiceLive,
    userTalking,
    status: voiceStatus,
    error: voiceError,
    pendingTranscript,
    caption: voiceCaption,
    consumeTranscript,
    toggleListen,
    toggleConversation,
    speaks: voiceSpeaks,
    replyMuted,
    muteReply
  } = useVoice()
  // Without auto-send a finished clip goes into the box instead.
  const voiceAutoSend = useWorkspace().settings?.voice.autoSend === true
  const voiceMode =
    voiceStatus === 'listening' || (voiceLive && userTalking)
      ? 'user'
      : voiceStatus === 'speaking'
        ? 'grok'
        : voiceStatus === 'transcribing' || voiceStatus === 'loading' || voiceStatus === 'waiting'
          ? 'wait'
          : voiceLive
            ? 'listen'
            : null

  useEffect(() => {
    if (!pendingTranscript) return
    setValue((current) => (current.trim() ? `${current.trim()} ${pendingTranscript}` : pendingTranscript))
    consumeTranscript()
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      const pos = el.value.length
      el.setSelectionRange(pos, pos)
    })
  }, [consumeTranscript, pendingTranscript])

  useEffect(() => {
    ref.current?.focus()
  }, [])

  useEffect(() => {
    if (!value && attachments.length === 0 && mentions.length === 0) drafts.current.delete(chatId)
    else drafts.current.set(chatId, { value, attachments, mentions })
  }, [attachments, chatId, drafts, mentions, value])

  // A send that fails after its chat was switched away and back lands in this composer, not the old one.
  useEffect(() => {
    const put = (sent: ComposerDraft): void => {
      setValue((typed) => joinText(sent.value, typed))
      setAttachments((typed) => joinBy(sent.attachments, typed, (item) => item.id))
      setMentions((typed) => joinBy(sent.mentions, typed, (item) => item.path))
    }
    const live = restorers.current
    live.set(chatId, put)
    return () => {
      if (live.get(chatId) === put) live.delete(chatId)
    }
  }, [chatId, restorers])

  useEffect(() => {
    let cancelled = false
    let seq = 0
    const load = (): void => {
      const mine = ++seq
      void window.workbench.getChatCommands(chatId).then((next) => {
        if (!cancelled && mine === seq) setAnnounced(next)
      })
    }
    load()
    const unsub = window.workbench.onChatEvent((event) => {
      if (event.chatId !== chatId) return
      if (event.type === 'commands') {
        seq++
        setAnnounced(event.commands)
      }
      // A new or reloaded session can announce before this chat is linked to it.
      else if (event.type === 'done') load()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [chatId])

  const slashList = useMemo(() => slashCommandsFor(agent, announced), [agent, announced])
  const commands = command ? filterSlashCommands(command.query, slashList) : []

  useEffect(() => {
    selectedCmd.current?.scrollIntoView({ block: 'nearest' })
  }, [cmdIndex, command?.query])

  const commandOpen = command !== null

  useEffect(() => {
    if (commandOpen || !mention || !hasFolder) {
      setHits([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        const found = await window.workbench.searchFiles(projectId, mention.query, chatId)
        if (cancelled) return
        const recents = loadRecents(projectId)
        const q = mention.query.toLowerCase()
        const recentHits: FileHit[] = recents
          .filter((item) => !q || item.path.toLowerCase().includes(q) || item.path.toLowerCase().split('/').pop()?.startsWith(q))
          .map((item) => ({
            path: item.path,
            name: item.path.split('/').pop() || item.path,
            kind: item.kind
          }))
        const seen = new Set(recentHits.map((item) => item.path))
        const merged = [...recentHits, ...found.filter((item) => !seen.has(item.path))].slice(0, 30)
        setHits(merged)
        setHitsQuery(mention.query)
        setHitIndex(0)
      })()
    }, 60)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [chatId, commandOpen, hasFolder, mention, projectId])

  function syncTrigger(text: string, caret: number): void {
    const nextCommand = commandAt(text, caret)
    if (nextCommand) {
      setCommand(nextCommand)
      setCmdIndex(0)
      setMention(null)
      return
    }
    setCommand(null)
    setMention(mentionAt(text, caret))
  }

  function fillCommand(def: SlashDef): void {
    const caret = ref.current?.selectionStart ?? value.length
    const at = command ?? commandAt(value, caret)
    const token = completeSlash(def)
    const start = at?.start ?? 0
    const next = at ? value.slice(0, start) + token + value.slice(caret) : token
    setValue(next)
    setHistoryIndex(null)
    if (def.needsArgs) {
      setCommand(null)
    } else {
      setCommand({ start, query: def.id })
      setCmdIndex(0)
    }
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      const pos = start + token.length
      el.setSelectionRange(pos, pos)
    })
  }

  async function runPicked(def: SlashDef, args: string): Promise<void> {
    setCommand(null)
    setHistoryIndex(null)
    if (def.needsArgs && !args) {
      setValue(`/${def.id} `)
      requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        el.focus()
        const pos = el.value.length
        el.setSelectionRange(pos, pos)
      })
      return
    }
    setValue('')
    try {
      const notice = await onSlash(def, args, { attachments, mentions })
      if (def.kind === 'prompt' || def.kind === 'agent' || def.id === 'new' || def.id === 'delete') {
        setAttachments([])
        setMentions([])
      }
      if (notice) setPasteError(notice)
    } catch (error) {
      const line = args ? `/${def.id} ${args}` : `/${def.id}`
      setValue((current) => current || line)
      setPasteError(errorText(error, `/${def.id} failed`))
    }
  }

  /** Puts a failed send back, ahead of anything typed since. */
  function restore(sent: ComposerDraft): void {
    const live = restorers.current.get(chatId)
    if (live) return live(sent)
    // Its chat is not on screen: the draft waits for it.
    const typed = drafts.current.get(chatId)
    drafts.current.set(
      chatId,
      typed
        ? {
            value: joinText(sent.value, typed.value),
            attachments: joinBy(sent.attachments, typed.attachments, (item) => item.id),
            mentions: joinBy(sent.mentions, typed.mentions, (item) => item.path)
          }
        : sent
    )
  }

  function pickHit(hit: FileHit): void {
    const current = ref.current
    const caret = current?.selectionStart ?? value.length
    const at = mentionAt(value, caret)
    const nextText = at ? value.slice(0, at.start) + value.slice(caret) : value
    const next: FileMention = { path: hit.path, kind: hit.kind }
    setMentions((existing) =>
      existing.some((item) => item.path === next.path) ? existing : [...existing, next]
    )
    saveRecent(projectId, next)
    setValue(nextText)
    setMention(null)
    setHits([])
    setHistoryIndex(null)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      const pos = at ? at.start : nextText.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  function recall(nextIndex: number): void {
    if (historyIndex === null) {
      if (history.length === 0) return
      historyRef.current = history
      draftRef.current = value
    }
    const list = historyRef.current
    if (nextIndex < 0) nextIndex = 0
    if (nextIndex >= list.length) {
      setHistoryIndex(null)
      setValue(draftRef.current)
      return
    }
    setHistoryIndex(nextIndex)
    setValue(list[nextIndex])
  }

  async function addImages(incoming: Attachment[]): Promise<void> {
    if (incoming.length === 0) return
    setAttachments((current) => {
      const room = MAX_IMAGES - current.length
      if (room <= 0) {
        setPasteError(`Up to ${MAX_IMAGES} images per message`)
        return current
      }
      setPasteError(null)
      return [...current, ...incoming.slice(0, room)]
    })
  }

  function submit(): void {
    const parsed = parseSlashLine(value, slashList)
    if (parsed?.def) {
      void runPicked(parsed.def, parsed.args)
      return
    }
    const text = value.trim()
    if (!text && attachments.length === 0 && mentions.length === 0) return
    const sent: ComposerDraft = { value, attachments, mentions }
    void onSend(text, attachments, mentions).then((ok) => {
      if (!ok) restore(sent)
    })
    setValue('')
    setAttachments([])
    setMentions([])
    setMention(null)
    setCommand(null)
    setHits([])
    setPasteError(null)
    setHistoryIndex(null)
    draftRef.current = ''
    drafts.current.delete(chatId)
  }

  /** Types a trigger character at the caret, as if the user had typed it. */
  function insertTrigger(char: '@' | '/'): void {
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const before = value.slice(0, caret)
    const lineEmpty = before.slice(before.lastIndexOf('\n') + 1) === ''
    const lead =
      char === '/' ? (lineEmpty ? '' : '\n') : before && !/\s$/.test(before) ? ' ' : ''
    const token = lead + char
    const next = before + token + value.slice(caret)
    const pos = caret + token.length
    setValue(next)
    setHistoryIndex(null)
    syncTrigger(next, pos)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(pos, pos)
    })
  }

  async function attachFiles(files: FileList | null): Promise<void> {
    const images = [...(files ?? [])].filter((file) => file.type.startsWith('image/'))
    const incoming = (await Promise.all(images.map((file) => fileToAttachment(file, file.type)))).filter(
      (item): item is Attachment => item !== null
    )
    if (images.length > incoming.length) setPasteError('Images over 8 MB were skipped')
    await addImages(incoming)
  }

  const empty = !value.trim() && attachments.length === 0 && mentions.length === 0
  const status = replyMuted
    ? 'Muted for this request'
    : (voiceError ??
      (voiceLive
        ? voiceStatus === 'listening'
          ? 'Conversation on · listening — pause to send, work starts now'
          : voiceStatus === 'transcribing'
            ? 'Conversation on · transcribing…'
            : voiceStatus === 'speaking'
              ? 'Conversation on · speaking — keep talking to steer'
              : voiceStatus === 'loading'
                ? 'Conversation on · starting…'
                : `Conversation on · ${progress || 'working'}`
        : voiceStatus === 'listening'
          ? voiceAutoSend || voiceConversation
            ? 'Listening… click the mic or pause to send'
            : 'Listening… click the mic or pause when done'
          : voiceStatus === 'transcribing'
            ? 'Transcribing on this machine…'
            : voiceStatus === 'speaking'
              ? 'Speaking…'
              : voiceStatus === 'loading'
                ? 'Loading local speech model…'
                : (pasteError ??
                  (streaming ? `${progress || 'Still working'} · Esc stops the task` : null))))

  return (
    <div className="shrink-0 pt-2 pb-[18px]">
      <div className="mx-auto w-[min(720px,100%-40px)]">
        {question && (
          <QuestionCard
            key={question.requestId}
            request={question}
            onDecision={(requestId, decision) => onQuestion(requestId, decision)}
          />
        )}
        {permission && (
          <PermissionBar
            key={permission.requestId}
            request={permission}
            onDecision={(decision) => onPermission(permission.requestId, decision)}
          />
        )}
      <div className="rounded-[16px] border border-line-strong bg-raised px-3 pt-3 pb-2.5 shadow-[0_18px_40px_-18px_rgba(0,0,0,.7)] focus-within:border-accent-line">
        {(voiceLive || voiceError) && (
          <div className="mb-3 overflow-hidden rounded-xl bg-black">
            {voiceLive && (
              <VoiceBlob
                variant={
                  voiceMode === 'grok' ? 'grok' : voiceMode === 'user' || voiceMode === 'listen' ? 'user' : 'idle'
                }
              />
            )}
            <div
              className={`px-3 ${voiceLive ? 'pb-2.5' : 'py-2.5'} text-center text-[11px] font-medium tracking-tight ${
                voiceError ? 'text-red-400' : 'text-white/70'
              }`}
            >
              {voiceError
                ? voiceError
                : voiceCaption
                  ? voiceCaption
                  : voiceMode === 'user'
                    ? userTalking
                      ? 'You’re talking'
                      : 'Listening…'
                  : voiceMode === 'grok'
                    ? 'Agent is talking'
                    : voiceMode === 'wait'
                      ? progress ||
                        (voiceStatus === 'loading'
                          ? 'Starting conversation…'
                          : voiceStatus === 'waiting'
                            ? 'Working…'
                            : 'Got it — working')
                      : 'Listening…'}
            </div>
          </div>
        )}
        {(attachments.length > 0 || mentions.length > 0) && (
          <div className="mb-3 flex flex-wrap gap-2">
            {mentions.map((item) => (
              <MentionChip
                key={item.path}
                mention={item}
                onRemove={() =>
                  setMentions((current) => current.filter((mention) => mention.path !== item.path))
                }
              />
            ))}
            {attachments.map((attachment) => (
              <div key={attachment.id} className="relative">
                <img
                  src={`data:${attachment.mimeType};base64,${attachment.data}`}
                  alt=""
                  className="h-16 w-16 rounded-md border border-line object-cover"
                />
                <button
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-raised text-[10px] text-muted hover:text-ink"
                  onClick={() =>
                    setAttachments((current) => current.filter((item) => item.id !== attachment.id))
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative">
        {command && (
          <div
            data-testid="slash-menu"
            className="absolute inset-x-0 bottom-full z-10 mb-2 max-h-56 overflow-y-auto rounded-[8px] border border-line-strong bg-raised py-1 shadow-xl"
          >
            {commands.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-muted">No matching commands</div>
            ) : (
              commands.map((item, index) => {
                const alias = matchedSlashAlias(item, command.query)
                return (
                <button
                  key={item.id}
                  ref={index === cmdIndex ? selectedCmd : undefined}
                  type="button"
                  className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left ${
                    index === cmdIndex ? 'bg-hover' : 'hover:bg-hover'
                  }`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    void runPicked(item, '')
                  }}
                >
                  <span className="shrink-0 font-mono text-[12px] text-ink">
                    <SlashLabel id={item.id} query={command.query} />
                    {alias && <span className="ml-2 text-muted">{alias}</span>}
                  </span>
                  <span className="truncate text-[11px] text-muted">
                    {item.kind === 'unavailable' ? `TUI only · ${item.hint}` : item.hint}
                  </span>
                </button>
                )
              })
            )}
          </div>
        )}
        {mention && hasFolder && !command && (
          <div className="absolute inset-x-0 bottom-full z-10 mb-2 max-h-56 overflow-y-auto rounded-[8px] border border-line-strong bg-raised py-1 shadow-xl">
            {hits.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-muted">
                {mention.query ? 'No matching files' : 'Type to search files'}
              </div>
            ) : (
              hits.map((hit, index) => (
                <button
                  key={`${hit.kind}:${hit.path}`}
                  type="button"
                  className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left ${
                    index === hitIndex ? 'bg-hover' : 'hover:bg-hover'
                  }`}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    pickHit(hit)
                  }}
                >
                  <span className="min-w-0 truncate font-mono text-[12px] text-ink">{hit.path}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted">
                    {hit.kind === 'folder' ? 'folder' : 'file'}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
        <textarea
          ref={ref}
          rows={2}
          value={value}
          placeholder={
            streaming
              ? 'Steer the running task…  /btw asks an aside'
              : mode === 'plan'
                ? `Ask ${chatAgentLabel(agent)} to plan a change…`
                : `Ask ${chatAgentLabel(agent)} anything…`
          }
          className="w-full resize-none bg-transparent px-1 text-[14.5px] leading-[1.6] text-ink outline-none placeholder:text-faint focus-visible:outline-none disabled:opacity-60"
          onChange={(event) => {
            setValue(event.target.value)
            setHistoryIndex(null)
            syncTrigger(event.target.value, event.target.selectionStart)
          }}
          onClick={(event) => syncTrigger(event.currentTarget.value, event.currentTarget.selectionStart)}
          onKeyUp={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              syncTrigger(event.currentTarget.value, event.currentTarget.selectionStart)
            }
          }}
          onPaste={(event) => {
            const hasImage = [...event.clipboardData.items].some((item) =>
              item.type.startsWith('image/')
            )
            if (!hasImage) return
            event.preventDefault()
            void attachmentsFromClipboard(event).then((incoming) => {
              void addImages(incoming)
            })
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (command && commands.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCmdIndex((current) => (current + 1) % commands.length)
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCmdIndex((current) => (current - 1 + commands.length) % commands.length)
                return
              }
              if (event.key === 'Tab') {
                event.preventDefault()
                fillCommand(commands[cmdIndex] ?? commands[0])
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                void runPicked(commands[cmdIndex] ?? commands[0], '')
                return
              }
            }
            if (mention && hits.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setHitIndex((current) => (current + 1) % hits.length)
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setHitIndex((current) => (current - 1 + hits.length) % hits.length)
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                if (hitsQuery === mention.query) pickHit(hits[hitIndex] ?? hits[0])
                return
              }
            }
            if (event.key === 'Backspace' && mentions.length > 0) {
              const el = event.currentTarget
              if (el.selectionStart === 0 && el.selectionEnd === 0) {
                event.preventDefault()
                setMentions((current) => current.slice(0, -1))
                return
              }
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              if (command) {
                setCommand(null)
                lastEscAt.current = 0
                return
              }
              if (mention) {
                setMention(null)
                setHits([])
                lastEscAt.current = 0
                return
              }
              if (streaming) {
                onStop()
                lastEscAt.current = 0
                return
              }
              const at = Date.now()
              if (at - lastEscAt.current < 700) {
                lastEscAt.current = 0
                onRewindMenu()
                return
              }
              lastEscAt.current = at
              return
            }
            if (event.key === 'Tab' && event.shiftKey) {
              event.preventDefault()
              onMode(nextPermissionMode(mode))
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
              return
            }
            if (event.altKey || event.metaKey || event.ctrlKey) return
            const el = ref.current
            if (!el || (historyIndex === null && history.length === 0)) return
            if (event.key === 'ArrowUp' && (historyIndex !== null || caretOnFirstLine(el))) {
              event.preventDefault()
              recall(historyIndex === null ? history.length - 1 : historyIndex - 1)
              return
            }
            if (event.key === 'ArrowDown' && historyIndex !== null && caretOnLastLine(el)) {
              event.preventDefault()
              recall(historyIndex + 1)
            }
          }}
        />
        </div>
        <div className="mt-2 flex items-center gap-1">
          <label
            title="Attach images"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] text-muted hover:bg-hover hover:text-ink focus-within:outline-2 focus-within:outline-accent-line"
          >
            <Icon name="clip" />
            <input
              type="file"
              accept="image/*"
              multiple
              aria-label="Attach images"
              data-testid="composer-attach"
              className="sr-only"
              onChange={(event) => {
                const input = event.currentTarget
                void attachFiles(input.files).finally(() => {
                  input.value = ''
                })
              }}
            />
          </label>
          {hasFolder && (
            <IconButton icon="at" label="Mention a file" onClick={() => insertTrigger('@')} />
          )}
          <IconButton icon="slash" label="Commands" onClick={() => insertTrigger('/')} />
          <span className="mx-1.5 h-4 w-px shrink-0 bg-line" />
          <ModeToggle mode={mode} onMode={onMode} />
          <AgentToggle agent={agent} onAgent={onAgent} />
          <div className="min-w-2 flex-1" />
          {voiceSpeaks && (streaming || voiceStatus === 'speaking' || replyMuted) && (
            <button
              type="button"
              data-testid="voice-mute"
              className={`flex h-7 items-center rounded-[7px] px-2 text-[12.5px] active:translate-y-px ${
                replyMuted ? 'text-faint hover:bg-hover' : 'text-muted hover:bg-hover hover:text-ink'
              }`}
              aria-label={replyMuted ? 'Unmute this reply' : 'Mute this reply'}
              onClick={muteReply}
            >
              {replyMuted ? 'Muted' : 'Mute'}
            </button>
          )}
          {voiceOn && voiceConversation && (
            <button
              type="button"
              data-testid="voice-conversation"
              className={`flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-[12.5px] active:translate-y-px ${
                voiceLive
                  ? 'bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--color-accent-line)]'
                  : 'text-muted hover:bg-hover hover:text-ink'
              }`}
              aria-label={voiceLive ? 'Stop conversation' : 'Start conversation'}
              onClick={toggleConversation}
            >
              {voiceLive ? (
                <span className="h-[18px] w-6 overflow-hidden rounded-sm bg-black">
                  <VoiceBlob size="chip" variant={voiceMode === 'grok' ? 'grok' : 'user'} />
                </span>
              ) : (
                <MicIcon listening={false} />
              )}
              Conversation
            </button>
          )}
          {voiceOn && !voiceLive && (
            <button
              type="button"
              data-testid="voice-mic"
              title={voiceStatus === 'listening' ? 'Stop listening' : 'Dictate'}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] active:translate-y-px ${
                voiceStatus === 'listening'
                  ? 'bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--color-accent-line)]'
                  : 'text-muted hover:bg-hover hover:text-ink'
              }`}
              aria-label={voiceStatus === 'listening' ? 'Stop listening' : 'Start listening'}
              onClick={toggleListen}
            >
              <MicIcon listening={voiceStatus === 'listening'} />
            </button>
          )}
          {streaming ? (
            <>
              {!empty && (
                <button
                  type="button"
                  className="ml-1 flex h-8 shrink-0 items-center rounded-[10px] px-3 text-[12.5px] font-medium text-accent shadow-[inset_0_0_0_1px_var(--color-accent-line)] hover:bg-accent-soft active:translate-y-px"
                  onClick={submit}
                >
                  Steer
                </button>
              )}
              <button
                type="button"
                data-testid="composer-stop"
                title="Stop (Esc)"
                aria-label="Stop"
                className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-accent text-accent-ink hover:brightness-110 active:translate-y-px"
                onClick={onStop}
              >
                <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="composer-send"
              title="Send (↵)"
              aria-label="Send"
              className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-accent text-accent-ink transition hover:brightness-110 active:translate-y-px disabled:opacity-45 disabled:hover:brightness-100"
              disabled={empty}
              onClick={submit}
            >
              <Icon name="arrowUp" size={15} strokeWidth={1.8} />
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 truncate text-center text-[11px] tabular-nums text-faint" title={status ?? undefined}>
        {status ?? (
          <>
            ↵ send · ⇧↵ new line · Esc Esc rewind · {MODE_HINT[mode]}
          </>
        )}
      </div>
      </div>
    </div>
  )
}

function rewindClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function RewindModal({
  checkpoints,
  selectedId,
  busy,
  error,
  onSelect,
  onClose,
  onRewind
}: {
  checkpoints: Checkpoint[]
  selectedId: string | null
  busy: boolean
  error: string | null
  onSelect: (id: string) => void
  onClose: () => void
  onRewind: () => void
}): React.JSX.Element {
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-overlay"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div
        className="w-[440px] rounded-2xl border border-line bg-surface p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-[15px] font-semibold tracking-tight">Rewind</div>
        <p className="mt-1 text-[12.5px] text-muted">
          Restores files to that turn and drops later messages.
        </p>
        {checkpoints.length === 0 ? (
          <div className="mt-4 rounded-lg border border-line bg-canvas px-3 py-3 text-[12.5px] text-muted">
            No checkpoints yet. Send a message so the agent can snapshot the tree first.
          </div>
        ) : (
          <div className="mt-4 max-h-[320px] overflow-y-auto rounded-lg border border-line">
            {checkpoints.map((item) => {
              const active = item.id === selectedId
              const extra =
                item.files.length > 0
                  ? `${item.files.length} file${item.files.length === 1 ? '' : 's'}`
                  : item.kind !== 'files'
                    ? 'Full tree'
                    : 'Chat only'
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`flex w-full items-start justify-between gap-3 border-b border-line px-3 py-2.5 text-left last:border-b-0 ${
                    active ? 'bg-raised' : 'hover:bg-canvas'
                  }`}
                  onClick={() => onSelect(item.id)}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-ink">{item.label}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-muted">
                      {extra} · {item.kind === 'git' ? 'git' : item.kind === 'shadow' ? 'snapshot' : 'files'}
                    </div>
                  </div>
                  <div className="shrink-0 font-mono text-[10px] text-muted">
                    {rewindClock(item.createdAt)}
                  </div>
                </button>
              )
            })}
          </div>
        )}
        {error && <div className="mt-3 text-[12.5px] text-danger">{error}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-2 text-[12px] text-muted hover:text-ink"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-110 active:translate-y-px disabled:opacity-40"
            disabled={busy || !selectedId}
            onClick={onRewind}
          >
            {busy ? 'Rewinding…' : 'Rewind to here'}
          </button>
        </div>
      </div>
    </div>
  )
}
