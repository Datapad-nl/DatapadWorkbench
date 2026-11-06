import { Menu, clipboard, ipcMain, shell } from 'electron'
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron'
import { navigateBrowser, sanitizeUrl } from './browser'

const SEARCH_URL = 'https://www.google.com/search?q='

/** Windows showing a chat composer right now, so a selection can be quoted into it. */
const quoteTargets = new WeakSet<WebContents>()
let listening = false

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > 24 ? `${flat.slice(0, 24).trimEnd()}…` : flat
}

/** Right-click shows a native menu: spelling, links, editing, and actions on the selected text. */
export function attachContextMenu(window: BrowserWindow): void {
  if (!listening) {
    listening = true
    ipcMain.on('contextMenu:quoteTarget', (event, on: unknown) => {
      if (on === true) quoteTargets.add(event.sender)
      else quoteTargets.delete(event.sender)
    })
  }
  const contents = window.webContents
  // A reload drops the composer; the new page says again once it has one.
  contents.on('did-navigate', () => quoteTargets.delete(contents))
  contents.on('context-menu', (_event, params) => {
    const template = menuFor(contents, params)
    if (template.length) Menu.buildFromTemplate(template).popup({ window })
  })
}

function menuFor(contents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
  const sections: MenuItemConstructorOptions[][] = []
  const text = params.selectionText.trim()

  if (params.misspelledWord) {
    const word = params.misspelledWord
    const fixes = params.dictionarySuggestions.map(
      (fix): MenuItemConstructorOptions => ({ label: fix, click: () => contents.replaceMisspelling(fix) })
    )
    sections.push([
      ...(fixes.length ? fixes : [{ label: 'No Guesses Found', enabled: false }]),
      { label: 'Add to Dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(word) }
    ])
  }

  const link = params.linkURL ? sanitizeUrl(params.linkURL) : null
  if (link) {
    sections.push([
      { label: 'Open Link', click: () => void navigateBrowser(link) },
      { label: 'Open Link in Default Browser', click: () => void shell.openExternal(link) },
      { label: 'Copy Link', click: () => clipboard.writeText(link) }
    ])
  }

  if (params.mediaType === 'image' && params.hasImageContents) {
    sections.push([{ label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) }])
  }

  if (params.isEditable) {
    const flags = params.editFlags
    sections.push(
      [
        { role: 'undo', enabled: flags.canUndo },
        { role: 'redo', enabled: flags.canRedo }
      ],
      [
        { role: 'cut', enabled: flags.canCut },
        { role: 'copy', enabled: flags.canCopy },
        { role: 'paste', enabled: flags.canPaste },
        { role: 'selectAll', enabled: flags.canSelectAll }
      ]
    )
  } else if (text) {
    const copy: MenuItemConstructorOptions[] = [{ role: 'copy' }]
    if (quoteTargets.has(contents)) {
      copy.push({ label: 'Quote in Reply', click: () => contents.send('contextMenu:quote', params.selectionText) })
    }
    sections.push(copy)
  }

  if (text) {
    const lookups: MenuItemConstructorOptions[] = [
      { label: 'Search with Google', click: () => void navigateBrowser(SEARCH_URL + encodeURIComponent(text)) }
    ]
    if (process.platform === 'darwin') {
      lookups.push({ label: `Look Up “${excerpt(text)}”`, click: () => contents.showDefinitionForSelection() })
    }
    sections.push(lookups)
  }

  return sections.flatMap((section, index) =>
    index ? [{ type: 'separator' } as MenuItemConstructorOptions, ...section] : section
  )
}
