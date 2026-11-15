import { strToU8, zipSync } from 'fflate'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { convertBook } from './bookConvert'

let dir = ''
let out = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-book-convert-'))
  out = join(dir, 'out')
  mkdirSync(out)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function source(name: string, data: string | Uint8Array): string {
  const path = join(dir, name)
  writeFileSync(path, data)
  return path
}

function chapter(file: string): string {
  return readFileSync(join(out, file), 'utf8')
}

function words(count: number, from = 0): string {
  return Array.from({ length: count }, (_, i) => `w${from + i}`).join(' ')
}

const xhtml = (body: string): string =>
  '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
  `<head><title>ignored</title><style>p { color: red }</style></head><body>${body}</body></html>`

/** An EPUB with its container and package document; `files` are paths inside OEBPS. */
function epub(files: Record<string, string>, manifest: string, spine: string, extra: Record<string, string> = {}): Uint8Array {
  const opf =
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Test Book</dc:title></metadata>' +
    `<manifest>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`
  const entries: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'OEBPS/content.opf': strToU8(opf)
  }
  for (const [path, text] of Object.entries(files)) entries[`OEBPS/${path}`] = strToU8(text)
  for (const [path, text] of Object.entries(extra)) entries[path] = strToU8(text)
  return zipSync(entries)
}

function novel(extra: Record<string, string> = {}): Uint8Array {
  return epub(
    {
      'nav.xhtml': xhtml(
        '<nav epub:type="landmarks"><ol><li><a href="text/cover.xhtml">Cover</a></li></ol></nav>' +
          '<nav epub:type="toc"><ol>' +
          '<li><a href="text/cover.xhtml">Cover</a></li>' +
          '<li><a href="text/one.xhtml">Chapter One</a></li>' +
          '<li><a href="text/two.xhtml">Second Chapter</a></li>' +
          '<li><a href="text/three.xhtml#c3">Chapter Three</a><ol><li><a href="text/three.xhtml#c4">Chapter Four</a></li></ol></li>' +
          '</ol></nav>'
      ),
      'text/cover.xhtml': xhtml('<div><img src="../cover.jpg" alt="Cover"/></div>'),
      'text/one.xhtml': xhtml(
        '<h1>Chapter One</h1><p>It was a <em>dark </em>and <strong>stormy</strong> night.</p>' +
          '<ul><li>first</li><li>second</li></ul><blockquote><p>A quote.</p></blockquote>' +
          '<script>alert("no")</script><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
      ),
      'text/two.xhtml': xhtml('<h2>Something else</h2><p>Second &amp; text.</p>'),
      'text/three.xhtml': xhtml(
        '<p>Still chapter two.</p><h2 id="c3">Chapter Three</h2><p>Three text.</p>' +
          '<div id="c4"><h2>Chapter Four</h2><p>Four text.</p></div>'
      )
    },
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
      '<item id="three" href="text/three.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="two" href="text/two.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="one" href="text/one.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="img" href="cover.jpg" media-type="image/jpeg"/>',
    '<itemref idref="cover"/><itemref idref="one"/><itemref idref="two"/><itemref idref="three"/>',
    extra
  )
}

const encryption = (algorithm: string): Record<string, string> => ({
  'META-INF/encryption.xml':
    '<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">' +
    `<enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/>` +
    '<enc:CipherData><enc:CipherReference URI="OEBPS/text/one.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>'
})

