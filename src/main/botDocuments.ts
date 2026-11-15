import { shell } from 'electron'
import { mkdir, readdir, readFile, rename, rm, stat } from 'fs/promises'
import { basename, extname, join } from 'path'
import type { BotDocument } from '../shared/types'
import { convertBook, type ConvertedChapter } from './bookConvert'
import { botDocumentsFolder, getBot } from './bots'
import { id, now } from './ids'
import { withLock, writeFileAtomic } from './storeIo'

/** What document.json in a document's folder holds. */
type DocumentFile = { title: string; source: string; addedAt: string; chapters: ConvertedChapter[] }

const DOCUMENT_FILE = 'document.json'
const OUTLINE_FILE = 'OUTLINE.md'

/** Folder names are slugs of the title, so an id with anything else in it is no document's. */
function documentFolder(botId: string, documentId: string): string {
  if (!/^[\w-]+$/.test(documentId)) throw new Error('Document not found')
  return join(botDocumentsFolder(botId), documentId)
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'document'
  )
}

function toDocument(documentId: string, file: DocumentFile): BotDocument {
  return {
    id: documentId,
    title: file.title,
    source: file.source,
    addedAt: file.addedAt,
    chapters: file.chapters.length,
    words: file.chapters.reduce((sum, chapter) => sum + chapter.words, 0)
  }
}

/** The outline as written at upload. The bot fills in what each chapter covers in a run of its own. */
function outline(file: DocumentFile): string {
  const chapters = file.chapters.map((chapter) =>
    [`## ${chapter.title}`, '', `File: ${chapter.file} · ${chapter.words} words`, '', 'No summary yet.'].join('\n')
  )
  return [`# ${file.title}`, '', `Original file: ${file.source}`, '', ...chapters.flatMap((text) => [text, ''])].join('\n')
}

export async function listBotDocuments(botId: string): Promise<BotDocument[]> {
  const folder = botDocumentsFolder(botId)
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  const documents: BotDocument[] = []
  for (const entry of entries) {
    // A folder still being added starts with a dot and has no document.json yet.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const file = await readFile(join(folder, entry.name, DOCUMENT_FILE), 'utf8')
      .then((text) => JSON.parse(text) as DocumentFile)
      .catch(() => null)
    if (file && Array.isArray(file.chapters)) documents.push(toDocument(entry.name, file))
  }
  return documents.sort((a, b) => a.title.localeCompare(b.title))
}

/**
 * Converts each file into a folder of its own in the bot's documents. A file that cannot be read leaves no
 * folder behind; its error comes back with its name, and the other files are still added.
 */
export async function addBotDocuments(
  botId: string,
  sources: string[]
): Promise<{ added: BotDocument[]; errors: string[] }> {
  await getBot(botId)
  const folder = botDocumentsFolder(botId)
  await mkdir(folder, { recursive: true })
  const added: BotDocument[] = []
  const errors: string[] = []
  for (const source of sources) {
    // Converted under a hidden name first: the id follows from the title, which only the conversion knows.
    const temp = join(folder, `.adding-${id()}`)
    try {
      await mkdir(temp)
      const book = await convertBook(source, temp)
      const file: DocumentFile = {
        title: book.title.trim() || basename(source, extname(source)),
        source: basename(source),
        addedAt: now(),
        chapters: book.chapters
      }
      await writeFileAtomic(join(temp, DOCUMENT_FILE), JSON.stringify(file, null, 2))
      await writeFileAtomic(join(temp, OUTLINE_FILE), outline(file))
      const documentId = await withLock(folder, async () => {
        const taken = new Set(await readdir(folder))
        const base = slug(file.title)
        let candidate = base
        for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`
        await rename(temp, join(folder, candidate))
        return candidate
      })
      added.push(toDocument(documentId, file))
    } catch (error) {
      await rm(temp, { recursive: true, force: true })
      errors.push(`${basename(source)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { added, errors }
}

/** Moves the document's folder, chapters and outline included, to the Trash. */
export async function removeBotDocument(botId: string, documentId: string): Promise<BotDocument[]> {
  const folder = documentFolder(botId, documentId)
  await stat(folder).catch(() => {
    throw new Error('Document not found')
  })
  await shell.trashItem(folder).catch(() => rm(folder, { recursive: true, force: true }))
  return listBotDocuments(botId)
}

/** The one-off run after an upload, in which the bot writes what each chapter covers into the outlines. */
export function outlinePrompt(botId: string, documents: BotDocument[]): string {
  const list = documents.map((doc) => `${doc.title} (${documentFolder(botId, doc.id)})`).join(', ')
  const which = documents.length === 1 ? 'this document' : 'these documents'
  return `The user added ${which} to your documents: ${list}. For each, read its chapters in order and write in its OUTLINE.md, under each chapter, two to four lines on what the chapter covers: its subjects, the terms it defines and the questions it answers, in the words someone would search for. Do one chapter at a time and save the outline after each, so the work is kept if the run stops. Leave the chapter files as they are.`
}
