import { shell } from 'electron'
import { mkdir, readdir, readFile, rename, rm, stat } from 'fs/promises'
import { join } from 'path'
import type { BotSkill, SaveBotSkillInput } from '../shared/types'
import { botFolder, getBot } from './bots'
import { writeFileAtomic } from './storeIo'

/** Skill names as the Agent Skills format allows them: lowercase words joined by dashes. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_NAME = 64
const MAX_DESCRIPTION = 1024

function skillsDir(botId: string): string {
  return join(botFolder(botId), 'skills')
}

/** Frontmatter as entries: a `key:` line with the indented lines that continue it. */
type Entry = { key: string; lines: string[] }

function splitSkill(text: string): { entries: Entry[]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { entries: [], body: text }
  const entries: Entry[] = []
  for (const line of match[1].split(/\r?\n/)) {
    const key = /^([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1]
    if (key) entries.push({ key, lines: [line] })
    else if (entries.length > 0) entries[entries.length - 1].lines.push(line)
  }
  return { entries, body: text.slice(match[0].length).replace(/^\r?\n/, '') }
}

/** The value of a simple YAML scalar: plain, quoted, or a `>` / `|` block. */
function entryValue(entry: Entry | undefined): string {
  if (!entry) return ''
  const first = entry.lines[0].slice(entry.lines[0].indexOf(':') + 1).trim()
  const rest = entry.lines.slice(1).map((line) => line.trim())
  if (/^[>|][+-]?$/.test(first)) return rest.join(first.startsWith('>') ? ' ' : '\n').trim()
  const value = [first, ...rest].filter(Boolean).join(' ')
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value))
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  return value
}

function readSkill(dir: string, text: string): BotSkill {
  const { entries, body } = splitSkill(text)
  const find = (key: string): Entry | undefined => entries.find((entry) => entry.key === key)
  return { name: entryValue(find('name')) || dir, description: entryValue(find('description')), body }
}

/** The bot's own skills, from `skills/<name>/SKILL.md` in its folder. */
export async function listBotSkills(botId: string): Promise<BotSkill[]> {
  const root = skillsDir(botId)
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  const skills: BotSkill[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const text = await readFile(join(root, dir.name, 'SKILL.md'), 'utf8').catch(() => null)
    if (text !== null) skills.push({ ...readSkill(dir.name, text), name: dir.name })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/**
 * Writes a skill's SKILL.md, renaming its folder when the name changed. Frontmatter keys other than
 * name and description, such as `allowed-tools`, stay as they were.
 */
export async function saveBotSkill(input: SaveBotSkillInput): Promise<BotSkill> {
  await getBot(input.botId)
  const name = input.name.trim()
  const description = input.description.trim().replace(/\s+/g, ' ')
  if (!SKILL_NAME.test(name) || name.length > MAX_NAME) {
    throw new Error('Name the skill with lowercase letters, digits and dashes, like "weekly-report".')
  }
  if (!description) throw new Error('Describe what the skill does and when to use it.')
  if (description.length > MAX_DESCRIPTION) throw new Error('Keep the description under 1024 characters.')

  const root = skillsDir(input.botId)
  const previous = input.previousName?.trim() || null
  if (previous && !SKILL_NAME.test(previous)) throw new Error('Skill not found')
  const target = join(root, name)
  if (previous !== name && (await exists(target))) throw new Error(`There is already a skill named ${name}.`)
  if (previous && previous !== name) await rename(join(root, previous), target)
  await mkdir(target, { recursive: true })

  const file = join(target, 'SKILL.md')
  const old = await readFile(file, 'utf8').catch(() => '')
  const kept = splitSkill(old).entries.filter((entry) => entry.key !== 'name' && entry.key !== 'description')
  const frontmatter = [
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    ...kept.flatMap((entry) => entry.lines)
  ]
  const body = input.body.replace(/^\s*\n/, '')
  await writeFileAtomic(file, `---\n${frontmatter.join('\n')}\n---\n\n${body.endsWith('\n') ? body : `${body}\n`}`)
  return { name, description, body }
}

/** Moves the skill's folder, with any scripts or files next to SKILL.md, to the Trash. */
export async function removeBotSkill(botId: string, name: string): Promise<void> {
  if (!SKILL_NAME.test(name)) throw new Error('Skill not found')
  const dir = join(skillsDir(botId), name)
  await shell.trashItem(dir).catch(() => rm(dir, { recursive: true, force: true }))
}
