import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => stub.dir },
  shell: { trashItem: () => Promise.reject(new Error('no Trash in tests')) }
}))

import {
  addBotUnread,
  botAvatarUrl,
  botSessionRules,
  clearBotAvatar,
  clearBotUnread,
  createBot,
  getBot,
  isBotFolder,
  listBots,
  readBotMemory,
  readSharedMemory,
  removeBot,
  saveBotMemoryIndex,
  saveSharedMemoryIndex,
  setBotAvatar,
  setBotChat,
  updateBot
} from './bots'

let images = ''

beforeEach(() => {
  stub.dir = mkdtempSync(join(tmpdir(), 'wb-bots-'))
  images = mkdtempSync(join(tmpdir(), 'wb-bot-images-'))
})

afterEach(() => {
  rmSync(stub.dir, { recursive: true, force: true })
  rmSync(images, { recursive: true, force: true })
})

describe('bots', () => {
  it('knows a path inside a bot folder from one outside the bots folder', async () => {
    const bot = await createBot('Scout')
    expect(isBotFolder(bot.folder)).toBe(true)
    expect(isBotFolder(join(bot.folder, 'notes'))).toBe(true)
    expect(isBotFolder(join(stub.dir, 'workbench', 'bots'))).toBe(false)
    expect(isBotFolder(join(stub.dir, 'workbench', 'bots-old'))).toBe(false)
    expect(isBotFolder(stub.dir)).toBe(false)
  })

  it('creates a bot whose folder is a plugin both agents load', async () => {
    const bot = await createBot('Master Chief')
    expect(bot).toMatchObject({ name: 'Master Chief', agent: 'grok', model: '', avatar: null, allowedTools: [] })
    for (const dir of ['.grok-plugin', '.claude-plugin']) {
      const manifest = JSON.parse(readFileSync(join(bot.folder, dir, 'plugin.json'), 'utf8'))
      expect(manifest.name).toBe('master-chief')
    }
    expect(existsSync(join(bot.folder, 'skills'))).toBe(true)
    expect((await listBots()).map((item) => item.id)).toEqual([bot.id])
  })

  it('saves edits, keeps the old name when the new one is blank and renames the plugin', async () => {
    const bot = await createBot('Scout')
    const next = await updateBot({
      id: bot.id,
      name: 'Scout Two',
      agent: 'claude',
      model: 'sonnet',
      instructions: 'Find things.',
      allowedTools: ['Read', ' Read ', '', 'WebSearch']
    })
    expect(next).toMatchObject({ agent: 'claude', model: 'sonnet', instructions: 'Find things.' })
    expect(next.allowedTools).toEqual(['Read', 'WebSearch'])
    expect(JSON.parse(readFileSync(join(bot.folder, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('scout-two')
    expect((await updateBot({ id: bot.id, name: '  ' })).name).toBe('Scout Two')
  })

  it('keeps an effort of its own, or follows the setting when it has none', async () => {
    const bot = await createBot('Scout')
    expect(bot.effort).toBe('')
    expect((await updateBot({ id: bot.id, effort: 'Extra high' })).effort).toBe('xhigh')
    expect((await updateBot({ id: bot.id, model: 'opus' })).effort).toBe('xhigh')
    expect((await updateBot({ id: bot.id, effort: 'nonsense' })).effort).toBe('')
    expect((await updateBot({ id: bot.id, effort: 'max' })).effort).toBe('max')
    expect((await updateBot({ id: bot.id, effort: null })).effort).toBe('')
  })

  it('reads a bot saved before effort was a setting as following the setting', async () => {
    mkdirSync(join(stub.dir, 'workbench'), { recursive: true })
    writeFileSync(
      join(stub.dir, 'workbench', 'bots.json'),
      JSON.stringify({
        bots: [{ id: 'old', name: 'Old', agent: 'grok', model: '', instructions: '', allowedTools: [], avatar: null }]
      })
    )
    expect((await listBots())[0]).toMatchObject({ effort: '', chatId: null, unread: 0 })
  })

  it("keeps the bot's chat and its unread count apart from the settings", async () => {
    const bot = await createBot('Nova')
    await setBotChat(bot.id, 'nova-chat')
    await addBotUnread(bot.id)
    const counted = await addBotUnread(bot.id)
    expect(counted).toMatchObject({ chatId: 'nova-chat', unread: 2, updatedAt: bot.updatedAt })
    expect(await updateBot({ id: bot.id, instructions: 'Brief me.' })).toMatchObject({ chatId: 'nova-chat', unread: 2 })
    expect((await clearBotUnread(bot.id)).unread).toBe(0)
    expect(await getBot(bot.id)).toMatchObject({ chatId: 'nova-chat', unread: 0 })
    await expect(addBotUnread('gone')).rejects.toThrow('Bot not found')
  })

  it('copies the avatar into the bot folder and replaces it', async () => {
    const bot = await createBot('Pixel')
    const svg = join(images, 'face.svg')
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const withSvg = await setBotAvatar(bot.id, svg)
    expect(withSvg.avatar).toBe('avatar.svg')
    rmSync(svg)
    expect(await botAvatarUrl(bot.id)).toMatch(/^data:image\/svg\+xml;base64,/)

    const gif = join(images, 'wave.gif')
    writeFileSync(gif, 'GIF89a')
    expect((await setBotAvatar(bot.id, gif)).avatar).toBe('avatar.gif')
    expect(existsSync(join(bot.folder, 'avatar.svg'))).toBe(false)
    expect(await botAvatarUrl(bot.id)).toMatch(/^data:image\/gif;base64,/)

    expect((await clearBotAvatar(bot.id)).avatar).toBeNull()
    expect(existsSync(join(bot.folder, 'avatar.gif'))).toBe(false)
    expect(await botAvatarUrl(bot.id)).toBeNull()
  })

  it('refuses files that are not images', async () => {
    const bot = await createBot('Picky')
    const text = join(images, 'notes.txt')
    writeFileSync(text, 'hi')
    await expect(setBotAvatar(bot.id, text)).rejects.toThrow(/SVG, PNG/)
  })

  it('removes the bot and its folder', async () => {
    const bot = await createBot('Gone')
    await removeBot(bot.id)
    expect(await listBots()).toEqual([])
    expect(existsSync(bot.folder)).toBe(false)
  })

  it("keeps the bot's memory in its folder and puts the index in its session rules", async () => {
    const bot = await createBot('Scout')
    expect(await readBotMemory(bot.id)).toEqual({ folder: join(bot.folder, 'memory'), index: '', files: [] })
    expect(botSessionRules(bot)).toContain(`Your memory is the folder ${join(bot.folder, 'memory')}.`)
    expect(botSessionRules(bot)).toMatch(/#### MEMORY\.md\n\(empty\)\n\n### Shared memory\n/)

    mkdirSync(join(bot.folder, 'memory', 'people'), { recursive: true })
    writeFileSync(join(bot.folder, 'memory', 'people', 'peter.md'), 'Prefers short answers.')
    writeFileSync(join(bot.folder, 'memory', '.DS_Store'), '')
    const saved = await saveBotMemoryIndex(bot.id, '- [Peter](people/peter.md) — how he likes answers')
    expect(saved).toMatchObject({ index: '- [Peter](people/peter.md) — how he likes answers', files: ['people/peter.md'] })
    expect(readFileSync(join(bot.folder, 'memory', 'MEMORY.md'), 'utf8')).toBe(saved.index)

    const rules = botSessionRules(bot, 'x'.repeat(9000))
    expect(rules).toContain('cut here: keep MEMORY.md short')
    expect(rules).not.toContain('x'.repeat(8001))
    await expect(saveBotMemoryIndex('nobody', 'hi')).rejects.toThrow()
  })

  it('gives every bot the shared memory next to its own, with a shorter index', async () => {
    const scout = await createBot('Scout')
    const clerk = await createBot('Clerk')
    const folder = join(stub.dir, 'workbench', 'memory')
    expect(await readSharedMemory()).toEqual({ folder, index: '', files: [] })

    writeFileSync(join(folder, 'peter.md'), 'Prefers short answers.')
    const shared = await saveSharedMemoryIndex('- [Peter](peter.md) — how he likes answers')
    expect(shared).toEqual({ folder, index: '- [Peter](peter.md) — how he likes answers', files: ['peter.md'] })
    await saveBotMemoryIndex(scout.id, '- [Runs](runs.md) — what Scout reported')
    // The shared memory is not inside a bot's folder, and a bot's memory does not show in it.
    expect(isBotFolder(folder)).toBe(false)
    expect((await readBotMemory(clerk.id)).index).toBe('')

    for (const bot of [scout, clerk]) {
      const own = (await readBotMemory(bot.id)).index
      const rules = botSessionRules(bot, own, (await readSharedMemory()).index)
      expect(rules).toContain(`The shared memory is the folder ${folder}.`)
      expect(rules).toMatch(/### Shared memory\n[^\n]+\n\n#### MEMORY\.md\n- \[Peter\]\(peter\.md\) — how he likes answers$/)
      expect(rules.includes('what Scout reported')).toBe(bot === scout)
    }

    const long = botSessionRules(scout, '', 'y'.repeat(3000))
    expect(long).toContain('y'.repeat(2000))
    expect(long).not.toContain('y'.repeat(2001))
  })

  it('lists the documents after the memory in the session rules, only when the bot has any', async () => {
    const bot = await createBot('Reader')
    expect(botSessionRules(bot)).not.toContain('## Documents')
    expect(botSessionRules(bot, '', '', [])).not.toContain('## Documents')

    const documents = [
      { id: 'deep-work', title: 'Deep Work', source: 'deep-work.epub', addedAt: '', chapters: 12, words: 60000 },
      { id: 'notes', title: 'Notes', source: 'notes.md', addedAt: '', chapters: 1, words: 300 }
    ]
    const rules = botSessionRules(bot, '', '', documents)
    expect(rules).toContain(`## Documents\nThe user gave you books and documents to work from, in the folder ${join(bot.folder, 'documents')}.`)
    expect(rules.indexOf('## Documents')).toBeGreaterThan(rules.indexOf('### Shared memory'))
    expect(rules).toMatch(/\n\n- Deep Work \(12 chapters\): deep-work\/OUTLINE\.md\n- Notes \(1 chapter\): notes\/OUTLINE\.md$/)
  })
})
