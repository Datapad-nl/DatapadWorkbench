import { app, safeStorage } from 'electron'
import { randomInt, timingSafeEqual } from 'crypto'
import { join } from 'path'
import type { TelegramStatus } from '../shared/channels'
import type { Bot, PermissionRequest, Project, ShownIn, UserQuestion, UserQuestionRequest } from '../shared/types'
import { normalizeHexColor } from '../shared/projectColor'
import { splitBotMentions } from '../shared/botMentions'
import { replySteps } from '../shared/steps'
import { getBot, listBots } from './bots'
import { botChat, chatRunning, emitChat, isBotsOwn, send } from './chatTools'
import { onPermissionPrompt, onPermissionSettled, resolvePermission } from './permissions'
import { onUserQuestionPrompt, onUserQuestionSettled, resolveUserQuestion } from './questions'
import { createChat, getChat, listProjects } from './store'
import { readJsonFile, withLock, writeFileAtomic } from './storeIo'
import {
  TOKEN_PATTERN,
  TelegramError,
  telegramClient,
  type InlineButton,
  type TelegramCallbackQuery,
  type TelegramClient,
  type TelegramMessage,
  type TelegramUpdate,
  type TopicIcon
} from './telegram'

/**
 * The Telegram channel: the user talks to their bots and projects from their phone. Only the one paired
 * Telegram user is listened to, since this reaches agents that run shell commands; everything else is dropped
 * without a word. A direct message goes to the chief of staff, or to the bot it starts with @Name; in a group
 * with topics each bot and each reachable project has a topic of its own.
 */

type Target = { kind: 'bot'; botId: string } | { kind: 'project'; projectId: string; chatId?: string }

type TelegramState = {
  /** The bot token, sealed with the system keychain. */
  token: string | null
  username: string | null
  userId: number | null
  group: { id: number; title: string } | null
  /** The paired group's topics by thread id. */
  topics: Record<string, Target>
  /** Bots switched off. Every other bot is reachable, a bot made later too. */
  hiddenBots: string[]
  /** Projects switched on. */
  projects: string[]
  /** The first update not handled yet. */
  offset: number
  /** Replies also come as a spoken voice memo: /voice on. */
  voiceReplies: boolean
}

type ChannelsFile = { telegram?: Partial<TelegramState> }

/** Where a message goes: a chat, and the topic in it. */
type Place = { chat: number; thread?: number }

type Transcribe = (bytes: Buffer, mimeType: string) => Promise<string>
/** Gets the speech model ready. `fetching` hears its size, once, when it has to be downloaded first. */
type PrepareTranscribe = (fetching: (bytes: number) => Promise<void>) => Promise<void>
/** A reply as an Ogg Opus voice memo. */
type Speak = (text: string) => Promise<Buffer>

const PAIRING_MS = 10 * 60_000
const PAIRING_TRIES = 5
const MAX_TEXT = 4096
const RETRY_MS = 2_000
const MAX_RETRY_MS = 60_000
/** Waits before a failed send is tried again, as when the Mac just woke and the network is not back. */
const SEND_RETRIES_MS = [2_000, 10_000, 30_000]

const TOPICS_NEEDED =
  'To give each bot and project its own topic here, turn on Topics in the group settings and make this bot an admin that may manage topics.'
const ONLY_TEXT = 'Only text and voice notes work here.'
const NOT_LINKED = 'This topic is not linked to a bot or project.'

let makeClient: (token: string) => TelegramClient = telegramClient
let transcribe: Transcribe | null = null
let prepareTranscribe: PrepareTranscribe | null = null
let speak: Speak | null = null
let onStatus: (status: TelegramStatus) => void = () => {}
let listening = false

let loaded: Promise<TelegramState> | null = null
/** The token, unsealed. */
let token: string | null = null
let client: TelegramClient | null = null
/** The id of the 🤖 topic icon, asked once per client and only when a bot topic is made. */
let botIcon: Promise<string | undefined> | null = null
let loop: AbortController | null = null
let pollState: TelegramStatus['state'] = 'off'
let pollError: string | null = null
let sendError: string | null = null
let lastStatus = ''
/** Telegram refused to make topics: the group is told once, not with every bot message. */
let topicsRefused = false
/** Why Telegram refused the last topic, shown in Settings until topics are made. */
let topicsError: string | null = null
let pairing: { code: string; expiresAt: number; tries: number; timer: NodeJS.Timeout } | null = null

/** A question or approval shown on Telegram, by the short id its buttons carry. */
type Ask = {
  id: string
  kind: 'question' | 'permission'
  requestId: string
  /** Null until it is known where the request is shown. */
  place: Place | null
  prefix: string
  /** The message with the buttons, which come off once it is answered. */
  messageId: number | null
  questions: UserQuestion[]
  index: number
  answers: string[][]
}
const asks = new Map<string, Ask>()
let askCount = 0

