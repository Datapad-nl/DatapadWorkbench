import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setFlagsFromString } from 'v8'
import { runInNewContext } from 'vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const stub = vi.hoisted(() => ({ root: '' }))
vi.mock('./store', () => ({
  getChat: async () => ({}),
  listProjects: async () => [
    { id: 'a', path: `${stub.root}/a` },
    { id: 'b', path: `${stub.root}/b` }
  ]
}))

import { searchProjectFiles } from './files'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(stub.root, { recursive: true, force: true })
})

describe('project file search', () => {
  it('lets go of a folder’s file list once it has expired and another folder was searched', async () => {
    stub.root = mkdtempSync(join(tmpdir(), 'files-test-'))
    for (const name of ['a', 'b']) {
      mkdirSync(join(stub.root, name))
      writeFileSync(join(stub.root, name, `${name}.md`), '')
    }
    let clock = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)

    const held = new WeakRef((await searchProjectFiles('a', 'a.md'))[0])
    expect(held.deref()?.name).toBe('a.md')
    clock += 60_000
    expect((await searchProjectFiles('b', 'b.md'))[0].name).toBe('b.md')

    // A WeakRef keeps its target until the current job ends.
    await new Promise((resolve) => setTimeout(resolve, 0))
    gc()
    expect(held.deref()).toBeUndefined()
  })
})
