import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({
  dir: '',
  stackLabel: null as string | null,
  generate: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => stub.dir } }))
vi.mock('./store', () => ({
  getChat: async (id: string) => ({ id, projectId: 'p1' }),
  // '/tmp' has no briefing file, so the tests write nothing outside the temp dir.
  listProjects: async () => [{ id: 'p1', name: 'Demo', path: '/tmp' }]
}))
vi.mock('./projectScan', () => ({
  scanProject: async () => ({ stackLabel: stub.stackLabel, summary: null, findings: [] })
}))
vi.mock('./intakeQuestions', () => ({ generateIntakeQuestions: stub.generate }))

import {
  cancelProjectIntake,
  formatProjectSessionRules,
  getProjectIntake,
  maybeStartProjectIntake,
  needsProjectIntake,
  projectSessionRules,
  vaultSessionRule
} from './intake'
import type { Project } from '../shared/types'
import { pendingQuestionRequests, resolveUserQuestion } from './questions'

const questions = Array.from({ length: 7 }, (_, index) => ({
  question: `Q${index}`,
  header: null,
  multiSelect: false,
  options: []
}))

const home = process.env.HOME

beforeEach(() => {
  stub.dir = mkdtempSync(join(tmpdir(), 'intake-'))
  stub.stackLabel = null
  stub.generate.mockReset().mockResolvedValue({ title: 'About Demo', questions })
  // Recording an intake also tidies ~/.grok/memory. Keep it off the real one.
  process.env.HOME = stub.dir
})

afterEach(() => {
  vi.useRealTimers()
  process.env.HOME = home
  rmSync(stub.dir, { recursive: true, force: true })
})

async function nextCard(): Promise<ReturnType<typeof pendingQuestionRequests>[number]> {
  await vi.waitFor(() => expect(pendingQuestionRequests()).toHaveLength(1))
  return pendingQuestionRequests()[0]
}

describe('the knowledge vault in the session rules', () => {
  const project = (path: string): Project => ({ id: 'p2', name: 'Demo', path, createdAt: '', updatedAt: '' })

  it('points the agent at the vault of a project that has one', async () => {
    mkdirSync(join(stub.dir, 'knowledge'))
    writeFileSync(join(stub.dir, 'knowledge', 'Home.md'), '# Home\n')
    const rule = await vaultSessionRule(project(stub.dir))
    expect(rule).toContain(join(stub.dir, 'knowledge'))
    expect(rule).toContain('Home.md')
  })

  it('says nothing for a project without a vault or without a folder', async () => {
    expect(await vaultSessionRule(project(stub.dir))).toBeNull()
    expect(await vaultSessionRule(project(''))).toBeNull()
  })

  it('gives a project with no briefing and no vault no rules', async () => {
    expect(await projectSessionRules('p1')).toBeNull()
  })
})

