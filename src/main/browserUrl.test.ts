import { describe, expect, it } from 'vitest'
import { allowedNavigation, isFileViewUrl, pageTitle, sameAddress, sanitizeUrl, sanitizeWebUrl } from './browserUrl'

const CHAT = '3f2b8c1e-0d4a-4c51-9a7e-2b6f0e1d9c88'
const FILE = `workbench-file://${CHAT}/docs/a.md`

describe('sanitizeUrl', () => {
  it('keeps web addresses as before', () => {
    expect(sanitizeUrl('example.com')).toBe('https://example.com/')
    expect(sanitizeUrl(' http://localhost:5173/x ')).toBe('http://localhost:5173/x')
    expect(sanitizeUrl('')).toBeNull()
  })

  it('takes a project file address', () => {
    expect(sanitizeUrl(FILE)).toBe(FILE)
    expect(sanitizeUrl(`  ${FILE}  `)).toBe(FILE)
    expect(sanitizeUrl(`workbench-file://${CHAT}/my%20docs/a.md`)).toBe(`workbench-file://${CHAT}/my%20docs/a.md`)
  })

  it('refuses file: and every other scheme', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'workbench-media://media/x?src=a.png',
      'workbench-visual://v/x',
      `workbench-file://${CHAT}/`,
      `workbench-file://${CHAT}/a%2F..%2Fb`,
      'workbench-file://bad_host/a.md'
    ]) {
      expect(sanitizeUrl(url), url).toBeNull()
    }
  })
})

describe('sanitizeWebUrl', () => {
  it('takes only http(s)', () => {
    expect(sanitizeWebUrl('https://a.test/')).toBe('https://a.test/')
    expect(sanitizeWebUrl(FILE)).toBeNull()
    expect(sanitizeWebUrl('file:///etc/passwd')).toBeNull()
  })
})

describe('allowedNavigation', () => {
  it('lets a file page go to another file or the web', () => {
    expect(allowedNavigation(FILE, `workbench-file://${CHAT}/docs/b.md`)).toBe(`workbench-file://${CHAT}/docs/b.md`)
    expect(allowedNavigation(FILE, 'https://a.test/')).toBe('https://a.test/')
  })

  it('stops a web page opening a project file', () => {
    expect(allowedNavigation('https://evil.test/', FILE)).toBeNull()
    expect(allowedNavigation('', FILE)).toBeNull()
    expect(allowedNavigation('https://a.test/', 'https://b.test/')).toBe('https://b.test/')
    expect(allowedNavigation(FILE, 'file:///etc/passwd')).toBeNull()
  })

  it('knows a file view address', () => {
    expect(isFileViewUrl(FILE)).toBe(true)
    expect(isFileViewUrl('https://a.test/')).toBe(false)
  })
})

describe('sameAddress', () => {
  it('compares file views by chat and decoded path', () => {
    expect(
      sameAddress(`workbench-file://${CHAT}/my%20docs/a.md`, `workbench-file://${CHAT.toUpperCase()}/my docs/a.md`)
    ).toBe(true)
    expect(sameAddress(FILE, `workbench-file://${CHAT}/docs/b.md`)).toBe(false)
    expect(sameAddress('https://a.test/', 'https://a.test/')).toBe(true)
  })
})

describe('pageTitle', () => {
  it('names a project file without a title of its own by its file name', () => {
    const url = 'workbench-file://chat-1/src/my%20app.ts'
    expect(pageTitle(url, url)).toBe('my app.ts')
    expect(pageTitle(url, '')).toBe('my app.ts')
    expect(pageTitle(url, 'Readme')).toBe('Readme')
    expect(pageTitle('https://example.com/', 'https://example.com/')).toBe('https://example.com/')
  })
})
