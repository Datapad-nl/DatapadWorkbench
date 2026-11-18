import type { Bot } from './types'

/** The order bots are listed in: the chief of staff first, then the others by name. */
export function compareBots(a: Pick<Bot, 'name' | 'chief'>, b: Pick<Bot, 'name' | 'chief'>): number {
  return Number(Boolean(b.chief)) - Number(Boolean(a.chief)) || a.name.localeCompare(b.name)
}
