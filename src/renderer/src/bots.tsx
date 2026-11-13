import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { resolveProjectColor } from '../../shared/projectColor'
import type { Bot, Chat, UpdateBotInput } from '../../shared/types'

type BotsContextValue = {
  bots: Bot[]
  createBot: (name: string) => Promise<Bot>
  updateBot: (input: UpdateBotInput) => Promise<Bot>
  deleteBot: (botId: string) => Promise<void>
  pickAvatar: (botId: string) => Promise<void>
  clearAvatar: (botId: string) => Promise<void>
  /** The user has seen the bot's chat. */
  markBotRead: (botId: string) => Promise<void>
}

const BotsContext = createContext<BotsContextValue | null>(null)

export function BotsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [bots, setBots] = useState<Bot[]>([])

  useEffect(() => {
    void window.workbench.listBots().then(setBots)
  }, [])

  const put = useCallback((bot: Bot) => {
    setBots((current) => {
      const next = current.some((item) => item.id === bot.id)
        ? current.map((item) => (item.id === bot.id ? bot : item))
        : [...current, bot]
      return next.sort((a, b) => a.name.localeCompare(b.name))
    })
  }, [])

  // Main tells us when a bot changes, such as its count of new messages.
  useEffect(
    () =>
      window.workbench.onChatEvent((event) => {
        if (event.type === 'bot') put(event.bot)
      }),
    [put]
  )

  const createBot = useCallback(
    async (name: string) => {
      const bot = await window.workbench.createBot(name)
      put(bot)
      return bot
    },
    [put]
  )

  const updateBot = useCallback(
    async (input: UpdateBotInput) => {
      const bot = await window.workbench.updateBot(input)
      put(bot)
      return bot
    },
    [put]
  )

  const deleteBot = useCallback(async (botId: string) => {
    await window.workbench.deleteBot(botId)
    setBots((current) => current.filter((item) => item.id !== botId))
  }, [])

  const pickAvatar = useCallback(
    async (botId: string) => {
      const bot = await window.workbench.pickBotAvatar(botId)
      if (bot) put(bot)
    },
    [put]
  )

  const clearAvatar = useCallback(
    async (botId: string) => {
      put(await window.workbench.clearBotAvatar(botId))
    },
    [put]
  )

  const markBotRead = useCallback(
    async (botId: string) => {
      put(await window.workbench.markBotRead(botId))
    },
    [put]
  )

  const value = useMemo(
    () => ({ bots, createBot, updateBot, deleteBot, pickAvatar, clearAvatar, markBotRead }),
    [bots, createBot, updateBot, deleteBot, pickAvatar, clearAvatar, markBotRead]
  )
  return <BotsContext.Provider value={value}>{children}</BotsContext.Provider>
}

export function useBots(): BotsContextValue {
  const value = useContext(BotsContext)
  if (!value) throw new Error('useBots needs a BotsProvider')
  return value
}

/**
 * While a bot's Chat tab is on screen its new messages count as read: when the tab opens, when one comes in,
 * and when the window gets focus back. Returns the first message that was new when the tab opened, for the New line.
 */
export function useBotChatRead(bot: Bot | null, chat: Chat | undefined): string | null {
  const { markBotRead } = useBots()
  const botId = bot?.id ?? null
  const chatId = chat?.id ?? null
  const unread = useRef(0)
  unread.current = bot?.unread ?? 0
  const messages = useRef(chat?.messages)
  messages.current = chat?.messages
  const [newFrom, setNewFrom] = useState<{ chatId: string; messageId: string } | null>(null)

  useEffect(() => {
    if (!botId || !chatId) return
    const count = unread.current
    const replies = (messages.current ?? []).filter((message) => message.role === 'assistant')
    const first = count > 0 ? replies[Math.max(0, replies.length - count)] : undefined
    setNewFrom(first ? { chatId, messageId: first.id } : null)

    function markRead(): void {
      if (botId && document.hasFocus()) void markBotRead(botId).catch(() => undefined)
    }
    function markIfNew(): void {
      if (unread.current > 0) markRead()
    }
    markIfNew()
    window.addEventListener('focus', markIfNew)
    const off = window.workbench.onChatEvent((event) => {
      if (event.type === 'bot-message' && event.botId === botId) markRead()
    })
    return () => {
      window.removeEventListener('focus', markIfNew)
      off()
    }
  }, [botId, chatId, markBotRead])

  return newFrom?.chatId === chatId ? newFrom.messageId : null
}

/** Avatar data URLs by bot id and the bot's updatedAt, so a new image is fetched once. */
const avatarCache = new Map<string, Promise<string | null>>()

function useBotAvatar(bot: Bot): string | null {
  const key = `${bot.id}:${bot.updatedAt}`
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!bot.avatar) {
      setUrl(null)
      return
    }
    let live = true
    let pending = avatarCache.get(key)
    if (!pending) {
      pending = window.workbench.getBotAvatar(bot.id).catch(() => null)
      avatarCache.set(key, pending)
    }
    void pending.then((next) => {
      if (live) setUrl(next)
    })
    return () => {
      live = false
    }
  }, [bot.id, bot.avatar, key])
  return url
}

function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return '·'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** A round avatar. The image is an `<img>`, so an SVG's scripts never run while its animation plays. */
export function BotAvatar({ bot, size }: { bot: Bot; size: number }): React.JSX.Element {
  const url = useBotAvatar(bot)
  if (url) {
    return (
      <img
        src={url}
        alt=""
        draggable={false}
        className="shrink-0 rounded-full bg-raised object-cover"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-black/75"
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.4), background: resolveProjectColor(bot) }}
      aria-hidden
    >
      {initials(bot.name)}
    </span>
  )
}
