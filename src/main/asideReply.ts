export function parseAsideReply(text: string): { steer: boolean; reply: string } {
  const trimmed = text.trim()
  const match = trimmed.match(/^STEER\b:?[ \t]*([\s\S]*)$/i)
  if (!match) return { steer: false, reply: trimmed }
  const rest = match[1].trim()
  return {
    steer: true,
    reply: rest || 'Noted — I’ll apply that to the current task.'
  }
}

/** The reply of an aside that ended early. The text it streamed before a stop stays, like a stopped turn's. */
export function asideEndReply(streamed: string, error: unknown, fallback: string): { steer: boolean; reply: string } {
  if (streamed.trim()) return parseAsideReply(streamed)
  const reply = error instanceof Error && /cancel/i.test(error.message) ? '(stopped)' : fallback
  return { steer: false, reply }
}
