import { describe, expect, it, vi } from 'vitest'
import type { ChatEdits } from './store'

vi.mock('./store', () => ({ listChatEdits: async () => [], listProjects: async () => [] }))
vi.mock('./git', () => ({ uncommittedPaths: async () => [] }))
vi.mock('./checkpoints', () => ({ filesThisTurn: () => [], pathsFromUpdate: () => [] }))

import { findHolder } from './fileClash'

function chat(id: string, touched: Record<string, string> = {}, extra: Partial<ChatEdits> = {}): ChatEdits {
  return {
    id,
    projectId: 'p',
    title: id.toUpperCase(),
    worktreePath: null,
    parentChatId: null,
    handoffFrom: null,
    handoffTo: null,
    touched,
    ...extra
  }
}

const idle = (): string[] => []

describe('findHolder', () => {
  it('names the other chat that changed the file last', () => {
    const chats = [chat('me'), chat('a', { 'x.ts': '2026-01-01T00:00:00Z' }), chat('b', { 'x.ts': '2026-02-01T00:00:00Z' })]
    const found = findHolder({ chatId: 'me', chats, paths: ['x.ts', 'y.ts'], thisTurn: idle })
    expect(found?.holder.id).toBe('b')
    expect(found?.files).toEqual(['x.ts'])
  })

  it('lets a chat edit a file it changed after the other chat did', () => {
    const chats = [chat('me', { 'x.ts': '2026-03-01T00:00:00Z' }), chat('a', { 'x.ts': '2026-01-01T00:00:00Z' })]
    expect(findHolder({ chatId: 'me', chats, paths: ['x.ts'], thisTurn: idle })).toBeNull()
  })

  it('counts the files of a running turn as the newest', () => {
    const chats = [chat('me', { 'x.ts': '2026-03-01T00:00:00Z' }), chat('a')]
    const thisTurn = (id: string): string[] => (id === 'a' ? ['x.ts'] : [])
    expect(findHolder({ chatId: 'me', chats, paths: ['x.ts'], thisTurn })?.holder.id).toBe('a')
  })

  it('ignores chats in their own worktree, in other projects, and the chat’s own family', () => {
    const at = { 'x.ts': '2026-01-01T00:00:00Z' }
    const chats = [
      chat('me', {}, { parentChatId: 'boss', handoffFrom: 'before' }),
      chat('boss', at),
      chat('before', at),
      chat('worker', at, { parentChatId: 'me' }),
      chat('apart', at, { worktreePath: '/wt/apart' }),
      chat('elsewhere', at, { projectId: 'q' })
    ]
    expect(findHolder({ chatId: 'me', chats, paths: ['x.ts'], thisTurn: idle })).toBeNull()
  })
})
