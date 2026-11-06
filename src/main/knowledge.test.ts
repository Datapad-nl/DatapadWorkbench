import { existsSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeSnapshot, OrientationCard, Project } from '../shared/types'

const stub = vi.hoisted(() => ({
  projects: [] as Project[],
  send: vi.fn(),
  orientation: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: stub.send } }] },
  shell: {}
}))
vi.mock('./codegraph', () => ({ buildOrientation: stub.orientation }))
vi.mock('./store', () => ({ listProjects: async () => stub.projects }))

let root = ''
let project: Project

function card(target: Project): OrientationCard {
  return {
    projectId: target.id,
    name: target.name,
    path: target.path,
    stack: null,
    summary: 'A test project.',
    rulesFile: null,
    tree: null,
    fileCount: null,
    nodeCount: null,
    languages: [],
    state: 'indexed',
    error: null
  }
}

/** Makes the next run wait at its orientation read, until `release` is called. */
function holdNextRun(): { reached: Promise<void>; release: () => void } {
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve
  })
  stub.orientation.mockImplementationOnce(async (target: Project) => {
    reached()
    await gate
    return card(target)
  })
  return { reached: reachedPromise, release: () => release() }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Lets file events for earlier writes arrive and the 500ms write window close. */
const settle = (): Promise<void> => pause(1_500)

function snapshotsSent(): KnowledgeSnapshot[] {
  return stub.send.mock.calls.filter(([channel]) => channel === 'knowledge:snapshot').map(([, snapshot]) => snapshot)
}

async function load(): Promise<typeof import('./knowledge')> {
  vi.resetModules()
  return import('./knowledge')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'knowledge-'))
  project = { id: 'p1', name: 'Demo', path: root, createdAt: '', updatedAt: '' }
  stub.projects = [project]
  stub.send.mockReset()
  stub.orientation.mockReset().mockImplementation(async (target: Project) => card(target))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('outside edits', () => {
  it('in the vault while a run is writing still reach the graph', async () => {
    const knowledge = await load()
    await knowledge.maintainVault(project)
    await knowledge.setKnowledgeActiveProject('p1')
    await settle()

    const held = holdNextRun()
    const run = knowledge.maintainVault(project)
    await held.reached
    stub.send.mockReset()
    await writeFile(join(root, 'knowledge', 'notes', 'Outside.md'), '# Outside\n')

    // The run is still held, so only the watcher can have sent this.
    await vi.waitFor(
      () => expect(snapshotsSent().some((snapshot) => snapshot.nodes.some((node) => node.path === 'notes/Outside.md'))).toBe(true),
      { timeout: 5_000, interval: 50 }
    )
    held.release()
    await run
    knowledge.stopKnowledgeWatchers()
  }, 15_000)

  it('in the project folder while a run is writing get one more run, and a run’s own writes get none', async () => {
    const knowledge = await load()
    await knowledge.syncKnowledgeWatchers()
    await vi.waitFor(() => expect(existsSync(join(root, 'knowledge', 'generated', 'Overview.md'))).toBe(true))
    await settle()
    // The first run created the vault inside the watched folder. Its own writes start no run.
    expect(stub.orientation).toHaveBeenCalledTimes(1)

    const held = holdNextRun()
    const run = knowledge.maintainVault(project)
    await held.reached
    await writeFile(join(root, 'README.md'), '# Demo\n')
    // Past the 400ms debounce, so the request lands while the run is still held.
    await pause(1_000)
    expect(stub.orientation).toHaveBeenCalledTimes(2)
    held.release()
    await run
    await vi.waitFor(() => expect(stub.orientation).toHaveBeenCalledTimes(3), { timeout: 5_000, interval: 50 })
    await settle()
    expect(stub.orientation).toHaveBeenCalledTimes(3)
    knowledge.stopKnowledgeWatchers()
  }, 20_000)
})

describe('requests during a run', () => {
  it('get one more run, with the latest project', async () => {
    const knowledge = await load()
    const held = holdNextRun()
    const first = knowledge.maintainVault(project)
    await held.reached
    const second = knowledge.maintainVault(project)
    const third = knowledge.maintainVault({ ...project, name: 'Renamed' })
    held.release()
    await Promise.all([first, second, third])

    expect(stub.orientation).toHaveBeenCalledTimes(2)
    expect(stub.orientation.mock.calls[1][0]).toMatchObject({ name: 'Renamed' })
    expect(await readFile(join(root, 'knowledge', 'Home.md'), 'utf8')).toContain('Renamed')
  })
})

describe('quitting', () => {
  it('stops a running job before its next write', async () => {
    const knowledge = await load()
    const held = holdNextRun()
    const run = knowledge.maintainVault(project)
    await held.reached
    knowledge.stopKnowledgeJobs()
    held.release()
    await expect(run).resolves.toMatchObject({ available: false, reason: 'error', error: 'The app is quitting' })
    expect(existsSync(join(root, 'knowledge', 'generated', 'Overview.md'))).toBe(false)
    expect(existsSync(join(root, 'knowledge', 'Home.md'))).toBe(false)
  })

  it('makes a later job write nothing', async () => {
    const knowledge = await load()
    knowledge.stopKnowledgeJobs()
    await expect(knowledge.maintainVault(project)).resolves.toMatchObject({
      available: false,
      reason: 'error',
      error: 'The app is quitting'
    })
    expect(existsSync(join(root, 'knowledge'))).toBe(false)
  })

  it('stops the watchers, and the run a change had already scheduled', async () => {
    const knowledge = await load()
    await knowledge.syncKnowledgeWatchers()
    await vi.waitFor(() => expect(existsSync(join(root, 'knowledge', 'generated', 'Overview.md'))).toBe(true))
    await settle()
    expect(stub.orientation).toHaveBeenCalledTimes(1)

    await writeFile(join(root, 'README.md'), '# Demo\n')
    // Long enough for the event to arrive, short of the 400ms debounce.
    await pause(150)
    knowledge.stopKnowledgeWatchers()
    await writeFile(join(root, 'LICENSE'), 'MIT\n')
    await settle()
    expect(stub.orientation).toHaveBeenCalledTimes(1)
  }, 15_000)
})