/** The ipc layer hands over where the status goes; the voice helper hands over its transcriber and voice. */
export function registerChannels(input: {
  onStatus?: (status: TelegramStatus) => void
  transcribe?: Transcribe
  prepareTranscribe?: PrepareTranscribe
  speak?: Speak
  /** Tests put a fake Telegram here. */
  client?: (token: string) => TelegramClient
}): void {
  if (input.onStatus) onStatus = input.onStatus
  if (input.transcribe) transcribe = input.transcribe
  if (input.prepareTranscribe) prepareTranscribe = input.prepareTranscribe
  if (input.speak) speak = input.speak
  if (input.client) makeClient = input.client
  if (listening) return
  listening = true
  onPermissionPrompt((request) => void raisePermission(request).catch(() => {}))
  onPermissionSettled((request) => settle(request.requestId))
  onUserQuestionPrompt((request) => void raiseQuestion(request).catch(() => {}))
  onUserQuestionSettled((request) => settle(request.requestId))
}

function channelsPath(): string {
  return join(app.getPath('userData'), 'workbench', 'channels.json')
}

function current(): Promise<TelegramState> {
  loaded ??= readJsonFile<ChannelsFile>(channelsPath(), {}).then(
    (file) => {
      const saved = file.telegram ?? {}
      const state: TelegramState = {
        token: saved.token ?? null,
        username: saved.username ?? null,
        userId: saved.userId ?? null,
        group: saved.group ?? null,
        topics: saved.topics ?? {},
        hiddenBots: saved.hiddenBots ?? [],
        projects: saved.projects ?? [],
        offset: saved.offset ?? 0,
        voiceReplies: saved.voiceReplies ?? false
      }
      token = state.token ? unseal(state.token) : null
      return state
    },
    (error: unknown) => {
      loaded = null
      throw error
    }
  )
  return loaded
}

function unseal(sealed: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  } catch {
    // Sealed under another keychain entry, e.g. after the app was reinstalled.
    return null
  }
}

async function save(change: (state: TelegramState) => void): Promise<void> {
  const state = await current()
  await withLock(channelsPath(), async () => {
    change(state)
    await writeFileAtomic(channelsPath(), JSON.stringify({ telegram: state }, null, 2))
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

async function reachableBots(state: TelegramState): Promise<Bot[]> {
  return (await listBots()).filter((bot) => !state.hiddenBots.includes(bot.id))
}

async function reachableProjects(state: TelegramState): Promise<Project[]> {
  return (await listProjects()).filter((project) => state.projects.includes(project.id))
}

export async function getTelegramStatus(): Promise<TelegramStatus> {
  const state = await current()
  const open = pairing && pairing.expiresAt > Date.now() ? pairing : null
  return {
    hasToken: Boolean(token),
    username: state.username,
    state: token ? pollState : 'off',
    error: pollError ?? sendError ?? topicsError,
    paired: state.userId !== null,
    group: state.group?.title ?? null,
    pairing: open ? { code: open.code, expiresAt: new Date(open.expiresAt).toISOString() } : null,
    reachableBots: (await reachableBots(state)).map((bot) => bot.id),
    reachableProjects: (await reachableProjects(state)).map((project) => project.id)
  }
}

/** Tells Settings when the status changed. */
function changed(): void {
  void getTelegramStatus()
    .then((status) => {
      const text = JSON.stringify(status)
      if (text === lastStatus) return
      lastStatus = text
      onStatus(status)
    })
    .catch(() => {})
}

function report(): Promise<TelegramStatus> {
  changed()
  return getTelegramStatus()
}

// ---- Settings

/** Checks the token with Telegram before it is kept. Null removes it and unpairs. */
export async function setTelegramToken(input: string | null): Promise<TelegramStatus> {
  await current()
  if (input === null) {
    stopPolling()
    clearPairing()
    asks.clear()
    token = null
    pollError = null
    sendError = null
    topicsError = null
    await save((state) => {
      state.token = null
      state.username = null
      unpairState(state)
      state.offset = 0
    })
    return report()
  }
  const value = String(input).trim()
  if (!TOKEN_PATTERN.test(value)) {
    throw new Error('This is not a Telegram bot token. BotFather gives one that looks like 123456789:AAH…')
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The system keychain is not available to encrypt the token.')
  let username: string | null
  try {
    username = (await makeClient(value).getMe()).username ?? null
  } catch (error) {
    throw new Error(`Telegram did not accept this token: ${messageOf(error)}`)
  }
  // Another bot does not know the paired chats or their topics.
  const sameBot = token?.split(':')[0] === value.split(':')[0]
  stopPolling()
  token = value
  pollError = null
  sendError = null
  if (!sameBot) topicsError = null
  await save((state) => {
    state.token = safeStorage.encryptString(value).toString('base64')
    state.username = username
    if (!sameBot) {
      unpairState(state)
      state.offset = 0
    }
  })
  startPolling()
  return report()
}

/** A code for `/pair`, valid for 10 minutes. A new one replaces the last. */
export async function startPairing(): Promise<TelegramStatus> {
  await current()
  if (!token) throw new Error('Save the bot token first.')
  clearPairing()
  const timer = setTimeout(() => {
    clearPairing()
    changed()
  }, PAIRING_MS)
  timer.unref?.()
  pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + PAIRING_MS, tries: 0, timer }
  return report()
}

function clearPairing(): void {
  if (pairing) clearTimeout(pairing.timer)
  pairing = null
}

function unpairState(state: TelegramState): void {
  state.userId = null
  state.group = null
  state.topics = {}
}

/** Forgets the user, the group and its topics. The token stays. */
export async function unpairTelegram(): Promise<TelegramStatus> {
  asks.clear()
  topicsError = null
  await save(unpairState)
  return report()
}

export async function setTelegramReachable(input: { bots?: unknown; projects?: unknown }): Promise<TelegramStatus> {
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string'))] : []
  const bots = new Set(ids(input.bots))
  const all = await listBots()
  await save((state) => {
    state.hiddenBots = all.filter((bot) => !bots.has(bot.id)).map((bot) => bot.id)
    state.projects = ids(input.projects)
  })
  await ensureTopics(true)
  return report()
}

// ---- Polling

/** At app start: polls when a token is saved, and makes the topics still missing, as after the group became a supergroup. */
export async function startChannels(): Promise<void> {
  const state = await current()
  if (!token) return
  startPolling()
  if (state.group) void ensureTopics(false).catch(() => {})
}

export function stopChannels(): void {
  stopPolling()
  clearPairing()
}

function startPolling(): void {
  stopPolling()
  if (!token) return
  const controller = new AbortController()
  loop = controller
  client = makeClient(token)
  botIcon = null
  pollState = 'connecting'
  pollError = null
  changed()
  void pollLoop(client, controller)
}

function stopPolling(): void {
  loop?.abort()
  loop = null
  client = null
  botIcon = null
  pollState = 'off'
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

async function pollLoop(telegram: TelegramClient, controller: AbortController): Promise<void> {
  const { signal } = controller
  let delay = RETRY_MS
  while (!signal.aborted) {
    try {
      const updates = await telegram.getUpdates((await current()).offset, signal)
      if (signal.aborted) return
      if (pollState !== 'connected' || pollError) {
        pollState = 'connected'
        pollError = null
        changed()
      }
      for (const update of updates) {
        if (signal.aborted) return
        // Kept before it is handled: after a crash a message is lost rather than run twice.
        await save((state) => {
          state.offset = Math.max(state.offset, update.update_id + 1)
        })
        await handleUpdate(update).catch(() => {})
      }
      delay = RETRY_MS
    } catch (error) {
      if (signal.aborted) return
      // Asking again would not help: the token is wrong, or another app reads this bot's messages.
      if (error instanceof TelegramError && (error.code === 401 || error.code === 409)) {
        if (loop === controller) loop = null
        pollState = 'error'
        pollError =
          error.code === 401
            ? 'Telegram refused the bot token. Save a new one.'
            : 'Another app is reading this bot’s messages. Stop it, then save the token again.'
        changed()
        return
      }
      pollState = 'error'
      pollError = messageOf(error)
      changed()
      await sleep(delay, signal)
      delay = Math.min(delay * 2, MAX_RETRY_MS)
    }
  }
}

// ---- Sending

/** Cut at Telegram's limit, on a line break where there is one in the second half. */
export function splitMessage(text: string, max = MAX_TEXT): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = max
    // Not between the two halves of an emoji.
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.trim()) parts.push(rest)
  return parts
}

function retryable(error: unknown): boolean {
  return error instanceof TelegramError && (error.code === 0 || error.code === 429 || error.code >= 500)
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= SEND_RETRIES_MS.length || !retryable(error)) throw error
      await sleep(SEND_RETRIES_MS[attempt])
    }
  }
}

