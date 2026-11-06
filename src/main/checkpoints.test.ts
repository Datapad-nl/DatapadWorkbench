import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../shared/types'

const stub = vi.hoisted(() => ({ dir: '', chats: new Map<string, Chat>() }))
vi.mock('electron', () => ({ app: { getPath: () => stub.dir } }))
vi.mock('./store', () => ({
  getChat: async (chatId: string) => structuredClone(stub.chats.get(chatId)!),
  mutateChat: async (chatId: string, change: (chat: Chat) => void) => {
    const chat = stub.chats.get(chatId)!
    change(chat)
    return structuredClone(chat)
  }
}))

import { finishCheckpoint, rewindTo, snapshotBeforeTool, snapshotTouched, startCheckpoint } from './checkpoints'

let root = ''
let project = ''

function makeChat(chatId: string): Chat {
  const chat = { id: chatId, messages: [], checkpoints: [], grokSessionId: null, plan: null } as unknown as Chat
  stub.chats.set(chatId, chat)
  return chat
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  }).toString()
}

const read = (rel: string): string => readFileSync(join(project, rel), 'utf8')
const write = (rel: string, text: string): void => writeFileSync(join(project, rel), text)
const edit = (...paths: string[]) => ({
  sessionUpdate: 'tool_call',
  toolCallId: 't1',
  kind: 'edit',
  title: `Edit ${paths.join(', ')}`,
  locations: paths.map((path) => ({ path }))
})

/** One turn: open its checkpoint, run `work`, close it, as grok.ts does. */
async function turn(chat: Chat, label: string, work: () => Promise<void> | void) {
  const checkpoint = await startCheckpoint({ chat, messageId: `m-${label}`, label, cwd: project })
  await work()
  await finishCheckpoint(chat.id, checkpoint.id)
  return checkpoint
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'checkpoints-test-'))
  stub.dir = join(root, 'userData')
  project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  stub.chats.clear()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('checkpoints in a folder outside git', () => {
  it('rewinds a file a tool changed before the app was told, and removes a file it made', async () => {
    write('notes.md', 'original\n')
    mkdirSync(join(project, 'node_modules'))
    write('node_modules/dep.js', 'dep v1\n')
    const chat = makeChat('chat-shadow')

    const checkpoint = await turn(chat, 'edit', async () => {
      // A tool that ran without asking: the files change first, the update arrives after.
      write('notes.md', 'changed by the agent\n')
      write('made-this-turn.md', 'new\n')
      write('node_modules/dep.js', 'dep v2\n')
      await snapshotTouched(chat.id, edit('notes.md', 'made-this-turn.md') as never)
    })
    expect(checkpoint.kind).toBe('shadow')

    await rewindTo(chat.id, checkpoint.id, project)
    expect(read('notes.md')).toBe('original\n')
    expect(existsSync(join(project, 'made-this-turn.md'))).toBe(false)
    // Left out of the copy, so left alone.
    expect(read('node_modules/dep.js')).toBe('dep v2\n')
    // The rewound checkpoint's commit is gone from the chat's private repository.
    const shadow = join(stub.dir, 'workbench', 'checkpoints', chat.id, 'shadow.git')
    expect(git(project, `--git-dir=${shadow}`, 'for-each-ref').trim()).toBe('')
  })

  it('keeps a file too big for the copy instead of deleting it on rewind', async () => {
    write('big.bin', 'x'.repeat(9 * 1024 * 1024))
    write('notes.md', 'original\n')
    const chat = makeChat('chat-big')
    const checkpoint = await turn(chat, 'edit', () => write('notes.md', 'changed\n'))
    expect(checkpoint.kind).toBe('shadow')

    await rewindTo(chat.id, checkpoint.id, project)
    expect(existsSync(join(project, 'big.bin'))).toBe(true)
    expect(read('notes.md')).toBe('original\n')
  })

  it('handles names git would quote, and spaces', async () => {
    write('café notes.md', 'original\n')
    const chat = makeChat('chat-names')
    const checkpoint = await turn(chat, 'edit', () => {
      write('café notes.md', 'changed\n')
      write('naïve new.md', 'new\n')
    })
    await rewindTo(chat.id, checkpoint.id, project)
    expect(read('café notes.md')).toBe('original\n')
    expect(existsSync(join(project, 'naïve new.md'))).toBe(false)
  })
})

describe('checkpoints in a git repository', () => {
  beforeEach(() => {
    git(project, 'init', '-q')
    write('.gitignore', 'secret.env\n')
    write('notes.md', 'original\n')
    git(project, 'add', '-A')
    git(project, 'commit', '-qm', 'start')
  })

  it('lets the commit win over a file copy taken after the tool ran', async () => {
    const chat = makeChat('chat-git')
    const checkpoint = await turn(chat, 'edit', async () => {
      write('notes.md', 'changed by the agent\n')
      await snapshotTouched(chat.id, edit('notes.md') as never)
    })
    expect(checkpoint.kind).toBe('git')

    await rewindTo(chat.id, checkpoint.id, project)
    expect(read('notes.md')).toBe('original\n')
  })

  it('undoes every later turn, including ignored files only the file copies hold', async () => {
    write('secret.env', 'KEY=original\n')
    const chat = makeChat('chat-turns')
    const first = await turn(chat, 'first', () => undefined)
    await turn(chat, 'second', async () => {
      await snapshotBeforeTool(chat.id, edit('secret.env') as never)
      write('secret.env', 'KEY=changed\n')
    })

    await rewindTo(chat.id, first.id, project)
    expect(read('secret.env')).toBe('KEY=original\n')
    expect(stub.chats.get(chat.id)!.checkpoints).toEqual([])
  })

  it('rewinds past a nested repository the turn left behind', async () => {
    const chat = makeChat('chat-nested')
    const checkpoint = await turn(chat, 'clone', () => {
      mkdirSync(join(project, 'vendor'))
      git(join(project, 'vendor'), 'init', '-q')
      write('vendor/readme.md', 'cloned\n')
    })
    await expect(rewindTo(chat.id, checkpoint.id, project)).resolves.toBeTruthy()
    expect(read('notes.md')).toBe('original\n')
  })
})
