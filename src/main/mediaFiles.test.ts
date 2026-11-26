import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseFileViewUrl } from '../shared/fileView'
import { resolveMediaFile, resolveRootFile } from './mediaFiles'

let base = ''
let root = ''
let worktree = ''
let outside = ''

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'wb-files-')))
  root = join(base, 'project')
  worktree = join(base, 'worktree')
  outside = join(base, 'outside')
  for (const dir of [join(root, 'docs', 'design'), join(worktree, 'docs'), outside]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'docs', 'design', 'flow-platform.md'), '# Flow')
  writeFileSync(join(root, 'docs', 'shot.png'), 'png')
  writeFileSync(join(root, 'Makefile'), 'all:')
  writeFileSync(join(worktree, 'docs', 'only-here.md'), 'wt')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  writeFileSync(join(base, 'sibling.txt'), 'secret')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'))
  symlinkSync(outside, join(root, 'linked-dir'))
  symlinkSync(join(root, 'docs', 'design', 'flow-platform.md'), join(root, 'alias.md'))
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('resolveRootFile', () => {
  it('finds a relative, absolute, ./ or file: path inside a root, with the root it is in', () => {
    const file = join(root, 'docs', 'design', 'flow-platform.md')
    for (const src of [
      'docs/design/flow-platform.md',
      './docs/design/flow-platform.md',
      file,
      pathToFileURL(file).href,
      'docs/../docs/design/flow-platform.md'
    ]) {
      expect(resolveRootFile([root], src), src).toEqual({ root, file })
    }
    expect(resolveRootFile([root], 'Makefile')).toEqual({ root, file: join(root, 'Makefile') })
  })

  it('tries the roots in order', () => {
    expect(resolveRootFile([worktree, root], 'docs/only-here.md')).toEqual({
      root: worktree,
      file: join(worktree, 'docs', 'only-here.md')
    })
    expect(resolveRootFile([worktree, root], 'docs/shot.png')?.root).toBe(root)
  })

  it('follows a symlink that stays inside', () => {
    expect(resolveRootFile([root], 'alias.md')?.file).toBe(join(root, 'docs', 'design', 'flow-platform.md'))
  })

  it('never reaches outside the roots', () => {
    for (const src of [
      '../sibling.txt',
      'docs/../../sibling.txt',
      '../outside/secret.txt',
      join(outside, 'secret.txt'),
      pathToFileURL(join(outside, 'secret.txt')).href,
      'leak.txt',
      'linked-dir/secret.txt',
      '/etc/passwd',
      '~/.ssh/id_rsa',
      '%2e%2e/sibling.txt'
    ]) {
      expect(resolveRootFile([root], src), src).toBeNull()
    }
  })

  it('serves no directory, no URL and nothing without a root', () => {
    expect(resolveRootFile([root], 'docs')).toBeNull()
    expect(resolveRootFile([root], 'https://a.test/x.md')).toBeNull()
    expect(resolveRootFile([], 'docs/shot.png')).toBeNull()
    expect(resolveRootFile([join(base, 'missing')], 'docs/shot.png')).toBeNull()
  })

  it('applies the filter', () => {
    expect(resolveRootFile([root], 'Makefile', () => false)).toBeNull()
  })

  it('keeps an address of the file view inside the root, however it is encoded', () => {
    const chat = '3f2b8c1e-0d4a-4c51-9a7e-2b6f0e1d9c88'
    for (const url of [
      `workbench-file://${chat}/../sibling.txt`,
      `workbench-file://${chat}/%2e%2e/sibling.txt`,
      `workbench-file://${chat}/docs/%2e%2e/%2e%2e/sibling.txt`
    ]) {
      const parsed = parseFileViewUrl(url)
      const found = parsed ? resolveRootFile([root], `./${parsed.path}`) : null
      expect(found, url).toBeNull()
    }
  })
})

describe('resolveMediaFile', () => {
  it('still takes only media', () => {
    expect(resolveMediaFile([root], 'docs/shot.png')).toBe(join(root, 'docs', 'shot.png'))
    expect(resolveMediaFile([root], 'docs/design/flow-platform.md')).toBeNull()
  })
})
