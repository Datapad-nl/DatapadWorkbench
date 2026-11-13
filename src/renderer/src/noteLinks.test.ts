import { describe, expect, it } from 'vitest'
import type { KnowledgeNode } from '../../shared/types'
import { linkNotes, NOTE_HREF } from './noteLinks'

const node = (path: string, title: string): KnowledgeNode => ({ id: path, path, title, kind: 'generated', tags: [] })
const nodes = [
  node('Home.md', 'Demo'),
  node('generated/Architecture.md', 'Architecture'),
  node('generated/src.md', 'src'),
  node('generated/src/main.md', 'src/main'),
  node('generated/src/renderer/src.md', 'src/renderer/src'),
  node('notes/Idea (draft).md', 'Idea (draft)')
]
const link = (label: string, id: string): string => `[${label}](${NOTE_HREF}${encodeURIComponent(id).replace(/\(/g, '%28').replace(/\)/g, '%29')})`

describe('linkNotes', () => {
  it('links path links, titles and file names to their notes', () => {
    const body = '- [[generated/src/main.md|main]]\n- [[Architecture]]\n- [[Home]]\n- [[Idea (draft)]]'
    expect(linkNotes(body, 'generated/src.md', nodes)).toBe(
      [
        `- ${link('main', 'generated/src/main.md')}`,
        `- ${link('Architecture', 'generated/Architecture.md')}`,
        `- ${link('Home', 'Home.md')}`,
        `- ${link('Idea (draft)', 'notes/Idea (draft).md')}`
      ].join('\n')
    )
  })

  it('leaves a link to no note, or to several, as its text', () => {
    // Two notes are called src, by title or by file name.
    expect(linkNotes('[[Missing|gone]] and [[src]]', 'Home.md', nodes)).toBe('gone and src')
  })

  it('drops Obsidian comments outside code', () => {
    const body = 'Intro\n\n%% datapad-workbench:start %%\n\nText %%inline\nnote%% end\n\n`%% kept %%`'
    expect(linkNotes(body, 'Home.md', nodes)).toBe('Intro\n\n\n\nText  end\n\n`%% kept %%`')
  })

  it('leaves code and embeds as written', () => {
    const body = '`[[Architecture]]`\n\n```\n[[Architecture]]\n```\n\n![[Architecture]]'
    expect(linkNotes(body, 'Home.md', nodes)).toBe(body)
  })
})
