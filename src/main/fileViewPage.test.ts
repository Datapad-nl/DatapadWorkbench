import { describe, expect, it } from 'vitest'
import { FILE_CSP, PAGE_CSP, TEXT_LIMIT, cannotShowPage, fileViewKind, isText, markdownPage } from './fileViewPage'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('fileViewKind', () => {
  it('renders markdown', () => {
    expect(fileViewKind('/p/docs/a.md')).toEqual({ kind: 'markdown' })
    expect(fileViewKind('/p/README.MARKDOWN')).toEqual({ kind: 'markdown' })
  })

  it('serves what the pane shows natively with its type', () => {
    expect(fileViewKind('/p/index.html')).toEqual({ kind: 'raw', type: 'text/html' })
    expect(fileViewKind('/p/a.HTM')).toEqual({ kind: 'raw', type: 'text/html' })
    expect(fileViewKind('/p/shot.png')).toEqual({ kind: 'raw', type: 'image/png' })
    expect(fileViewKind('/p/shot.jpg')).toEqual({ kind: 'raw', type: 'image/jpeg' })
    expect(fileViewKind('/p/icon.svg')).toEqual({ kind: 'raw', type: 'image/svg+xml' })
    expect(fileViewKind('/p/clip.mp4')).toEqual({ kind: 'raw', type: 'video/mp4' })
    expect(fileViewKind('/p/spec.pdf')).toEqual({ kind: 'raw', type: 'application/pdf' })
  })

  it('leaves the rest to the bytes', () => {
    for (const name of ['/p/a.ts', '/p/data.json', '/p/Makefile', '/p/app.exe', '/p/.env']) {
      expect(fileViewKind(name)).toEqual({ kind: 'other' })
    }
  })
})

describe('isText', () => {
  it('takes UTF-8 code and extensionless text', () => {
    expect(isText('/p/a.ts', bytes('const a = 1 // héllo'))).toBe(true)
    expect(isText('/p/Makefile', bytes('all:\n\techo hi'))).toBe(true)
    expect(isText('/p/empty', new Uint8Array())).toBe(true)
  })

  it('takes a character cut off at the read limit', () => {
    const cut = bytes('ab€').subarray(0, 4)
    expect(isText('/p/a.ts', cut)).toBe(true)
  })

  it('refuses binary of no known text kind', () => {
    expect(isText('/p/app.exe', new Uint8Array([0x4d, 0x5a, 0x00, 0x01]))).toBe(false)
    expect(isText('/p/blob', new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(false)
  })

  it('shows a known text kind even when it is not UTF-8', () => {
    expect(isText('/p/data.csv', new Uint8Array([0x63, 0xe9, 0x0a]))).toBe(true)
  })
})

describe('markdownPage', () => {
  it('renders the document with its file name as title', () => {
    const html = markdownPage('docs/design/flow-platform.md', '# Flow\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![shot](../shot.png)', 100)
    expect(html).toContain('<title>flow-platform.md</title>')
    expect(html).toContain('<h1>Flow</h1>')
    expect(html).toContain('<table>')
    // Relative to the page's own address, which is the document's.
    expect(html).toContain('src="../shot.png"')
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).not.toContain('Only the first')
  })

  it('escapes the title and says when the file was cut', () => {
    const html = markdownPage('docs/<b>.md', 'x', TEXT_LIMIT * 3)
    expect(html).toContain('<title>&#60;b&#62;.md</title>')
    expect(html).toContain('Only the first 4 MB of this 12 MB file is shown.')
  })

  it('names a file it cannot show', () => {
    expect(cannotShowPage('bin/app.exe')).toContain('This file cannot be shown here.')
  })
})

describe('policies', () => {
  it('give every page an opaque origin, and the rendered page no script', () => {
    expect(FILE_CSP).toBe('sandbox allow-scripts')
    expect(PAGE_CSP).toContain('sandbox allow-scripts')
    expect(PAGE_CSP).toContain("script-src 'none'")
    expect(PAGE_CSP).toContain("default-src 'none'")
  })
})
