/** How wide the chat's text column (messages and composer) may grow. Kept per machine, like pane widths. */
export const CHAT_WIDTHS = [
  { id: 'standard', label: 'Standard', width: '720px' },
  { id: 'wide', label: 'Wide', width: '880px' },
  { id: 'wider', label: 'Wider', width: '1080px' },
  { id: 'full', label: 'Full', width: '100%' }
] as const

export type ChatWidth = (typeof CHAT_WIDTHS)[number]['id']

const CHAT_WIDTH_KEY = 'workbench.chatWidth'

export function readChatWidth(): ChatWidth {
  const stored = localStorage.getItem(CHAT_WIDTH_KEY)
  return CHAT_WIDTHS.find((option) => option.id === stored)?.id ?? 'standard'
}

export function applyChatWidth(id: ChatWidth = readChatWidth()): void {
  const option = CHAT_WIDTHS.find((item) => item.id === id) ?? CHAT_WIDTHS[0]
  document.documentElement.style.setProperty('--chat-width', option.width)
}

export function saveChatWidth(id: ChatWidth): void {
  localStorage.setItem(CHAT_WIDTH_KEY, id)
  applyChatWidth(id)
}

/** Every window of the app follows a change made in another one. */
export function watchChatWidth(): void {
  applyChatWidth()
  window.addEventListener('storage', (event) => {
    if (event.key === CHAT_WIDTH_KEY) applyChatWidth()
  })
}
