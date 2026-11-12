import { describe, expect, it } from 'vitest'
import { trayBots, trayWaiting, whenLabel } from './trayMenu'

const now = new Date(2026, 10, 12, 15, 0)

describe('tray menu', () => {
  it('names the day of the next run', () => {
    expect(whenLabel(new Date(2026, 10, 12, 18, 30), now)).toMatch(/^today /)
    expect(whenLabel(new Date(2026, 10, 13, 9, 0), now)).toMatch(/^tomorrow /)
    expect(whenLabel(new Date(2026, 10, 30, 9, 0), now)).not.toMatch(/^(today|tomorrow) /)
  })

  it('shows a bot at work, else its next run, else just its name', () => {
    const bots = [
      { id: 'a', name: 'Scout' },
      { id: 'b', name: 'Lint' },
      { id: 'c', name: 'Idle' }
    ]
    const chats = [
      { id: 'a1', botId: 'a', schedule: { prompt: 'x', cron: '0 9 * * *', nextRunAt: new Date(2026, 10, 13, 9).toISOString() } },
      { id: 'b1', botId: 'b', schedule: { prompt: 'x', cron: '0 9 * * *', nextRunAt: new Date(2026, 10, 14, 9).toISOString() } },
      { id: 'b2', botId: 'b', schedule: { prompt: 'x', nextRunAt: new Date(2026, 10, 13, 8).toISOString() } },
      { id: 'p1', schedule: { prompt: 'x', nextRunAt: new Date(2026, 10, 12, 16).toISOString() } }
    ]
    const lines = trayBots(bots, chats, (chatId) => chatId === 'a1', now)
    expect(lines[0]).toEqual({ id: 'a', label: 'Scout · working' })
    expect(lines[1].label).toMatch(/^Lint · next tomorrow /)
    expect(lines[1].label).toContain('08')
    expect(lines[2]).toEqual({ id: 'c', label: 'Idle' })
  })

  it('lists each waiting chat once, a bot chat under the bot name', () => {
    const lines = trayWaiting(
      [
        { chatId: 'c1', kind: 'question' },
        { chatId: 'c1', kind: 'permission' },
        { chatId: 'c2', kind: 'permission' },
        { chatId: 'gone', kind: 'question' }
      ],
      [
        { id: 'c1', title: 'Fix login' },
        { id: 'c2', title: 'Nightly', botId: 'a' }
      ],
      [{ id: 'a', name: 'Scout' }]
    )
    expect(lines).toEqual([
      { chatId: 'c1', label: 'Fix login · answer a question' },
      { chatId: 'c2', label: 'Scout: Nightly · allow a tool' }
    ])
  })
})
