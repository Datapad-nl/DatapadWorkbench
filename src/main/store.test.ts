import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => stub.dir } }))

import { createChat, deleteChat, listChats, mutateChat } from './store'

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
})

describe('listChats', () => {
  it('summarises each chat, newest first', async () => {
    put('a', 'Older', '2026-01-01T00:00:00.000Z', 1_700_000_000)
    put('b', 'Newer', '2026-01-02T00:00:00.000Z', 1_700_000_000)
    const list = await listChats()
    expect(list.map((chat) => chat.title)).toEqual(['Newer', 'Older'])
    expect(list[0]).toMatchObject({ id: 'b', projectId: 'p1', agent: 'grok', messageCount: 2, schedule: null, pr: null })
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
