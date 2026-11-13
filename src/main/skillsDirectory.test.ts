import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' }, shell: {} }))

import { downloadSkill, previewSkill, searchSkills } from './skillsDirectory'

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })

function serve(routes: Record<string, () => Response>): string[] {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url)
      return routes[url]?.() ?? new Response('<html>not found</html>', { status: 404 })
    })
  )
  return asked
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('skills.sh', () => {
  it('searches by name and keeps only complete listings', async () => {
    serve({
      'https://skills.sh/api/search?q=react&limit=40': () =>
        json({
          skills: [
            { id: 'vercel-labs/agent-skills/react', source: 'vercel-labs/agent-skills', skillId: 'react', installs: 9 },
            { id: 'broken' }
          ]
        })
    })
    expect(await searchSkills(' react ')).toEqual([
      { id: 'vercel-labs/agent-skills/react', source: 'vercel-labs/agent-skills', skill: 'react', installs: 9 }
    ])
    expect(await searchSkills('r')).toEqual([])
  })

  it('downloads a GitHub skill from skills.sh and previews its SKILL.md', async () => {
    serve({
      'https://skills.sh/api/download/mattpocock/skills/grill-me': () =>
        json({
          files: [
            { path: 'SKILL.md', contents: '---\nname: grill-me\ndescription: "Ask hard questions."\n---\nGrill.\n' },
            { path: 'agents/openai.yaml', contents: 'x: 1' }
          ]
        })
    })
    expect(await previewSkill('mattpocock/skills', 'grill-me')).toEqual({
      name: 'grill-me',
      description: 'Ask hard questions.',
      body: 'Grill.\n',
      source: 'mattpocock/skills',
      skill: 'grill-me',
      files: ['SKILL.md', 'agents/openai.yaml']
    })
  })

  it('reads a skill a site publishes itself, from its .well-known index', async () => {
    const asked = serve({
      'https://example.com/.well-known/agent-skills/index.json': () => new Response('<html></html>', { status: 200 }),
      'https://example.com/.well-known/skills/index.json': () =>
        json({ skills: [{ name: 'taste', description: 'd', files: ['SKILL.md', 'refs/a b.md'] }] }),
      'https://example.com/.well-known/skills/taste/SKILL.md': () => new Response('---\nname: taste\n---\nBody'),
      'https://example.com/.well-known/skills/taste/refs/a%20b.md': () => new Response('A')
    })
    const files = await downloadSkill('example.com', 'taste')
    expect(files.map((file) => [file.path, file.data.toString()])).toEqual([
      ['SKILL.md', '---\nname: taste\n---\nBody'],
      ['refs/a b.md', 'A']
    ])
    expect(asked[0]).toBe('https://example.com/.well-known/agent-skills/index.json')

    await expect(downloadSkill('example.com', 'missing')).rejects.toThrow(/does not list/)
    await expect(downloadSkill('evil.com/../x', 'a')).rejects.toThrow(/not a GitHub repo/)
    await expect(downloadSkill('owner/repo', '..')).rejects.toThrow(/not a GitHub repo/)
    await expect(downloadSkill('localhost', 'a')).rejects.toThrow(/not a site/)
  })

  it('refuses a well-known file path that leaves the skill folder', async () => {
    serve({
      'https://example.com/.well-known/agent-skills/index.json': () =>
        json({ skills: [{ name: 'taste', files: ['SKILL.md', '../../index.json'] }] })
    })
    await expect(downloadSkill('example.com', 'taste')).rejects.toThrow(/outside/)
  })
})
