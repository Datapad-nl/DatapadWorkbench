/** The Telegram channel as Settings shows it. The token itself never leaves the main process. */
export type TelegramStatus = {
  hasToken: boolean
  /** The bot's @username once the token was checked. */
  username: string | null
  state: 'off' | 'connecting' | 'connected' | 'error'
  error: string | null
  paired: boolean
  /** Title of the paired group, or null when paired in a direct message only. */
  group: string | null
  /** An open pairing code and when it ends, for Settings to show. */
  pairing: { code: string; expiresAt: string } | null
  reachableBots: string[]
  reachableProjects: string[]
}
