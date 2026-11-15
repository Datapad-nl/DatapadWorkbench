import { strFromU8, unzipSync } from 'fflate'
import { readFile, writeFile } from 'fs/promises'
import { DomUtils, ElementType, parseDocument } from 'htmlparser2'
import { basename, extname, join, posix } from 'path'

export type ConvertedChapter = { file: string; title: string; words: number }
export type ConvertedBook = { title: string; chapters: ConvertedChapter[] }
/** Lowercase, with the dot. */
export const BOOK_EXTENSIONS: readonly string[] = ['.pdf', '.epub', '.txt', '.md', '.markdown']

/** About what an agent reads in one go. A longer chapter is split into parts. */
const MAX_WORDS = 6000

type Chapter = { title: string; text: string }
type Book = { title: string; chapters: Chapter[] }
type Element = ReturnType<typeof DomUtils.findAll>[number]
type Node = Element['children'][number]

/**
 * Converts the book at `source` into Markdown chapter files written into `destFolder`, which exists and is empty.
 * Throws an Error whose message is for the user when the file cannot be read as text.
 */
export async function convertBook(source: string, destFolder: string): Promise<ConvertedBook> {
  const ext = extname(source).toLowerCase()
  const name = basename(source, extname(source))
  if (!BOOK_EXTENSIONS.includes(ext)) {
    throw new Error(`${basename(source)} is not a book the app can read. Add a PDF, EPUB, TXT or Markdown file.`)
  }
  const data = await readFile(source).catch(() => {
    throw new Error(`${basename(source)} could not be opened.`)
  })
  const book =
    ext === '.pdf'
      ? await readPdf(data, name)
      : ext === '.epub'
        ? await readEpub(data, name)
        : readText(decodeText(data, basename(source)), name, ext !== '.txt')
  const parts = book.chapters
    .map((chapter) => withoutTitleHeading({ ...chapter, title: chapter.title.replace(/\s+/g, ' ').trim() || 'Untitled' }))
    .filter((chapter) => countWords(chapter.text) > 0)
    .flatMap(splitLong)
  if (parts.length === 0) throw new Error(`${basename(source)} has no text in it.`)
  const width = Math.max(2, String(parts.length).length)
  const chapters: ConvertedChapter[] = []
  for (const [i, part] of parts.entries()) {
    const file = `${String(i + 1).padStart(width, '0')}-${slug(part.title)}.md`
    await writeFile(join(destFolder, file), `# ${part.title}\n\n${part.text}\n`)
    chapters.push({ file, title: part.title, words: countWords(part.text) })
  }
  return { title: book.title.replace(/\s+/g, ' ').trim() || name, chapters }
}

/** Lets the main process handle other events between pages and chapters. */
function pause(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Words as people count them: runs of non-space that hold a letter or a digit. */
function countWords(text: string): number {
  let count = 0
  for (const word of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(word)) count++
  return count
}

function slug(title: string): string {
  const words = title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g) ?? []
  let out = ''
  for (const word of words) {
    if (out && out.length + word.length >= 40) break
    out = out ? `${out}-${word}` : word
  }
  return out.slice(0, 40) || 'part'
}

