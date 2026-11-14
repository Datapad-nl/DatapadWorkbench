import { describe, expect, it } from 'vitest'
import { carryOverPrompt } from './carryOver'
import type { Message } from './types'

function msg(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { id: content, role, content, createdAt: '2026-11-14T00:00:00Z', ...extra }
}

describe('carryOverPrompt', () => {
  it('is null with nothing before the new message', () => {
    expect(carryOverPrompt([], 'c1')).toBeNull()
  })

  it('hands over the conversation without side answers', () => {
    const text = carryOverPrompt(
      [msg('user', 'fix the build'), msg('assistant', 'Done, tests pass'), msg('user', 'aside?', { kind: 'btw' })],
      'c1'
    )!
    expect(text).toContain('### User\nfix the build')
    expect(text).toContain('### Assistant\nDone, tests pass')
    expect(text).not.toContain('aside?')
    expect(text).not.toContain('read_chat')
  })

  it('keeps the newest turns and points at read_chat when cut', () => {
    const text = carryOverPrompt([msg('user', 'old '.repeat(50)), msg('assistant', 'newest')], 'c9', 40)!
    expect(text).toContain('newest')
    expect(text).not.toContain('old old')
    expect(text).toContain('chat id c9')
  })
})
