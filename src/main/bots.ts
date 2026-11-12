import { app, shell } from 'electron'
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'fs/promises'
import { extname, isAbsolute, join, relative } from 'path'
import { normalizeChatAgent, normalizeReasoningEffort, type Bot, type UpdateBotInput } from '../shared/types'
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
  // Bots saved before effort was a setting follow the global one.
  return { ...bot, effort: bot.effort ?? '', folder: botFolder(bot.id) }
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

/** The bot's instructions, as rules for each of its sessions. */
export function botSessionRules(bot: Bot): string {
  const intro = `You are ${bot.name}, a bot in Datapad Workbench.`
  const instructions = bot.instructions.trim()
  return instructions ? `${intro}\n\n${instructions}` : intro
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
      updatedAt: now()
    }
    if (next.name !== current.name) await writePluginFolder(next)
    bots[index] = next
    await saveBots(bots)
    return withFolder(next)
  })
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
