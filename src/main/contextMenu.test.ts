import { EventEmitter } from 'events'
import type { MenuItemConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  templates: [] as MenuItemConstructorOptions[][],
  ipc: null as unknown as EventEmitter,
  navigate: vi.fn()
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('events')
  fake.ipc = new EventEmitter()
  return {
    Menu: {
      buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
        fake.templates.push(template)
        return { popup: vi.fn() }
      }
    },
    clipboard: { writeText: vi.fn() },
    shell: { openExternal: vi.fn() },
    ipcMain: fake.ipc
  }
})

vi.mock('./browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./browser')>()),
  navigateBrowser: fake.navigate
}))

const { attachContextMenu } = await import('./contextMenu')

type Contents = EventEmitter & { send: ReturnType<typeof vi.fn> }

const noEdits = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canSelectAll: false
}

function params(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selectionText: '',
    isEditable: false,
    editFlags: noEdits,
    linkURL: '',
    misspelledWord: '',
    dictionarySuggestions: [],
    mediaType: 'none',
    hasImageContents: false,
    x: 0,
    y: 0,
    ...overrides
  }
}

function setup(): Contents {
  const contents = Object.assign(new EventEmitter(), { send: vi.fn() }) as Contents
  attachContextMenu({ webContents: contents } as never)
  return contents
}

function rightClick(contents: Contents, overrides: Record<string, unknown> = {}): MenuItemConstructorOptions[] | null {
  const before = fake.templates.length
  contents.emit('context-menu', {}, params(overrides))
  return fake.templates.length > before ? fake.templates[fake.templates.length - 1] : null
}

function names(template: MenuItemConstructorOptions[] | null): string[] {
  return (template ?? []).map((item) => item.label ?? item.role ?? item.type ?? '?')
}

function composerOpen(contents: Contents, open: boolean): void {
  fake.ipc.emit('contextMenu:quoteTarget', { sender: contents }, open)
}

beforeEach(() => {
  fake.templates.length = 0
  fake.navigate.mockReset()
})

describe('context menu', () => {
  it('shows nothing where there is nothing to act on', () => {
    expect(rightClick(setup())).toBeNull()
  })

  it('offers copy, quote and lookups for selected text while a composer is open', () => {
    const contents = setup()
    composerOpen(contents, true)
    const template = rightClick(contents, { selectionText: '  some reply text  ' })
    const expected = ['copy', 'Quote in Reply', 'separator', 'Search with Google']
    if (process.platform === 'darwin') expected.push('Look Up “some reply text”')
    expect(names(template)).toEqual(expected)

    template!.find((item) => item.label === 'Quote in Reply')!.click!({} as never, undefined, {} as never)
    expect(contents.send).toHaveBeenCalledWith('contextMenu:quote', '  some reply text  ')

    template!.find((item) => item.label === 'Search with Google')!.click!({} as never, undefined, {} as never)
    expect(fake.navigate).toHaveBeenCalledWith('https://www.google.com/search?q=some%20reply%20text')
  })

  it('leaves out quoting when no composer is open', () => {
    const contents = setup()
    composerOpen(contents, true)
    composerOpen(contents, false)
    expect(names(rightClick(contents, { selectionText: 'text' }))).not.toContain('Quote in Reply')
  })

  it('forgets the composer when the page reloads', () => {
    const contents = setup()
    composerOpen(contents, true)
    contents.emit('did-navigate')
    expect(names(rightClick(contents, { selectionText: 'text' }))).not.toContain('Quote in Reply')
  })

  it('offers editing in a text field, enabled by what the field allows', () => {
    const contents = setup()
    composerOpen(contents, true)
    const template = rightClick(contents, {
      isEditable: true,
      editFlags: { ...noEdits, canPaste: true, canSelectAll: true }
    })
    expect(names(template)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'selectAll'])
    expect(template!.filter((item) => item.enabled).map((item) => item.role)).toEqual(['paste', 'selectAll'])
  })

  it('puts spelling fixes first', () => {
    const template = rightClick(setup(), {
      isEditable: true,
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'tech']
    })
    expect(names(template).slice(0, 4)).toEqual(['the', 'tech', 'Add to Dictionary', 'separator'])
  })

  it('offers link actions for web links only', () => {
    const contents = setup()
    expect(names(rightClick(contents, { linkURL: 'https://example.com/a' }))).toEqual([
      'Open Link',
      'Open Link in Default Browser',
      'Copy Link'
    ])
    expect(rightClick(contents, { linkURL: 'javascript:alert(1)' })).toBeNull()
  })
})
