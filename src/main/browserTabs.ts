/** A tab as saved: its last http(s) address ('' for an empty tab) and title. */
export type SavedTab = { id: string; url: string; title: string }

/** A scope's tabs in order, and the one it shows. `active` is always the id of one of `tabs`. */
export type TabList = { active: string; tabs: SavedTab[] }

export function emptyTabList(newId: () => string): TabList {
  const tab = { id: newId(), url: '', title: '' }
  return { active: tab.id, tabs: [tab] }
}

/**
 * Reads `browser.json`: `{ tabs: { [scope]: TabList } }`, or the older `{ urls: { [scope]: url } }`,
 * which becomes one tab per scope so nobody loses their page.
 */
export function parseSavedTabs(
  raw: unknown,
  clean: (url: string) => string | null,
  newId: () => string
): Record<string, TabList> {
  const out: Record<string, TabList> = {}
  if (!raw || typeof raw !== 'object') return out
  const body = raw as { tabs?: unknown; urls?: unknown }

  if (body.tabs && typeof body.tabs === 'object') {
    for (const [scope, value] of Object.entries(body.tabs as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const row = value as { active?: unknown; tabs?: unknown }
      if (!Array.isArray(row.tabs)) continue
      const seen = new Set<string>()
      const tabs: SavedTab[] = []
      for (const item of row.tabs as unknown[]) {
        if (!item || typeof item !== 'object') continue
        const tab = item as { id?: unknown; url?: unknown; title?: unknown }
        // A missing or repeated id would make two tabs one, so such a tab gets a fresh id.
        const id = typeof tab.id === 'string' && tab.id && !seen.has(tab.id) ? tab.id : newId()
        seen.add(id)
        tabs.push({
          id,
          url: (typeof tab.url === 'string' ? clean(tab.url) : null) ?? '',
          title: typeof tab.title === 'string' ? tab.title : ''
        })
      }
      if (tabs.length === 0) continue
      const active = tabs.some((tab) => tab.id === row.active) ? (row.active as string) : tabs[0].id
      out[scope] = { active, tabs }
    }
    return out
  }

  // The oldest single `{ url }` belonged to no project, so it is left out.
  if (body.urls && typeof body.urls === 'object') {
    for (const [scope, url] of Object.entries(body.urls as Record<string, unknown>)) {
      const href = typeof url === 'string' ? clean(url) : null
      if (!href) continue
      const tab = { id: newId(), url: href, title: '' }
      out[scope] = { active: tab.id, tabs: [tab] }
    }
  }
  return out
}

/** Appends a tab and selects it. */
export function addTab(list: TabList, tab: SavedTab): TabList {
  return { active: tab.id, tabs: [...list.tabs, tab] }
}

/** Selects a tab; an id not in the list changes nothing. */
export function selectTab(list: TabList, id: string): TabList {
  return list.tabs.some((tab) => tab.id === id) ? { ...list, active: id } : list
}

/**
 * Removes a tab. Closing the active one selects the tab after it, or the one before when it was last;
 * closing the only tab leaves one fresh empty tab.
 */
export function closeTab(list: TabList, id: string, newId: () => string): TabList {
  const index = list.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return list
  const tabs = list.tabs.filter((tab) => tab.id !== id)
  if (tabs.length === 0) return emptyTabList(newId)
  if (list.active !== id) return { ...list, tabs }
  return { active: tabs[Math.min(index, tabs.length - 1)].id, tabs }
}
