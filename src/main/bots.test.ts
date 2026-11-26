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
  addBotProblem,
  addBotUnread,
  botAvatarUrl,
  botSessionRules,
  clearBotAvatar,
  clearBotUnread,
  createBot,
  ensureChiefBot,
  getBot,
  isBotFolder,
  listBots,
  listDefaultAvatars,
  readBotMemory,
  readBotMemoryFile,
  readSharedMemory,
  removeBot,
  saveBotHeartbeat,
  saveBotMemoryIndex,
  saveSharedMemoryIndex,
  setBotAvatar,
  setBotChat,
  setDefaultBotAvatar,
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

  it('creates a bot on the agent it is given, following the model set in Settings', async () => {
    expect(await createBot('Scout')).toMatchObject({ agent: 'grok', model: '' })
    expect(await createBot('Scout', 'workbench')).toMatchObject({ agent: 'workbench', model: '' })
    expect(await createBot('Scout', 'claude')).toMatchObject({ agent: 'claude', model: '' })
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

  it('keeps short replies off until switched on, and keeps the choice through other edits', async () => {
    const bot = await createBot('Scout')
    expect(bot.conciseReplies).toBe(false)
    expect((await updateBot({ id: bot.id, conciseReplies: true })).conciseReplies).toBe(true)
    expect((await updateBot({ id: bot.id, model: 'opus' })).conciseReplies).toBe(true)
    expect((await updateBot({ id: bot.id, conciseReplies: false })).conciseReplies).toBe(false)
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

  it('lists the bundled avatars and sets one', async () => {
    const avatars = await listDefaultAvatars()
    expect(avatars).toHaveLength(11)
    expect(avatars.map((avatar) => avatar.name)).toEqual(avatars.map((avatar) => avatar.name).sort())
    for (const avatar of avatars) expect(avatar.url).toMatch(/^data:image\/webp;base64,/)
    expect(avatars.find((avatar) => avatar.name === 'accountant.webp')?.label).toBe('Accountant')
    expect(avatars.find((avatar) => avatar.name === 'ads-checker.webp')?.label).toBe('Ads checker')

    const bot = await createBot('Dressed')
    expect((await setDefaultBotAvatar(bot.id, 'accountant.webp')).avatar).toBe('avatar.webp')
    expect(existsSync(join(bot.folder, 'avatar.webp'))).toBe(true)
  })

  it('refuses a default avatar that is not bundled', async () => {
    const bot = await createBot('Sneaky')
    await expect(setDefaultBotAvatar(bot.id, '../icon.png')).rejects.toThrow('Avatar not found')
    await expect(setDefaultBotAvatar(bot.id, 'nope.webp')).rejects.toThrow('Avatar not found')
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
      expect(rules).toMatch(/### Shared memory\n[^\n]+\n\n#### MEMORY\.md\n- \[Peter\]\(peter\.md\) — how he likes answers\n\n## Lessons\n/)
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

  it('tells a Grok bot to use the image tool, and leaves the section out for a Claude bot', async () => {
    const grok = await createBot('Artist')
    const rules = botSessionRules(grok)
    expect(rules).toContain('## Images\n')
    expect(rules).toContain('`image_gen`')
    expect(rules).toContain('`image_edit`')
    expect(rules.indexOf('## Images')).toBeLessThan(rules.indexOf('## Memory'))

    const claude = await updateBot({ id: grok.id, agent: 'claude' })
    expect(botSessionRules(claude)).not.toContain('## Images')
    expect(botSessionRules(claude)).not.toContain('image_gen')
  })

  it('makes the chief of staff when there is none, on the given agent', async () => {
    await createBot('Scout')
    const { bot, created } = await ensureChiefBot('claude')
    expect(created).toBe(true)
    expect(bot).toMatchObject({ name: 'Chief of staff', agent: 'claude', instructions: '', chief: true })
    expect(existsSync(bot.folder)).toBe(true)
    expect(await ensureChiefBot('grok')).toEqual({ bot, created: false })
    expect((await listBots()).filter((item) => item.chief)).toHaveLength(1)
  })

  it('lists the chief of staff first, then the other bots by name', async () => {
    await createBot('Scout')
    const { bot } = await ensureChiefBot('grok')
    await createBot('Archie')
    await updateBot({ id: bot.id, name: 'Zed' })
    expect((await listBots()).map((item) => item.name)).toEqual(['Zed', 'Archie', 'Scout'])
  })

  it('keeps the oldest of several chiefs', async () => {
    mkdirSync(join(stub.dir, 'workbench'), { recursive: true })
    const bot = { agent: 'grok', model: '', effort: '', instructions: '', allowedTools: [], mcpServers: [], avatar: null }
    writeFileSync(
      join(stub.dir, 'workbench', 'bots.json'),
      JSON.stringify({
        bots: [
          { ...bot, id: 'new', name: 'New', chief: true, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '' },
          { ...bot, id: 'old', name: 'Old', chief: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '' }
        ]
      })
    )
    expect(await ensureChiefBot('grok')).toMatchObject({ bot: { id: 'old', chief: true }, created: false })
    expect((await getBot('new')).chief).toBe(false)
    expect((await listBots()).filter((item) => item.chief).map((item) => item.id)).toEqual(['old'])
  })

  it('refuses to delete the chief of staff', async () => {
    const { bot } = await ensureChiefBot('grok')
    await expect(removeBot(bot.id)).rejects.toThrow('The chief of staff cannot be deleted.')
    expect(existsSync(bot.folder)).toBe(true)
    expect((await getBot(bot.id)).chief).toBe(true)
  })

  it("keeps the chief's checklist in its memory folder", async () => {
    const chief = await createBot('Chief')
    expect(await readBotMemoryFile(chief.id, 'HEARTBEAT.md')).toBe('')
    expect(await saveBotHeartbeat(chief.id, '- Inbox: anything from the bank?')).toBe('- Inbox: anything from the bank?')
    expect(readFileSync(join(chief.folder, 'memory', 'HEARTBEAT.md'), 'utf8')).toBe('- Inbox: anything from the bank?')
    expect((await readBotMemory(chief.id)).files).toContain('HEARTBEAT.md')
    await expect(saveBotHeartbeat('nobody', 'x')).rejects.toThrow('Bot not found')
  })

  it('has a bot keep its open work in STATUS.md for the chief, by name', async () => {
    const chief = { ...(await createBot('Chief')), chief: true }
    const clerk = await updateBot({ id: (await createBot('Clerk')).id, instructions: 'Books invoices.' })
    const rules = botSessionRules(clerk, '', '', [], [chief, clerk])
    const status = join(clerk.folder, 'memory', 'STATUS.md')
    expect(rules).toContain(
      'No other bot reads it, except that Chief, the chief of staff, sees STATUS.md and PROBLEMS.md, and may change LESSONS.md and PROBLEMS.md.'
    )
    expect(rules).toContain(`## Open work\nChief is the chief of staff. On its heartbeat it sees the file ${status}`)
    expect(rules).toContain('Remove an item once it is done. Leave the file empty when nothing is open.')
    expect(rules).toContain('also set a follow_up')
    expect(rules).not.toContain('## Chief of staff')
    expect(rules.indexOf('## Open work')).toBeGreaterThan(rules.indexOf('### Shared memory'))
  })

  it('tells the chief the other bots, how a heartbeat goes and where its checklist is', async () => {
    const chief = { ...(await createBot('Chief')), chief: true }
    const clerk = await updateBot({ id: (await createBot('Clerk')).id, instructions: '\nBooks invoices.\nAsks before paying.' })
    const scout = await createBot('Scout')
    const rules = botSessionRules(chief, '', '', [], [chief, clerk, scout])
    expect(rules).toContain('## Chief of staff\n')
    expect(rules).toContain('\n- Clerk: Books invoices.\n- Scout: (no instructions)\n')
    expect(rules).not.toContain('- Chief:')
    expect(rules).toContain('with the workbench tool ask_bot, in a message that stands on its own')
    expect(rules).toContain("Do not do a specialist's work yourself.")
    expect(rules).toContain('Do not hand out the same item again unless its status changed.')
    expect(rules).toContain('Tell the user once, with notify, only when something needs them.')
    expect(rules).toContain(`Your checklist is the file ${join(chief.folder, 'memory', 'HEARTBEAT.md')}.`)
    expect(rules).toContain(`Your memory is the folder ${join(chief.folder, 'memory')}. No other bot reads it.`)
    expect(rules).not.toContain('## Open work')
    expect(botSessionRules(chief, '', '', [], [chief])).toContain('There are no other bots yet.')
    expect(rules).toContain("On a heartbeat you also get what went wrong: the entries in each bot's PROBLEMS.md, your own included.")
    expect(rules).toContain("Write the rule that prevents it in that bot's LESSONS.md, which is next to its PROBLEMS.md.")
    expect(rules).toContain('When the same thing went wrong despite a lesson, sharpen that lesson.')
    expect(rules).toContain('Then remove the entry from PROBLEMS.md.')
    expect(rules).toContain('You can read and write the LESSONS.md and PROBLEMS.md of every bot without asking.')
  })

  it('logs a problem once per text, on one dated line', async () => {
    const bot = await createBot('Clerk')
    const file = join(bot.folder, 'memory', 'PROBLEMS.md')
    await addBotProblem(bot.id, 'The scheduled run failed:\n  disk full')
    await addBotProblem(bot.id, 'The scheduled run failed: disk full')
    await addBotProblem(bot.id, 'x'.repeat(600))
    const lines = readFileSync(file, 'utf8').split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^- .+: The scheduled run failed: disk full$/)
    expect(lines[1]).toMatch(new RegExp(`^- .+: ${'x'.repeat(500)}…$`))
    expect(lines[2]).toBe('')
    expect(await readBotMemoryFile(bot.id, 'PROBLEMS.md')).toBe(lines.join('\n'))
    await expect(addBotProblem('nobody', 'x')).rejects.toThrow('Bot not found')
  })

  it('gives every bot its lessons, and a place for problems only next to a chief', async () => {
    const chief = { ...(await createBot('Chief')), chief: true }
    const clerk = await createBot('Clerk')
    const lessons = join(clerk.folder, 'memory', 'LESSONS.md')
    const problems = join(clerk.folder, 'memory', 'PROBLEMS.md')

    const alone = botSessionRules(clerk, '', '', [], [clerk])
    expect(alone).toContain(`## Lessons\nYou learn from what goes wrong, so it does not happen again. Your lessons are the file ${lessons}, shown below. Follow them.`)
    expect(alone).toMatch(/#### LESSONS\.md\n\(empty\)$/)
    expect(alone.indexOf('## Lessons')).toBeGreaterThan(alone.indexOf('### Shared memory'))
    expect(alone).not.toContain('PROBLEMS.md')

    const next = botSessionRules(clerk, '', '', [], [chief, clerk], '- Check the bank export before booking: it was empty once.')
    expect(next).toContain(`add a line to ${problems} saying what happened and when. Chief, the chief of staff, reviews that file.`)
    expect(next).toContain('#### LESSONS.md\n- Check the bank export before booking: it was empty once.')
    expect(next.indexOf('## Lessons')).toBeLessThan(next.indexOf('## Open work'))

    const own = botSessionRules(chief, '', '', [], [chief, clerk], 'l'.repeat(5000))
    expect(own).toContain(`add a line to ${join(chief.folder, 'memory', 'PROBLEMS.md')} saying what happened and when.`)
    expect(own).toContain(`${'l'.repeat(4000)}\n… (cut here: keep LESSONS.md short and merge lessons that say the same)`)
    expect(own).not.toContain('l'.repeat(4001))
  })

  it('leaves the chief out of the rules when there is none', async () => {
    const clerk = await createBot('Clerk')
    const scout = await createBot('Scout')
    const rules = botSessionRules(clerk, '', '', [], [clerk, scout])
    expect(rules).toBe(botSessionRules(clerk))
    expect(rules).toContain('No other bot reads it. It holds')
    expect(rules).not.toContain('STATUS.md')
    expect(rules).not.toContain('chief')
  })
})
