import { useEffect, useState } from 'react'
import type { Chat, ChatSummary, Message } from '../../../shared/types'
import { replySteps } from '../../../shared/steps'
import { useChatsProgress } from '../progress'
import { WORKER_STATE_LABEL, workerState, workersSummary, type WorkerState } from '../subagents'
import { useStreamStatuses, useStreams, useWorkspace } from '../workspace'
import { AgentReply } from './AgentReply'
import { Icon } from './icons'

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trim()}…`
}

function StateMark({ state }: { state: WorkerState }): React.JSX.Element {
  if (state === 'reported') return <Icon name="check" size={12} className="text-ok" />
  const tone =
    state === 'working'
      ? 'streaming-dot bg-accent'
      : state === 'waiting'
        ? 'bg-faint'
        : 'bg-danger'
  return <span className={`m-[3px] h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
}

/** The worker's chat with its messages: from the workspace when it is loaded, read once otherwise. */
function useWorkerChat(worker: ChatSummary, enabled: boolean): Chat | null {
  const { chatsById } = useWorkspace()
  const loaded = chatsById[worker.id]
  const [fetched, setFetched] = useState<Chat | null>(null)
  const missing = enabled && !loaded
  useEffect(() => {
    if (!missing) return
    let cancel = false
    void window.workbench.getChat(worker.id).then((chat: Chat | null) => {
      if (!cancel && chat) setFetched(chat)
    })
    return () => {
      cancel = true
    }
  }, [missing, worker.id, worker.updatedAt])
  return loaded ?? fetched
}

/** The reply a working subagent is writing now. */
function LiveDraft({ chatId }: { chatId: string }): React.JSX.Element | null {
  const draft = useStreams()[chatId]?.draft
  if (!draft) return null
  return (
    <ThreadEntry who="Subagent" what="Writing now">
      <AgentReply text={draft} chatId={chatId} live />
    </ThreadEntry>
  )
}

function ThreadEntry({
  who,
  what,
  fromOrchestrator = false,
  children
}: {
  who: string
  what: string
  fromOrchestrator?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li className={`flex flex-col ${fromOrchestrator ? 'items-end' : 'items-start'}`}>
      <div className="mb-1 text-[11px] text-faint">
        {who} · {what}
      </div>
      <div
        className={`max-h-[240px] w-full max-w-[92%] overflow-y-auto rounded-[8px] border px-3 py-2 text-[13px] leading-5 ${
          fromOrchestrator ? 'border-accent-line bg-accent-soft text-ink' : 'border-line bg-surface text-ink-2'
        }`}
      >
        {children}
      </div>
    </li>
  )
}

/** What the orchestrator and one subagent said to each other, oldest first. */
function Thread({ worker, working }: { worker: ChatSummary; working: boolean }): React.JSX.Element {
  const chat = useWorkerChat(worker, true)
  const messages: Message[] = chat?.messages ?? []
  let tasks = 0
  return (
    <ol className="mt-2 flex flex-col gap-3 border-l border-line pl-3" data-testid="subagent-thread">
      {messages.length === 0 && !working ? (
        <li className="text-[12.5px] text-muted">{chat ? 'Nothing said yet.' : 'Loading…'}</li>
      ) : null}
      {messages.map((message) =>
        message.role === 'user' ? (
          <ThreadEntry key={message.id} who="Orchestrator" what={tasks++ === 0 ? 'Task' : 'Nudge'} fromOrchestrator>
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          </ThreadEntry>
        ) : (
          <ThreadEntry key={message.id} who="Subagent" what="Report">
            <AgentReply text={message.content} chatId={worker.id} />
          </ThreadEntry>
        )
      )}
      {working ? <LiveDraft chatId={worker.id} /> : null}
    </ol>
  )
}

function WorkerRow({
  worker,
  state,
  doing,
  error
}: {
  worker: ChatSummary
  state: WorkerState
  doing: string
  error: string | null
}): React.JSX.Element {
  const { chatsById, openChat } = useWorkspace()
  const [open, setOpen] = useState(false)
  const messages = chatsById[worker.id]?.messages
  const last = messages?.[messages.length - 1]
  const line =
    state === 'working'
      ? doing || 'Working'
      : state === 'needs-you'
        ? 'Waiting for your answer in its chat'
        : state === 'error'
          ? error || 'The run failed'
          : state === 'reported' && last?.role === 'assistant'
            ? clip(replySteps(last.content).at(-1) ?? '', 160)
            : WORKER_STATE_LABEL[state]
  return (
    <li className="border-t border-line py-2 first:border-t-0" data-testid="subagent-row">
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? 'chevronDown' : 'chevron'} size={12} className="mt-1 text-faint" />
          <span className="mt-1 flex h-3 w-3 shrink-0 items-center justify-center">
            <StateMark state={state} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium text-ink">{worker.title}</span>
              {worker.model ? (
                <span className="shrink-0 rounded-full border border-line px-1.5 text-[10.5px] leading-4 text-muted">
                  {worker.model}
                </span>
              ) : null}
            </span>
            <span
              className={`block truncate text-[12.5px] leading-5 ${
                state === 'error' || state === 'needs-you' ? 'text-danger' : 'text-muted'
              }`}
            >
              {line}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="shrink-0 rounded-[8px] px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
          onClick={() => openChat(worker.id)}
        >
          Open chat
        </button>
      </div>
      {open ? <Thread worker={worker} working={state === 'working' || state === 'needs-you'} /> : null}
    </li>
  )
}

/**
 * The subagents of an orchestrator chat: how many there are, what each is doing now,
 * and, opened, what it and the orchestrator said to each other.
 */
export function SubagentsPanel({ chatId }: { chatId: string }): React.JSX.Element | null {
  const { chats, permissions, questions } = useWorkspace()
  const statuses = useStreamStatuses()
  const [open, setOpen] = useState(true)
  const workers = chats
    .filter((chat) => chat.parentChatId === chatId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const states = workers.map((worker) =>
    workerState({
      status: statuses[worker.id]?.status,
      needsUser: Boolean(permissions[worker.id] || questions[worker.id]),
      messageCount: worker.messageCount
    })
  )
  const doing = useChatsProgress(workers.filter((_, index) => states[index] === 'working').map((worker) => worker.id))
  if (workers.length === 0) return null

  return (
    <div className="mx-auto mb-2 w-[min(720px,100%-40px)] shrink-0" data-testid="subagents-panel">
      <div className="rounded-[8px] border border-line-strong bg-raised">
        <button
          type="button"
          aria-expanded={open}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? 'chevronDown' : 'chevron'} size={12} className="text-faint" />
          <span className="text-[12.5px] font-semibold text-ink">
            {workers.length} {workers.length === 1 ? 'subagent' : 'subagents'}
          </span>
          <span className="truncate text-[12.5px] text-muted">{workersSummary(states)}</span>
        </button>
        {open ? (
          <ul className="max-h-[38vh] overflow-y-auto border-t border-line px-3">
            {workers.map((worker, index) => (
              <WorkerRow
                key={worker.id}
                worker={worker}
                state={states[index]}
                doing={doing[worker.id] ?? ''}
                error={statuses[worker.id]?.error ?? null}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