/** A PDF with a page of Helvetica text lines per entry. An empty line leaves a gap, as between paragraphs. */
function pdf(pages: string[][], options: { title?: string; outline?: { title: string; page: number }[] } = {}): Buffer {
  const escape = (text: string): string => text.replace(/[\\()]/g, '\\$&')
  const outline = options.outline ?? []
  const objects: string[] = []
  const pageIds = pages.map((_, i) => 4 + i * 2)
  const root = 4 + pages.length * 2
  const info = root + 1 + outline.length
  objects[1] = `<< /Type /Catalog /Pages 2 0 R${outline.length ? ` /Outlines ${root} 0 R` : ''} >>`
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  pages.forEach((lines, i) => {
    const stream = lines.length ? `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET` : ''
    objects[pageIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`
    objects[pageIds[i] + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  if (outline.length) {
    objects[root] = `<< /Type /Outlines /First ${root + 1} 0 R /Last ${root + outline.length} 0 R /Count ${outline.length} >>`
    outline.forEach((entry, k) => {
      const id = root + 1 + k
      objects[id] =
        `<< /Title (${escape(entry.title)}) /Parent ${root} 0 R /Dest [${pageIds[entry.page]} 0 R /Fit]` +
        `${k > 0 ? ` /Prev ${id - 1} 0 R` : ''}${k < outline.length - 1 ? ` /Next ${id + 1} 0 R` : ''} >>`
    })
  }
  if (options.title) objects[info] = `<< /Title (${escape(options.title)}) >>`
  let text = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = text.length
    text += `${id} 0 obj\n${objects[id] ?? 'null'}\nendobj\n`
  }
  const xref = text.length
  text += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) text += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  text += `trailer\n<< /Size ${objects.length} /Root 1 0 R${options.title ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(text, 'latin1')
}

describe('EPUB', () => {
  it('follows the spine, takes titles from the navigation and leaves out the cover', async () => {
    const book = await convertBook(source('novel.epub', novel()), out)
    expect(book.title).toBe('The Test Book')
    expect(book.chapters.map((c) => [c.file, c.title])).toEqual([
      ['01-chapter-one.md', 'Chapter One'],
      ['02-second-chapter.md', 'Second Chapter'],
      ['03-chapter-three.md', 'Chapter Three'],
      ['04-chapter-four.md', 'Chapter Four']
    ])
    expect(readdirSync(out).sort()).toEqual(book.chapters.map((c) => c.file))
    expect(chapter('01-chapter-one.md')).toBe(
      '# Chapter One\n\nIt was a *dark* and **stormy** night.\n\n- first\n\n- second\n\n> A quote.\n\n' +
        '| A | B |\n| --- | --- |\n| 1 | 2 |\n'
    )
    expect(chapter('02-second-chapter.md')).toBe('# Second Chapter\n\n### Something else\n\nSecond & text.\n\nStill chapter two.\n')
    expect(chapter('04-chapter-four.md')).toBe('# Chapter Four\n\nFour text.\n')
    expect(book.chapters[1].words).toBe(7)
  })

  it('takes titles from the NCX, else from the first heading, else Part N', async () => {
    const ncx =
      '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>' +
      '<navPoint id="p1"><navLabel><text>Opening</text></navLabel><content src="a.xhtml"/></navPoint></navMap></ncx>'
    const book = await convertBook(
      source(
        'old.epub',
        epub(
          {
            'toc.ncx': ncx,
            'a.xhtml': xhtml('<p>Alpha.</p>'),
            'b.xhtml': xhtml('<h1>Interlude</h1><p>Beta.</p>'),
            'c.xhtml': xhtml('<p>Gamma.</p>')
          },
          '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
            '<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>' +
            '<item id="b" href="b.xhtml" media-type="application/xhtml+xml"/>' +
            '<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>',
          '<itemref idref="a"/><itemref idref="b"/><itemref idref="c"/>'
        )
      ),
      out
    )
    // c.xhtml has no entry and no heading, so it continues the chapter before it.
    expect(book.chapters.map((c) => c.title)).toEqual(['Opening', 'Interlude'])
    expect(chapter('02-interlude.md')).toBe('# Interlude\n\nBeta.\n\nGamma.\n')

    mkdirSync(join(dir, 'bare'))
    const bare = await convertBook(
      source('bare.epub', epub({ 'a.xhtml': xhtml('<p>Alpha.</p>') }, '<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>', '<itemref idref="a"/>')),
      join(dir, 'bare')
    )
    expect(bare.chapters.map((c) => c.title)).toEqual(['Part 1'])
  })

  it('rejects an EPUB with DRM but reads one whose fonts are only obfuscated', async () => {
    await expect(convertBook(source('drm.epub', novel(encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc'))), out)).rejects.toThrow(
      'This EPUB is protected with DRM'
    )
    expect(readdirSync(out)).toEqual([])
    const book = await convertBook(source('fonts.epub', novel(encryption('http://www.idpf.org/2008/embedding'))), out)
    expect(book.chapters).toHaveLength(4)
  })
})

describe('Markdown and text', () => {
  it('splits Markdown at the highest heading level that occurs more than once', async () => {
    const text =
      '# My Notes\n\nIntro paragraph.\n\n## First\n\nText one.\n\n```\n## not a heading\n## nor this\n```\n\n' +
      '### Sub\n\nSub text.\n\n## Second\n\nText two.\n'
    const book = await convertBook(source('notes.md', text), out)
    expect(book.title).toBe('My Notes')
    expect(book.chapters.map((c) => c.file)).toEqual(['01-my-notes.md', '02-first.md', '03-second.md'])
    expect(chapter('01-my-notes.md')).toBe('# My Notes\n\nIntro paragraph.\n')
    expect(chapter('02-first.md')).toBe('# First\n\nText one.\n\n```\n## not a heading\n## nor this\n```\n\n### Sub\n\nSub text.\n')
  })

  it('splits text by size at paragraph breaks, and between words when a paragraph is too long', async () => {
    const paragraphs = Array.from({ length: 130 }, (_, i) => words(100, i * 100))
    const book = await convertBook(source('Long Read.txt', paragraphs.join('\n\n')), out)
    expect(book.title).toBe('Long Read')
    expect(book.chapters.map((c) => c.title)).toEqual(['Long Read (part 1)', 'Long Read (part 2)', 'Long Read (part 3)'])
    expect(book.chapters.every((c) => c.words <= 6000)).toBe(true)
    const body = book.chapters.map((c) => chapter(c.file).replace(/^# .*\n\n/, '').trim())
    expect(body.join('\n\n')).toBe(paragraphs.join('\n\n'))

    const wall = words(13000)
    mkdirSync(join(dir, 'wall'))
    const one = await convertBook(source('wall.txt', wall), join(dir, 'wall'))
    expect(one.chapters.map((c) => c.words)).toEqual([6000, 6000, 1000])
    const parts = one.chapters.map((c) => readFileSync(join(dir, 'wall', c.file), 'utf8').replace(/^# .*\n\n/, '').trim())
    expect(parts.join(' ')).toBe(wall)
  })

  it('splits a long chapter into parts', async () => {
    const book = await convertBook(source('big.md', `## A\n\n${words(4000)}\n\n${words(3000, 4000)}\n\n## B\n\nShort.\n`), out)
    expect(book.chapters.map((c) => [c.file, c.title, c.words])).toEqual([
      ['01-a-part-1.md', 'A (part 1)', 4000],
      ['02-a-part-2.md', 'A (part 2)', 3000],
      ['03-b.md', 'B', 1]
    ])
  })
})

describe('PDF', () => {
  it('reads the text of each page and joins lines into paragraphs', async () => {
    const file = pdf(
      [
        ['The first paragraph starts here and it', 'goes on with a hyphen-', 'ated word.', '', 'A second paragraph.'],
        ['Page two text.']
      ],
      { title: 'A Real Title' }
    )
    const book = await convertBook(source('paper.pdf', file), out)
    expect(book.title).toBe('A Real Title')
    expect(book.chapters.map((c) => c.file)).toEqual(['01-pages-1-2.md'])
    expect(chapter('01-pages-1-2.md')).toBe(
      '# Pages 1-2\n\nThe first paragraph starts here and it goes on with a hyphenated word.\n\nA second paragraph.\n\nPage two text.\n'
    )
  })

  it('makes a chapter per bookmark, with the pages before the first one as their own part', async () => {
    const file = pdf([['Title page.'], ['One starts.'], ['One goes on.'], ['Two.']], {
      title: 'Microsoft Word - draft.docx',
      outline: [
        { title: 'Chapter One', page: 1 },
        { title: 'Chapter Two', page: 3 }
      ]
    })
    const book = await convertBook(source('Bookmarked.pdf', file), out)
    expect(book.title).toBe('Bookmarked')
    expect(book.chapters.map((c) => c.title)).toEqual(['Page 1', 'Chapter One', 'Chapter Two'])
    expect(chapter('02-chapter-one.md')).toBe('# Chapter One\n\nOne starts.\n\nOne goes on.\n')
  })

  it('rejects a PDF with no text', async () => {
    await expect(convertBook(source('scan.pdf', pdf([[], []])), out)).rejects.toThrow(
      'This PDF has no text in it. It looks scanned, and scanned books cannot be read yet.'
    )
  })

  it('rejects a PDF that needs a password', async () => {
    await expect(convertBook(join(__dirname, 'fixtures', 'password.pdf'), out)).rejects.toThrow('This PDF is protected with a password')
  })

  it('rejects a file that is not a PDF', async () => {
    await expect(convertBook(source('broken.pdf', 'not a pdf'), out)).rejects.toThrow('This PDF could not be opened.')
  })
})

describe('other files', () => {
  it('rejects an unsupported extension and a missing file', async () => {
    await expect(convertBook(source('book.docx', 'x'), out)).rejects.toThrow('book.docx is not a book the app can read.')
    await expect(convertBook(join(dir, 'gone.txt'), out)).rejects.toThrow('gone.txt could not be opened.')
  })
})
