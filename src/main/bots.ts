import { app, shell } from 'electron'
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'path'
import {
  normalizeChatAgent,
  normalizeReasoningEffort,
  type Bot,
  type BotDocument,
  type BotMemory,
  type DefaultBotAvatar,
  type UpdateBotInput
} from '../shared/types'
import { id, now } from './ids'
import { readJsonFile, withLock, writeFileAtomic } from './storeIo'

/** A bot as saved in bots.json. Its folder follows from its id. */
type StoredBot = Omit<Bot, 'folder'>

type BotsFile = { bots: StoredBot[] }

export const AVATAR_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

const MAX_AVATAR_BYTES = 5 * 1024 * 1024

function botsDir(): string {
  return join(app.getPath('userData'), 'workbench', 'bots')
}

function botsFile(): string {
  return join(app.getPath('userData'), 'workbench', 'bots.json')
}

export function botFolder(botId: string): string {
  return join(botsDir(), botId.replace(/[^\w-]/g, '_'))
}

/** Whether `path` is a bot's folder or inside one, where bot chats work. */
export function isBotFolder(path: string): boolean {
  const rel = relative(botsDir(), path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function withFolder(bot: StoredBot): Bot {
  // Bots saved before effort was a setting follow the global one. Those saved before the bot's chat have none yet.
  // Those saved before MCP servers were chosen per bot get none, until they are switched on.
  return {
    ...bot,
    effort: bot.effort ?? '',
    mcpServers: bot.mcpServers ?? [],
    chatId: bot.chatId ?? null,
    unread: bot.unread ?? 0,
    folder: botFolder(bot.id)
  }
}

async function loadBots(): Promise<StoredBot[]> {
  const data = await readJsonFile<BotsFile>(botsFile(), { bots: [] })
  return Array.isArray(data.bots) ? data.bots : []
}

async function saveBots(bots: StoredBot[]): Promise<void> {
  await writeFileAtomic(botsFile(), JSON.stringify({ bots } satisfies BotsFile, null, 2))
}

function withBotsLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(botsFile(), fn)
}

/** Plugin names may only hold lowercase letters, digits and dashes. */
function pluginName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'bot'
  )
}

/** The bot's folder doubles as a plugin, so both agent CLIs load its skills. */
async function writePluginFolder(bot: StoredBot): Promise<void> {
  const folder = botFolder(bot.id)
  await mkdir(join(folder, 'skills'), { recursive: true })
  const manifest = JSON.stringify(
    { name: pluginName(bot.name), version: '0.0.1', description: `Skills of the bot ${bot.name}` },
    null,
    2
  )
  for (const dir of ['.grok-plugin', '.claude-plugin']) {
    await mkdir(join(folder, dir), { recursive: true })
    await writeFileAtomic(join(folder, dir, 'plugin.json'), manifest)
  }
}

export async function listBots(): Promise<Bot[]> {
  const bots = await loadBots()
  return bots.map(withFolder).sort((a, b) => a.name.localeCompare(b.name))
}

export async function getBot(botId: string): Promise<Bot> {
  const bot = (await loadBots()).find((item) => item.id === botId)
  if (!bot) throw new Error('Bot not found')
  return withFolder(bot)
}

/** Where the bot keeps what it learns. It outlives every chat and both agents. */
export function botMemoryFolder(botId: string): string {
  return join(botFolder(botId), 'memory')
}

/** The books and documents the user gave the bot, each converted into a folder of its own. */
export function botDocumentsFolder(botId: string): string {
  return join(botFolder(botId), 'documents')
}

/** What every bot knows: who the user is and what they work on. Every bot reads it, and asks before writing in it. */
export function sharedMemoryFolder(): string {
  return join(app.getPath('userData'), 'workbench', 'memory')
}

const MEMORY_INDEX = 'MEMORY.md'
/** How much of MEMORY.md each session starts with. The index is meant to stay short. */
const MAX_INDEX_CHARS = 8000
/** The shared index is in every session of every bot, so it gets less room. */
const MAX_SHARED_INDEX_CHARS = 2000