/** Letters and digits only, to compare titles that differ in case or punctuation. */
function plain(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Drops a heading at the top of the text that repeats the chapter title, as the file starts with it already. */
function withoutTitleHeading(chapter: Chapter): Chapter {
  const text = chapter.text.trim()
  const match = /^#{1,6}[ \t]+(.*)(?:\n|$)/.exec(text)
  if (match && plain(match[1]) === plain(chapter.title)) return { ...chapter, text: text.slice(match[0].length).trim() }
  return { ...chapter, text }
}

/**
 * Splits a chapter of more than MAX_WORDS into parts of about equal length at paragraph breaks.
 * A paragraph that is too long by itself is cut between words.
 */
function splitLong(chapter: Chapter): Chapter[] {
  const total = countWords(chapter.text)
  if (total <= MAX_WORDS) return [chapter]
  const target = total / Math.ceil(total / MAX_WORDS)
  const blocks = chapter.text
    .split(/\n[ \t]*\n/)
    .flatMap((block) =>
      countWords(block) > MAX_WORDS ? (block.match(new RegExp(`(?:\\S+\\s*){1,${MAX_WORDS}}`, 'g')) ?? []) : [block]
    )
  const parts: string[][] = [[]]
  let words = 0
  for (const block of blocks) {
    const count = countWords(block)
    if (parts[parts.length - 1].length > 0 && words + count / 2 > target * parts.length) parts.push([])
    parts[parts.length - 1].push(block.trim())
    words += count
  }
  return parts.map((part, i) => ({ title: `${chapter.title} (part ${i + 1})`, text: part.join('\n\n') }))
}

/** UTF-8, or Windows-1252 for older text files that are not valid UTF-8. */
function decodeText(data: Buffer, file: string): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    text = new TextDecoder('windows-1252').decode(data)
  }
  if (text.includes('\0')) throw new Error(`${file} is not a text file.`)
  return text.replace(/\r\n?/g, '\n')
}

