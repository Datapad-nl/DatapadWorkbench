import { describe, expect, it } from 'vitest'
import { askedFromPrompt, carryOverPrompt } from './carryOver'
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

describe('askedFromPrompt', () => {
  const chat = [
    msg('user', 'who is our target audience?'),
    msg('assistant', 'Small agencies'),
    msg('assistant', 'Read the report', { fromBot: { botId: 'b1', name: 'Scout', runChatId: 'r1' } }),
    msg('user', '@Critic do we need to change it when you read this?', { toBots: true }),
    msg('assistant', 'later answer')
  ]

  it('hands over the conversation in order, without the question or what came after', () => {
    const text = askedFromPrompt(chat, '@Critic do we need to change it when you read this?', 'Marketing')!
    expect(text).toContain('You were asked from the project chat "Marketing".')
    const user = text.indexOf('### User\nwho is our target audience?')
    const assistant = text.indexOf('### Assistant\nSmall agencies')
    const bot = text.indexOf('### Bot Scout\nRead the report')
    expect(user).toBeGreaterThan(-1)
    expect(assistant).toBeGreaterThan(user)
    expect(bot).toBeGreaterThan(assistant)
    expect(text).not.toContain('@Critic')
    expect(text).not.toContain('later answer')
    expect(text).not.toContain('Only the most recent part')
    expect(text.endsWith('The question follows.')).toBe(true)
  })

  it('keeps a last message that is not to the bots, as ask_bot sees it', () => {
    const text = askedFromPrompt(chat, 'Small agencies', 'Marketing')!
    expect(text).toContain('### Assistant\nSmall agencies')
    expect(text).not.toContain('Read the report')
  })

  it('keeps the newest turns and says so when cut, without read_chat', () => {
    const text = askedFromPrompt([msg('user', 'old '.repeat(50)), msg('assistant', 'newest')], 'newest', 'T', 40)!
    expect(text).toContain('newest')
    expect(text).not.toContain('old old')
    expect(text).toContain('Only the most recent part is included.')
    expect(text).not.toContain('read_chat')
  })

  it('is null when nothing precedes the question or the message is gone', () => {
    expect(askedFromPrompt([msg('user', 'q', { toBots: true })], 'q', 'T')).toBeNull()
    expect(askedFromPrompt(chat, 'missing', 'T')).toBeNull()
    expect(askedFromPrompt([], 'q', 'T')).toBeNull()
  })
})
