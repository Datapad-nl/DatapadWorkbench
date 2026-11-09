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
  it('gives each indexed folder a note, linked to the folder holding it and the folders it imports from', async () => {
    await indexFiles({
      'src/main/a.ts': "import { b } from './b'\nimport type { T } from '../shared/types.js'\nimport './a.test'\n",
      'src/main/c.ts': "import { b } from './b'\nimport type { T } from '../shared/types'\n",
      'src/main/b.ts': 'export const b = 1\n',
      'src/main/a.test.ts': "import './a'\nimport './b'\n",
      'src/shared/types.ts': 'export type T = 1\n',
      'node_modules/dep/index.ts': '',
      '.github/ci.ts': '',
      'root.ts': ''
    })
    const knowledge = await load()
    const snapshot = await knowledge.maintainVault(project)

    expect(snapshot.nodes.map((node) => node.path).filter((path) => path.startsWith('generated/src')).sort()).toEqual([
      'generated/src.md',
      'generated/src/main.md',
      'generated/src/shared.md'
    ])
    const edges = snapshot.edges.map((edge) => `${edge.from} -> ${edge.to}`)
    expect(edges).toEqual(
      expect.arrayContaining([
        'Home.md -> generated/src.md',
        'generated/src.md -> generated/src/main.md',
        'generated/src.md -> generated/src/shared.md',
        'generated/src/main.md -> generated/src.md',
        'generated/src/main.md -> generated/src/shared.md'
      ])
    )
    expect(edges).not.toContain('generated/src/shared.md -> generated/src/main.md')
    const main = await generated('src/main.md')
    expect(main).toContain('- [[generated/src/shared.md|shared]] (2 imports)')
    // The test's import of b.ts doesn't count.
    expect(main).toContain('- `b.ts`: imported by 2 files')
    expect(main).toContain('- `a.ts`')
    expect(main).toContain('- `a.test.ts` (test)')
    expect(await generated('src/shared.md')).toContain('- `types.ts`: imported by 2 files')
    expect(existsSync(join(root, 'knowledge', 'generated', 'node_modules.md'))).toBe(false)
  })

  it('describes a folder with the lines of the rules file and README about it', async () => {
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
    await knowledge.maintainVault(project)

    const main = await generated('src/main.md')
    expect(main).toContain('\nMain process: `src/main` (persistence, IPC)\n')
    expect(main.indexOf('Main process')).toBeLessThan(main.indexOf('## In'))
    expect(main).toContain('\nBuild output lands next to src/main.\n')
    expect(main).not.toContain('helpers')
    expect(main).not.toContain('not this')
    // No line names the folder, so one about a file directly in it stands in.
    expect(await generated('src/shared.md')).toContain('\nShared types: `src/shared/types.ts`\n')
    expect(await generated('src.md')).not.toContain('Main process')
  })

  it('links an area to the areas it imports from, not to every other area', async () => {
    await indexFiles({ 'src/a.ts': "import { b } from '../lib/b'\n", 'lib/b.ts': '', 'tools/c.ts': '' })
    const knowledge = await load()
    await knowledge.maintainVault(project)
    const src = await generated('src.md')
    expect(src).toContain('[[generated/lib.md|lib]]')
    expect(src).not.toContain('generated/tools.md')
    expect(await generated('tools.md')).not.toContain('generated/src.md')
  })

  it('drops the notes of folders that left the index, and the folders under generated/ that emptied', async () => {
    await indexFiles({ 'src/main/a.ts': '', 'src/ui/web/b.ts': '' })
    const knowledge = await load()
    await knowledge.maintainVault(project)
    expect(existsSync(join(root, 'knowledge', 'generated', 'src', 'ui', 'web.md'))).toBe(true)

    await rm(join(root, 'src', 'ui'), { recursive: true })
    await indexFiles({ 'src/main/a.ts': '' })
    await knowledge.maintainVault(project)
    expect(existsSync(join(root, 'knowledge', 'generated', 'src', 'ui'))).toBe(false)
    expect(existsSync(join(root, 'knowledge', 'generated', 'src', 'ui.md'))).toBe(false)
    expect(existsSync(join(root, 'knowledge', 'generated', 'src', 'main.md'))).toBe(true)
  })

  it('past the note budget, lists the deepest folders in their parent without a note', async () => {
    await indexFiles(Object.fromEntries(Array.from({ length: 125 }, (_, i) => [`src/m${i}/f.ts`, ''])))
    const knowledge = await load()
    const snapshot = await knowledge.maintainVault(project)
    expect(snapshot.nodes.filter((node) => node.path.startsWith('generated/src/'))).toHaveLength(120)
    expect(await generated('src.md')).toMatch(/^- `m\d+\/`$/m)
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
  /** The requests for module descriptions. The one for the features comes after them. */
  const modulePrompts = (): string[] =>
    stub.ask.mock.calls.map(([, prompt]) => prompt as string).filter((prompt) => prompt.includes('module notes'))
  const describedMain = (): Promise<void> =>
    vi.waitFor(async () => expect(await generated('src/main.md')).toContain('Runs the main process.'), {
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
    const main = await generated('src/main.md')
    expect(main).toContain('- `config.ts`: Reads the config file.')
    expect(main.indexOf('Runs the main process.')).toBeLessThan(main.indexOf('## In'))
    expect(await generated('src/shared.md')).toContain('- `types.ts`: The shared types.')
    expect(await generated('Architecture.md')).toContain('- [[generated/src.md|src]] — Holds the app.\n')
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
      JSON.stringify({ modules: [{ path: 'src/main', about: 'Runs the main process.', files: { 'extra.ts': 'The extras.' } }] })
    )
    await indexFiles({ 'src/main/config.ts': '', 'src/main/extra.ts': '', 'src/shared/types.ts': '' })
    await knowledge.maintainVault(project)
    await vi.waitFor(async () => expect(await generated('src/main.md')).toContain('- `extra.ts`: The extras.'), {
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
    expect(await generated('src/shared.md')).toContain('Types both processes share.')
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

describe('features', () => {
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
        files: ['src/main/config.ts', 'docs/guide.md', 'src/main/gone.ts']
      },
      { name: 'Guesswork', about: 'Nothing behind it.', files: ['src/nowhere.ts'] }
    ]
  })
  const prompts = (about: string): string[] =>
    stub.ask.mock.calls.map(([, prompt]) => prompt as string).filter((prompt) => prompt.includes(about))
  const written = (text: string): Promise<void> =>
    vi.waitFor(async () => expect(await generated('features/Settings.md')).toContain(text), { timeout: 5_000, interval: 50 })

  beforeEach(async () => {
    stub.ask.mockImplementation(async (_project: Project, prompt: string) =>
      prompt.includes('feature notes') ? features : modules
    )
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n\nHow to set the app up.\n')
  })

  it('come from the model once the modules are described, each a note linked from the overview and to its modules', async () => {
    await indexFiles({ 'src/main/config.ts': '' })
    let knowledge = await load()
    await knowledge.setKnowledgeActiveProject('p1')
    await written('Keeps what the user chose.')
    const snapshot = await knowledge.maintainVault(project)

    expect(await generated('features/Settings.md')).toContain(
      [
        '## Where it lives',
        '',
        '- [[generated/src/main.md|src/main]]',
        '  - `config.ts`: Reads the config file.',
        '- [[generated/docs.md|docs]]',
        '  - `guide.md`: How to set the app up.',
        ''
      ].join('\n')
    )
    expect(existsSync(join(root, 'knowledge', 'generated', 'features', 'Guesswork.md'))).toBe(false)
    expect(await generated('Overview.md')).toContain(
      '## What it does\n\n- [[generated/features/Settings.md|Settings]] — Keeps what the user chose.\n'
    )
    expect(snapshot.nodes.find((node) => node.path === 'generated/features/Settings.md')?.tags).toContain('feature')
    expect(snapshot.edges).toContainEqual({ from: 'generated/Overview.md', to: 'generated/features/Settings.md' })
    expect(snapshot.edges).toContainEqual({ from: 'generated/features/Settings.md', to: 'generated/src/main.md' })
    expect(prompts('feature notes')).toHaveLength(1)
    expect(prompts('feature notes')[0]).toContain('## src/main/\nRuns the main process.\n- src/main/config.ts: Reads the config file.\n')
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
    await vi.waitFor(() => expect(prompts('feature notes')).toHaveLength(2), { timeout: 5_000, interval: 50 })
    expect(prompts('feature notes')[1]).toContain('- src/main/extra.ts: The extras.')
    expect(prompts('module notes')).toHaveLength(2)
    knowledge.stopKnowledgeWatchers()
  })

  it('describe an area the index holds nothing of from its file names and the first lines of its prose', async () => {
    await indexFiles({ 'src/main/config.ts': '' })
    const knowledge = await load()
    await knowledge.setKnowledgeActiveProject('p1')
    await vi.waitFor(async () => expect(await generated('docs.md')).toContain('The written guides.'), {
      timeout: 5_000,
      interval: 50
    })
    expect(await generated('docs.md')).toContain('- `docs/guide.md`: How to set the app up.')
    expect(prompts('module notes')[0]).toContain('## Module docs/\n### guide.md\n# Guide\nHow to set the app up.\n')
    expect(await generated('Architecture.md')).toContain('- [[generated/docs.md|docs]] — The written guides.\n')
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