export function readBotMemory(botId: string): Promise<BotMemory> {
  return readMemory(botMemoryFolder(botId))
}

export function readSharedMemory(): Promise<BotMemory> {
  return readMemory(sharedMemoryFolder())
}

/** The memory folder is made here, so it is there before a bot first writes in it. */
async function readMemory(folder: string): Promise<BotMemory> {
  await mkdir(folder, { recursive: true }).catch(() => {})
  const index = await readFile(join(folder, MEMORY_INDEX), 'utf8').catch(() => '')
  const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => [])
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => path !== MEMORY_INDEX && !path.split('/').some((part) => part.startsWith('.')))
    .sort()
  return { folder, index, files }
}

export async function saveBotMemoryIndex(botId: string, index: string): Promise<BotMemory> {
  await getBot(botId)
  return saveMemoryIndex(botMemoryFolder(botId), index)
}

export function saveSharedMemoryIndex(index: string): Promise<BotMemory> {
  return saveMemoryIndex(sharedMemoryFolder(), index)
}

async function saveMemoryIndex(folder: string, index: string): Promise<BotMemory> {
  await mkdir(folder, { recursive: true })
  await writeFileAtomic(join(folder, MEMORY_INDEX), index)
  return readMemory(folder)
}

function shownIndex(index: string, max: number): string {
  const text = index.trim()
  if (!text) return '(empty)'
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (cut here: keep ${MEMORY_INDEX} short and move details into files)`
}

/** How the bot finds its way in its documents, with one line per document. Empty when it has none. */
function documentRules(bot: Bot, documents: BotDocument[]): string {
  if (documents.length === 0) return ''
  return [
    '## Documents',
    `The user gave you books and documents to work from, in the folder ${botDocumentsFolder(bot.id)}. Each has a folder there with OUTLINE.md, which lists its chapters and what each covers, and one Markdown file per chapter.`,
    '- When a request touches what one of them covers, read its OUTLINE.md and then the chapters that matter, before you answer. Do not answer from what you remember of a book.',
    '- When the outline does not point to it, search the document\'s folder for the words.',
    '- Say which document and chapter an answer rests on.',
    '- You can read these files without asking. Leave the chapter files as they are. In OUTLINE.md you may add or correct what a chapter covers.',
    '',
    ...documents.map(
      (doc) => `- ${doc.title} (${doc.chapters} ${doc.chapters === 1 ? 'chapter' : 'chapters'}): ${doc.id}/OUTLINE.md`
    )
  ].join('\n')
}

/**
 * The bot's instructions, the indexes of its own and the shared memory and the list of its documents, as rules
 * for each of its sessions.
 */
export function botSessionRules(bot: Bot, memoryIndex = '', sharedIndex = '', documents: BotDocument[] = []): string {
  const intro = `You are ${bot.name}, a bot in Datapad Workbench.`
  const instructions = bot.instructions.trim()
  const images =
    bot.agent === 'grok'
      ? [
          '## Images',
          '- When the user asks for an image, such as a picture, logo, illustration or ad visual, make it with the image tool, `image_gen`. Change an existing image with `image_edit`.',
          '- Do not draw it in code instead (SVG, HTML, a script that renders a picture), unless the user asks for a vector or code file.',
          '- When the image model falls short of something the request needs, such as exact lettering, still deliver the generated images and say what is off. Do not switch method on your own.'
        ].join('\n')
      : ''
  const memory = [
    '## Memory',
    'You have two memory folders, your own and one shared with the other bots. They outlive this chat: a new session starts with only these rules and what is saved there.',
    `- ${MEMORY_INDEX} in each is its index, shown below. One line per entry, linking to a file in the folder for the details. Read a file when its entry matters to the task.`,
    '- Save what you will need later and cannot look up again. For something kept elsewhere, save where to find it, not a copy.',
    '- Save as you go, not only at the end. Change or remove entries that are no longer true.',
    '- Save only in these two folders, not in any other memory your agent has: the other bots and the user do not see that one.',
    '',
    '### Your memory',
    `Your memory is the folder ${botMemoryFolder(bot.id)}. No other bot reads it. It holds your own work: what you already told the user, where unfinished work stands, and how the user wants your job done, with their corrections. You can write in this folder without asking.`,
    '',
    `#### ${MEMORY_INDEX}`,
    shownIndex(memoryIndex, MAX_INDEX_CHARS),
    '',
    '### Shared memory',
    `The shared memory is the folder ${sharedMemoryFolder()}. Every bot reads it. It holds what any bot would need: who the user is, their businesses and projects, and how they want things done in general. You can read its files without asking. Writing in it asks the user first, so save there only what another bot would need too, and everything else in your own. Use your file tools there, not the shell: a command that names this folder asks first too.`,
    '',
    `#### ${MEMORY_INDEX}`,
    shownIndex(sharedIndex, MAX_SHARED_INDEX_CHARS)
  ].join('\n')
  return [intro, instructions, images, memory, documentRules(bot, documents)].filter(Boolean).join('\n\n')
}

