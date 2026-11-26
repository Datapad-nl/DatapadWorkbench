import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({ dir: '', keychain: true }))
// A stand-in keychain: reversible, but never the plain text on disk.
vi.mock('electron', () => ({
  app: { getPath: () => stub.dir },
  safeStorage: {
    isEncryptionAvailable: () => stub.keychain,
    encryptString: (value: string) => Buffer.from(`sealed:${Buffer.from(value).toString('hex')}`),
    decryptString: (sealed: Buffer) => Buffer.from(sealed.toString().slice('sealed:'.length), 'hex').toString()
  }
}))

import {
  createChat,
  deleteChat,
  ensureStore,
  getApiKey,
  getChat,
  getConciseReplies,
  getDefaultAgent,
  grokModelFor,
  listChats,
  mutateChat,
  saveAttachment,
  setThemeId,
  updateSettings,
  workbenchModelChoice,
  workbenchModelFor
} from './store'
import { getBot } from './bots'

let chats = ''

function chatJson(id: string, title: string, updatedAt: string): string {
  return JSON.stringify({ id, projectId: 'p1', title, createdAt: updatedAt, updatedAt, messages: [{}, {}] })
}

/** Writes the file in place, at a whole second so the time can be set again exactly. */
function put(id: string, title: string, updatedAt: string, at: number): void {
  const path = join(chats, `${id}.json`)
  writeFileSync(path, chatJson(id, title, updatedAt))
  utimesSync(path, at, at)
}

beforeEach(async () => {
  stub.dir = mkdtempSync(join(tmpdir(), 'wb-store-'))
  chats = join(stub.dir, 'workbench', 'chats')
  mkdirSync(chats, { recursive: true })
  // Listing the empty folder drops the summaries the test before left. Linux gives a new file the
  // inode that was just freed, so a file with the same name, time and size would look unchanged.
  await listChats()
})

afterEach(() => {
  rmSync(stub.dir, { recursive: true, force: true })
  stub.keychain = true
  vi.unstubAllEnvs()
})

describe('listChats', () => {
  it('summarises each chat, newest first', async () => {
    put('a', 'Older', '2026-01-01T00:00:00.000Z', 1_700_000_000)
    put('b', 'Newer', '2026-01-02T00:00:00.000Z', 1_700_000_000)
    const list = await listChats()
    expect(list.map((chat) => chat.title)).toEqual(['Newer', 'Older'])
    expect(list[0]).toMatchObject({ id: 'b', projectId: 'p1', agent: 'grok', messageCount: 2, schedule: null, pr: null })
  })

  it('carries the chat\'s model, so the list can tag an unopened chat', async () => {
    writeFileSync(
      join(chats, 'a.json'),
      JSON.stringify({ ...JSON.parse(chatJson('a', 'Routed', '2026-01-01T00:00:00.000Z')), model: 'wb-or-nemotron' })
    )
    expect((await listChats())[0]?.model).toBe('wb-or-nemotron')
  })

  it('does not read a file again while its inode, time and size are the same', async () => {
    put('a', 'First', '2026-01-01T00:00:00.000Z', 1_700_000_000)
    expect((await listChats())[0]?.title).toBe('First')
    const before = statSync(join(chats, 'a.json'))
    // Same length, same inode, same time: only a read of the file would show the new title.
    put('a', 'Other', '2026-01-01T00:00:00.000Z', 1_700_000_000)
    const after = statSync(join(chats, 'a.json'))
    expect([after.ino, after.mtimeMs, after.size]).toEqual([before.ino, before.mtimeMs, before.size])
    expect((await listChats())[0]?.title).toBe('First')
  })

  it('reads a file again once its time changes', async () => {
    put('a', 'First', '2026-01-01T00:00:00.000Z', 1_700_000_000)
    await listChats()
    put('a', 'Other', '2026-01-01T00:00:00.000Z', 1_700_000_001)
    expect((await listChats())[0]?.title).toBe('Other')
  })

  it('shows a saved change and drops a deleted chat', async () => {
    put('a', 'First', '2026-01-01T00:00:00.000Z', 1_700_000_000)
    put('b', 'Second', '2026-01-02T00:00:00.000Z', 1_700_000_000)
    await listChats()
    await mutateChat('a', (chat) => {
      chat.title = 'Renamed'
      chat.messages = []
    })
    const list = await listChats()
    expect(list[0]).toMatchObject({ id: 'a', title: 'Renamed', messageCount: 0 })
    expect(list).toHaveLength(2)
    await deleteChat('b')
    expect((await listChats()).map((chat) => chat.id)).toEqual(['a'])
  })
})

