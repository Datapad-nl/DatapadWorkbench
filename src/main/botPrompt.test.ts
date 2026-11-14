import { describe, expect, it } from 'vitest'
import type { Message } from '../shared/types'
import { promptForBotAnswers, promptForBotRun, promptForBotsAsked } from './botPrompt'

const answer = (name: string, content: string): Message => ({
  id: name,
  role: 'assistant',
  content,
  fromBot: { botId: name, name, runChatId: `${name}-run` },
  createdAt: ''
})

describe('bot prompts', () => {
  it('leaves a prompt without bots alone', () => {
    expect(promptForBotsAsked('fix it', [])).toBe('fix it')
    expect(promptForBotAnswers('fix it', [])).toBe('fix it')
  })

  it('tells the agent which bots were asked, ahead of the message', () => {
    expect(promptForBotsAsked('review the login', [{ id: 'scout', name: 'Scout' }])).toBe(
      'The user also asked the bot Scout about this message. Each works on it by itself and posts its answer in this chat; you get it with your next prompt.\n\nreview the login'
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
