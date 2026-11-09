import { describe, expect, it } from 'vitest'
import { batches, outline, parseSummaries, readStored, storedText, type ModuleBrief } from './moduleSummaries'

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
