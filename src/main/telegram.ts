/**
 * A thin client for the Telegram Bot API. The routing in channels.ts talks to it through `TelegramClient`,
 * so tests can put a fake in its place. The token is part of every URL, so no error from here may carry one.
 */

export type TelegramUser = { id: number; is_bot?: boolean; first_name?: string; username?: string }

export type TelegramChat = { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; is_forum?: boolean }

export type TelegramMessage = {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
  caption?: string
  message_thread_id?: number
  is_topic_message?: boolean
  voice?: { file_id: string; mime_type?: string; duration?: number }
  audio?: { file_id: string; mime_type?: string; duration?: number }
  photo?: unknown[]
  document?: unknown
  video?: unknown
  video_note?: unknown
  sticker?: unknown
  animation?: unknown
}

export type TelegramCallbackQuery = {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export type InlineButton = { text: string; callback_data: string }

export type SendOptions = {
  threadId?: number
  /** Rows of buttons under the message. */
  buttons?: InlineButton[][]
}

export interface TelegramClient {
  getMe(): Promise<TelegramUser>
  /** Long polls for up to 50 s. Updates before `offset` are confirmed and not sent again. */
  getUpdates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]>
  sendMessage(chatId: number, text: string, options?: SendOptions): Promise<TelegramMessage>
  /** Takes the buttons off a message. */
  removeButtons(chatId: number, messageId: number): Promise<void>
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>
  /** The new topic's thread id. */
  createForumTopic(chatId: number, name: string): Promise<number>
  /** A file's bytes by its file_id, such as a voice note's. */
  downloadFile(fileId: string): Promise<Buffer>
  /** An Ogg Opus file, which Telegram shows as a voice memo. */
  sendVoice(chatId: number, ogg: Buffer, options?: { threadId?: number }): Promise<TelegramMessage>
}

export class TelegramError extends Error {
  /** Telegram's error_code, or 0 when Telegram could not be reached. */
  readonly code: number

  constructor(code: number, description: string) {
    super(description)
    this.name = 'TelegramError'
    this.code = code
  }
}

/** A bot token as BotFather hands it out. Anything else could change the URL it is put in. */
export const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/

const API = 'https://api.telegram.org'
const POLL_SECONDS = 50

export function telegramClient(token: string): TelegramClient {
  if (!TOKEN_PATTERN.test(token)) throw new TelegramError(0, 'This is not a Telegram bot token.')
  const hide = (text: string): string => text.split(token).join('<token>')

  async function request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init)
    } catch (error) {
      if (init.signal?.aborted && (init.signal.reason as Error | undefined)?.name !== 'TimeoutError') throw error
      const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)
      throw new TelegramError(0, `Could not reach Telegram: ${hide(reason)}`)
    }
  }

  async function call<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
    // A form sets its own multipart content type.
    const form = body instanceof FormData
    const response = await request(`${API}/bot${token}/${method}`, {
      method: 'POST',
      ...(form ? {} : { headers: { 'content-type': 'application/json' } }),
      body: form ? body : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30_000)
    })
    const data = (await response.json().catch(() => null)) as
      | { ok: boolean; result?: T; description?: string; error_code?: number }
      | null
    if (!data?.ok) {
      const code = data?.error_code ?? response.status
      throw new TelegramError(code, hide(data?.description ?? `Telegram answered ${response.status}`))
    }
    return data.result as T
  }

  return {
    getMe: () => call<TelegramUser>('getMe', {}),
    getUpdates: (offset, signal) =>
      call<TelegramUpdate[]>(
        'getUpdates',
        { offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] },
        // A poll that outlives its timeout, as after the Mac slept, is given up on and started again.
        AbortSignal.any([signal, AbortSignal.timeout((POLL_SECONDS + 15) * 1000)])
      ),
    sendMessage: (chatId, text, options = {}) =>
      call<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text,
        ...(options.threadId ? { message_thread_id: options.threadId } : {}),
        ...(options.buttons ? { reply_markup: { inline_keyboard: options.buttons } } : {})
      }),
    removeButtons: async (chatId, messageId) => {
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
    },
    answerCallbackQuery: async (callbackQueryId, text) => {
      await call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) })
    },
    createForumTopic: async (chatId, name) =>
      (await call<{ message_thread_id: number }>('createForumTopic', { chat_id: chatId, name: name.slice(0, 128) }))
        .message_thread_id,
    downloadFile: async (fileId) => {
      const file = await call<{ file_path?: string }>('getFile', { file_id: fileId })
      if (!file.file_path) throw new TelegramError(0, 'Telegram has no file for this message.')
      const response = await request(`${API}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new TelegramError(response.status, `Could not download the file: ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    },
    sendVoice: (chatId, ogg, options = {}) => {
      const form = new FormData()
      form.set('chat_id', String(chatId))
      if (options.threadId) form.set('message_thread_id', String(options.threadId))
      form.set('voice', new Blob([new Uint8Array(ogg)], { type: 'audio/ogg' }), 'reply.ogg')
      return call<TelegramMessage>('sendVoice', form, AbortSignal.timeout(60_000))
    }
  }
}
