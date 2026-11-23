import { describe, expect, it } from 'vitest'
import { pairingCountdown } from './pairingCountdown'

describe('pairingCountdown', () => {
  const end = '2026-01-01T10:10:00.000Z'
  const at = (iso: string): number => Date.parse(iso)

  it('shows minutes and padded seconds', () => {
    expect(pairingCountdown(end, at('2026-01-01T10:00:00.000Z'))).toBe('10:00')
    expect(pairingCountdown(end, at('2026-01-01T10:09:55.000Z'))).toBe('0:05')
  })

  it('rounds a part of a second up', () => {
    expect(pairingCountdown(end, at('2026-01-01T10:09:59.500Z'))).toBe('0:01')
  })

  it('is null once it has passed or the time is not a date', () => {
    expect(pairingCountdown(end, at(end))).toBeNull()
    expect(pairingCountdown('soon', 0)).toBeNull()
  })
})
