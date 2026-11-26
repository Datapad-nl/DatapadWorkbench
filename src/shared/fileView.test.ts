import { describe, expect, it } from 'vitest'
import { fileViewUrl, localLinkSrc, looksLikeFilePath, parseFileViewUrl, stripLineSuffix } from './fileView'

const CHAT = '3f2b8c1e-0d4a-4c51-9a7e-2b6f0e1d9c88'

describe('file view addresses', () => {
  it('builds a readable address with each segment encoded', () => {
    expect(fileViewUrl(CHAT, 'docs/design/flow-platform.md')).toBe(
      `workbench-file://${CHAT}/docs/design/flow-platform.md`
    )
    expect(fileViewUrl(CHAT, 'my docs/a#b?.md')).toBe(`workbench-file://${CHAT}/my%20docs/a%23b%3F.md`)
    expect(fileViewUrl(CHAT, 'docs\\win.md')).toBe(`workbench-file://${CHAT}/docs/win.md`)
  })

  it('refuses a bad chat id or a path that steps out', () => {
    expect(fileViewUrl('../x', 'a.md')).toBeNull()
    expect(fileViewUrl('a b', 'a.md')).toBeNull()
    expect(fileViewUrl(CHAT, '../a.md')).toBeNull()
    expect(fileViewUrl(CHAT, '')).toBeNull()
  })

  it('parses what it builds', () => {
    for (const path of ['docs/design/flow-platform.md', 'my docs/a#b?.md', 'ünï/çødé.ts', 'a/[id].tsx']) {
      expect(parseFileViewUrl(fileViewUrl(CHAT, path)!)).toEqual({ chatId: CHAT, path })
    }
  })

  it('never yields a path with a dot segment or a separator in a segment', () => {
    // The URL parser folds `..` and `%2e%2e` away at the top, so they cannot climb above the root.
    expect(parseFileViewUrl(`workbench-file://${CHAT}/../../etc/passwd`)).toEqual({ chatId: CHAT, path: 'etc/passwd' })
    expect(parseFileViewUrl(`workbench-file://${CHAT}/%2e%2e/%2E%2E/etc/passwd`)).toEqual({
      chatId: CHAT,
      path: 'etc/passwd'
    })
    expect(parseFileViewUrl(`workbench-file://${CHAT}/docs/..%2F..%2Fetc%2Fpasswd`)).toBeNull()
    expect(parseFileViewUrl(`workbench-file://${CHAT}/docs/..%5C..%5Cx`)).toBeNull()
    expect(parseFileViewUrl(`workbench-file://${CHAT}/a%00.md`)).toBeNull()
    expect(parseFileViewUrl(`workbench-file://${CHAT}/%E0%A4%A`)).toBeNull()
  })

  it('refuses other schemes, odd hosts and empty paths', () => {
    expect(parseFileViewUrl(`file:///etc/passwd`)).toBeNull()
    expect(parseFileViewUrl(`https://${CHAT}/a.md`)).toBeNull()
    expect(parseFileViewUrl(`workbench-file://${CHAT}/`)).toBeNull()
    expect(parseFileViewUrl(`workbench-file://user:pw@${CHAT}/a.md`)).toBeNull()
    expect(parseFileViewUrl(`workbench-file://${CHAT}:99/a.md`)).toBeNull()
    expect(parseFileViewUrl('workbench-file://a_b/a.md')).toBeNull()
    expect(parseFileViewUrl('not a url')).toBeNull()
  })
})

describe('stripLineSuffix', () => {
  it('drops a trailing line and column', () => {
    expect(stripLineSuffix('src/app.ts:12')).toBe('src/app.ts')
    expect(stripLineSuffix('src/app.ts:12:4')).toBe('src/app.ts')
    expect(stripLineSuffix(' src/app.ts ')).toBe('src/app.ts')
    expect(stripLineSuffix('src/app.ts')).toBe('src/app.ts')
    expect(stripLineSuffix('a:b.ts')).toBe('a:b.ts')
    expect(stripLineSuffix('src/app.ts:12:4:9')).toBe('src/app.ts:12')
  })
})

describe('looksLikeFilePath', () => {
  it('takes paths and file names', () => {
    for (const text of [
      'docs/design/flow-platform.md',
      'src/main/browser.ts:42',
      'src/main/browser.ts:42:7',
      'package.json',
      'README.md',
      '.env',
      './scripts/run.sh',
      '~/notes/todo.txt',
      '/Users/me/project/a.png',
      'src/renderer',
      'app/[id]/page.tsx',
      'Makefile/'
    ]) {
      expect(looksLikeFilePath(text), text).toBe(true)
    }
  })

  it('leaves code and commands alone', () => {
    for (const text of [
      'mobileNotice',
      'npm run build',
      'foo()',
      'v1.2',
      '1.2.3',
      'a = b',
      'useState<string>',
      '{ a: 1 }',
      'https://example.com/a.md',
      'x.reallyLongPropertyName',
      '...',
      '/',
      '',
      'a'.repeat(301) + '.md'
    ]) {
      expect(looksLikeFilePath(text), text).toBe(false)
    }
  })
})

describe('localLinkSrc', () => {
  it('reads a relative or absolute link as a path', () => {
    expect(localLinkSrc('docs/design/flow-platform.md')).toBe('docs/design/flow-platform.md')
    expect(localLinkSrc('docs/my%20file.md#part')).toBe('docs/my file.md')
    expect(localLinkSrc('/abs/a.md?x=1')).toBe('/abs/a.md')
  })

  it('leaves anchors and other schemes', () => {
    expect(localLinkSrc('#section')).toBeNull()
    expect(localLinkSrc('mailto:a@b.c')).toBeNull()
    expect(localLinkSrc('https://a.test/x.md')).toBeNull()
    expect(localLinkSrc('')).toBeNull()
  })
})
