import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({ taskLine: null as string | null }))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
// Only the session-update bridge uses acp, and these tests don't start it.
vi.mock('./acp', () => ({}))
vi.mock('./taskProgress', () => ({ latestTaskLine: () => stub.taskLine }))

import {
  bindSession,
  clearActivity,
  emitNotice,
  emitPermissionActivity,
  finishTurn,
  getActivitySnapshot,
  lookupSession,
  startTurn
} from './activity'

beforeEach(() => {
  vi.useFakeTimers()
  stub.taskLine = null
})

afterEach(() => {
  finishTurn('chat-1', 'done')
  clearActivity()
  vi.useRealTimers()
})

function rowsFor(chatId: string): ReturnType<typeof getActivitySnapshot>['events'] {
  return getActivitySnapshot().events.filter((event) => event.chatId === chatId)
}

function hasRow(chatId: string, coalesceKey: string): boolean {
  return rowsFor(chatId).some((event) => event.coalesceKey === coalesceKey)
}

function noteOtherChat(title: string): void {
  emitNotice({ chatId: 'chat-other', chatTitle: 'Other', title, detail: 'done' })
}

describe('activity turn rows', () => {
  it('keep a running turn, and its progress updates, through a clear', () => {
    startTurn({ chatId: 'chat-1', chatTitle: 'Chat 1', sessionId: 's1', prompt: 'Fix the build' })
    noteOtherChat('earlier')

    expect(clearActivity().events.map((event) => event.kind)).toEqual(['turn'])

    stub.taskLine = 'Running tests'
    vi.advanceTimersByTime(2_000)
    expect(hasRow('chat-1', 'taskfeed:chat-1')).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(hasRow('chat-1', 'heartbeat:chat-1')).toBe(true)

    finishTurn('chat-1', 'done')
    const turns = rowsFor('chat-1').filter((event) => event.kind === 'turn')
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ status: 'done', title: 'Chat 1', detail: 'Fix the build' })
  })

  it('never evict a running turn row', () => {
    startTurn({ chatId: 'chat-1', chatTitle: 'Chat 1', sessionId: 's1', prompt: 'Fix the build' })
    for (let index = 0; index < 450; index += 1) noteOtherChat(`notice ${index}`)

    const events = getActivitySnapshot().events
    expect(events).toHaveLength(400)
    expect(events[0]).toMatchObject({ kind: 'turn', chatId: 'chat-1', status: 'running' })
    expect(events.at(-1)?.title).toBe('notice 449')

    stub.taskLine = 'Running tests'
    vi.advanceTimersByTime(2_000)
    expect(hasRow('chat-1', 'taskfeed:chat-1')).toBe(true)
  })
})

describe('a superseded turn', () => {
  it('has its rows finished in place when the next turn starts', () => {
    startTurn({ chatId: 'chat-1', chatTitle: 'Chat 1', sessionId: 's1', prompt: 'First' })
    emitPermissionActivity({
      chatId: 'chat-1',
      sessionId: 's1',
      title: 'Edit a.txt',
      detail: null,
      status: 'running',
      requestId: 'r1'
    })
    // No finishTurn: the first turn was superseded.
    startTurn({ chatId: 'chat-1', chatTitle: 'Chat 1', sessionId: 's1', prompt: 'Second' })

    const rows = rowsFor('chat-1')
    expect(rows.filter((event) => event.status === 'running').map((event) => event.detail)).toEqual(['Second'])
    expect(rows.find((event) => event.detail === 'First')).toMatchObject({ kind: 'turn', status: 'done' })
    expect(rows.find((event) => event.kind === 'permission')).toMatchObject({ status: 'done' })
    expect(new Set(rows.map((event) => event.id)).size).toBe(rows.length)

    finishTurn('chat-1', 'error')
    const after = rowsFor('chat-1')
    expect(after.filter((event) => event.status === 'running')).toEqual([])
    expect(new Set(after.map((event) => event.id)).size).toBe(after.length)
  })
})

describe('a finished row', () => {
  it('is not revived by a late running update', () => {
    const permission = (status: 'running' | 'done'): void =>
      emitPermissionActivity({ chatId: 'chat-1', sessionId: null, title: 'Edit a.txt', detail: null, status, requestId: 'r2' })
    permission('running')
    permission('done')
    permission('running')
    expect(rowsFor('chat-1').filter((event) => event.kind === 'permission')).toMatchObject([{ status: 'done' }])
  })
})

describe('bound sessions', () => {
  it('are capped, dropping the least recently bound first', () => {
    const kept = { id: 'chat-kept', title: 'Kept' }
    bindSession('old', { id: 'chat-old', title: 'Old' })
    bindSession('kept', kept)
    for (let index = 0; index < 250; index += 1) {
      bindSession(`s${index}`, { id: `chat-${index}`, title: 'Chat' })
      // A chat that keeps taking turns rebinds its session each time.
      bindSession('kept', kept)
    }

    expect(lookupSession('old')).toBeNull()
    expect(lookupSession('s0')).toBeNull()
    expect(lookupSession('kept')).toEqual(kept)
    expect(lookupSession('s249')).toEqual({ id: 'chat-249', title: 'Chat' })
  })
})