describe('project intake', () => {
  it('posts no card when its chat is deleted before the intake got going', async () => {
    const started = maybeStartProjectIntake('p1', 'chat-gone')
    // chat:delete cancels while the intake is still reading the chat and the projects.
    cancelProjectIntake('chat-gone')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const posted = pendingQuestionRequests().length
    // Let a card that was posted anyway go, so the run ends.
    cancelProjectIntake('chat-gone')
    await started

    expect(posted).toBe(0)
    expect(await needsProjectIntake('p1')).toBe(true)
  })

  it('resumes after a stop with the saved answers, asking only the rounds left', async () => {
    const first = maybeStartProjectIntake('p1', 'chat-1')
    const round1 = await nextCard()
    expect(round1.title).toBe('About Demo')
    resolveUserQuestion(round1.requestId, { type: 'submit', answers: round1.questions.map(() => ['x']) })
    await vi.waitFor(() => expect(pendingQuestionRequests()[0]?.title).toBe('A few more details'))

    cancelProjectIntake('chat-1')
    await first
    expect(await getProjectIntake('p1')).toBeNull()
    expect(await needsProjectIntake('p1')).toBe(true)

    const second = maybeStartProjectIntake('p1', 'chat-1')
    const round2 = await nextCard()
    expect(stub.generate).toHaveBeenCalledTimes(1)
    expect(round2.title).toBe('A few more details')
    expect(round2.questions.map((question) => question.question)).toEqual(['Q5', 'Q6'])
    resolveUserQuestion(round2.requestId, { type: 'submit', answers: [['y'], ['z']] })
    await second

    const intake = await getProjectIntake('p1')
    expect(intake?.status).toBe('completed')
    expect(intake?.rounds).toHaveLength(1)
    expect(intake?.rounds[0].answers.map((answer) => answer.values[0])).toEqual(['x', 'x', 'x', 'x', 'x', 'y', 'z'])
  })

  it('records a decline after something was gathered as declined, and keeps what was gathered', async () => {
    stub.stackLabel = 'Electron'
    const run = maybeStartProjectIntake('p1', 'chat-1')
    resolveUserQuestion((await nextCard()).requestId, { type: 'skip' })
    await run

    const intake = await getProjectIntake('p1')
    expect(intake?.status).toBe('declined')
    expect(intake?.rounds.map((round) => round.title)).toEqual(['From the repo'])
    expect(await needsProjectIntake('p1')).toBe(false)
  })

  it('keeps the submitted rounds through a quit, and resumes from disk after a restart', async () => {
    const beforeQuit = maybeStartProjectIntake('p1', 'chat-1')
    const round1 = await nextCard()
    resolveUserQuestion(round1.requestId, { type: 'submit', answers: round1.questions.map(() => ['x']) })
    // The next card is only posted once the round has been saved.
    await vi.waitFor(() => expect(pendingQuestionRequests()[0]?.title).toBe('A few more details'))

    // Quit with the second card open: nothing is cancelled or recorded, and memory starts over.
    vi.resetModules()
    const restarted = await import('./intake')
    const questionsAfter = await import('./questions')
    expect(await restarted.getProjectIntake('p1')).toBeNull()
    expect(await restarted.needsProjectIntake('p1')).toBe(true)

    const run = restarted.maybeStartProjectIntake('p1', 'chat-2')
    await vi.waitFor(() => expect(questionsAfter.pendingQuestionRequests()).toHaveLength(1))
    const round2 = questionsAfter.pendingQuestionRequests()[0]
    expect(stub.generate).toHaveBeenCalledTimes(1)
    expect(round2.title).toBe('A few more details')
    expect(round2.questions.map((question) => question.question)).toEqual(['Q5', 'Q6'])
    questionsAfter.resolveUserQuestion(round2.requestId, { type: 'submit', answers: [['y'], ['z']] })
    await run

    const intake = await restarted.getProjectIntake('p1')
    expect(intake?.status).toBe('completed')
    expect(intake?.rounds[0].answers.map((answer) => answer.values[0])).toEqual(['x', 'x', 'x', 'x', 'x', 'y', 'z'])

    // The quit would have ended the first process. End its run here so later tests start clean.
    cancelProjectIntake('chat-1')
    await beforeQuit
    expect((await restarted.getProjectIntake('p1'))?.status).toBe('completed')
  })

  it('records a decline after an answered round as declined, keeps the answers, and briefs from them', async () => {
    const run = maybeStartProjectIntake('p1', 'chat-1')
    const round1 = await nextCard()
    resolveUserQuestion(round1.requestId, { type: 'submit', answers: round1.questions.map(() => ['x']) })
    await vi.waitFor(() => expect(pendingQuestionRequests()[0]?.title).toBe('A few more details'))
    resolveUserQuestion(pendingQuestionRequests()[0].requestId, { type: 'skip' })
    await run

    const intake = await getProjectIntake('p1')
    expect(intake?.status).toBe('declined')
    expect(intake?.rounds).toHaveLength(1)
    expect(intake?.rounds[0]).toMatchObject({ title: 'From you' })
    expect(intake?.rounds[0].answers).toHaveLength(5)
    expect(await needsProjectIntake('p1')).toBe(false)
    const rules = formatProjectSessionRules(intake, { id: 'p1', name: 'Demo', path: '/tmp', createdAt: '', updatedAt: '' })
    expect(rules).toContain('From you:')
    expect(rules).toContain('- Q0 x')
  })

  it('records a decline with nothing gathered as skipped', async () => {
    const run = maybeStartProjectIntake('p1', 'chat-1')
    resolveUserQuestion((await nextCard()).requestId, { type: 'skip' })
    await run

    expect(await getProjectIntake('p1')).toMatchObject({ status: 'skipped', rounds: [] })
    expect(await needsProjectIntake('p1')).toBe(false)
  })

  it('cancels a card nobody answers after 30 minutes and records nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stub.stackLabel = 'Electron'
    const run = maybeStartProjectIntake('p1', 'chat-1')
    await nextCard()

    await vi.advanceTimersByTimeAsync(29 * 60_000)
    expect(pendingQuestionRequests()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await run

    expect(pendingQuestionRequests()).toEqual([])
    expect(await getProjectIntake('p1')).toBeNull()
    expect(await needsProjectIntake('p1')).toBe(true)
  })
})
