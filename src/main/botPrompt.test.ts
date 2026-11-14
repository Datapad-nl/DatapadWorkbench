import { describe, expect, it } from 'vitest'
import type { Message } from '../shared/types'
import { promptForBotAnswers, promptForBotRun, promptForBotsMentioned } from './botPrompt'

const answer = (name: string, content: string): Message => ({
  id: name,
  role: 'assistant',
  content,
  fromBot: { botId: name, name, runChatId: `${name}-run` },
  createdAt: ''
})

describe('bot prompts', () => {
  it('leaves a prompt without bots alone', () => {
    expect(promptForBotsMentioned('fix it', [])).toBe('fix it')
    expect(promptForBotAnswers('fix it', [])).toBe('fix it')
  })

  it('tells the agent which bots the message names and how to ask them, ahead of the message', () => {
    const prompt = promptForBotsMentioned('send these to @Ads Checker', [{ id: 'ads', name: 'Ads Checker' }])
    expect(prompt.startsWith('The user names the bot @Ads Checker in this message.')).toBe(true)
    expect(prompt).toContain('call the workbench tool ask_bot')
    expect(prompt.endsWith('\n\nsend these to @Ads Checker')).toBe(true)
  })

  it('tells the agent what the user asked a bot directly', () => {
    const asked: Message = { ...answer('Scout', 'Two broken links.'), fromBot: { botId: 'Scout', name: 'Scout', runChatId: 'r', question: 'check the links' } }
    expect(promptForBotAnswers('next', [asked])).toBe(
      'Bots answered in this chat since your last prompt:\n\n### Scout\n\nThe user asked it: check the links\n\nTwo broken links.\n\nnext'
    )
  })

  it('passes the answers on, after a slash command so it still runs', () => {
    const prompt = promptForBotAnswers('/review', [answer('Scout', 'Looks fine.'), answer('Lint', 'Two warnings.')])
    expect(prompt).toBe(
      '/review\n\nBots answered in this chat since your last prompt:\n\n### Scout\n\nLooks fine.\n\n### Lint\n\nTwo warnings.'
    )
  })

  it('tells a bot an unattended run is quiet unless it calls notify, after a slash command', () => {
    const scheduled = promptForBotRun('/check-inbox', { kind: 'schedule' })
    expect(scheduled.startsWith('/check-inbox\n\nThis is a scheduled run. It starts in a fresh session')).toBe(true)
    expect(scheduled).toContain('unless you call the workbench tool notify')
    expect(promptForBotRun('Follow-up: deploy?', { kind: 'followUp' })).toContain('the follow-up you set earlier')
  })
})
