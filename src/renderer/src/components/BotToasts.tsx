import { useEffect, useRef, useState } from 'react'
import type { Bot } from '../../../shared/types'
import { plainReply } from '../../../shared/steps'
import { BotAvatar, useBots } from '../bots'
import { useWorkspace } from '../workspace'
import { Icon } from './icons'

type Toast = { id: number; botId: string; text: string; source?: string }

/** The first two lines of a message, without Markdown's marks. */
function preview(text: string): string {
  return plainReply(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|[*`]/g, '')
}

/** A bot's new message while the user is elsewhere in the app, bottom right. Up to 3 stack; older ones go first. */
export function BotToasts(): React.JSX.Element | null {
  const { activeBotId, botTab, openBot } = useWorkspace()
  const { bots } = useBots()
  const [toasts, setToasts] = useState<Toast[]>([])
  const chatTabBotId = activeBotId && botTab === 'chat' ? activeBotId : null
  const onChatTab = useRef(chatTabBotId)
  onChatTab.current = chatTabBotId
  const nextId = useRef(0)

  useEffect(
    () =>
      window.workbench.onChatEvent((event) => {
        if (event.type !== 'bot-message') return
        // In the background main shows a system notification instead; on the bot's Chat tab the message is in view.
        if (!document.hasFocus() || onChatTab.current === event.botId) return
        const toast = { id: ++nextId.current, botId: event.botId, text: preview(event.text), source: event.source }
        setToasts((current) => [...current, toast].slice(-3))
      }),
    []
  )

  // Opening the bot's chat shows what its toasts said.
  useEffect(() => {
    if (chatTabBotId) setToasts((current) => current.filter((toast) => toast.botId !== chatTabBotId))
  }, [chatTabBotId])

  function close(id: number): void {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }

  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed right-4 bottom-[calc(var(--spacing-statusbar)+12px)] z-50 flex w-[330px] flex-col gap-2">
      {toasts.map((toast) => {
        const bot = bots.find((item) => item.id === toast.botId)
        if (!bot) return null
        return (
          <BotToast
            key={toast.id}
            bot={bot}
            toast={toast}
            onOpen={() => {
              close(toast.id)
              openBot(bot.id)
            }}
            onClose={() => close(toast.id)}
          />
        )
      })}
    </div>
  )
}

/** Closes when its bar runs out, after about 8 seconds; the bar waits while the pointer is over the toast. */
function BotToast({
  bot,
  toast,
  onOpen,
  onClose
}: {
  bot: Bot
  toast: Toast
  onOpen: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid="bot-toast"
      className="group pointer-events-auto flex gap-2.5 rounded-xl border border-line-strong bg-raised px-3 py-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.6)]"
    >
      <BotAvatar bot={bot} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
          <span className="truncate">{bot.name}</span>
          {toast.source && (
            <span className="min-w-0 truncate text-[11px] font-normal text-faint">· {toast.source} · now</span>
          )}
          <button
            type="button"
            aria-label="Close"
            className="ml-auto shrink-0 text-faint hover:text-ink"
            onClick={onClose}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
        <div className="line-clamp-2 text-[12.5px] text-ink-2">{toast.text}</div>
        <div className="mt-1.5 flex gap-1.5">
          <button
            type="button"
            className="rounded-md border border-accent bg-accent px-2.5 py-0.5 text-[12px] font-semibold text-accent-ink"
            onClick={onOpen}
          >
            Open
          </button>
        </div>
        <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-line">
          <div
            className="toast-timer h-full bg-accent group-hover:[animation-play-state:paused]"
            onAnimationEnd={onClose}
          />
        </div>
      </div>
    </div>
  )
}