/** Plain text, cut to size. The buttons go under the last part. Never throws: a failure shows in the status. */
async function deliver(place: Place, text: string, buttons?: InlineButton[][]): Promise<number | null> {
  const telegram = client
  if (!telegram) return null
  const parts = splitMessage(text)
  let last: number | null = null
  let chat = place.chat
  try {
    for (const [index, part] of parts.entries()) {
      const options = { threadId: place.thread, ...(buttons && index === parts.length - 1 ? { buttons } : {}) }
      const sent = await withRetry(() => telegram.sendMessage(chat, part, options)).catch(async (error: unknown) => {
        const moved = await migrated(chat, error, true)
        if (moved === null) throw error
        chat = moved
        return withRetry(() => telegram.sendMessage(chat, part, options))
      })
      last = sent.message_id
    }
    if (sendError) {
      sendError = null
      changed()
    }
  } catch (error) {
    sendError = `Could not send to Telegram: ${messageOf(error)}`
    changed()
  }
  return last
}

/** A reply: its text, then, with /voice on, the same reply spoken without the bot's name. The voice memo is best effort. */
async function deliverReply(place: Place, text: string, prefix = ''): Promise<void> {
  if ((await deliver(place, prefix + text)) === null) return
  if (!speak || !(await current()).voiceReplies) return
  void sendSpoken(place, text, speak)
}

