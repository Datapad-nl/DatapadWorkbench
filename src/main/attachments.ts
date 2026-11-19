import type { Attachment } from '../shared/types'

/** The largest file, other than an image, a message can carry. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024

/** A file the user attached, as opposed to an image that goes to the agent as itself. */
export function isFileAttachment(attachment: Attachment): boolean {
  return Boolean(attachment.path)
}

/** A file name that stays inside the folder it is saved in. */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim() ?? ''
  return base && base !== '.' && base !== '..' ? base : 'file'
}

/** What an attachment-only message is called: its first file's name, or a screenshot. */
export function attachmentTitle(attachments: Attachment[]): string {
  const file = attachments.find(isFileAttachment)
  return file ? file.name || 'File' : 'Screenshot'
}

/**
 * Split a message's attachments for the agent: images go as images, files as a list of paths in the
 * prompt text, which they read themselves. A slash command stays at the start of the prompt.
 */
export function promptForAttachments(
  text: string,
  attachments: Attachment[] = []
): { text: string; images: Attachment[] } {
  const images = attachments.filter((item) => !isFileAttachment(item))
  const files = attachments.filter(isFileAttachment)
  if (files.length === 0) return { text, images }
  const list = files.map((item) => `- ${item.path}`).join('\n')
  const block = `The user attached these files. Read them before answering.\n${list}`
  // A slash command only runs when it starts the prompt.
  if (/^\/\S/.test(text.trimStart())) return { text: `${text}\n\n${block}`, images }
  return { text: text.trim() ? `${block}\n\n${text}` : block, images }
}
