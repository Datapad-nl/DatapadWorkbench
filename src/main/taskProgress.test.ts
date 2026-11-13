import { describe, expect, it } from 'vitest'
import { lastLine } from './taskProgress'

describe('lastLine', () => {
  it('drops terminal colour codes from the line it reports', () => {
    const log = 'Signed in\n\x1b[1minbox\x1b[0m Inbox unread \x1b[33m0\x1b[39m total \x1b[33m19074\x1b[39m\n'
    expect(lastLine(log)).toBe('inbox Inbox unread 0 total 19074')
  })

  it('drops title escapes and skips lines that were only codes', () => {
    expect(lastLine('done\n\x1b]0;title\x07\x1b[2K\n')).toBe('done')
  })
})