async function sendSpoken(place: Place, text: string, voice: Speak): Promise<void> {
  let ogg: Buffer
  try {
    ogg = await voice(text)
  } catch (error) {
    sendError = `Could not speak the reply: ${messageOf(error)}`
    changed()
    return
  }
  const telegram = client
  if (!telegram) return
  try {
    await withRetry(() => telegram.sendVoice(place.chat, ogg, { threadId: place.thread })).catch(async (error: unknown) => {
      const moved = await migrated(place.chat, error, true)
      if (moved === null) throw error
      return withRetry(() => telegram.sendVoice(moved, ogg, { threadId: place.thread }))
    })
  } catch (error) {
    sendError = `Could not send a voice memo to Telegram: ${messageOf(error)}`
    changed()
  }
}

function topicOf(state: TelegramState, match: (target: Target) => boolean): number | undefined {
  const found = Object.entries(state.topics).find(([, target]) => match(target))
  return found ? Number(found[0]) : undefined
}

/** Saves the paired group's new id, once it became a supergroup. Its topics stay. False when `from` is not the paired group. */
async function moveGroup(from: number, to: number): Promise<boolean> {
  let moved = false
  await save((state) => {
    if (state.group?.id !== from) return
    state.group = { ...state.group, id: to }
    moved = true
  })
  if (moved) {
    topicsRefused = false
    changed()
  }
  return moved
}

/**
 * The paired group's new id when Telegram refused a call to `chat` because the group became a supergroup, else null.
 * The id is saved; with `makeTopics` the topics are made there afterwards, which ensureTopics itself must not ask for.
 */
async function migrated(chat: number, error: unknown, makeTopics: boolean): Promise<number | null> {
  if (!(error instanceof TelegramError) || !error.migrateTo) return null
  const to = error.migrateTo
  // Followed already, by an earlier call.
  if ((await current()).group?.id === to) return to
  if (!(await moveGroup(chat, to))) return null
  if (makeTopics) void ensureTopics(true).catch(() => {})
  return to
}

/** The colours Telegram allows for a topic icon. */
const TOPIC_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f]

/** The Telegram topic colour nearest to a project's `#RRGGBB` colour, or undefined when it has none that can be read. */
function topicColor(color: string | undefined): number | undefined {
  const hex = normalizeHexColor(color)
  if (!hex) return undefined
  const channels = (value: number): number[] => [value >> 16, (value >> 8) & 255, value & 255]
  const want = channels(parseInt(hex.slice(1), 16))
  const distance = (value: number): number => channels(value).reduce((sum, part, i) => sum + (part - want[i]) ** 2, 0)
  return TOPIC_COLORS.reduce((best, value) => (distance(value) < distance(best) ? value : best))
}

function sameTarget(a: Target, b: Target): boolean {
  return a.kind === 'bot' ? b.kind === 'bot' && a.botId === b.botId : b.kind === 'project' && a.projectId === b.projectId
}

/** Makes a topic for each reachable bot and project that has none. Topics are never deleted. */
async function ensureTopics(tell: boolean): Promise<void> {
  await withLock('telegram-topics', async () => {
    const state = await current()
    const telegram = client
    const group = state.group
    if (!group || !telegram || (!tell && topicsRefused)) return
    let groupId = group.id
    const wanted: Array<{ name: string; target: Target; color?: string }> = [
      ...(await reachableBots(state)).map((bot) => ({ name: bot.name, target: { kind: 'bot', botId: bot.id } as Target })),
      ...(await reachableProjects(state)).map((project) => ({
        name: project.name,
        target: { kind: 'project', projectId: project.id } as Target,
        color: project.color
      }))
    ]
    for (const { name, target, color } of wanted) {
      if (topicOf(state, (item) => sameTarget(item, target)) !== undefined) continue
      let thread: number
      try {
        let icon: TopicIcon = {}
        if (target.kind === 'project') {
          const value = topicColor(color)
          if (value !== undefined) icon = { color: value }
        } else {
          botIcon ??= telegram.getForumTopicIconStickers().then(
            (stickers) => stickers.find((sticker) => sticker.emoji === '🤖')?.custom_emoji_id,
            () => undefined
          )
          const emojiId = await botIcon
          if (emojiId) icon = { emojiId }
        }
        const hasIcon = icon.color !== undefined || icon.emojiId !== undefined
        const make = (chat: number): Promise<number> =>
          telegram.createForumTopic(chat, name, icon).catch((error: unknown) => {
            // An icon never stops a topic: a plain 400 is tried again without it.
            if (!hasIcon || !(error instanceof TelegramError) || error.code !== 400 || error.migrateTo) throw error
            return telegram.createForumTopic(chat, name)
          })
        thread = await make(groupId).catch(async (error: unknown) => {
          const moved = await migrated(groupId, error, false)
          if (moved === null) throw error
          groupId = moved
          return make(groupId)
        })
      } catch (error) {
        // A 400 or 403: the group has no topics, or the bot may not manage them.
        if (error instanceof TelegramError && (error.code === 400 || error.code === 403)) {
          topicsRefused = true
          topicsError = `Could not make a topic for ${name}: ${messageOf(error)}. Turn on Topics in the group settings and make this bot an admin that may manage topics.`
          changed()
          if (tell) await deliver({ chat: groupId }, TOPICS_NEEDED)
        } else {
          sendError = `Could not make a topic: ${messageOf(error)}`
          changed()
        }
        return
      }
      await save((latest) => {
        latest.topics[String(thread)] = target
      })
    }
    topicsRefused = false
    if (topicsError) {
      topicsError = null
      changed()
    }
  })
}

