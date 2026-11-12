import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeSnapshot, OrientationCard, Project } from '../shared/types'

const stub = vi.hoisted(() => ({
  projects: [] as Project[],
  send: vi.fn(),
  orientation: vi.fn(),
  sync: vi.fn(),
  files: vi.fn(),
  ask: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: stub.send } }] },
  shell: {}
}))
vi.mock('./codegraph', () => ({
  buildOrientation: stub.orientation,
  syncIndex: stub.sync,
  listIndexedFiles: stub.files
}))
vi.mock('./store', () => ({ listProjects: async () => stub.projects }))
vi.mock('./askOnce', () => ({ askOnce: stub.ask }))

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
  stub.sync.mockReset().mockResolvedValue(undefined)
  stub.files.mockReset().mockResolvedValue(null)
  stub.ask.mockReset().mockResolvedValue(null)
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

describe('project edits', () => {
  it('deep inside the project folder get a run', async () => {
    const knowledge = await load()
    await knowledge.syncKnowledgeWatchers()
    await vi.waitFor(() => expect(existsSync(join(root, 'knowledge', 'generated', 'Overview.md'))).toBe(true))
    await settle()
    expect(stub.orientation).toHaveBeenCalledTimes(1)

    await mkdir(join(root, 'src', 'main'), { recursive: true })
    await settle()
    stub.orientation.mockClear()
    await writeFile(join(root, 'src', 'main', 'feature.ts'), 'export const x = 1\n')
    await vi.waitFor(() => expect(stub.orientation).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 50 })
    knowledge.stopKnowledgeWatchers()
  }, 15_000)

  it('under dependency, build and dot folders get none', async () => {
    const knowledge = await load()
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
    await mkdir(join(root, '.git'))
    await mkdir(join(root, '.codegraph'))
    await knowledge.syncKnowledgeWatchers()
    await vi.waitFor(() => expect(existsSync(join(root, 'knowledge', 'generated', 'Overview.md'))).toBe(true))
    await settle()
    expect(stub.orientation).toHaveBeenCalledTimes(1)

    await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    await writeFile(join(root, '.git', 'index'), 'x')
    await writeFile(join(root, '.codegraph', 'codegraph.db-wal'), 'x')
    await settle()
    expect(stub.orientation).toHaveBeenCalledTimes(1)
    knowledge.stopKnowledgeWatchers()
  }, 15_000)

  it('reach the generated notes, because each run syncs the index before it reads it', async () => {
    const knowledge = await load()
    await knowledge.maintainVault(project)
    expect(stub.sync).toHaveBeenCalledWith(project)
    expect(stub.sync.mock.invocationCallOrder[0]).toBeLessThan(stub.orientation.mock.invocationCallOrder[0])
  })
})

/** Writes project files and has the index list them. */
async function indexFiles(files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  stub.files.mockResolvedValue(
    Object.keys(files).map((path) => ({ path, language: path.endsWith('.ts') ? 'typescript' : 'json', nodeCount: 1 }))
  )
}

const generated = (path: string): Promise<string> => readFile(join(root, 'knowledge', 'generated', path), 'utf8')