export async function createBot(name: string): Promise<Bot> {
  return withBotsLock(async () => {
    const bots = await loadBots()
    const timestamp = now()
    const bot: StoredBot = {
      id: id(),
      name: name.trim() || 'New bot',
      agent: 'grok',
      model: '',
      effort: '',
      instructions: '',
      allowedTools: [],
      mcpServers: [],
      avatar: null,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    await writePluginFolder(bot)
    bots.push(bot)
    await saveBots(bots)
    return withFolder(bot)
  })
}

function cleanTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) return []
  const seen = new Set<string>()
  for (const tool of tools) {
    const value = typeof tool === 'string' ? tool.trim() : ''
    if (value) seen.add(value)
  }
  return [...seen]
}

export async function updateBot(input: UpdateBotInput): Promise<Bot> {
  return withBotsLock(async () => {
    const bots = await loadBots()
    const index = bots.findIndex((item) => item.id === input.id)
    if (index === -1) throw new Error('Bot not found')
    const current = bots[index]
    const next: StoredBot = {
      ...current,
      name: input.name !== undefined ? input.name.trim() || current.name : current.name,
      agent: input.agent !== undefined ? normalizeChatAgent(input.agent) : current.agent,
      model: input.model !== undefined ? String(input.model).trim() : current.model,
      effort: input.effort !== undefined ? (normalizeReasoningEffort(input.effort) ?? '') : (current.effort ?? ''),
      instructions: input.instructions !== undefined ? String(input.instructions) : current.instructions,
      allowedTools: input.allowedTools !== undefined ? cleanTools(input.allowedTools) : current.allowedTools,
      mcpServers: input.mcpServers !== undefined ? cleanTools(input.mcpServers) : (current.mcpServers ?? []),
      updatedAt: now()
    }
    if (next.name !== current.name) await writePluginFolder(next)
    bots[index] = next
    await saveBots(bots)
    return withFolder(next)
  })
}

/** Saves what the app keeps on a bot besides its settings, so `updatedAt` stays the time of the last edit. */
function changeBot(botId: string, change: (bot: StoredBot) => StoredBot): Promise<Bot> {
  return withBotsLock(async () => {
    const bots = await loadBots()
    const index = bots.findIndex((item) => item.id === botId)
    if (index === -1) throw new Error('Bot not found')
    bots[index] = change(bots[index])
    await saveBots(bots)
    return withFolder(bots[index])
  })
}

export function setBotChat(botId: string, chatId: string): Promise<Bot> {
  return changeBot(botId, (bot) => ({ ...bot, chatId }))
}

/** One more message in the bot's chat that the user has not seen. */
export function addBotUnread(botId: string): Promise<Bot> {
  return changeBot(botId, (bot) => ({ ...bot, unread: (bot.unread ?? 0) + 1 }))
}

export function clearBotUnread(botId: string): Promise<Bot> {
  return changeBot(botId, (bot) => ({ ...bot, unread: 0 }))
}