/** Links a topic the user made by hand to the reachable bot or project of its name that has no topic yet. */
async function linkTopic(thread: number, name: string): Promise<boolean> {
  return withLock('telegram-topics', async () => {
    const state = await current()
    const wanted = name.trim().toLowerCase()
    const free = (target: Target): boolean => topicOf(state, (item) => sameTarget(item, target)) === undefined
    const target = [
      ...(await reachableBots(state)).map((bot) => ({ name: bot.name, target: { kind: 'bot', botId: bot.id } as Target })),
      ...(await reachableProjects(state)).map((project) => ({
        name: project.name,
        target: { kind: 'project', projectId: project.id } as Target
      }))
    ].find((item) => item.name.trim().toLowerCase() === wanted && free(item.target))?.target
    if (!target) return false
    await save((latest) => {
      latest.topics[String(thread)] = target
    })
    return true
  })
}

/** Where a bot speaks: its topic, else the group or the direct message with its name in front. Null when it is not reachable. */
async function botPlace(bot: Bot): Promise<{ place: Place; prefix: string } | null> {
  const state = await current()
  if (state.userId === null || state.hiddenBots.includes(bot.id)) return null
  if (!state.group) return { place: { chat: state.userId }, prefix: `${bot.name}: ` }
  const isBot = (target: Target): boolean => target.kind === 'bot' && target.botId === bot.id
  if (topicOf(state, isBot) === undefined) await ensureTopics(false)
  const thread = topicOf(state, isBot)
  if (thread !== undefined) return { place: { chat: state.group.id, thread }, prefix: '' }
  return { place: { chat: state.group.id }, prefix: `${bot.name}: ` }
}

/**
 * A new message from the bot in its own chat. Every one passes through `botMessage` in chatTools.ts,
 * which hands it here, so each reaches Telegram exactly once.
 */
export async function telegramBotMessage(bot: Bot, text: string): Promise<void> {
  if (!text.trim()) return
  const at = await botPlace(bot)
  if (at) await deliverReply(at.place, text, at.prefix)
}

// ---- Incoming

export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) await handleCallback(update.callback_query)
  else if (update.message) await handleMessage(update.message)
}

/** Whether the paired user sent this, in their direct message or the paired group. */
function fromPaired(state: TelegramState, from: number | undefined, chat: TelegramMessage['chat'] | undefined): boolean {
  if (state.userId === null || from !== state.userId || !chat) return false
  return chat.type === 'private' ? chat.id === state.userId : chat.id === state.group?.id
}

function parseCommand(text: string, username: string | null): { name: string; rest: string } | null {
  const match = /^\/([a-z]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(text)
  if (!match) return null
  // Meant for another bot in the group.
  if (match[2] && username && match[2].toLowerCase() !== username.toLowerCase()) return null
  return { name: match[1].toLowerCase(), rest: (match[3] ?? '').trim() }
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  const state = await current()
  // The paired group became a supergroup. The supergroup's message comes from a chat not known yet.
  if (message.migrate_to_chat_id || message.migrate_from_chat_id) {
    const group = state.group
    const to =
      message.migrate_to_chat_id && message.chat.id === group?.id
        ? message.migrate_to_chat_id
        : message.migrate_from_chat_id && message.migrate_from_chat_id === group?.id
          ? message.chat.id
          : undefined
    if (group && to !== undefined && (await moveGroup(group.id, to))) await ensureTopics(true)
    return
  }
  if (!message.from || message.from.is_bot) return
  const text = (message.text ?? '').trim()
  const command = parseCommand(text, state.username)
  if (command?.name === 'pair') return tryPair(message, command.rest)
  if (!fromPaired(state, message.from.id, message.chat)) return
  if (message.forum_topic_created) {
    if (message.message_thread_id && message.chat.id === state.group?.id) {
      await linkTopic(message.message_thread_id, message.forum_topic_created.name)
    }
    return
  }
  const place: Place = {
    chat: message.chat.id,
    ...(message.is_topic_message && message.message_thread_id ? { thread: message.message_thread_id } : {})
  }
  // A topic made by hand is linked by its name; one that cannot be is not passed on.
  if (place.thread !== undefined && place.chat === state.group?.id && !state.topics[String(place.thread)]) {
    const name = message.reply_to_message?.forum_topic_created?.name
    if (!name || !(await linkTopic(place.thread, name))) {
      await deliver(place, NOT_LINKED)
      return
    }
  }
  try {
    if (command?.name === 'help') {
      await deliver(place, await helpText(state))
      return
    }
    if (command?.name === 'new') return await startNewChat(place, command.rest)
    if (command?.name === 'voice') return await setVoiceReplies(place, command.rest)
    const voice = message.voice ?? message.audio
    let body = text
    if (voice) {
      const heard = await transcribeVoice(place, voice)
      if (heard === null) return
      body = heard
    } else if (!message.text) {
      await deliver(place, ONLY_TEXT)
      return
    }
    const open = openQuestionAt(place)
    if (open) return await answerTyped(open, body)
    await routeText(place, body)
  } catch (error) {
    await deliver(place, `Could not pass that on: ${messageOf(error)}`)
  }
}

async function tryPair(message: TelegramMessage, code: string): Promise<void> {
  const state = await current()
  const from = message.from!.id
  // Once paired, only the paired user may pair again, such as to add a group.
  if (state.userId !== null && state.userId !== from) return
  const open = pairing
  if (!open || open.expiresAt <= Date.now()) return
  const place: Place = { chat: message.chat.id }
  const given = Buffer.from(code)
  const wanted = Buffer.from(open.code)
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    open.tries += 1
    if (open.tries >= PAIRING_TRIES) {
      clearPairing()
      changed()
    }
    await deliver(place, 'That code is not right.')
    return
  }
  clearPairing()
  const inGroup = message.chat.type === 'group' || message.chat.type === 'supergroup'
  const group = inGroup
    ? { id: message.chat.id, title: message.chat.title ?? 'Group' }
    : state.userId === from
      ? state.group
      : null
  await save((latest) => {
    if (latest.group?.id !== group?.id) latest.topics = {}
    latest.userId = from
    latest.group = group
  })
  changed()
  await deliver(place, `Paired with Datapad Workbench.\n\n${await helpText(state)}`)
  if (inGroup) await ensureTopics(true)
}

