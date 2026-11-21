import { describe, expect, it } from 'vitest'
import { addTab, closeTab, emptyTabList, parseSavedTabs, selectTab, type TabList } from './browserTabs'

function ids(): () => string {
  let next = 0
  return () => `new${++next}`
}

const clean = (url: string): string | null => (/^https?:\/\//.test(url) ? url : null)

function list(...tabIds: string[]): TabList {
  return { active: tabIds[0], tabs: tabIds.map((id) => ({ id, url: `https://${id}.test/`, title: id })) }
}

describe('saved browser tabs', () => {
  it('reads the tabs of every scope', () => {
    const raw = {
      tabs: {
        p1: {
          active: 'b',
          tabs: [
            { id: 'a', url: 'https://a.test/', title: 'A' },
            { id: 'b', url: 'https://b.test/', title: 'B' }
          ]
        }
      }
    }
    expect(parseSavedTabs(raw, clean, ids())).toEqual(raw.tabs)
  })

  it('turns the old one page per scope into one tab per scope', () => {
    const raw = { urls: { p1: 'https://a.test/', p2: 'file:///etc/passwd', p3: 4 } }
    expect(parseSavedTabs(raw, clean, ids())).toEqual({
      p1: { active: 'new1', tabs: [{ id: 'new1', url: 'https://a.test/', title: '' }] }
    })
  })

  it('keeps a tab without a valid address as an empty tab', () => {
    const raw = {
      tabs: {
        p1: {
          active: 'a',
          tabs: [
            { id: 'a', url: 'javascript:alert(1)', title: 'A' },
            { id: 'b', url: 'https://b.test/' }
          ]
        },
        p2: { active: 'c', tabs: [{ id: 'c' }] }
      }
    }
    expect(parseSavedTabs(raw, clean, ids())).toEqual({
      p1: {
        active: 'a',
        tabs: [
          { id: 'a', url: '', title: 'A' },
          { id: 'b', url: 'https://b.test/', title: '' }
        ]
      },
      p2: { active: 'c', tabs: [{ id: 'c', url: '', title: '' }] }
    })
  })

  it('repairs missing or repeated ids, an unknown active tab and scopes without tabs', () => {
    const raw = {
      tabs: {
        p1: { active: 'gone', tabs: [{ id: 'a' }, { id: 'a' }, { url: 'https://c.test/' }, null] },
        p2: { active: 'x', tabs: [] },
        p3: 'nonsense'
      }
    }
    const parsed = parseSavedTabs(raw, clean, ids())
    expect(Object.keys(parsed)).toEqual(['p1'])
    expect(parsed.p1.tabs.map((tab) => tab.id)).toEqual(['a', 'new1', 'new2'])
    expect(parsed.p1.active).toBe('a')
  })

  it('reads nothing from a file that is not an object', () => {
    expect(parseSavedTabs(null, clean, ids())).toEqual({})
    expect(parseSavedTabs('x', clean, ids())).toEqual({})
    expect(parseSavedTabs({}, clean, ids())).toEqual({})
  })
})

describe('tab list', () => {
  it('starts with one empty tab', () => {
    expect(emptyTabList(ids())).toEqual({ active: 'new1', tabs: [{ id: 'new1', url: '', title: '' }] })
  })

  it('appends a new tab and selects it', () => {
    const next = addTab(list('a', 'b'), { id: 'c', url: '', title: '' })
    expect(next.tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c'])
    expect(next.active).toBe('c')
  })

  it('selects only a tab it has', () => {
    expect(selectTab(list('a', 'b'), 'b').active).toBe('b')
    const before = list('a', 'b')
    expect(selectTab(before, 'z')).toBe(before)
  })

  it('selects the tab after the closed active one, or the one before when it was last', () => {
    expect(closeTab(selectTab(list('a', 'b', 'c'), 'b'), 'b', ids()).active).toBe('c')
    expect(closeTab(selectTab(list('a', 'b', 'c'), 'c'), 'c', ids()).active).toBe('b')
  })

  it('keeps the active tab when another one closes', () => {
    const next = closeTab(selectTab(list('a', 'b', 'c'), 'c'), 'a', ids())
    expect(next).toEqual({ active: 'c', tabs: list('b', 'c').tabs })
  })

  it('leaves one fresh empty tab when the last one closes', () => {
    expect(closeTab(list('a'), 'a', ids())).toEqual({ active: 'new1', tabs: [{ id: 'new1', url: '', title: '' }] })
  })

  it('changes nothing when the tab is not there', () => {
    const before = list('a')
    expect(closeTab(before, 'z', ids())).toBe(before)
  })
})
