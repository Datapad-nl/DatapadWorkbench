import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => stub.dir },
  shell: { trashItem: () => Promise.reject(new Error('no Trash in tests')) }
}))

/** Splits a "book" on lines starting with "# ", one chapter file each. A file named bad.pdf cannot be read. */
vi.mock('./bookConvert', () => ({
  BOOK_EXTENSIONS: ['.pdf', '.epub', '.txt', '.md', '.markdown'],
  convertBook: vi.fn(async (source: string, destFolder: string) => {
    if (basename(source) === 'bad.pdf') {
      await writeFile(join(destFolder, '01-half.md'), 'half')
      throw new Error('This PDF has no text in it.')
    }
    const { readFile } = await import('fs/promises')
    const parts = (await readFile(source, 'utf8')).split(/^# /m).filter(Boolean)
    const chapters: Array<{ file: string; title: string; words: number }> = []
    for (const [index, part] of parts.slice(1).entries()) {
      const title = part.split('\n')[0]
      const file = `${String(index + 1).padStart(2, '0')}-${title.toLowerCase()}.md`
      await writeFile(join(destFolder, file), `# ${part}`)
      chapters.push({ file, title, words: part.split(/\s+/).filter(Boolean).length })
    }
    return { title: parts[0].trim(), chapters }
  })
}))

import { addBotDocuments, listBotDocuments, outlinePrompt, removeBotDocument } from './botDocuments'
import { createBot } from './bots'

let books = ''

beforeEach(() => {
  stub.dir = mkdtempSync(join(tmpdir(), 'wb-docs-'))
  books = mkdtempSync(join(tmpdir(), 'wb-books-'))
})

afterEach(() => {
  rmSync(stub.dir, { recursive: true, force: true })
  rmSync(books, { recursive: true, force: true })
})

function book(name: string, title: string): string {
  const path = join(books, name)
  writeFileSync(path, `${title}\n# Intro\nwhy this book\n# Method\nhow it works in three steps\n`)
  return path
}

describe('bot documents', () => {
  it('converts a book into its own folder with document.json and an outline, and lists it', async () => {
    const bot = await createBot('Reader')
    const { added, errors } = await addBotDocuments(bot.id, [book('deep.txt', 'Deep Work')])
    expect(errors).toEqual([])
    expect(added).toEqual([
      { id: 'deep-work', title: 'Deep Work', source: 'deep.txt', addedAt: expect.any(String), chapters: 2, words: 11 }
    ])
    expect(await listBotDocuments(bot.id)).toEqual(added)

    const folder = join(bot.folder, 'documents', 'deep-work')
    expect(readdirSync(folder).sort()).toEqual(['01-intro.md', '02-method.md', 'OUTLINE.md', 'document.json'])
    expect(JSON.parse(readFileSync(join(folder, 'document.json'), 'utf8'))).toEqual({
      title: 'Deep Work',
      source: 'deep.txt',
      addedAt: added[0].addedAt,
      chapters: [
        { file: '01-intro.md', title: 'Intro', words: 4 },
        { file: '02-method.md', title: 'Method', words: 7 }
      ]
    })
    const outline = readFileSync(join(folder, 'OUTLINE.md'), 'utf8')
    expect(outline).toMatch(/^# Deep Work\n\nOriginal file: deep\.txt\n/)
    expect(outline).toContain('## Intro\n\nFile: 01-intro.md · 4 words\n\nNo summary yet.')
    expect(outline).toContain('## Method\n\nFile: 02-method.md · 7 words\n\nNo summary yet.')
  })

  it('gives a second book with the same title an id of its own', async () => {
    const bot = await createBot('Reader')
    await addBotDocuments(bot.id, [book('a.txt', 'Deep Work')])
    const { added } = await addBotDocuments(bot.id, [book('b.txt', 'Deep Work'), book('c.txt', 'Deep Work')])
    expect(added.map((doc) => doc.id)).toEqual(['deep-work-2', 'deep-work-3'])
    expect((await listBotDocuments(bot.id)).map((doc) => doc.source).sort()).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('leaves no folder behind when a book cannot be read, and still adds the others', async () => {
    const bot = await createBot('Reader')
    writeFileSync(join(books, 'bad.pdf'), '')
    const { added, errors } = await addBotDocuments(bot.id, [join(books, 'bad.pdf'), book('ok.txt', 'Fine')])
    expect(errors).toEqual(['bad.pdf: This PDF has no text in it.'])
    expect(added.map((doc) => doc.id)).toEqual(['fine'])
    expect(readdirSync(join(bot.folder, 'documents'))).toEqual(['fine'])
  })

  it('moves a document to the Trash, or removes it when there is none', async () => {
    const bot = await createBot('Reader')
    await addBotDocuments(bot.id, [book('a.txt', 'One'), book('b.txt', 'Two')])
    expect((await removeBotDocument(bot.id, 'one')).map((doc) => doc.id)).toEqual(['two'])
    expect(existsSync(join(bot.folder, 'documents', 'one'))).toBe(false)
    await expect(removeBotDocument(bot.id, 'one')).rejects.toThrow('Document not found')
  })

  it('refuses a document id that leaves the documents folder', async () => {
    const bot = await createBot('Reader')
    await addBotDocuments(bot.id, [book('a.txt', 'One')])
    for (const id of ['..', '../memory', 'one/../..', '/tmp', '']) {
      await expect(removeBotDocument(bot.id, id)).rejects.toThrow('Document not found')
    }
    expect(existsSync(join(bot.folder, 'skills'))).toBe(true)
    expect(existsSync(bot.folder)).toBe(true)
    expect(() => outlinePrompt(bot.id, [{ id: '../x', title: 'X', source: '', addedAt: '', chapters: 0, words: 0 }])).toThrow()
  })

  it('asks the bot to write the outlines of what was added, with their folders', async () => {
    const bot = await createBot('Reader')
    const { added } = await addBotDocuments(bot.id, [book('a.txt', 'One'), book('b.txt', 'Two')])
    const docs = join(bot.folder, 'documents')
    expect(outlinePrompt(bot.id, added)).toMatch(
      /^The user added these documents to your documents: One \(.+\), Two \(.+\)\. For each, read its chapters/
    )
    expect(outlinePrompt(bot.id, added)).toContain(`One (${join(docs, 'one')}), Two (${join(docs, 'two')}).`)
    expect(outlinePrompt(bot.id, added.slice(0, 1))).toContain('The user added this document to your documents: One (')
  })
})
