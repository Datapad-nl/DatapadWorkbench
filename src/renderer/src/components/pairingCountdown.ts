/** "9:41" for the time left until `expiresAt`, or null once it has passed. */
export function pairingCountdown(expiresAt: string, now: number): string | null {
  const left = Date.parse(expiresAt) - now
  if (!Number.isFinite(left) || left <= 0) return null
  const seconds = Math.ceil(left / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
