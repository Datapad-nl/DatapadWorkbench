import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../shared/types'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./store', () => ({ getChat: async () => null, listProjects: async () => [] }))

import { isolateChatIfNeeded, uncommittedPaths } from './git'

let root = ''
let project = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  }).toString()
}

const chat = (): Chat => ({ id: 'abcd1234-0000', mode: 'auto', messages: [] }) as unknown as Chat

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-git-'))
  project = join(root, 'repo')
  execFileSync('mkdir', [project])
  git(project, 'init', '-q')
  writeFileSync(join(project, 'a.txt'), 'a')
  git(project, 'add', '.')
  git(project, 'commit', '-qm', 'init')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('isolateChatIfNeeded', () => {
  it('keeps an editing chat in the project folder when no other chat is at work there', async () => {
    const result = await isolateChatIfNeeded(chat(), project, 'fix the login bug', { streaming: false })
    expect(result.reason).toBeNull()
    expect(result.chat.worktreePath).toBeUndefined()
  })

  it('moves a chat to its own worktree while another chat works in the folder', async () => {
    const result = await isolateChatIfNeeded(chat(), project, 'fix the login bug', { streaming: true })
    expect(result.reason).toMatch(/already working/)
    expect(result.chat.worktreeBranch).toBe('workbench/abcd1234')
    expect(git(project, 'worktree', 'list')).toContain(result.chat.worktreePath!)
  })

  it('moves a chat that asks for an experiment', async () => {
    const result = await isolateChatIfNeeded(chat(), project, 'prototype a new sidebar', { streaming: false })
    expect(result.reason).toMatch(/experiment/)
  })
})

describe('uncommittedPaths', () => {
  it('finds changed and new files among the paths, also from a folder below the repository top', async () => {
    writeFileSync(join(project, 'a.txt'), 'changed')
    writeFileSync(join(project, 'new.txt'), 'new')
    expect(await uncommittedPaths(project, ['a.txt', 'new.txt', 'clean.txt'])).toEqual(['a.txt', 'new.txt'])

    execFileSync('mkdir', [join(project, 'sub')])
    writeFileSync(join(project, 'sub', 'b.txt'), 'b')
    expect(await uncommittedPaths(join(project, 'sub'), ['b.txt'])).toEqual(['b.txt'])
  })
})