describe('saveAttachment', () => {
  it('saves the file in the chat\'s folder under its own name, and deleting the chat removes it', async () => {
    put('a', 'First', '2026-01-01T00:00:00.000Z', 1_700_000_000)
    const bytes = new TextEncoder().encode('%PDF-1.7')
    const attachment = await saveAttachment({ chatId: 'a', name: 'report.pdf', mimeType: 'application/pdf', bytes })
    expect(attachment).toMatchObject({ mimeType: 'application/pdf', data: '', name: 'report.pdf' })
    expect(attachment.path).toBe(join(stub.dir, 'workbench', 'attachments', 'a', attachment.id, 'report.pdf'))
    expect(readFileSync(attachment.path!, 'utf8')).toBe('%PDF-1.7')
    await deleteChat('a')
    expect(existsSync(join(stub.dir, 'workbench', 'attachments', 'a'))).toBe(false)
  })

  it('keeps a name or chat id with path parts inside the attachments folder', async () => {
    const bytes = new Uint8Array([1])
    const attachment = await saveAttachment({ chatId: '../x', name: '../../evil.sh', mimeType: '', bytes })
    expect(attachment.name).toBe('evil.sh')
    expect(attachment.mimeType).toBe('application/octet-stream')
    expect(attachment.path!.startsWith(join(stub.dir, 'workbench', 'attachments') + '/')).toBe(true)
    expect(attachment.path).not.toContain('..')
  })

  it('refuses a file over 25 MB', async () => {
    const bytes = new Uint8Array(25 * 1024 * 1024 + 1)
    await expect(saveAttachment({ chatId: 'a', name: 'big.zip', mimeType: 'application/zip', bytes })).rejects.toThrow(
      'big.zip is over 25 MB'
    )
  })
})

describe('bot chats', () => {
  it('opens a chat of a bot without a project, and lists it with its bot', async () => {
    writeFileSync(
      join(stub.dir, 'workbench', 'bots.json'),
      JSON.stringify({ bots: [{ id: 'b1', name: 'Scout', agent: 'grok', model: '', instructions: '', allowedTools: [], avatar: null }] })
    )
    const chat = await createChat('', { botId: 'b1', title: 'Scheduled: report' })
    expect(chat).toMatchObject({ projectId: '', botId: 'b1' })
    expect((await listChats()).find((item) => item.id === chat.id)).toMatchObject({ projectId: '', botId: 'b1' })
    await expect(createChat('', { botId: 'gone' })).rejects.toThrow('Bot not found')
    await expect(createChat('nowhere')).rejects.toThrow('Project not found')
  })
})

describe('short replies setting', () => {
  it('is off by default, and saving it on keeps it across other changes', async () => {
    expect(await getConciseReplies()).toBe(false)
    expect((await updateSettings({ conciseReplies: true })).conciseReplies).toBe(true)
    expect(await getConciseReplies()).toBe(true)
    expect((await updateSettings({ maxSubagents: 1 })).conciseReplies).toBe(true)
    expect((await updateSettings({ conciseReplies: false })).conciseReplies).toBe(false)
    expect(await getConciseReplies()).toBe(false)
  })
})

describe('API key at rest', () => {
  const settings = (): string => join(stub.dir, 'workbench', 'settings.json')
  const plain = (): void =>
    writeFileSync(settings(), JSON.stringify({ apiKey: 'xai-test-1234', model: 'grok', effort: '', themeId: 't' }))

  beforeEach(() => vi.stubEnv('XAI_API_KEY', ''))

  it('encrypts a plain text key on load and still gives it back', async () => {
    plain()
    await ensureStore()
    const disk = readFileSync(settings(), 'utf8')
    expect(disk).not.toContain('xai-test-1234')
    expect(JSON.parse(disk)).toMatchObject({ apiKey: '', apiKeySealed: expect.any(String) })
    expect(await getApiKey()).toBe('xai-test-1234')
    // Other settings writes keep it sealed.
    await setThemeId('other')
    expect(readFileSync(settings(), 'utf8')).not.toContain('xai-test-1234')
    expect(await getApiKey()).toBe('xai-test-1234')
  })

  it('leaves the key as it was without a keychain', async () => {
    stub.keychain = false
    plain()
    await ensureStore()
    expect(JSON.parse(readFileSync(settings(), 'utf8'))).toMatchObject({ apiKey: 'xai-test-1234' })
    expect(await getApiKey()).toBe('xai-test-1234')
  })
})

