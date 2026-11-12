import { describe, expect, it } from 'vitest'
import {
  batches,
  featurePrompt,
  featuresSignature,
  outline,
  parseFeatures,
  parseSummaries,
  readStored,
  readStoredFeatures,
  storedText,
  type ModuleBrief,
  type StoredSummary
} from './moduleSummaries'

const brief = (path: string, files: string[], line = 'export const x = 1'): ModuleBrief => ({
  path,
  docs: [],
  folders: [],
  uses: [],
  files: files.map((name) => ({ name, outline: [line] }))
})

describe('outline', () => {
  it('lists top-level declarations after the first line of the comment above each', () => {
    const source = [
      "import { join } from 'path'",
      '',
      '/**',
      ' * Reads the config.',
      ' * Falls back to defaults.',
      ' */',
      'export function readConfig(path: string): Config {',
      '  const inner = 1',
      '}',
      '',
      '/** One line. */',
      'export class Store {',
      '// Not above a declaration.',
      'run()',
      'const internal = 2'
    ].join('\n')
    expect(outline(source)).toEqual([
      '// Reads the config.',
      'export function readConfig(path: string): Config',
      '// One line.',
      'export class Store',
      'const internal = 2'
    ])
  })

  it('keeps what a file exports, then what is commented, in source order', () => {
    const source = [
      ...Array.from({ length: 8 }, (_, i) => `const plain${i} = ${i}`),
      '// Why this one matters.',
      'function helper() {',
      '}',
      'export function api() {',
      '}'
    ].join('\n')
    const lines = outline(source)
    expect(lines.filter((line) => !line.startsWith('//'))).toHaveLength(8)
    expect(lines.slice(-3)).toEqual(['// Why this one matters.', 'function helper()', 'export function api()'])
  })

  it('reads Python and Rust, and shows the first lines of a file without declarations', () => {
    expect(outline('# Loads data.\ndef load(path):\n    pass\n')).toEqual(['// Loads data.', 'def load(path):'])
    expect(outline('#[derive(Debug)]\npub struct Item {\n}\n')).toEqual(['pub struct Item'])
    expect(outline('\n:root {\n  --ink: #111;\n}\nbody {}\n')).toEqual([':root {', '--ink: #111;', '}'])
  })
})

describe('parseSummaries', () => {
  it('keeps the modules and files it asked about, from JSON wrapped in prose or a fence', () => {
    const raw = [
      'Here you go:',
      '```json',
      JSON.stringify({
        modules: [
          { path: 'src/main/', about: '  Runs the app.\n It starts windows. ', files: { 'a.ts': 'Starts it.', 'z.ts': 'Not asked.' } },
          { path: 'src/other', about: 'Not asked.' },
          { path: 'src/shared', about: '' }
        ]
      }),
      '```'
    ].join('\n')
    const parsed = parseSummaries(raw, [brief('src/main', ['a.ts', 'b.ts']), brief('src/shared', ['t.ts'])])
    expect([...parsed]).toEqual([['src/main', { about: 'Runs the app. It starts windows.', files: { 'a.ts': 'Starts it.' } }]])
  })

  it('finds nothing in a reply that is not JSON', () => {
    expect(parseSummaries('Sorry, I cannot help.', [brief('src', ['a.ts'])]).size).toBe(0)
  })
})

describe('batches', () => {
  it('groups modules up to the limit, and gives a bigger one a batch alone', () => {
    const small = brief('a', ['x.ts'])
    const big = brief('b', ['y.ts'], 'x'.repeat(500))
    expect(batches([small, small, big, small], 200).map((group) => group.map((item) => item.path))).toEqual([
      ['a', 'a'],
      ['b'],
      ['a']
    ])
  })
})

describe('stored summaries', () => {
  it('read back what was stored, and nothing from a broken file', () => {
    const summaries = new Map([['src', { signature: 's1', about: 'The app.', files: { 'a.ts': 'Does a.' } }]])
    expect(readStored(storedText(summaries))).toEqual(summaries)
    expect(readStored('{not json').size).toBe(0)
    expect(readStored(null).size).toBe(0)
  })
})