/** Removes the bot from the list and moves its folder, skills included, to the Trash. */
export async function removeBot(botId: string): Promise<void> {
  await withBotsLock(async () => {
    const bots = await loadBots()
    const remaining = bots.filter((item) => item.id !== botId)
    if (remaining.length === bots.length) return
    await saveBots(remaining)
  })
  const folder = botFolder(botId)
  await shell.trashItem(folder).catch(() => rm(folder, { recursive: true, force: true }))
}

/** Copies an image into the bot's folder as its avatar. The original file may move or go afterwards. */
export async function setBotAvatar(botId: string, source: string): Promise<Bot> {
  const ext = extname(source).toLowerCase()
  if (!AVATAR_MIME[ext]) throw new Error('Choose an SVG, PNG, APNG, JPEG, GIF or WebP image.')
  const info = await stat(source)
  if (info.size > MAX_AVATAR_BYTES) throw new Error('Choose an image under 5 MB.')
  return withBotsLock(async () => {
    const bots = await loadBots()
    const index = bots.findIndex((item) => item.id === botId)
    if (index === -1) throw new Error('Bot not found')
    const folder = botFolder(botId)
    await mkdir(folder, { recursive: true })
    await removeAvatarFiles(folder)
    const file = `avatar${ext}`
    await copyFile(source, join(folder, file))
    bots[index] = { ...bots[index], avatar: file, updatedAt: now() }
    await saveBots(bots)
    return withFolder(bots[index])
  })
}

/** The avatars that ship with the app. Dev and packaged builds both reach it from out/main, as the ?asset imports do. */
const DEFAULT_AVATARS_DIR = join(__dirname, '../../resources/bot-avatars')

async function defaultAvatarFiles(): Promise<string[]> {
  const entries = await readdir(DEFAULT_AVATARS_DIR).catch(() => [] as string[])
  return entries.filter((entry) => AVATAR_MIME[extname(entry).toLowerCase()]).sort()
}

export async function listDefaultAvatars(): Promise<DefaultBotAvatar[]> {
  const avatars: DefaultBotAvatar[] = []
  for (const name of await defaultAvatarFiles()) {
    const ext = extname(name)
    const data = await readFile(join(DEFAULT_AVATARS_DIR, name)).catch(() => null)
    if (!data) continue
    const words = name.slice(0, -ext.length).replace(/-/g, ' ')
    avatars.push({
      name,
      label: words.charAt(0).toUpperCase() + words.slice(1),
      url: `data:${AVATAR_MIME[ext.toLowerCase()]};base64,${data.toString('base64')}`
    })
  }
  return avatars
}

/** Sets one of the bundled avatars. The name must be a file in the bundled folder. */
export async function setDefaultBotAvatar(botId: string, name: string): Promise<Bot> {
  if (!(await defaultAvatarFiles()).includes(name)) throw new Error('Avatar not found')
  return setBotAvatar(botId, join(DEFAULT_AVATARS_DIR, name))
}

export async function clearBotAvatar(botId: string): Promise<Bot> {
  return withBotsLock(async () => {
    const bots = await loadBots()
    const index = bots.findIndex((item) => item.id === botId)
    if (index === -1) throw new Error('Bot not found')
    await removeAvatarFiles(botFolder(botId))
    bots[index] = { ...bots[index], avatar: null, updatedAt: now() }
    await saveBots(bots)
    return withFolder(bots[index])
  })
}

async function removeAvatarFiles(folder: string): Promise<void> {
  const entries = await readdir(folder).catch(() => [] as string[])
  for (const entry of entries) {
    if (entry.startsWith('avatar.') && AVATAR_MIME[extname(entry).toLowerCase()]) {
      await rm(join(folder, entry), { force: true })
    }
  }
}

/** The avatar as a data URL for an `<img>`, where an SVG's scripts never run but its animation plays. */
export async function botAvatarUrl(botId: string): Promise<string | null> {
  const bot = (await loadBots()).find((item) => item.id === botId)
  if (!bot?.avatar) return null
  const mime = AVATAR_MIME[extname(bot.avatar).toLowerCase()]
  if (!mime) return null
  const data = await readFile(join(botFolder(botId), bot.avatar)).catch(() => null)
  return data ? `data:${mime};base64,${data.toString('base64')}` : null
}