describe('provider models from before the app\'s own agent', () => {
  const settings = (): string => join(stub.dir, 'workbench', 'settings.json')
  const providers = [
    { id: 'or', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', backend: 'chat_completions', apiKey: '', models: [{ id: 'a/b', name: 'B', efforts: [] }, { id: 'c', name: 'C', efforts: [] }] }
  ]
  const chat = (id: string, fields: Record<string, unknown>): void =>
    writeFileSync(join(chats, `${id}.json`), JSON.stringify({ ...JSON.parse(chatJson(id, id, '2026-01-01T00:00:00.000Z')), ...fields }))

  it('reads a Grok chat, bot or Settings on a wb- model as on the app\'s own agent', async () => {
    chat('a', { agent: 'grok', model: 'wb-or-a-b' })
    chat('b', { model: 'wb-or-c' })
    chat('c', { agent: 'claude', model: 'wb-or-c' })
    chat('d', { agent: 'grok', model: 'grok-4.6' })
    expect((await getChat('a')).agent).toBe('workbench')
    expect((await getChat('b')).agent).toBe('workbench')
    expect((await getChat('c')).agent).toBe('claude')
    expect((await getChat('d')).agent).toBe('grok')
    expect(Object.fromEntries((await listChats()).map((item) => [item.id, item.agent]))).toEqual({
      a: 'workbench',
      b: 'workbench',
      c: 'claude',
      d: 'grok'
    })
    writeFileSync(
      join(stub.dir, 'workbench', 'bots.json'),
      JSON.stringify({ bots: [{ id: 'b1', name: 'Scout', agent: 'grok', model: 'wb-or-c', instructions: '', allowedTools: [], avatar: null }] })
    )
    expect((await getBot('b1')).agent).toBe('workbench')
    writeFileSync(settings(), JSON.stringify({ defaultAgent: 'grok', model: 'wb-or-c', providers }))
    expect(await getDefaultAgent()).toBe('workbench')
    writeFileSync(settings(), JSON.stringify({ defaultAgent: 'grok', model: 'grok-4.6', providers }))
    expect(await getDefaultAgent()).toBe('grok')
  })

  it('gives the app\'s own agent a listed model: the chat\'s, else Settings\', else the first, and Grok none of them', async () => {
    writeFileSync(settings(), JSON.stringify({ defaultAgent: 'workbench', model: 'wb-or-c', providers }))
    chat('own', { agent: 'workbench', model: 'wb-or-a-b' })
    chat('none', { agent: 'workbench' })
    expect(await workbenchModelFor('own')).toBe('wb-or-a-b')
    expect(await workbenchModelFor('none')).toBe('wb-or-c')
    expect(await grokModelFor('none')).toBe('')
    writeFileSync(settings(), JSON.stringify({ defaultAgent: 'workbench', model: 'grok-4.6', providers }))
    expect(await workbenchModelFor('none')).toBe('wb-or-a-b')
    writeFileSync(settings(), JSON.stringify({ model: 'grok-4.6' }))
    expect(await workbenchModelFor('none')).toBe('')
  })

  it('runs a chat whose model was removed on none, not on another provider\'s model', async () => {
    writeFileSync(settings(), JSON.stringify({ defaultAgent: 'workbench', model: 'wb-or-c', providers }))
    chat('gone', { agent: 'workbench', model: 'wb-gone-x' })
    chat('none', { agent: 'workbench' })
    expect(await workbenchModelChoice('gone')).toEqual({ model: '', removed: true })
    expect(await workbenchModelFor('gone')).toBe('')
    expect(await workbenchModelChoice('none')).toEqual({ model: 'wb-or-c', removed: false })
    writeFileSync(settings(), JSON.stringify({ defaultAgent: 'workbench', model: 'wb-gone-x', providers }))
    expect(await workbenchModelChoice('none')).toEqual({ model: '', removed: true })
    writeFileSync(settings(), JSON.stringify({ defaultAgent: 'workbench', model: 'wb-or-c' }))
    expect(await workbenchModelChoice('none')).toEqual({ model: '', removed: true })
  })
})