describe('features', () => {
  const summaries = new Map<string, StoredSummary>([
    ['src/main', { signature: 's1', about: 'Runs the main process.', files: { 'config.ts': 'Reads the config.' } }],
    ['src/ui', { signature: 's2', about: 'Draws the window.', files: { 'App.tsx': 'The root component.' } }]
  ])

  it('are asked for with what is written about each module and its files', () => {
    const prompt = featurePrompt('Demo', 'A test project.', summaries)
    expect(prompt).toContain('The project: A test project.')
    expect(prompt).toContain('## src/main/\nRuns the main process.\n- src/main/config.ts: Reads the config.\n')
    expect(prompt).toContain('## src/ui/\nDraws the window.\n- src/ui/App.tsx: The root component.\n')
  })

  it('past the limit, are asked for with the later modules but not their files', () => {
    const prompt = featurePrompt('Demo', null, summaries, 10)
    expect(prompt).toContain('- src/main/config.ts: Reads the config.')
    expect(prompt).toContain('## src/ui/\nDraws the window.\n')
    expect(prompt).not.toContain('App.tsx')
  })

  it('are read from a reply with the files the project has, without the ones that name none', () => {
    const known = new Set(['src/main/config.ts', 'src/ui/App.tsx'])
    const raw = `Here: ${JSON.stringify({
      features: [
        { name: 'Settings [beta]', about: 'Keeps what you chose.', files: ['src/main/config.ts', 'src/gone.ts', 'src/main/config.ts'] },
        { name: 'settings [beta]', about: 'The same again.', files: ['src/ui/App.tsx'] },
        { name: 'Guess', about: 'Nothing behind it.', files: ['src/nowhere.ts'] },
        { name: 'Window', files: ['src/ui/App.tsx'] }
      ]
    })}`
    expect(parseFeatures(raw, known)).toEqual([
      { name: 'Settings beta', about: 'Keeps what you chose.', related: [], files: ['src/main/config.ts'] }
    ])
    expect(parseFeatures('Sorry, no.', known)).toEqual([])
  })

  it('are read with the other concepts each names, also a later one, and not itself or one that was left out', () => {
    const known = new Set(['src/main/config.ts', 'src/ui/App.tsx'])
    const raw = JSON.stringify({
      features: [
        { name: 'Settings', about: 'Keeps what you chose.', related: ['window', 'Settings', 'Guess', 'Window', 7], files: ['src/main/config.ts'] },
        { name: 'Guess', about: 'Nothing behind it.', related: ['Settings'], files: ['src/nowhere.ts'] },
        { name: 'Window', about: 'Shows the app.', files: ['src/ui/App.tsx'] }
      ]
    })
    expect(parseFeatures(raw, known).map((feature) => [feature.name, feature.related])).toEqual([
      ['Settings', ['Window']],
      ['Window', []]
    ])
  })

  it('read back what was stored, next to the summaries', () => {
    const settings = { name: 'Settings', about: 'Keeps what you chose.', files: ['src/main/config.ts'] }
    const features = { signature: 'f1', list: [{ ...settings, related: ['Window'] }] }
    const text = storedText(summaries, features)
    expect(readStoredFeatures(text)).toEqual(features)
    // What an earlier version stored names no related concepts.
    expect(readStoredFeatures(JSON.stringify({ features: { signature: 'f0', list: [settings] } }))?.list).toEqual([
      { ...settings, related: [] }
    ])
    expect(readStored(text)).toEqual(summaries)
    expect(readStoredFeatures(storedText(summaries))).toBeNull()
    expect(readStoredFeatures(null)).toBeNull()
  })

  it('have a signature that changes when a module is described again', () => {
    const again = new Map(summaries).set('src/ui', { ...summaries.get('src/ui')!, signature: 's3' })
    expect(featuresSignature(new Map([...summaries].reverse()))).toBe(featuresSignature(summaries))
    expect(featuresSignature(again)).not.toBe(featuresSignature(summaries))
  })
})