/** Markdown splits at the highest heading level that occurs more than once. Plain text has no structure to split at. */
function readText(text: string, name: string, markdown: boolean): Book {
  if (!markdown) return { title: name, chapters: [{ title: name, text }] }
  const lines = text.split('\n')
  const headings: { line: number; level: number; title: string }[] = []
  let fence = false
  lines.forEach((line, i) => {
    if (/^ {0,3}(```|~~~)/.test(line)) fence = !fence
    const match = fence ? null : /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
    if (match) headings.push({ line: i, level: match[1].length, title: match[2] })
  })
  const title = headings.find((heading) => heading.level === 1)?.title || name
  const level = [1, 2, 3, 4, 5, 6].find((l) => headings.filter((heading) => heading.level === l).length > 1)
  const cuts = headings.filter((heading) => heading.level === level)
  if (cuts.length === 0) return { title, chapters: [{ title, text }] }
  const chapters = [{ title, text: lines.slice(0, cuts[0].line).join('\n') }]
  cuts.forEach((cut, i) => {
    chapters.push({ title: cut.title, text: lines.slice(cut.line + 1, cuts[i + 1]?.line).join('\n') })
  })
  return { title, chapters }
}

// EPUB

/** Fonts are often obfuscated with these, which is not DRM: the text is still readable. */
const FONT_OBFUSCATION = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']

function local(name: string): string {
  return name.toLowerCase().replace(/^.*:/, '')
}

function find(root: Node[] | Element, name: string): Element[] {
  return DomUtils.findAll((element) => local(element.name) === name, Array.isArray(root) ? root : [root])
}

function attr(element: Element | undefined, name: string): string {
  return (element && Object.entries(element.attribs).find(([key]) => local(key) === name)?.[1]) || ''
}

function textOf(node: Node | Node[]): string {
  return DomUtils.textContent(node).replace(/\s+/g, ' ').trim()
}

/** A zip path for an href relative to the file `from`, without its fragment. */
function resolveHref(from: string, href: string): { path: string; id: string } {
  const [file, id = ''] = href.split('#')
  let path = file
  try {
    path = decodeURIComponent(file)
  } catch {
    // a stray % in a file name; use it as it is
  }
  return { path: file ? posix.join(posix.dirname(from), path) : from, id }
}

async function readEpub(data: Buffer, name: string): Promise<Book> {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(data, { filter: (file) => /\.(x?html?|xml|opf|ncx)$/i.test(file.name) })
  } catch {
    throw new Error('This EPUB could not be opened. The file may be damaged.')
  }
  const xml = (path: string): Node[] | null =>
    files[path] ? parseDocument(strFromU8(files[path]), { xmlMode: true }).children : null

  const encryption = xml('META-INF/encryption.xml')
  const drm = encryption && find(encryption, 'encryptionmethod').some((method) => !FONT_OBFUSCATION.includes(attr(method, 'algorithm')))
  if (drm) throw new Error('This EPUB is protected with DRM, so its text cannot be read. Add a copy without DRM.')

  const container = xml('META-INF/container.xml')
  const opfPath = container ? attr(find(container, 'rootfile')[0], 'full-path') : ''
  const opf = opfPath ? xml(opfPath) : null
  if (!opf) throw new Error('This EPUB could not be read. The file may be damaged.')

  const manifest = new Map(
    find(opf, 'item').map((item) => [
      attr(item, 'id'),
      { path: resolveHref(opfPath, attr(item, 'href')).path, type: attr(item, 'media-type'), properties: attr(item, 'properties') }
    ])
  )
  const spine = find(opf, 'spine')[0]
  const items = find(opf, 'itemref')
    .map((ref) => manifest.get(attr(ref, 'idref')))
    .filter((item) => item && /html/.test(item.type))
    .map((item) => item!.path)
  const toc = tableOfContents(
    files,
    [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'))?.path,
    manifest.get(attr(spine, 'toc'))?.path ?? [...manifest.values()].find((item) => item.type === 'application/x-dtbncx+xml')?.path
  )

  const chapters: Chapter[] = []
  for (const path of items) {
    await pause()
    if (!files[path]) continue
    const marks = new Map<string, string>()
    for (const entry of toc) if (entry.path === path && entry.id && !marks.has(entry.id)) marks.set(entry.id, entry.title)
    const start = toc.find((entry) => entry.path === path && !entry.id)?.title
    xhtmlToMarkdown(strFromU8(files[path]), marks).forEach((segment, i) => {
      const text = segment.blocks.join('\n\n')
      const heading = /^#+ (.*)/.exec(segment.blocks[0] ?? '')?.[1].replace(/\*/g, '')
      const title = segment.title ?? (i === 0 ? start : undefined)
      // Text before the file's first contents entry continues the chapter before it, as when a long chapter spans files.
      if (!title && !heading && toc.length > 0 && chapters.length > 0) {
        chapters[chapters.length - 1].text += `\n\n${text}`
      } else {
        chapters.push({ title: title ?? heading ?? `Part ${chapters.length + 1}`, text })
      }
    })
  }
  return { title: textOf(find(opf, 'title')[0] ?? []) || name, chapters }
}

type TocEntry = { path: string; id: string; title: string }

/**
 * Chapter titles from the EPUB 3 navigation document, else from the EPUB 2 NCX. Two levels deep, so a book in
 * parts gets its chapters without every subsection becoming a file.
 */
function tableOfContents(files: Record<string, Uint8Array>, navPath?: string, ncxPath?: string): TocEntry[] {
  const depth = (element: Element, name: string): number => {
    let count = 0
    for (let node = element.parent; node; node = node.parent) if ('name' in node && local(node.name) === name) count++
    return count
  }
  if (navPath && files[navPath]) {
    const doc = parseDocument(strFromU8(files[navPath]), { xmlMode: true }).children
    const navs = find(doc, 'nav')
    const nav = navs.find((element) => /\btoc\b/.test(attr(element, 'type'))) ?? navs[0]
    const entries = nav
      ? find(nav, 'a')
          .filter((a) => attr(a, 'href') && depth(a, 'li') <= 2)
          .map((a) => ({ ...resolveHref(navPath, attr(a, 'href')), title: textOf(a) }))
      : []
    if (entries.length > 0) return entries
  }
  if (ncxPath && files[ncxPath]) {
    const doc = parseDocument(strFromU8(files[ncxPath]), { xmlMode: true }).children
    return find(doc, 'navpoint')
      .filter((point) => depth(point, 'navpoint') < 2)
      .map((point) => ({
        ...resolveHref(ncxPath, attr(find(point, 'content')[0], 'src')),
        title: textOf(find(find(point, 'navlabel')[0] ?? [], 'text')[0] ?? [])
      }))
      .filter((entry) => entry.title)
  }
  return []
}

/** Elements whose content is not text to read. */
const SKIP = new Set(['head', 'script', 'style', 'img', 'svg', 'math', 'audio', 'video', 'object', 'iframe', 'noscript', 'template'])
const EMPHASIS: Record<string, [string, string]> = {
  em: ['\uE000', '\uE001'],
  i: ['\uE000', '\uE001'],
  cite: ['\uE000', '\uE001'],
  strong: ['\uE002', '\uE003'],
  b: ['\uE002', '\uE003']
}

type Segment = { title: string | null; blocks: string[] }

/**
 * XHTML as Markdown blocks: headings, paragraphs, lists, emphasis, block quotes and tables. Starts a new segment at
 * each element whose id is in `marks`, the anchors that the table of contents points to.
 */
function xhtmlToMarkdown(html: string, marks: Map<string, string>): Segment[] {
  const segments: Segment[] = [{ title: null, blocks: [] }]
  const lists: { ordered: boolean; n: number }[] = []
  let line = ''
  let quote = 0
  let marker = ''

  const emit = (text: string): void => {
    if (!text.trim()) return
    const pad = '  '.repeat(Math.max(0, lists.length - 1))
    const first = lists.length > 0 ? marker || '  ' : ''
    marker = ''
    const block = text
      .split('\n')
      .map((row, i) => '> '.repeat(quote) + pad + (i === 0 ? first : ' '.repeat(first.length)) + row)
      .join('\n')
    segments[segments.length - 1].blocks.push(block)
  }
  // Emphasis is marked with private characters first, so spaces just inside it can move out before it becomes `*`.
  const flush = (format = (text: string): string => text): void => {
    const text = line
      .replace(/([\uE000\uE002])(\s+)/g, '$2$1')
      .replace(/(\s+)([\uE001\uE003])/g, '$2$1')
      .replace(/\uE000\uE001|\uE002\uE003/g, '')
      .replace(/[\uE000\uE001]/g, '*')
      .replace(/[\uE002\uE003]/g, '**')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .trim()
    line = ''
    if (text) emit(format(text))
  }
  const walk = (nodes: Node[]): void => {
    for (const node of nodes) visit(node)
  }
  const visit = (node: Node): void => {
    if (node.type === ElementType.Text) {
      line += node.data.replace(/\s+/g, ' ')
      return
    }
    if (!('attribs' in node)) return
    const id = node.attribs.id
    if (id && marks.has(id)) {
      flush()
      segments.push({ title: marks.get(id)!, blocks: [] })
    }
    const name = local(node.name)
    if (SKIP.has(name)) return
    const heading = /^h([1-6])$/.exec(name)
    if (heading) {
      flush()
      walk(node.children)
      flush((text) => `${'#'.repeat(Math.min(6, Number(heading[1]) + 1))} ${text.replace(/\n/g, ' ')}`)
    } else if (EMPHASIS[name]) {
      line += EMPHASIS[name][0]
      walk(node.children)
      line += EMPHASIS[name][1]
    } else if (name === 'br') {
      line += '\n'
    } else if (name === 'hr') {
      flush()
      emit('---')
    } else if (name === 'blockquote') {
      flush()
      quote++
      walk(node.children)
      flush()
      quote--
    } else if (name === 'ul' || name === 'ol') {
      flush()
      lists.push({ ordered: name === 'ol', n: Number(node.attribs.start) || 1 })
      walk(node.children)
      flush()
      lists.pop()
    } else if (name === 'li') {
      flush()
      const list = lists[lists.length - 1]
      marker = list?.ordered ? `${list.n++}. ` : '- '
      walk(node.children)
      flush()
    } else if (name === 'pre') {
      flush()
      emit('```\n' + DomUtils.textContent(node).replace(/^\n|\n$/g, '') + '\n```')
    } else if (name === 'table') {
      flush()
      emit(table(node))
    } else if (/^(p|div|section|article|header|footer|aside|nav|main|figure|figcaption|dl|dt|dd|address|center|body)$/.test(name)) {
      flush()
      walk(node.children)
      flush()
    } else {
      walk(node.children)
    }
  }
  walk(parseDocument(html, { recognizeSelfClosing: true }).children)
  flush()
  return segments
}

/** A table as Markdown rows of plain cell text, the first row as its header. */
function table(element: Element): string {
  const rows = find(element, 'tr').map((tr) =>
    tr.children
      .filter((cell): cell is Element => 'attribs' in cell && /^t[dh]$/.test(local(cell.name)))
      .map((cell) => textOf(cell).replace(/\|/g, '\\|'))
  )
  const width = Math.max(0, ...rows.map((row) => row.length))
  if (width === 0 || rows.every((row) => row.every((cell) => !cell))) return ''
  const format = (row: string[]): string => `| ${[...row, ...Array(width - row.length).fill('')].join(' | ')} |`
  return [format(rows[0]), format(Array(width).fill('---')), ...rows.slice(1).map(format)].join('\n')
}

// PDF

const NO_TEXT = 'This PDF has no text in it. It looks scanned, and scanned books cannot be read yet.'

type PdfDocument = Awaited<ReturnType<typeof import('unpdf').getDocumentProxy>>
type PdfItem = Awaited<ReturnType<Awaited<ReturnType<PdfDocument['getPage']>>['getTextContent']>>['items'][number]
type TextItem = Extract<PdfItem, { str: string }>

async function readPdf(data: Buffer, name: string): Promise<Book> {
  // PDF.js is large, so it loads when the first PDF is converted rather than when the app starts.
  const { getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 }).catch((error: { name?: string }) => {
    throw new Error(
      error?.name === 'PasswordException'
        ? 'This PDF is protected with a password, so its text cannot be read. Add a copy without a password.'
        : 'This PDF could not be opened. The file may be damaged.'
    )
  })
  try {
    const pages: string[] = []
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      const content = await page.getTextContent()
      pages.push(pageText(content.items.filter((item): item is TextItem => 'str' in item)))
      page.cleanup()
      await pause()
    }
    if (!pages.some((page) => countWords(page) > 0)) throw new Error(NO_TEXT)
    const info = (await pdf.getMetadata().catch(() => null))?.info as { Title?: unknown } | undefined
    const starts = await outline(pdf)
    return { title: realTitle(info?.Title) ?? name, chapters: starts.length > 0 ? byOutline(pages, starts) : byPages(pages) }
  } finally {
    await pdf.loadingTask.destroy()
  }
}

/** The info Title, unless it is empty or what a program filled in, such as a file name. */
function realTitle(value: unknown): string | null {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!/\p{L}/u.test(title)) return null
  if (/^(untitled|title|document|microsoft word\b)/i.test(title) || /\.(pdf|docx?|rtf|odt|tex|dvi|indd|qxd|ps|txt|html?)$/i.test(title)) return null
  return title
}

/**
 * A page's text in paragraphs. Full lines are joined, and a word hyphenated at a line end is put back together. A
 * new paragraph starts after a larger gap, at a change of font size, or after a short line that ends a sentence or
 * is followed by an indented line. Other short lines keep their line break, as in code and verse. Every character
 * on the page is kept.
 */
function pageText(items: TextItem[]): string {
  type Line = { text: string; x: number; y: number; end: number; size: number }
  const lines: Line[] = []
  let current: Line | null = null
  for (const item of items) {
    const [, , c, d, x, y] = item.transform
    const size = Math.hypot(c, d) || item.height
    if (current && item.str.trim() && Math.abs(y - current.y) > current.size / 2) {
      lines.push(current)
      current = null
    }
    if (!current && item.str.trim()) current = { text: '', x, y, end: x, size }
    if (current) {
      current.text += item.str
      current.end = Math.max(current.end, x + item.width)
      if (item.hasEOL) {
        lines.push(current)
        current = null
      }
    }
  }
  if (current) lines.push(current)

  const gaps = lines
    .slice(1)
    .map((line, i) => lines[i].y - line.y)
    .filter((gap) => gap > 0)
    .sort((a, b) => a - b)
  const usual = gaps[Math.floor(gaps.length / 2)] ?? 0
  const right = Math.max(0, ...lines.map((line) => line.end))
  const paragraphs: string[] = []
  lines.forEach((line, i) => {
    const text = line.text.replace(/\s+/g, ' ').trim()
    const prev = lines[i - 1]
    const last = paragraphs.length - 1
    const gap = prev ? prev.y - line.y : 0
    const short = prev && prev.end < right - prev.size * 3
    const breaks =
      !prev ||
      gap < 0 ||
      (usual > 0 && gap > usual * 1.4) ||
      Math.abs(line.size - prev.size) > prev.size * 0.15 ||
      (short && (/[.!?:"\u201D\u2019)]$/.test(paragraphs[last]) || line.x > prev.x + line.size))
    if (breaks) paragraphs.push(text)
    else if (/\p{L}[-\u00AD]$/u.test(paragraphs[last]) && /^\p{Ll}/u.test(text)) paragraphs[last] = paragraphs[last].slice(0, -1) + text
    else if (short) paragraphs[last] += `\n${text}`
    else paragraphs[last] += ` ${text}`
  })
  return paragraphs.join('\n\n')
}

/** The pages where the outline's entries start, from the first level that has more than one entry. */
async function outline(pdf: PdfDocument): Promise<{ title: string; page: number }[]> {
  let items = (await pdf.getOutline().catch(() => null)) ?? []
  while (items.length === 1 && items[0].items.length > 0) items = items[0].items
  const starts: { title: string; page: number }[] = []
  for (const item of items) {
    try {
      const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest
      const ref = dest?.[0]
      const page = typeof ref === 'number' ? ref : ref ? await pdf.getPageIndex(ref) : -1
      if (page >= 0 && page < pdf.numPages) starts.push({ title: item.title, page })
    } catch {
      // an entry that points nowhere is left out
    }
  }
  return starts.sort((a, b) => a.page - b.page)
}

function pageRange(from: number, to: number): string {
  return to - from > 1 ? `Pages ${from + 1}-${to}` : `Page ${from + 1}`
}

/** A chapter per outline entry, up to the next one. Entries that start on the same page share a chapter. */
function byOutline(pages: string[], starts: { title: string; page: number }[]): Chapter[] {
  const chapters: Chapter[] = []
  if (starts[0].page > 0) chapters.push({ title: pageRange(0, starts[0].page), text: pages.slice(0, starts[0].page).join('\n\n') })
  starts.forEach((start, i) => {
    const end = starts.find((next) => next.page > start.page)?.page ?? pages.length
    if (starts[i - 1]?.page === start.page) chapters[chapters.length - 1].title += ` / ${start.title}`
    else chapters.push({ title: start.title, text: pages.slice(start.page, end).join('\n\n') })
  })
  return chapters
}

/** Without an outline, consecutive pages make parts of up to MAX_WORDS. */
function byPages(pages: string[]): Chapter[] {
  const chapters: Chapter[] = []
  let from = 0
  let words = 0
  pages.forEach((page, i) => {
    const count = countWords(page)
    if (i > from && words + count > MAX_WORDS) {
      chapters.push({ title: pageRange(from, i), text: pages.slice(from, i).join('\n\n') })
      from = i
      words = 0
    }
    words += count
  })
  chapters.push({ title: pageRange(from, pages.length), text: pages.slice(from).join('\n\n') })
  return chapters
}
