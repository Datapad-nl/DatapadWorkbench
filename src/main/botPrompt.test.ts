import { describe, expect, it } from 'vitest'
import type { Message } from '../shared/types'
import { hasOpenItems, promptForBotAnswers, promptForBotRun, promptForBotsMentioned, promptForHeartbeat } from './botPrompt'

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

  it('finds no open item in an empty file, headings, comments or empty list items', () => {
    expect(hasOpenItems('')).toBe(false)
    expect(hasOpenItems('  \n\n\t')).toBe(false)
    expect(hasOpenItems('# Status\n\n## Waiting on\n')).toBe(false)
    expect(hasOpenItems('<!-- what is open goes here -->\n<!--\n- not this\n-->')).toBe(false)
    expect(hasOpenItems('## Open\n-\n*\n- [ ]\n- [x]\n+')).toBe(false)
    expect(hasOpenItems('<!-- an unclosed comment\n- still a comment')).toBe(false)
  })

  it('finds an open item', () => {
    expect(hasOpenItems('# Status\n- Waiting on the bank until Friday')).toBe(true)
    expect(hasOpenItems('- [ ] Send the invoice')).toBe(true)
    expect(hasOpenItems('Check the deploy at 14:00')).toBe(true)
    expect(hasOpenItems('<!-- note --> Reply to Anna')).toBe(true)
  })

  it('gives the chief the time, its checklist and the open work of each bot that has any', () => {
    const now = new Date(2026, 10, 18, 9, 30)
    const prompt = promptForHeartbeat({
      now,
      checklist: '- Inbox: anything from the bank?',
      work: [
        { name: 'Accountant', status: '- Book the March invoices by Friday' },
        { name: 'Scout', status: '# Status\n' },
        { name: 'Writer', status: 'w'.repeat(3000) }
      ]
    })
    expect(prompt.startsWith(`Heartbeat. It is ${now.toString()}.`)).toBe(true)
    expect(prompt).toContain('## Your checklist\n\n- Inbox: anything from the bank?')
    expect(prompt).toContain('### Accountant\n\n- Book the March invoices by Friday')
    expect(prompt).not.toContain('### Scout')
    expect(prompt).toContain(`### Writer\n\n${'w'.repeat(2000)}…`)
    expect(prompt).not.toContain('w'.repeat(2001))
    expect(prompt).toContain('hand it to the bot it belongs to with the workbench tool ask_bot')
    expect(prompt).toContain('Leave what is not due yet.')
    expect(prompt).toContain('call notify once if the user needs to know or act on something')
  })

  it('says so when the checklist or the work is empty', () => {
    const prompt = promptForHeartbeat({ now: new Date(), checklist: '# Checklist\n', work: [] })
    expect(prompt).toContain('## Your checklist\n\n(empty)')
    expect(prompt).toContain('## Open work of the bots\n\nNo bot has open work.')
  })
})