async function helpText(state: TelegramState): Promise<string> {
  const bots = await reachableBots(state)
  const chief = bots.find((bot) => bot.chief)
  const lines = [
    chief ? `Write to talk to ${chief.name}.` : '',
    bots.length > 0 ? `Start with @Name to talk to another bot: ${bots.map((bot) => `@${bot.name}`).join(', ')}.` : '',
    state.group ? 'In the group, each bot and project has its own topic.' : '',
    '/new starts a fresh chat in a project’s topic.',
    transcribe ? 'Voice notes work too.' : '',
    speak ? `/voice on also sends each reply as a voice memo, /voice off stops that. Now ${state.voiceReplies ? 'on' : 'off'}.` : '',
    '/help shows this.'
  ]
  return lines.filter(Boolean).join('\n')
}

async function setVoiceReplies(place: Place, rest: string): Promise<void> {
  if (!speak) {
    await deliver(place, 'Spoken replies are not available.')
    return
  }
  const word = rest.toLowerCase()
  if (word === 'on' || word === 'off') {
    await save((state) => {
      state.voiceReplies = word === 'on'
    })
  } else if (word) {
    await deliver(place, 'Write /voice on, /voice off, or /voice to see which it is.')
    return
  }
  await deliver(
    place,
    (await current()).voiceReplies
      ? 'Spoken replies are on: each reply also comes as a voice memo.'
      : 'Spoken replies are off. /voice on turns them on.'
  )
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

async function transcribeVoice(place: Place, voice: { file_id: string; mime_type?: string }): Promise<string | null> {
  const telegram = client
  if (!transcribe || !telegram) {
    await deliver(place, 'Voice notes are not available yet. Write your message instead.')
    return null
  }
  if (prepareTranscribe) {
    try {
      await prepareTranscribe(async (bytes) => {
        await deliver(place, `Fetching the speech model for voice notes once (${megabytes(bytes)}); this note is transcribed when it is in.`)
      })
    } catch (error) {
      await deliver(place, `Could not fetch the speech model for voice notes: ${messageOf(error)}. Send the voice note again to try once more.`)
      return null
    }
  }
  try {
    const text = (await transcribe(await telegram.downloadFile(voice.file_id), voice.mime_type ?? 'audio/ogg')).trim()
    if (!text) {
      await deliver(place, 'Could not make out any words in that voice note.')
      return null
    }
    await deliver(place, `Heard: ${text}`)
    return text
  } catch (error) {
    await deliver(place, `Could not transcribe that voice note: ${messageOf(error)}`)
    return null
  }
}

function topicAt(state: TelegramState, place: Place): Target | undefined {
  return place.thread !== undefined && place.chat === state.group?.id ? state.topics[String(place.thread)] : undefined
}

async function routeText(place: Place, text: string): Promise<void> {
  const state = await current()
  const topic = topicAt(state, place)
  if (topic?.kind === 'project') return sendToProject(place, topic, text)
  const bots = await reachableBots(state)
  if (topic?.kind === 'bot') {
    const bot = bots.find((item) => item.id === topic.botId)
    if (!bot) {
      await deliver(place, 'This bot is not reachable from Telegram. Switch it on in Datapad Workbench Settings.')
      return
    }
    return sendToBot(bot, text, place)
  }
  const { addressed, rest } = splitBotMentions(
    text,
    bots.map((bot) => ({ id: bot.id, name: bot.name }))
  )
  const named = addressed.length > 0 ? bots.find((bot) => bot.id === addressed[0].id) : undefined
  if (named) {
    if (!rest) {
      await deliver(place, `Write your message for ${named.name} after @${named.name}.`)
      return
    }
    return sendToBot(named, rest, place)
  }
  const chief = bots.find((bot) => bot.chief)
  if (chief) return sendToBot(chief, text, place)
  await deliver(
    place,
    bots.length > 0
      ? `Start your message with the bot it is for: ${bots.map((bot) => `@${bot.name}`).join(', ')}.`
      : 'No bot is reachable from Telegram. Switch one on in Datapad Workbench Settings.'
  )
}

function busy(name: string): string {
  return `${name} is still working on the previous message. Send this again once it has answered.`
}

async function sendToBot(bot: Bot, text: string, place: Place): Promise<void> {
  const chat = await botChat(bot.id)
  if (chatRunning(chat.id)) {
    await deliver(place, busy(bot.name))
    return
  }
  const { done } = await send(chat.id, text)
  // The answer comes through telegramBotMessage, like every message of the bot. Only a failure is told here.
  done.catch(async (error: unknown) => {
    const at = await botPlace(bot)
    if (at) await deliver(at.place, `${at.prefix}Stopped: ${messageOf(error)}`)
  })
}

async function topicProject(state: TelegramState, topic: Target | undefined): Promise<Project | null | undefined> {
  if (topic?.kind !== 'project') return undefined
  return (await reachableProjects(state)).find((project) => project.id === topic.projectId) ?? null
}

/** A fresh chat for a project's topic. The one before stays in the sidebar. */
async function newTopicChat(thread: number, projectId: string): Promise<string> {
  const chat = await createChat(projectId, { title: 'Telegram' })
  emitChat(chat)
  await save((state) => {
    state.topics[String(thread)] = { kind: 'project', projectId, chatId: chat.id }
  })
  return chat.id
}

async function sendToProject(place: Place, topic: Target & { kind: 'project' }, text: string): Promise<void> {
  const state = await current()
  const project = await topicProject(state, topic)
  if (!project) {
    await deliver(place, 'This project is not reachable from Telegram. Switch it on in Datapad Workbench Settings.')
    return
  }
  const existing = topic.chatId ? await getChat(topic.chatId).catch(() => null) : null
  const chatId = existing?.id ?? (await newTopicChat(place.thread!, project.id))
  if (chatRunning(chatId)) {
    await deliver(place, busy(project.name))
    return
  }
  const { done } = await send(chatId, text)
  done.then(
    (saved) => {
      const reply = saved?.messages.at(-1)
      const answer = reply?.role === 'assistant' ? replySteps(reply.content).at(-1) : undefined
      if (answer) return deliverReply(place, answer)
      return deliver(place, 'Finished.').then(() => undefined)
    },
    (error: unknown) => deliver(place, `Stopped: ${messageOf(error)}`)
  )
}

async function startNewChat(place: Place, rest: string): Promise<void> {
  const state = await current()
  const topic = topicAt(state, place)
  const project = await topicProject(state, topic)
  if (project === undefined || topic?.kind !== 'project') {
    await deliver(place, '/new works in a project’s topic.')
    return
  }
  if (!project) {
    await deliver(place, 'This project is not reachable from Telegram. Switch it on in Datapad Workbench Settings.')
    return
  }
  const chatId = await newTopicChat(place.thread!, project.id)
  if (rest) return sendToProject(place, { ...topic, chatId }, rest)
  await deliver(place, `Started a new chat in ${project.name}.`)
}

// ---- Questions and approvals

/** A bot asked from another chat asks the user there, where they wait. */
function shownChat(request: { chatId: string; shownIn?: ShownIn }): string {
  return request.shownIn?.chatId ?? request.chatId
}

/** Where a request in this chat is shown on Telegram: a reachable bot's chats, or a project topic's chat. */
async function placeForChat(chatId: string): Promise<{ place: Place; prefix: string; name: string } | null> {
  const state = await current()
  if (state.userId === null) return null
  const chat = await getChat(chatId).catch(() => null)
  if (!chat) return null
  if (isBotsOwn(chat)) {
    const bot = await getBot(chat.botId).catch(() => null)
    const at = bot ? await botPlace(bot) : null
    return bot && at ? { ...at, name: bot.name } : null
  }
  const group = state.group
  const thread = topicOf(state, (target) => target.kind === 'project' && target.chatId === chatId)
  const project = (await reachableProjects(state)).find((item) => item.id === chat.projectId)
  if (!group || thread === undefined || !project) return null
  return { place: { chat: group.id, thread }, prefix: '', name: project.name }
}

function newAsk(kind: Ask['kind'], requestId: string, questions: UserQuestion[] = []): Ask {
  const ask: Ask = {
    id: (++askCount).toString(36),
    kind,
    requestId,
    place: null,
    prefix: '',
    messageId: null,
    questions,
    index: 0,
    answers: []
  }
  asks.set(ask.id, ask)
  return ask
}

/** The request was answered, here or in the app, or its turn stopped: its buttons come off. */
function settle(requestId: string): void {
  for (const ask of [...asks.values()]) {
    if (ask.requestId !== requestId) continue
    asks.delete(ask.id)
    void dropButtons(ask)
  }
}

async function dropButtons(ask: Ask): Promise<void> {
  const telegram = client
  if (!telegram || !ask.place || ask.messageId === null) return
  await telegram.removeButtons(ask.place.chat, ask.messageId).catch(() => {})
}

/** Sends the message with its buttons. Settled meanwhile, the buttons come off at once. */
async function show(ask: Ask, text: string, buttons: InlineButton[][]): Promise<void> {
  ask.messageId = await deliver(ask.place!, text, buttons)
  if (!asks.has(ask.id)) await dropButtons(ask)
}

async function raisePermission(request: PermissionRequest): Promise<void> {
  const ask = newAsk('permission', request.requestId)
  const at = await placeForChat(shownChat(request))
  if (!at || !asks.has(ask.id)) {
    asks.delete(ask.id)
    return
  }
  ask.place = at.place
  const askedBy = request.shownIn ? `${request.shownIn.botName}: ` : ''
  const detail = request.detail?.trim() ? `\n\n${clip(request.detail.trim(), 800)}` : ''
  await show(ask, `${at.prefix}${askedBy}Needs approval: ${request.title}${detail}`, [
    [
      { text: 'Allow', callback_data: `${ask.id}:0:a` },
      { text: 'Deny', callback_data: `${ask.id}:0:d` }
    ]
  ])
}

async function raiseQuestion(request: UserQuestionRequest): Promise<void> {
  const ask = newAsk('question', request.requestId, request.questions)
  const at = await placeForChat(shownChat(request))
  if (!at || !asks.has(ask.id) || request.questions.length === 0) {
    asks.delete(ask.id)
    return
  }
  // A secret is typed in the app only, so it never passes through Telegram.
  if (request.questions.some((question) => question.secret)) {
    asks.delete(ask.id)
    await deliver(at.place, `${request.shownIn?.botName ?? at.name} needs a secret. Enter it in the app.`)
    return
  }
  ask.place = at.place
  ask.prefix = at.prefix + (request.shownIn ? `${request.shownIn.botName}: ` : '')
  await showQuestion(ask)
}

async function showQuestion(ask: Ask): Promise<void> {
  const question = ask.questions[ask.index]
  const count = ask.questions.length > 1 ? ` (${ask.index + 1} of ${ask.questions.length})` : ''
  const header = question.header && question.header !== question.question ? `${question.header}: ` : ''
  const lines = [`${ask.prefix}${header}${question.question}${count}`]
  const described = question.options.filter((option) => option.description)
  if (question.multiSelect && question.options.length > 0) {
    lines.push('', ...question.options.map((option) => `• ${option.label}${option.description ? `: ${option.description}` : ''}`))
    lines.push('', 'Reply with the options you pick, separated by commas.')
  } else {
    if (described.length > 0) lines.push('', ...described.map((option) => `• ${option.label}: ${option.description}`))
    lines.push('', question.options.length > 0 ? 'Tap an option, or reply with your own answer.' : 'Reply with your answer.')
  }
  const options = question.multiSelect
    ? []
    : question.options.map((option, index) => [{ text: clip(option.label, 60), callback_data: `${ask.id}:${ask.index}:${index}` }])
  await show(ask, lines.join('\n'), [...options, [{ text: 'Skip', callback_data: `${ask.id}:${ask.index}:s` }]])
}

function openQuestionAt(place: Place): Ask | undefined {
  return [...asks.values()]
    .reverse()
    .find((ask) => ask.kind === 'question' && ask.place?.chat === place.chat && ask.place.thread === place.thread)
}

async function answerTyped(ask: Ask, text: string): Promise<void> {
  const question = ask.questions[ask.index]
  const label = (item: string): string =>
    question.options.find((option) => option.label.toLowerCase() === item.toLowerCase())?.label ?? item
  const answer = question.multiSelect
    ? text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map(label)
    : [label(text.trim())]
  await answerCurrent(ask, answer)
}

async function answerCurrent(ask: Ask, answer: string[]): Promise<void> {
  ask.answers[ask.index] = answer
  ask.index += 1
  if (ask.index >= ask.questions.length) {
    // The settle listener takes the buttons off.
    if (!resolveUserQuestion(ask.requestId, { type: 'submit', answers: ask.answers })) settle(ask.requestId)
    return
  }
  await dropButtons(ask)
  await showQuestion(ask)
}

async function handleCallback(query: TelegramCallbackQuery): Promise<void> {
  const state = await current()
  if (!fromPaired(state, query.from.id, query.message?.chat)) return
  const telegram = client
  const answer = (text?: string): Promise<void> =>
    telegram ? telegram.answerCallbackQuery(query.id, text).catch(() => {}) : Promise.resolve()
  const [id, index, choice] = (query.data ?? '').split(':')
  const ask = asks.get(id)
  if (!ask || Number(index) !== ask.index) return answer('No longer open')
  if (ask.kind === 'permission') {
    const allow = choice === 'a'
    if (!resolvePermission(ask.requestId, allow ? 'allow' : 'deny')) {
      settle(ask.requestId)
      return answer('No longer open')
    }
    return answer(allow ? 'Allowed' : 'Denied')
  }
  if (choice === 's') {
    if (!resolveUserQuestion(ask.requestId, { type: 'skip' })) settle(ask.requestId)
    return answer('Skipped')
  }
  const option = ask.questions[ask.index]?.options[Number(choice)]
  if (!option) return answer('No longer open')
  await answer()
  await answerCurrent(ask, [option.label])
}
