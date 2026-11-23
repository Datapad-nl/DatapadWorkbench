import { afterEach, describe, expect, it, vi } from 'vitest'
import { telegramClient } from './telegram'

const TOKEN = '123456:AAHabcdefghijklmnopqrstuvwxyz'

afterEach(() => vi.unstubAllGlobals())

describe('sendVoice', () => {
  it('uploads the memo as a multipart form, in the topic', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true, result: { message_id: 7 } }))
    vi.stubGlobal('fetch', fetch)
    const sent = await telegramClient(TOKEN).sendVoice(-100, Buffer.from('OggS voice'), { threadId: 12 })
    expect(sent.message_id).toBe(7)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendVoice`)
    // fetch sets the multipart boundary itself.
    expect(init.headers).toBeUndefined()
    const form = init.body as FormData
    expect(form.get('chat_id')).toBe('-100')
    expect(form.get('message_thread_id')).toBe('12')
    const voice = form.get('voice') as File
    expect(voice.type).toBe('audio/ogg')
    expect(voice.name).toBe('reply.ogg')
    expect(Buffer.from(await voice.arrayBuffer()).toString()).toBe('OggS voice')
  })

  it('leaves out the topic in a direct message', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true, result: { message_id: 1 } }))
    vi.stubGlobal('fetch', fetch)
    await telegramClient(TOKEN).sendVoice(42, Buffer.from('x'))
    expect((fetch.mock.calls[0][1].body as FormData).has('message_thread_id')).toBe(false)
  })

  it('keeps the token out of its errors', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendVoice`)
    })
    const error = (await telegramClient(TOKEN)
      .sendVoice(42, Buffer.from('x'))
      .catch((caught: Error) => caught)) as Error
    expect(error.message).toContain('Could not reach Telegram')
    expect(error.message).not.toContain(TOKEN)

    vi.stubGlobal('fetch', async () => Response.json({ ok: false, error_code: 400, description: `bad ${TOKEN}` }))
    const refused = (await telegramClient(TOKEN)
      .sendVoice(42, Buffer.from('x'))
      .catch((caught: Error) => caught)) as Error
    expect(refused.message).toBe('bad <token>')
  })
})
