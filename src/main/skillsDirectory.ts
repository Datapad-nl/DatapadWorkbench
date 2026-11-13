import type { SkillListing, SkillPreview } from '../shared/types'
import { readSkill, safeSkillPath, type SkillFile } from './botSkills'

/** skills.sh, the directory of Agent Skills. Its search and download need no key. */
const SKILLS_SH = 'https://skills.sh'
const SEARCH_LIMIT = 40
const TIMEOUT = 15_000
const MAX_FILES = 300
const MAX_BYTES = 20 * 1024 * 1024
/** Where a site that publishes its own skills lists them, newest place first. */
const WELL_KNOWN = ['.well-known/agent-skills', '.well-known/skills']

async function get(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) })
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`)
  return response
}

/** Skills whose name matches `query`, most installed first as skills.sh ranks them. */
export async function searchSkills(query: string): Promise<SkillListing[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const params = new URLSearchParams({ q, limit: String(SEARCH_LIMIT) })
  const result = (await (await get(`${SKILLS_SH}/api/search?${params}`)).json()) as {
    skills?: Array<{ id?: string; source?: string; skillId?: string; installs?: number }>
  }
  return (result.skills ?? []).flatMap((item) =>
    item.id && item.source && item.skillId
      ? [{ id: item.id, source: item.source, skill: item.skillId, installs: item.installs ?? 0 }]
      : []
  )
}

/** A skill from a GitHub repo, all its files as skills.sh keeps them. */
async function fromSkillsSh(source: string, skill: string): Promise<SkillFile[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(source) || source.split('/').some((part) => /^\.+$/.test(part)) || /^\.+$/.test(skill)) {
    throw new Error(`${source} is not a GitHub repo.`)
  }
  const path = [...source.split('/'), skill].map(encodeURIComponent).join('/')
  const result = (await (await get(`${SKILLS_SH}/api/download/${path}`)).json()) as {
    files?: Array<{ path?: string; contents?: string }>
  }
  return (result.files ?? []).map((file) => ({ path: String(file.path ?? ''), data: Buffer.from(file.contents ?? '', 'utf8') }))
}

/** A skill a site publishes itself, from the index in its `.well-known` folder. */
async function fromWellKnown(domain: string, skill: string): Promise<SkillFile[]> {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw new Error(`${domain} is not a site skills can come from.`)
  for (const folder of WELL_KNOWN) {
    const base = `https://${domain}/${folder}`
    const index = await get(`${base}/index.json`)
      .then((response) => response.json() as Promise<{ skills?: Array<{ name?: string; files?: unknown }> }>)
      .catch(() => null)
    const entry = index?.skills?.find((item) => item.name === skill)
    if (!entry) continue
    if (!Array.isArray(entry.files)) {
      throw new Error(`${domain} serves ${skill} as an archive, which can't be added here. Use "npx skills add" instead.`)
    }
    const paths = entry.files.map(String)
    if (paths.length > MAX_FILES) throw new Error(`${skill} has more than ${MAX_FILES} files.`)
    return Promise.all(
      paths.map(async (path) => {
        if (!safeSkillPath(path)) throw new Error('The skill has a file outside its own folder.')
        const response = await get(`${base}/${encodeURIComponent(skill)}/${path.split('/').map(encodeURIComponent).join('/')}`)
        return { path, data: Buffer.from(await response.arrayBuffer()) }
      })
    )
  }
  throw new Error(`${domain} does not list a skill named ${skill}.`)
}

/** Every file of a listed skill. `source` is `owner/repo` for GitHub, or a domain. */
export async function downloadSkill(source: string, skill: string): Promise<SkillFile[]> {
  const files = source.includes('/') ? await fromSkillsSh(source, skill) : await fromWellKnown(source, skill)
  if (files.length > MAX_FILES) throw new Error(`${skill} has more than ${MAX_FILES} files.`)
  if (files.reduce((sum, file) => sum + file.data.length, 0) > MAX_BYTES) throw new Error(`${skill} is larger than 20 MB.`)
  if (!files.some((file) => file.path === 'SKILL.md')) throw new Error(`${skill} has no SKILL.md.`)
  return files
}

/** What a listed skill says it does and which files come with it, before it is added. */
export async function previewSkill(source: string, skill: string): Promise<SkillPreview> {
  const files = await downloadSkill(source, skill)
  const skillMd = files.find((file) => file.path === 'SKILL.md') as SkillFile
  return {
    ...readSkill(skill, skillMd.data.toString('utf8')),
    name: skill,
    source,
    skill,
    files: files.map((file) => file.path).sort()
  }
}