describe('the layout', () => {
  /** The requests for module descriptions. */
  const modulePrompts = (): string =>
    stub.ask.mock.calls
      .map(([, prompt]) => prompt as string)
      .filter((prompt) => prompt.includes('module notes'))
      .join('\n')

  it('gives no folder a note: the folders are listed in Architecture, and the notes an earlier version wrote go', async () => {
    await indexFiles({ 'src/main/a.ts': '', 'src/shared/types.ts': '', 'node_modules/dep/index.ts': '', 'root.ts': '' })
    await mkdir(join(root, 'knowledge', 'generated', 'src'), { recursive: true })
    await writeFile(join(root, 'knowledge', 'generated', 'src', 'main.md'), '# src/main\n')
    await writeFile(join(root, 'knowledge', 'generated', 'src.md'), '# src\n')
    const knowledge = await load()
    const snapshot = await knowledge.maintainVault(project)

    expect(snapshot.nodes.map((node) => node.path).sort()).toEqual([
      'Home.md',
      'generated/Architecture.md',
      'generated/Overview.md',
      'notes/How to use this vault.md'
    ])
    expect(existsSync(join(root, 'knowledge', 'generated', 'src'))).toBe(false)
    expect(await generated('Architecture.md')).toContain('## Areas\n\n- `src/`\n')
  })

  it('has each module described with the modules it imports from, leaving out the tests', async () => {
    await indexFiles({
      'src/main/a.ts': "import { b } from './b'\nimport type { T } from '../shared/types.js'\nimport './a.test'\n",
      'src/main/b.ts': 'export const b = 1\n',
      'src/main/a.test.ts': "import '../ui/view'\n",
      'src/shared/types.ts': 'export type T = 1\n',
      'src/ui/view.ts': ''
    })
    const knowledge = await load()
    await knowledge.setKnowledgeActiveProject('p1')
    await vi.waitFor(() => expect(stub.ask).toHaveBeenCalled())
    expect(modulePrompts()).toContain('## Module src/main/\nUses: src/shared\n### a.ts\n')
    expect(modulePrompts()).not.toContain('a.test.ts')
    expect(modulePrompts()).not.toContain('## Module src/shared/\nUses')
    knowledge.stopKnowledgeWatchers()
  })

  it('has a module described with the lines of the rules file and README about it', async () => {
    await writeFile(
      join(root, 'CLAUDE.md'),
      [
        '# Demo',
        '',
        '- Main process: `src/main` (persistence, IPC)',
        '- Shared types: `src/shared/types.ts`',
        '- The main helpers: `src/main/util/x.ts`',
        '',
        '```',
        'src/main  <- not this',
        '```'
      ].join('\n')
    )
    await writeFile(join(root, 'README.md'), 'Build output lands next to src/main.\n')
    stub.orientation.mockImplementation(async (target: Project) => ({ ...card(target), rulesFile: 'CLAUDE.md' }))
    await indexFiles({ 'src/main/a.ts': '', 'src/main/util/x.ts': '', 'src/shared/types.ts': '' })
    const knowledge = await load()
    await knowledge.setKnowledgeActiveProject('p1')
    await vi.waitFor(() => expect(stub.ask).toHaveBeenCalled())

    expect(modulePrompts()).toContain(
      '## Module src/main/\nDocs: Main process: `src/main` (persistence, IPC)\nDocs: Build output lands next to src/main.\n'
    )
    expect(modulePrompts()).not.toContain('not this')
    // No line names the folder, so one about a file directly in it stands in.
    expect(modulePrompts()).toContain('## Module src/shared/\nDocs: Shared types: `src/shared/types.ts`\n')
    expect(modulePrompts()).not.toContain('## Module src/\nDocs')
    knowledge.stopKnowledgeWatchers()
  })

  it('past the module budget, counts the deepest folders with the module above them', async () => {
    await indexFiles(Object.fromEntries(Array.from({ length: 125 }, (_, i) => [`src/m${i}/f.ts`, ''])))
    const knowledge = await load()
    await knowledge.setKnowledgeActiveProject('p1')
    await vi.waitFor(() => expect(stub.ask).toHaveBeenCalled())
    await knowledge.maintainVault(project)
    expect(modulePrompts().match(/^## Module src\/m\d+\/$/gm)).toHaveLength(120)
    knowledge.stopKnowledgeWatchers()
  })
})

describe('module descriptions', () => {
  const reply = JSON.stringify({
    modules: [
      { path: 'src', about: 'Holds the app. It is split by process.', files: {} },
      { path: 'src/main', about: 'Runs the main process. It reads the config.', files: { 'config.ts': 'Reads the config file.' } },
      { path: 'src/shared', about: 'Types both processes share.', files: { 'types.ts': 'The shared types.' } }
    ]
  })
  /** The requests for module descriptions. The one for the concepts comes after them. */
  const modulePrompts = (): string[] =>
    stub.ask.mock.calls.map(([, prompt]) => prompt as string).filter((prompt) => prompt.includes('module notes'))
  const describedMain = (): Promise<void> =>
    vi.waitFor(async () => expect(await generated('Architecture.md')).toContain('Runs the main process.'), {
      timeout: 5_000,
      interval: 50
    })

  it('come from the model while the Knowledge pane is open, for each module and the files in it', async () => {
    await indexFiles({
      'src/main/config.ts': "import type { T } from '../shared/types'\n/** Reads the config. */\nexport function readConfig(): T {\n}\n",
      'src/shared/types.ts': 'export type T = 1\n'
    })
    stub.ask.mockResolvedValue(reply)
    const knowledge = await load()
    await knowledge.maintainVault(project)
    expect(stub.ask).not.toHaveBeenCalled()

    await knowledge.setKnowledgeActiveProject('p1')
    await describedMain()
    // Lets the run that wrote it finish.
    await knowledge.maintainVault(project)
    const architecture = await generated('Architecture.md')
    expect(architecture).toContain('## Areas\n\n- `src/`: Holds the app.\n')
    expect(architecture).toContain(
      '## Modules\n\n- `src/main/`: Runs the main process. It reads the config.\n- `src/shared/`: Types both processes share.\n'
    )
    expect(modulePrompts()).toHaveLength(1)
    expect(modulePrompts()[0]).toContain(
      '## Module src/main/\nUses: src/shared\n### config.ts\n// Reads the config.\nexport function readConfig(): T\n'
    )
    knowledge.stopKnowledgeWatchers()
  })

  it('are asked for again only for a module whose files changed, also after a restart', async () => {
    await indexFiles({ 'src/main/config.ts': '', 'src/shared/types.ts': '' })
    stub.ask.mockResolvedValue(reply)
    let knowledge = await load()
    await knowledge.setKnowledgeActiveProject('p1')
    await describedMain()
    await knowledge.maintainVault(project)
    expect(modulePrompts()).toHaveLength(1)
    knowledge.stopKnowledgeWatchers()

    knowledge = await load()
    await knowledge.setKnowledgeActiveProject('p1')
    await knowledge.maintainVault(project)
    expect(modulePrompts()).toHaveLength(1)

    stub.ask.mockResolvedValue(
      JSON.stringify({ modules: [{ path: 'src/main', about: 'Runs the main process and the extras.', files: { 'extra.ts': 'The extras.' } }] })
    )
    await indexFiles({ 'src/main/config.ts': '', 'src/main/extra.ts': '', 'src/shared/types.ts': '' })
    await knowledge.maintainVault(project)
    await vi.waitFor(async () => expect(await generated('Architecture.md')).toContain('and the extras.'), {
      timeout: 5_000,
      interval: 50
    })
    await knowledge.maintainVault(project)
    expect(modulePrompts()).toHaveLength(2)
    const prompt = modulePrompts()[1]
    expect(prompt).toContain('## Module src/main/\n')
    expect(prompt).not.toContain('## Module src/shared/\n')
    expect(prompt).not.toContain('## Module src/\n')
    // The other modules keep what was written about them.
    expect(await generated('Architecture.md')).toContain('Types both processes share.')
    knowledge.stopKnowledgeWatchers()
  })

  it('are not asked for again after a reply without them, until the module changes', async () => {
    await indexFiles({ 'src/main/config.ts': '' })
    stub.ask.mockResolvedValue('Sorry, no.')
    const knowledge = await load()
    await knowledge.setKnowledgeActiveProject('p1')
    await vi.waitFor(() => expect(stub.ask).toHaveBeenCalledTimes(1))
    await knowledge.maintainVault(project)
    await knowledge.maintainVault(project)
    expect(stub.ask).toHaveBeenCalledTimes(1)
    expect(existsSync(join(root, 'knowledge', 'generated', '.summaries.json'))).toBe(false)
    knowledge.stopKnowledgeWatchers()
  })
})

describe('concepts', () => {
  const modules = JSON.stringify({
    modules: [
      { path: 'src', about: 'Holds the app.', files: {} },
      { path: 'src/main', about: 'Runs the main process.', files: { 'config.ts': 'Reads the config file.', 'extra.ts': 'The extras.' } },
      { path: 'docs', about: 'The written guides.', files: { 'guide.md': 'How to set the app up.' } }
    ]
  })
  const features = JSON.stringify({
    features: [
      {
        name: 'Settings',
        about: 'Keeps what the user chose. It is read at launch.',
        related: ['Launch', 'Guesswork'],
        files: ['src/main/config.ts', 'docs/guide.md', 'src/main/gone.ts']
      },
      { name: 'Launch', about: 'Starts the app. It reads the settings first.', related: ['Settings'], files: ['src/main/config.ts'] },
      { name: 'Guesswork', about: 'Nothing behind it.', related: ['Settings'], files: ['src/nowhere.ts'] }
    ]
  })
  const prompts = (about: string): string[] =>
    stub.ask.mock.calls.map(([, prompt]) => prompt as string).filter((prompt) => prompt.includes(about))
  const written = (text: string): Promise<void> =>
    vi.waitFor(async () => expect(await generated('concepts/Settings.md')).toContain(text), { timeout: 5_000, interval: 50 })

  beforeEach(async () => {
    stub.ask.mockImplementation(async (_project: Project, prompt: string) =>
      prompt.includes('concept notes') ? features : modules
    )
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n\nHow to set the app up.\n')
  })

  it('come from the model once the modules are described, each a note linked from the overview and to the concepts it works with', async () => {
    await indexFiles({ 'src/main/config.ts': '' })
    let knowledge = await load()
    await knowledge.setKnowledgeActiveProject('p1')
    await written('Keeps what the user chose.')
    const snapshot = await knowledge.maintainVault(project)

    expect(await generated('concepts/Settings.md')).toContain(
      [
        '## Works with',
        '',
        '- [[generated/concepts/Launch.md|Launch]]',
        '',
        '## Where it lives',
        '',
        '- `src/main/`: Runs the main process.',
        '  - `config.ts`: Reads the config file.',
        '- `docs/`: The written guides.',
        '  - `guide.md`: How to set the app up.',
        ''
      ].join('\n')
    )
    expect(existsSync(join(root, 'knowledge', 'generated', 'concepts', 'Guesswork.md'))).toBe(false)
    expect(await generated('Overview.md')).toContain(
      '## How it works\n\n- [[generated/concepts/Settings.md|Settings]] — Keeps what the user chose.\n'
    )
    expect(await readFile(join(root, 'knowledge', 'Home.md'), 'utf8')).toContain(
      '## Concepts\n\n- [[generated/concepts/Settings.md|Settings]] — Keeps what the user chose.\n'
    )
    expect(snapshot.nodes.find((node) => node.path === 'generated/concepts/Settings.md')?.tags).toEqual(
      expect.arrayContaining(['concept', 'area/src/main'])
    )
    expect(snapshot.edges).toContainEqual({ from: 'generated/Overview.md', to: 'generated/concepts/Settings.md' })
    expect(snapshot.edges).toContainEqual({ from: 'generated/concepts/Settings.md', to: 'generated/concepts/Launch.md' })
    expect(snapshot.edges).toContainEqual({ from: 'generated/concepts/Launch.md', to: 'generated/concepts/Settings.md' })
    // Every generated note is a concept or one of the notes about the whole project.
    expect(snapshot.nodes.map((node) => node.path).filter((path) => path.startsWith('generated/')).sort()).toEqual([
      'generated/Architecture.md',
      'generated/Overview.md',
      'generated/concepts/Launch.md',
      'generated/concepts/Settings.md'
    ])
    expect(prompts('concept notes')).toHaveLength(1)
    expect(prompts('concept notes')[0]).toContain('## src/main/\nRuns the main process.\n- src/main/config.ts: Reads the config file.\n')
    knowledge.stopKnowledgeWatchers()

    // After a restart they are read from the vault.
    knowledge = await load()
    await knowledge.setKnowledgeActiveProject('p1')
    await knowledge.maintainVault(project)
    expect(stub.ask).toHaveBeenCalledTimes(2)
    knowledge.stopKnowledgeWatchers()
  })

  it('are asked for again once a module is described again', async () => {
    await indexFiles({ 'src/main/config.ts': '' })
    const knowledge = await load()
    await knowledge.setKnowledgeActiveProject('p1')
    await written('Keeps what the user chose.')
    await knowledge.maintainVault(project)

    await indexFiles({ 'src/main/config.ts': '', 'src/main/extra.ts': '' })
    await knowledge.maintainVault(project)
    await vi.waitFor(() => expect(prompts('concept notes')).toHaveLength(2), { timeout: 5_000, interval: 50 })
    expect(prompts('concept notes')[1]).toContain('- src/main/extra.ts: The extras.')
    expect(prompts('module notes')).toHaveLength(2)
    knowledge.stopKnowledgeWatchers()
  })

  it('describe an area the index holds nothing of from its file names and the first lines of its prose', async () => {
    await indexFiles({ 'src/main/config.ts': '' })
    const knowledge = await load()
    await knowledge.setKnowledgeActiveProject('p1')
    await vi.waitFor(async () => expect(await generated('Architecture.md')).toContain('- `docs/`: The written guides.\n'), {
      timeout: 5_000,
      interval: 50
    })
    expect(prompts('module notes')[0]).toContain('## Module docs/\n### guide.md\n# Guide\nHow to set the app up.\n')
    knowledge.stopKnowledgeWatchers()
  })
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
