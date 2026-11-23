import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot, Chat, UserQuestion } from '../shared/types'
import type { TelegramClient, TelegramMessage, TelegramUpdate } from './telegram'

const TOKEN = '123456:AAHabcdefghijklmnopqrstuvwxyz'
const ME = 42
const STRANGER = 99
const GROUP = -100

const stub = vi.hoisted(() => ({
  dir: '',
  chats: new Map<string, Chat>(),
  bots: new Map<string, Bot>(),
  running: new Set<string>(),
  /** What every turn answers, or throws. */
  answer: async (_chatId: string, _content: string): Promise<string> => 'Done.',
  turns: [] as Array<{ chatId: string; content: string }>,
  netFetch: vi.fn<(...args: unknown[]) => Promise<Response>>(),
  chatCount: 0,
  /** What the fake voice helper page answers to a job. */
  helperPage: (job: { id: number; kind: string }): Record<string, unknown> => ({ id: job.id, error: 'no page' })
}))

vi.mock('electron', () => ({
  app: { getPath: () => stub.dir },
  net: { fetch: (...args: unknown[]) => stub.netFetch(...args) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString('hex')}`),
    decryptString: (sealed: Buffer) => Buffer.from(sealed.toString().replace(/^sealed:/, ''), 'hex').toString()
  },
  // The voice helper's page: it answers each job as stub.helperPage says.
  WebContentsView: class {
    webContents: Record<string, unknown>
    constructor() {
      const listeners: Array<(event: unknown, result: unknown) => void> = []
      const contents: Record<string, unknown> = {
        ipc: { on: (_channel: string, listener: (event: unknown, result: unknown) => void) => listeners.push(listener) },
        on: () => {},
        setWindowOpenHandler: () => {},
        loadFile: async () => {},
        send: (_channel: string, job: { id: number; kind: string }) =>
          setTimeout(() => listeners.forEach((listener) => listener({ sender: contents }, stub.helperPage(job)))),
        isDestroyed: () => false,
        close: () => {}
      }
      this.webContents = contents
    }
  }
}))
vi.mock('./appUrl', () => ({ devServerUrl: () => null }))
vi.mock('./voice', () => ({ ensureVoiceModel: async () => ({ state: 'ready', error: null }) }))
vi.mock('./git', () => ({ addChatWorktree: vi.fn(), dropWorktreeIfUnchanged: vi.fn() }))
vi.mock('./bots', () => {
  const getBot = async (botId: string): Promise<Bot> => {
    const bot = stub.bots.get(botId)
    if (!bot) throw new Error('Bot not found')
    return { ...bot }
  }
  return {
    HEARTBEAT_FILE: 'HEARTBEAT.md',
    PROBLEMS_FILE: 'PROBLEMS.md',
    STATUS_FILE: 'STATUS.md',
    botMemoryFolder: (botId: string) => `/bots/${botId}/memory`,
    addBotProblem: async () => {},
    readBotMemoryFile: async () => '',
    getBot,
    ensureChiefBot: async () => ({ bot: await getBot('scout'), created: false }),
    listBots: async () => [...stub.bots.values()].map((bot) => ({ ...bot })),
    setBotChat: async (botId: string, chatId: string) => {
      stub.bots.get(botId)!.chatId = chatId
      return getBot(botId)
    },
    addBotUnread: getBot,
    clearBotUnread: getBot
  }
})
vi.mock('./store', () => ({
  createChat: async (projectId: string, input: { title?: string; botId?: string } = {}) => {
    const chat = {
      id: `chat-${++stub.chatCount}`,
      projectId,
      title: input.title ?? 'New chat',
      messages: [],
      ...(input.botId ? { botId: input.botId } : {})
    } as unknown as Chat
    stub.chats.set(chat.id, chat)
    return structuredClone(chat)
  },
  getDefaultAgent: async () => 'grok',
  getChat: async (chatId: string) => {
    const chat = stub.chats.get(chatId)
    if (!chat) throw new Error('Chat not found')
    return structuredClone(chat)
  },
  getMaxSubagents: async () => 4,
  getSubagentModel: async () => '',
  listProjects: async () => [{ id: 'site', name: 'Site', path: '/site' }],
  listChats: async () => [...stub.chats.values()],
  mutateChat: async (chatId: string, change: (chat: Chat) => void) => {
    const chat = stub.chats.get(chatId)!
    change(chat)
    return structuredClone(chat)
  },
  saveHandoff: async () => ''
}))

type Sent = { chat: number; text: string; thread?: number; buttons?: Array<Array<{ text: string; callback_data: string }>> }

/** A Telegram that hands out the updates a test pushes and keeps what was sent to it. */
function fakeTelegram() {
  const queue: TelegramUpdate[][] = []
  const waiters: Array<() => void> = []
  const offsets: number[] = []
  const sent: Sent[] = []
  const removed: Array<[number, number]> = []
  const answered: Array<[string, string | undefined]> = []
  const topics: Array<[number, string]> = []
  const voices: Array<{ chat: number; ogg: Buffer; thread?: number }> = []
  let nextMessage = 1
  let nextThread = 100
  let nextUpdate = 1
  const fake = {
    sent,
    removed,
    answered,
    topics,
    voices,
    offsets,
    topicsRefused: false,
    client: {
      getMe: async () => ({ id: 1, is_bot: true, username: 'wb_bot' }),
      getUpdates: async (offset: number, signal: AbortSignal) => {
        offsets.push(offset)
        while (queue.length === 0) {
          if (signal.aborted) return []
          await new Promise<void>((resolve) => {
            waiters.push(resolve)
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        return queue.shift()!
      },
      sendMessage: async (chat: number, text: string, options: { threadId?: number; buttons?: Sent['buttons'] } = {}) => {
        sent.push({ chat, text, ...(options.threadId ? { thread: options.threadId } : {}), ...(options.buttons ? { buttons: options.buttons } : {}) })
        return { message_id: nextMessage++, chat: { id: chat, type: 'private' }, date: 0 } as TelegramMessage
      },
      removeButtons: async (chat: number, messageId: number) => {
        removed.push([chat, messageId])
      },
      answerCallbackQuery: async (id: string, text?: string) => {
        answered.push([id, text])
      },
      createForumTopic: async (chat: number, name: string) => {
        if (fake.topicsRefused) {
          const { TelegramError } = await import('./telegram')
          throw new TelegramError(400, 'Bad Request: the chat is not a forum')
        }
        topics.push([chat, name])
        return nextThread++
      },
      downloadFile: async () => Buffer.from('voice bytes'),
      sendVoice: async (chat: number, ogg: Buffer, options: { threadId?: number } = {}) => {
        voices.push({ chat, ogg, ...(options.threadId ? { thread: options.threadId } : {}) })
        return { message_id: nextMessage++, chat: { id: chat, type: 'private' }, date: 0 } as TelegramMessage
      }
    } satisfies TelegramClient,
    /** Pushes updates; resolves with the last update's id. */
    push(...updates: Array<Omit<TelegramUpdate, 'update_id'>>): number {
      const batch = updates.map((update) => ({ ...update, update_id: nextUpdate++ }))
      queue.push(batch)
      for (const wake of waiters.splice(0)) wake()
      return batch[batch.length - 1].update_id
    },
    /** Waits until an update was handled: the loop then asks for the ones after it. */
    async handled(updateId: number): Promise<void> {
      await vi.waitFor(() => expect(offsets.some((offset) => offset > updateId)).toBe(true))
    },
    /** Forgets what was sent, so the next message is number 1 again. */
    clear(): void {
      sent.length = 0
      nextMessage = 1
    },
    texts(): string[] {
      return sent.map((item) => item.text)
    }
  }
  return fake
}

let messageId = 1000
function dm(text: string, from = ME, extra: Partial<TelegramMessage> = {}): Omit<TelegramUpdate, 'update_id'> {
  return {
    message: { message_id: messageId++, from: { id: from }, chat: { id: from, type: 'private' }, date: 0, text, ...extra }
  }
}
function inGroup(text: string, thread?: number, from = ME): Omit<TelegramUpdate, 'update_id'> {
  return {
    message: {
      message_id: messageId++,
      from: { id: from },
      chat: { id: GROUP, type: 'supergroup', title: 'Team', is_forum: true },
      date: 0,
      text,
      ...(thread ? { message_thread_id: thread, is_topic_message: true } : {})
    }
  }
}
function tap(data: string, from = ME, chat = ME): Omit<TelegramUpdate, 'update_id'> {
  return {
    callback_query: {
      id: `cb-${messageId++}`,
      from: { id: from },
      message: { message_id: 1, chat: { id: chat, type: chat === GROUP ? 'supergroup' : 'private' }, date: 0 },
      data
    }
  }
}

let fake: ReturnType<typeof fakeTelegram>
let channels: typeof import('./channels')
let tools: typeof import('./chatTools')
let questions: typeof import('./questions')
let permissions: typeof import('./permissions')

/** Fresh modules with a saved token and a running poll loop. */
async function start(
  options: Pick<Parameters<typeof import('./channels').registerChannels>[0], 'transcribe' | 'prepareTranscribe' | 'speak'> = {}
) {
  vi.resetModules()
  channels = await import('./channels')
  tools = await import('./chatTools')
  questions = await import('./questions')
  permissions = await import('./permissions')
  const { replySteps } = await import('../shared/steps')
  tools.registerChatTools({
    emit: () => {},
    isStreaming: (chatId) => stub.running.has(chatId),
    // As ipc.ts does: the bot's answer in its own chat goes through botMessage, which calls notifyBot.
    notifyBot: (bot, _chatId, text) => void channels.telegramBotMessage(bot, text),
    send: async (chatId, content) => {
      stub.turns.push({ chatId, content })
      const done = (async () => {
        const text = await stub.answer(chatId, content)
        const chat = stub.chats.get(chatId)!
        chat.messages.push({ id: `m${messageId++}`, role: 'assistant', content: text } as Chat['messages'][number])
        if (tools.isBotsOwn(chat)) await tools.botMessage(chat.botId, chatId, replySteps(text).at(-1) ?? '')
        return structuredClone(chat)
      })()
      return { chat: structuredClone(stub.chats.get(chatId)!), done }
    }
  })
  channels.registerChannels({ client: () => fake.client, ...options })
  await channels.setTelegramToken(TOKEN)
}

async function pairInDm(): Promise<void> {
  const { pairing } = await channels.startPairing()
  await fake.handled(fake.push(dm(`/pair ${pairing!.code}`)))
  expect((await channels.getTelegramStatus()).paired).toBe(true)
  fake.clear()
}

async function pairInGroup(): Promise<void> {
  const { pairing } = await channels.startPairing()
  await fake.handled(fake.push(inGroup(`/pair ${pairing!.code}`)))
  await vi.waitFor(() => expect(fake.topics).toHaveLength(2))
  fake.clear()
}

function bot(id: string, name: string, extra: Partial<Bot> = {}): Bot {
  return { id, name, agent: 'grok', model: '', folder: `/bots/${id}`, chatId: null, unread: 0, ...extra } as Bot
}

beforeEach(async () => {
  stub.dir = await mkdtemp(join(tmpdir(), 'channels-'))
  stub.chats.clear()
  stub.bots.clear()
  stub.bots.set('scout', bot('scout', 'Scout', { chief: true }))
  stub.bots.set('lint', bot('lint', 'Lint'))
  stub.running.clear()
  stub.turns.length = 0
  stub.answer = async () => 'Done.'
  fake = fakeTelegram()
})

afterEach(async () => {
  channels?.stopChannels()
  vi.restoreAllMocks()
  await rm(stub.dir, { recursive: true, force: true })
})

describe('pairing', () => {
  it('pairs the user who sends the right code', async () => {
    await start()
    const { pairing } = await channels.startPairing()
    expect(pairing!.code).toMatch(/^\d{6}$/)
    await fake.handled(fake.push(dm(`/pair ${pairing!.code}`)))
    const status = await channels.getTelegramStatus()
    expect(status).toMatchObject({ paired: true, group: null, pairing: null, state: 'connected' })
    expect(fake.sent[0]).toMatchObject({ chat: ME })
    expect(fake.sent[0].text).toMatch(/^Paired/)
  })

  it('does not pair with a wrong code', async () => {
    await start()
    await channels.startPairing()
    await fake.handled(fake.push(dm('/pair 000000x')))
    expect((await channels.getTelegramStatus()).paired).toBe(false)
    expect(fake.texts()).toEqual(['That code is not right.'])
  })

  it('drops a code once it expired', async () => {
    await start()
    const { pairing } = await channels.startPairing()
    const later = Date.now() + 11 * 60_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    await fake.handled(fake.push(dm(`/pair ${pairing!.code}`)))
    expect((await channels.getTelegramStatus()).paired).toBe(false)
    expect(fake.sent).toEqual([])
  })

  it('voids the code after 5 wrong tries', async () => {
    await start()
    const { pairing } = await channels.startPairing()
    const wrong = pairing!.code === '111111' ? '222222' : '111111'
    for (let i = 0; i < 5; i++) await fake.handled(fake.push(dm(`/pair ${wrong}`)))
    expect((await channels.getTelegramStatus()).pairing).toBeNull()
    await fake.handled(fake.push(dm(`/pair ${pairing!.code}`)))
    expect((await channels.getTelegramStatus()).paired).toBe(false)
    expect(fake.texts()).toHaveLength(5)
  })

  it('pairs a group and makes a topic for each reachable bot', async () => {
    await start()
    const { pairing } = await channels.startPairing()
    await fake.handled(fake.push(inGroup(`/pair ${pairing!.code}`)))
    await vi.waitFor(() =>
      expect(fake.topics).toEqual([
        [GROUP, 'Scout'],
        [GROUP, 'Lint']
      ])
    )
    expect(await channels.getTelegramStatus()).toMatchObject({ paired: true, group: 'Team' })
  })

  it('says what to switch on when the group has no topics', async () => {
    await start()
    fake.topicsRefused = true
    const { pairing } = await channels.startPairing()
    await fake.handled(fake.push(inGroup(`/pair ${pairing!.code}`)))
    await vi.waitFor(() => expect(fake.texts().some((text) => text.startsWith('To give each bot'))).toBe(true))
  })

  it('unpairs and keeps the token', async () => {
    await start()
    await pairInDm()
    const status = await channels.unpairTelegram()
    expect(status).toMatchObject({ paired: false, hasToken: true })
  })
})

describe('strangers', () => {
  it('drops a stranger’s message before pairing', async () => {
    await start()
    await channels.startPairing()
    await fake.handled(fake.push(dm('hello', STRANGER), dm('/help', STRANGER)))
    expect(fake.sent).toEqual([])
    expect(stub.turns).toEqual([])
  })

  it('drops a stranger’s message and pairing attempt after pairing', async () => {
    await start()
    await pairInDm()
    const { pairing } = await channels.startPairing()
    await fake.handled(fake.push(dm('hello', STRANGER), dm(`/pair ${pairing!.code}`, STRANGER)))
    expect(fake.sent).toEqual([])
    expect(stub.turns).toEqual([])
  })

  it('drops the paired user’s message from another group', async () => {
    await start()
    await pairInDm()
    const other = inGroup('hello')
    other.message!.chat.id = -555
    await fake.handled(fake.push(other))
    expect(fake.sent).toEqual([])
    expect(stub.turns).toEqual([])
  })

  it('drops a stranger’s tap on a button', async () => {
    await start()
    await pairInDm()
    const chat = await tools.botChat('scout')
    permissions.bindPermissionSession('s1', chat.id, 'default' as never)
    void permissions.askPermission('r1', 's1', { toolCall: { title: 'Run rm -rf build' } })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    const data = fake.sent[0].buttons![0][0].callback_data
    await fake.handled(fake.push(tap(data, STRANGER, STRANGER)))
    expect(permissions.pendingPermissionRequests()).toHaveLength(1)
    expect(fake.answered).toEqual([])
  })
})

describe('routing', () => {
  it('sends a direct message to the chief and its answer back once', async () => {
    await start()
    await pairInDm()
    stub.answer = async () => 'Looked into it.<!--step-->All good.'
    await fake.handled(fake.push(dm('how is the build?')))
    const scoutChat = stub.bots.get('scout')!.chatId
    expect(stub.turns).toEqual([{ chatId: scoutChat, content: 'how is the build?' }])
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    // Give a duplicate the chance to arrive.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fake.sent).toEqual([{ chat: ME, text: 'Scout: All good.' }])
  })

  it('sends @Name to that bot without the mention', async () => {
    await start()
    await pairInDm()
    await fake.handled(fake.push(dm('@Lint check the tests')))
    expect(stub.turns).toEqual([{ chatId: stub.bots.get('lint')!.chatId, content: 'check the tests' }])
    await vi.waitFor(() => expect(fake.texts()).toEqual(['Lint: Done.']))
  })

  it('lists the bots when there is no chief and no mention', async () => {
    stub.bots.get('scout')!.chief = false
    await start()
    await pairInDm()
    await fake.handled(fake.push(dm('hello')))
    expect(stub.turns).toEqual([])
    expect(fake.texts()).toEqual(['Start your message with the bot it is for: @Scout, @Lint.'])
  })

  it('does not reach a bot that was switched off', async () => {
    await start()
    await pairInDm()
    await channels.setTelegramReachable({ bots: ['scout'], projects: [] })
    await fake.handled(fake.push(dm('@Lint check')))
    // Not a mention of a reachable bot: it goes to the chief as it is.
    expect(stub.turns.map((turn) => turn.content)).toEqual(['@Lint check'])
    // A message of the hidden bot reaches nobody.
    await channels.telegramBotMessage(stub.bots.get('lint')!, 'hi')
    await vi.waitFor(() => expect(fake.texts()).toEqual(['Scout: Done.']))
  })

  it('sends a bot topic to that bot and answers in the topic', async () => {
    await start()
    await pairInGroup()
    const lintThread = 100 + fake.topics.findIndex(([, name]) => name === 'Lint')
    await fake.handled(fake.push(inGroup('run it', lintThread)))
    expect(stub.turns).toEqual([{ chatId: stub.bots.get('lint')!.chatId, content: 'run it' }])
    await vi.waitFor(() => expect(fake.sent).toEqual([{ chat: GROUP, thread: lintThread, text: 'Done.' }]))
  })

  it('sends the group’s General topic to the chief', async () => {
    await start()
    await pairInGroup()
    await fake.handled(fake.push(inGroup('status?')))
    expect(stub.turns[0].chatId).toBe(stub.bots.get('scout')!.chatId)
    const scoutThread = 100 + fake.topics.findIndex(([, name]) => name === 'Scout')
    await vi.waitFor(() => expect(fake.sent).toEqual([{ chat: GROUP, thread: scoutThread, text: 'Done.' }]))
  })

  it('makes a Telegram chat for a project topic, answers there, and /new starts another', async () => {
    await start()
    await pairInGroup()
    await channels.setTelegramReachable({ bots: ['scout', 'lint'], projects: ['site'] })
    await vi.waitFor(() => expect(fake.topics.map(([, name]) => name)).toContain('Site'))
    const thread = 102
    stub.answer = async () => 'Step one.<!--step-->The page is fixed.'
    await fake.handled(fake.push(inGroup('fix the header', thread)))
    const first = [...stub.chats.values()].find((chat) => chat.projectId === 'site')!
    expect(first.title).toBe('Telegram')
    expect(stub.turns).toEqual([{ chatId: first.id, content: 'fix the header' }])
    await vi.waitFor(() => expect(fake.sent).toEqual([{ chat: GROUP, thread, text: 'The page is fixed.' }]))

    await fake.handled(fake.push(inGroup('and the footer', thread)))
    expect(stub.turns[1].chatId).toBe(first.id)

    await fake.handled(fake.push(inGroup('/new', thread)))
    await fake.handled(fake.push(inGroup('start over', thread)))
    const chats = [...stub.chats.values()].filter((chat) => chat.projectId === 'site')
    expect(chats).toHaveLength(2)
    expect(stub.turns[2].chatId).toBe(chats[1].id)
  })

  it('tells a project topic when the turn failed', async () => {
    await start()
    await pairInGroup()
    await channels.setTelegramReachable({ bots: ['scout', 'lint'], projects: ['site'] })
    await vi.waitFor(() => expect(fake.topics).toHaveLength(3))
    stub.answer = async () => {
      throw new Error('The agent quit')
    }
    await fake.handled(fake.push(inGroup('fix it', 102)))
    await vi.waitFor(() => expect(fake.sent).toEqual([{ chat: GROUP, thread: 102, text: 'Stopped: The agent quit' }]))
  })

  it('says a busy chat is still working and does not queue', async () => {
    await start()
    await pairInDm()
    const chat = await tools.botChat('scout')
    stub.running.add(chat.id)
    await fake.handled(fake.push(dm('again')))
    expect(stub.turns).toEqual([])
    expect(fake.texts()).toEqual(['Scout is still working on the previous message. Send this again once it has answered.'])
  })

  it('says only text and voice notes work for a photo', async () => {
    await start()
    await pairInDm()
    await fake.handled(fake.push(dm('', ME, { text: undefined, photo: [{}] })))
    expect(fake.texts()).toEqual(['Only text and voice notes work here.'])
    expect(stub.turns).toEqual([])
  })

  it('passes an unknown command on as text', async () => {
    await start()
    await pairInDm()
    await fake.handled(fake.push(dm('/deploy now')))
    expect(stub.turns.map((turn) => turn.content)).toEqual(['/deploy now'])
  })
})

describe('voice', () => {
  it('says voice notes are not available without a transcriber', async () => {
    await start()
    await pairInDm()
    await fake.handled(fake.push(dm('', ME, { text: undefined, voice: { file_id: 'f1', mime_type: 'audio/ogg' } })))
    expect(fake.texts()).toEqual(['Voice notes are not available yet. Write your message instead.'])
    expect(stub.turns).toEqual([])
  })

  it('sends the transcript on and echoes it', async () => {
    const transcribe = vi.fn(async () => 'check the build')
    await start({ transcribe })
    await pairInDm()
    await fake.handled(fake.push(dm('', ME, { text: undefined, voice: { file_id: 'f1', mime_type: 'audio/ogg' } })))
    expect(transcribe).toHaveBeenCalledWith(Buffer.from('voice bytes'), 'audio/ogg')
    expect(fake.texts()[0]).toBe('Heard: check the build')
    expect(stub.turns.map((turn) => turn.content)).toEqual(['check the build'])
  })

  const note = (): Omit<TelegramUpdate, 'update_id'> =>
    dm('', ME, { text: undefined, voice: { file_id: 'f1', mime_type: 'audio/ogg' } })

  it('fetches the speech model with the first note, says so once, and transcribes after', async () => {
    let fetched = false
    const prepareTranscribe = vi.fn(async (fetching: (bytes: number) => Promise<void>) => {
      if (fetched) return
      await fetching(412_616_155)
      fetched = true
    })
    const transcribe = vi.fn(async () => 'check the build')
    await start({ prepareTranscribe, transcribe })
    await pairInDm()
    await fake.handled(fake.push(note()))
    expect(fake.texts().slice(0, 2)).toEqual([
      'Fetching the speech model for voice notes once (413 MB); this note is transcribed when it is in.',
      'Heard: check the build'
    ])
    fake.clear()
    await fake.handled(fake.push(note()))
    expect(fake.texts()[0]).toBe('Heard: check the build')
    expect(prepareTranscribe).toHaveBeenCalledTimes(2)
    expect(transcribe).toHaveBeenCalledTimes(2)
  })

  it('says a failed model download plainly and tries again with the next note', async () => {
    const prepareTranscribe = vi
      .fn<(fetching: (bytes: number) => Promise<void>) => Promise<void>>()
      .mockImplementationOnce(async (fetching) => {
        await fetching(412_616_155)
        throw new Error('Download of onnx/encoder_model_fp16.onnx stalled')
      })
      .mockImplementationOnce(async (fetching) => fetching(176_607_756))
    const transcribe = vi.fn(async () => 'check the build')
    await start({ prepareTranscribe, transcribe })
    await pairInDm()
    await fake.handled(fake.push(note()))
    expect(fake.texts()).toEqual([
      'Fetching the speech model for voice notes once (413 MB); this note is transcribed when it is in.',
      'Could not fetch the speech model for voice notes: Download of onnx/encoder_model_fp16.onnx stalled. Send the voice note again to try once more.'
    ])
    expect(transcribe).not.toHaveBeenCalled()
    expect(stub.turns).toEqual([])
    fake.clear()
    await fake.handled(fake.push(note()))
    expect(fake.texts().slice(0, 2)).toEqual([
      'Fetching the speech model for voice notes once (177 MB); this note is transcribed when it is in.',
      'Heard: check the build'
    ])
    expect(stub.turns.map((turn) => turn.content)).toEqual(['check the build'])
  })
})

describe('voice helper end to end', () => {
  it('hears a voice note and speaks the reply through the helper page', async () => {
    const helper = await import('./voiceHelper')
    const { DEFAULT_VOICE } = await import('../shared/types')
    const jobs: Array<{ kind: string; audio?: Uint8Array; text?: string }> = []
    stub.helperPage = (job) => {
      jobs.push(job)
      return job.kind === 'transcribe' ? { id: job.id, text: ' Kun je de build checken? ' } : { id: job.id, ogg: new Uint8Array([0x4f, 0x67, 0x67, 0x53]) }
    }
    stub.answer = async () => 'De build is gelukt.'
    await start({ transcribe: helper.transcribeVoiceNote, speak: (text) => helper.speakVoiceMemo(text, DEFAULT_VOICE) })
    await pairInDm()
    await fake.handled(fake.push(dm('/voice on')))
    fake.clear()
    await fake.handled(fake.push(dm('', ME, { text: undefined, voice: { file_id: 'f1', mime_type: 'audio/ogg' } })))
    expect(Buffer.from(jobs[0].audio!).toString()).toBe('voice bytes')
    expect(stub.turns.map((turn) => turn.content)).toEqual(['Kun je de build checken?'])
    await vi.waitFor(() => expect(fake.voices).toEqual([{ chat: ME, ogg: Buffer.from('OggS') }]))
    expect(fake.texts()).toEqual(['Heard: Kun je de build checken?', 'Scout: De build is gelukt.'])
    expect(jobs[1]).toMatchObject({ kind: 'speak', text: 'De build is gelukt.' })
  })
})

describe('spoken replies', () => {
  const speak = vi.fn(async (text: string) => Buffer.from(`ogg:${text}`))
  beforeEach(() => speak.mockClear())

  it('turns on and off with /voice, shows the state, and keeps it in channels.json', async () => {
    await start({ speak })
    await pairInDm()
    await fake.handled(fake.push(dm('/voice')))
    await fake.handled(fake.push(dm('/voice on')))
    await fake.handled(fake.push(dm('/voice')))
    const file = JSON.parse(await readFile(join(stub.dir, 'workbench', 'channels.json'), 'utf8'))
    expect(file.telegram.voiceReplies).toBe(true)
    await fake.handled(fake.push(dm('/voice off')))
    await fake.handled(fake.push(dm('/voice loud')))
    expect(fake.texts()).toEqual([
      'Spoken replies are off. /voice on turns them on.',
      'Spoken replies are on: each reply also comes as a voice memo.',
      'Spoken replies are on: each reply also comes as a voice memo.',
      'Spoken replies are off. /voice on turns them on.',
      'Write /voice on, /voice off, or /voice to see which it is.'
    ])
    expect(stub.turns).toEqual([])
    // A restart reads it back.
    await start({ speak })
    await fake.handled(fake.push(dm('/voice')))
    expect(fake.texts().at(-1)).toBe('Spoken replies are off. /voice on turns them on.')
  })

  it('lists /voice in /help', async () => {
    await start({ speak })
    await pairInDm()
    await fake.handled(fake.push(dm('/help')))
    expect(fake.texts()[0]).toContain('/voice on also sends each reply as a voice memo, /voice off stops that. Now off.')
  })

  it('sends a voice memo after a bot reply when on, and none when off', async () => {
    await start({ speak })
    await pairInDm()
    await channels.telegramBotMessage(stub.bots.get('scout')!, 'The build passed.')
    expect(fake.voices).toEqual([])
    expect(speak).not.toHaveBeenCalled()

    await fake.handled(fake.push(dm('/voice on')))
    fake.clear()
    await channels.telegramBotMessage(stub.bots.get('scout')!, 'The build passed.')
    expect(fake.texts()).toEqual(['Scout: The build passed.'])
    await vi.waitFor(() => expect(fake.voices).toEqual([{ chat: ME, ogg: Buffer.from('ogg:The build passed.') }]))
  })

  it('speaks a project topic’s reply in its topic, but not a failed turn', async () => {
    await start({ speak })
    await pairInGroup()
    await channels.setTelegramReachable({ bots: ['scout', 'lint'], projects: ['site'] })
    await vi.waitFor(() => expect(fake.topics).toHaveLength(3))
    await fake.handled(fake.push(inGroup('/voice on', 102)))
    fake.clear()
    stub.answer = async () => 'The page is fixed.'
    await fake.handled(fake.push(inGroup('fix the header', 102)))
    await vi.waitFor(() => expect(fake.voices).toEqual([{ chat: GROUP, thread: 102, ogg: Buffer.from('ogg:The page is fixed.') }]))

    stub.answer = async () => {
      throw new Error('The agent quit')
    }
    await fake.handled(fake.push(inGroup('fix it', 102)))
    await vi.waitFor(() => expect(fake.texts()).toContain('Stopped: The agent quit'))
    expect(fake.voices).toHaveLength(1)
  })

  it('does not speak questions, approvals or errors', async () => {
    await start({ speak })
    await pairInDm()
    await fake.handled(fake.push(dm('/voice on')))
    fake.clear()
    const chatId = (await tools.botChat('scout')).id
    void questions.askUserQuestions('q1', '', [
      { question: 'Which branch?', header: null, multiSelect: false, options: [{ label: 'main', description: null, preview: null }] }
    ], 'ext', { chatId })
    permissions.bindPermissionSession('s1', chatId, 'default' as never)
    void permissions.askPermission('r1', 's1', {
      toolCall: { title: 'Run npm publish' },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }]
    } as never)
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2))
    await fake.handled(fake.push(dm('', ME, { text: undefined, photo: [] })))
    expect(fake.texts()).toContain('Only text and voice notes work here.')
    expect(speak).not.toHaveBeenCalled()
    expect(fake.voices).toEqual([])
  })

  it('still delivers the text when speaking fails, and shows why', async () => {
    speak.mockRejectedValueOnce(new Error('This system has no Opus encoder'))
    await start({ speak })
    await pairInDm()
    await fake.handled(fake.push(dm('/voice on')))
    fake.clear()
    await channels.telegramBotMessage(stub.bots.get('scout')!, 'The build passed.')
    expect(fake.texts()).toEqual(['Scout: The build passed.'])
    await vi.waitFor(async () =>
      expect((await channels.getTelegramStatus()).error).toBe('Could not speak the reply: This system has no Opus encoder')
    )
    expect(fake.voices).toEqual([])
  })

  it('shows a voice memo Telegram refused in the status', async () => {
    await start({ speak })
    await pairInDm()
    await fake.handled(fake.push(dm('/voice on')))
    const { TelegramError } = await import('./telegram')
    fake.client.sendVoice = async () => {
      throw new TelegramError(400, 'Bad Request: wrong file type')
    }
    await channels.telegramBotMessage(stub.bots.get('scout')!, 'The build passed.')
    await vi.waitFor(async () =>
      expect((await channels.getTelegramStatus()).error).toBe('Could not send a voice memo to Telegram: Bad Request: wrong file type')
    )
  })
})

describe('sending', () => {
  it('splits at 4096 characters, on a line break where it can', () => {
    return import('./channels').then(({ splitMessage }) => {
      const line = 'a'.repeat(3000)
      expect(splitMessage(`${line}\n${line}`)).toEqual([line, line])
      const long = 'b'.repeat(5000)
      const parts = splitMessage(long)
      expect(parts.map((part) => part.length)).toEqual([4096, 904])
      expect(splitMessage('short')).toEqual(['short'])
    })
  })

  it('sends a long bot message in parts', async () => {
    await start()
    await pairInDm()
    await channels.telegramBotMessage(stub.bots.get('scout')!, 'x'.repeat(5000))
    expect(fake.sent.map((item) => item.text.length)).toEqual([4096, 'Scout: '.length + 5000 - 4096])
  })

  it('does not throw when a send fails and shows the error', async () => {
    await start()
    await pairInDm()
    const { TelegramError } = await import('./telegram')
    fake.client.sendMessage = async () => {
      throw new TelegramError(403, 'Forbidden: bot was blocked by the user')
    }
    await expect(channels.telegramBotMessage(stub.bots.get('scout')!, 'hi')).resolves.toBeUndefined()
    expect((await channels.getTelegramStatus()).error).toBe('Could not send to Telegram: Forbidden: bot was blocked by the user')
  })

  it('keeps the offset in channels.json', async () => {
    await start()
    await pairInDm()
    const last = fake.push(dm('one'), dm('two'))
    await fake.handled(last)
    const file = JSON.parse(await readFile(join(stub.dir, 'workbench', 'channels.json'), 'utf8'))
    expect(file.telegram.offset).toBe(last + 1)
    expect(JSON.stringify(file)).not.toContain(TOKEN)
  })
})

describe('approvals and questions', () => {
  async function scoutChat(): Promise<string> {
    return (await tools.botChat('scout')).id
  }

  it('asks for approval with buttons and passes the tap on', async () => {
    await start()
    await pairInDm()
    const chatId = await scoutChat()
    permissions.bindPermissionSession('s1', chatId, 'default' as never)
    const outcome = permissions.askPermission('r1', 's1', {
      toolCall: { title: 'Run npm publish' },
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Deny', kind: 'reject_once' }
      ]
    } as never)
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    expect(fake.sent[0].text).toMatch(/^Scout: Needs approval: /)
    const [allow, deny] = fake.sent[0].buttons![0]
    expect([allow.text, deny.text]).toEqual(['Allow', 'Deny'])
    expect(Buffer.byteLength(allow.callback_data)).toBeLessThanOrEqual(64)
    await fake.handled(fake.push(tap(allow.callback_data)))
    expect(await outcome).toMatchObject({ outcome: { outcome: 'selected', optionId: 'yes' } })
    await vi.waitFor(() => expect(fake.removed).toEqual([[ME, 1]]))
    expect(fake.answered[0][1]).toBe('Allowed')

    await fake.handled(fake.push(tap(allow.callback_data)))
    expect(fake.answered[1][1]).toBe('No longer open')
  })

  const pick: UserQuestion = {
    question: 'Which branch?',
    header: null,
    multiSelect: false,
    options: [
      { label: 'main', description: null, preview: null },
      { label: 'dev', description: null, preview: null }
    ]
  }
  const many: UserQuestion = {
    question: 'Which checks?',
    header: null,
    multiSelect: true,
    options: [
      { label: 'Lint', description: null, preview: null },
      { label: 'Tests', description: null, preview: null },
      { label: 'Types', description: null, preview: null }
    ]
  }

  it('answers a question with a button', async () => {
    await start()
    await pairInDm()
    const outcome = questions.askUserQuestions('q1', '', [pick], 'ext', { chatId: await scoutChat() })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    const rows = fake.sent[0].buttons!
    expect(rows.map((row) => row.map((button) => button.text))).toEqual([['main'], ['dev'], ['Skip']])
    await fake.handled(fake.push(tap(rows[1][0].callback_data)))
    expect(await outcome).toEqual({ type: 'Accepted', partial_answers: ['dev'] })
  })

  it('answers a question with a typed reply and does not send it to the bot', async () => {
    await start()
    await pairInDm()
    const outcome = questions.askUserQuestions('q1', '', [pick], 'ext', { chatId: await scoutChat() })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    await fake.handled(fake.push(dm('MAIN')))
    expect(await outcome).toEqual({ type: 'Accepted', partial_answers: ['main'] })
    expect(stub.turns).toEqual([])
  })

  it('asks several questions one at a time, a multi-select with commas', async () => {
    await start()
    await pairInDm()
    const outcome = questions.askUserQuestions('q1', '', [pick, many], 'ext', { chatId: await scoutChat() })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    expect(fake.sent[0].text).toContain('(1 of 2)')
    await fake.handled(fake.push(tap(fake.sent[0].buttons![0][0].callback_data)))
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2))
    expect(fake.sent[1].text).toContain('(2 of 2)')
    expect(fake.sent[1].text).toContain('separated by commas')
    expect(fake.removed).toContainEqual([ME, 1])
    // A tap on the first question's buttons is stale now.
    await fake.handled(fake.push(tap(fake.sent[0].buttons![1][0].callback_data)))
    expect(fake.answered.at(-1)![1]).toBe('No longer open')
    await fake.handled(fake.push(dm('tests, lint, something else')))
    expect(await outcome).toEqual({ type: 'Accepted', partial_answers: ['main', ['Tests', 'Lint', 'something else']] })
  })

  it('skips the whole request', async () => {
    await start()
    await pairInDm()
    const outcome = questions.askUserQuestions('q1', '', [pick, many], 'ext', { chatId: await scoutChat() })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    const skip = fake.sent[0].buttons!.at(-1)![0]
    expect(skip.text).toBe('Skip')
    await fake.handled(fake.push(tap(skip.callback_data)))
    const { skipOutcome } = questions
    expect(await outcome).toEqual(skipOutcome())
  })

  it('takes the buttons off when the question is answered in the app', async () => {
    await start()
    await pairInDm()
    void questions.askUserQuestions('q1', '', [pick], 'ext', { chatId: await scoutChat() })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    questions.resolveUserQuestion('q1', { type: 'submit', answers: [['main']] })
    await vi.waitFor(() => expect(fake.removed).toEqual([[ME, 1]]))
    // A typed reply now goes to the bot again.
    await fake.handled(fake.push(dm('thanks')))
    expect(stub.turns.map((turn) => turn.content)).toEqual(['thanks'])
  })

  it('never takes a secret from Telegram', async () => {
    await start()
    await pairInDm()
    const secret: UserQuestion = { question: 'The API key', header: null, multiSelect: false, options: [], secret: { name: 'API_KEY' } }
    void questions.askUserQuestions('q1', '', [secret], 'ext', { chatId: await scoutChat(), title: 'A secret for Scout' })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1))
    expect(fake.sent[0]).toEqual({ chat: ME, text: 'Scout needs a secret. Enter it in the app.' })
    stub.running.add(stub.bots.get('scout')!.chatId!)
    await fake.handled(fake.push(dm('sk-live-123')))
    expect(questions.pendingQuestionRequests()).toHaveLength(1)
    expect(stub.turns).toEqual([])
  })

  it('does not show a request of a project chat outside a Telegram topic', async () => {
    await start()
    await pairInDm()
    stub.chats.set('desk', { id: 'desk', projectId: 'site', title: 'Desk', messages: [] } as unknown as Chat)
    void questions.askUserQuestions('q1', '', [pick], 'ext', { chatId: 'desk' })
    await fake.handled(fake.push(dm('/help')))
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0].buttons).toBeUndefined()
  })
})

describe('token', () => {
  it('keeps the token out of errors from Telegram', async () => {
    const { telegramClient } = await import('./telegram')
    const fetchMock = stub.netFetch
    fetchMock.mockImplementation(async (): Promise<Response> => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getMe`)
    })
    {
      const error = (await telegramClient(TOKEN).getMe().catch((caught: Error) => caught)) as Error
      expect(error.message).toMatch(/^Could not reach Telegram/)
      expect(error.message).not.toContain(TOKEN)

      fetchMock.mockImplementation(async () =>
        new Response(JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized ${TOKEN}` }), { status: 401 })
      )
      const refused = (await telegramClient(TOKEN).getMe().catch((caught: Error) => caught)) as Error
      expect(refused.message).toBe('Unauthorized <token>')
    }
  })

  it('rejects a token Telegram refuses without repeating it', async () => {
    vi.resetModules()
    channels = await import('./channels')
    const { TelegramError } = await import('./telegram')
    channels.registerChannels({
      client: () => ({
        ...fake.client,
        getMe: async () => {
          throw new TelegramError(401, 'Unauthorized')
        }
      })
    })
    const error = await channels.setTelegramToken(TOKEN).catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Telegram did not accept this token: Unauthorized')
    expect((await channels.getTelegramStatus()).hasToken).toBe(false)
  })

  it('stops polling on a 401 and shows why', async () => {
    await start()
    const { TelegramError } = await import('./telegram')
    fake.client.getUpdates = async () => {
      throw new TelegramError(401, 'Unauthorized')
    }
    // The running loop is waiting on the old function; a new token starts one with the new one.
    await channels.setTelegramToken(TOKEN)
    await vi.waitFor(async () =>
      expect(await channels.getTelegramStatus()).toMatchObject({ state: 'error', error: 'Telegram refused the bot token. Save a new one.' })
    )
  })

  it('removes the token and unpairs', async () => {
    await start()
    await pairInDm()
    const status = await channels.setTelegramToken(null)
    expect(status).toMatchObject({ hasToken: false, paired: false, state: 'off' })
  })
})
