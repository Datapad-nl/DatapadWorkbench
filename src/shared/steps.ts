/**
 * Marks where an agent's reply paused for tool calls. The chat shows the text
 * before each break as a step and the text after the last break as the answer.
 */
export const STEP_BREAK = '\n\n<!--step-->\n\n'

const STEP_SPLIT = /\s*<!--step-->\s*/

/** A reply cut at its step breaks; the last part is the answer. */
export function replySteps(text: string): string[] {
  return text
    .split(STEP_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean)
}

/** The reply as plain markdown, for copying, speaking, searching and prompts. */
export function plainReply(text: string): string {
  return text.includes('<!--step-->') ? replySteps(text).join('\n\n') : text
}
