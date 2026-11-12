import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => stub.dir },
  shell: { trashItem: () => Promise.reject(new Error('no Trash in tests')) }
}))

import { createBot } from './bots'
import { listBotSkills, removeBotSkill, saveBotSkill } from './botSkills'

beforeEach(() => {
  stub.dir = mkdtempSync(join(tmpdir(), 'wb-bot-skills-'))
})

afterEach(() => {
  rmSync(stub.dir, { recursive: true, force: true })
})

describe('bot skills', () => {
  it('writes a SKILL.md with frontmatter and reads it back', async () => {
    const bot = await createBot('Scribe')
    await saveBotSkill({
      botId: bot.id,
      previousName: null,
      name: 'weekly-report',
      description: 'Write the weekly report: "what shipped", in short.',
      body: '1. Read the git log.\n2. Summarise it.'
    })
    const text = readFileSync(join(bot.folder, 'skills', 'weekly-report', 'SKILL.md'), 'utf8')
    expect(text).toBe(
      '---\nname: weekly-report\ndescription: "Write the weekly report: \\"what shipped\\", in short."\n---\n\n' +
        '1. Read the git log.\n2. Summarise it.\n'
    )
    expect(await listBotSkills(bot.id)).toEqual([
      {
        name: 'weekly-report',
        description: 'Write the weekly report: "what shipped", in short.',
        body: '1. Read the git log.\n2. Summarise it.\n'
      }
    ])
  })

  it('reads hand-written skills and keeps their other frontmatter on save', async () => {
    const bot = await createBot('Scribe')
    const dir = join(bot.folder, 'skills', 'deploy')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: deploy\ndescription: >\n  Ship the site\n  to production.\nallowed-tools:\n  - Bash\n---\nRun it.\n'
    )
    expect(await listBotSkills(bot.id)).toEqual([
      { name: 'deploy', description: 'Ship the site to production.', body: 'Run it.\n' }
    ])

    await saveBotSkill({ botId: bot.id, previousName: 'deploy', name: 'ship', description: 'Ship it.', body: 'Run it.\n' })
    expect(existsSync(dir)).toBe(false)
    expect(readFileSync(join(bot.folder, 'skills', 'ship', 'SKILL.md'), 'utf8')).toBe(
      '---\nname: ship\ndescription: "Ship it."\nallowed-tools:\n  - Bash\n---\n\nRun it.\n'
    )
  })

  it('refuses bad names, a missing description and a name already taken', async () => {
    const bot = await createBot('Scribe')
    const base = { botId: bot.id, previousName: null, description: 'Does a thing.', body: '' }
    await expect(saveBotSkill({ ...base, name: 'Weekly Report' })).rejects.toThrow(/lowercase/)
    await expect(saveBotSkill({ ...base, name: '../escape' })).rejects.toThrow(/lowercase/)
    await expect(saveBotSkill({ ...base, name: 'ok', description: '  ' })).rejects.toThrow(/Describe/)
    await saveBotSkill({ ...base, name: 'taken' })
    await expect(saveBotSkill({ ...base, name: 'taken' })).rejects.toThrow(/already a skill/)
    await saveBotSkill({ ...base, name: 'other' })
    await expect(saveBotSkill({ ...base, previousName: 'other', name: 'taken' })).rejects.toThrow(/already a skill/)
    // Saving under its own name edits it.
    await saveBotSkill({ ...base, previousName: 'taken', name: 'taken', description: 'Changed.' })
    expect((await listBotSkills(bot.id)).find((skill) => skill.name === 'taken')?.description).toBe('Changed.')
  })

  it('removes a skill and its folder', async () => {
    const bot = await createBot('Scribe')
    await saveBotSkill({ botId: bot.id, previousName: null, name: 'gone', description: 'Soon gone.', body: '' })
    await removeBotSkill(bot.id, 'gone')
    expect(await listBotSkills(bot.id)).toEqual([])
    await expect(removeBotSkill(bot.id, '..')).rejects.toThrow(/not found/)
  })
})
