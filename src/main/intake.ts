import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type {
  Project,
  ProjectIntake,
  ProjectIntakeAnswer,
  ProjectIntakeRound,
  UserQuestion
} from '../shared/types'
import { id, now } from './ids'
import { generateIntakeQuestions } from './intakeQuestions'
import { scanProject, type ProjectScan, type ScanField } from './projectScan'
import { askUserQuestions, type QuestionOutcome } from './questions'
import { getChat, listProjects } from './store'

type IntakeFile = {
  profiles: Record<string, ProjectIntake>
}

const inflight = new Set<string>()

const FIELD_LABEL: Record<ScanField, string> = {
  kind: 'Product kind',
  stage: 'How far along',
  frontend: 'Frontend / UI',
  backend: 'Backend / language',
  data: 'Data, auth, and infra',
  platforms: 'Where it runs',
  constraints: 'Hard constraints'
}

function dataDir(): string {
  return join(app.getPath('userData'), 'workbench')
}

function profilesPath(): string {
  return join(dataDir(), 'project-intakes.json')
}

function memoryPath(): string {
  return join(homedir(), '.grok', 'memory', 'MEMORY.md')
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

async function loadIntakes(): Promise<Record<string, ProjectIntake>> {
  const file = await readJson<IntakeFile>(profilesPath(), { profiles: {} })
  return file.profiles ?? {}
}

async function saveIntakes(profiles: Record<string, ProjectIntake>): Promise<void> {
  await writeJson(profilesPath(), { profiles } satisfies IntakeFile)
}

export async function getProjectIntake(projectId: string): Promise<ProjectIntake | null> {
  const profiles = await loadIntakes()
  return profiles[projectId] ?? null
}

export async function needsProjectIntake(projectId: string): Promise<boolean> {
  const existing = await getProjectIntake(projectId)
  if (!existing) return true
  return existing.status !== 'completed' && existing.status !== 'skipped'
}

function formatValues(values: string[]): string {
  return values.map((item) => item.trim()).filter(Boolean).join('; ')
}

function answersFromOutcome(
  questions: UserQuestion[],
  outcome: Extract<QuestionOutcome, { type: 'Accepted' }>
): ProjectIntakeAnswer[] {
  return questions.map((question, index) => {
    const raw = outcome.partial_answers[index]
    const values = Array.isArray(raw) ? raw : raw ? [raw] : []
    return {
      question: question.question,
      values: values.map((item) => String(item).trim()).filter(Boolean)
    }
  })
}

function briefLines(intake: ProjectIntake, project: Project): string[] {
  const lines = [
    `Project: ${project.name}`,
    project.path ? `Path: ${project.path}` : 'Path: (no folder attached)'
  ]
  for (const round of intake.rounds) {
    lines.push('')
    lines.push(`${round.title}:`)
    for (const answer of round.answers) {
      if (answer.values.length === 0) continue
      const value = formatValues(answer.values)
      const source = answer.source ? ` [${answer.source}]` : ''
      lines.push(`- ${answer.question} ${value}${source}`)
    }
  }
  return lines
}

export function formatProjectSessionRules(intake: ProjectIntake | null, project: Project): string | null {
  if (!intake || intake.status !== 'completed' || intake.rounds.length === 0) return null
  if (briefingPath(project)) {
    return [
      'This project already has a briefing in .grok/rules/briefing.md.',
      'Follow that file. "From the repo" facts were derived from the codebase. "From you" answers are intent the code cannot show.'
    ].join(' ')
  }
  return [
    `This Datapad Workbench project already has a briefing.`,
    `"From the repo" facts were derived from the codebase — match that stack unless the user asks to change it.`,
    `"From you" answers are intent the code cannot show.`,
    ...briefLines(intake, project)
  ].join('\n')
}

export async function projectSessionRules(projectId: string | undefined): Promise<string | null> {
  if (!projectId) return null
  const projects = await listProjects()
  const project = projects.find((item) => item.id === projectId)
  if (!project) return null
  const intake = await getProjectIntake(projectId)
  return formatProjectSessionRules(intake, project)
}

function memoryBlock(project: Project, intake: ProjectIntake): string {
  const start = `<!-- workbench-project ${project.id} -->`
  const end = `<!-- /workbench-project ${project.id} -->`
  const body = [`### ${project.name}`, '', ...briefLines(intake, project)].join('\n')
  return `${start}\n${body}\n${end}`
}

function briefingPath(project: Project): string | null {
  if (!project.path || project.path === '/tmp') return null
  return join(project.path, '.grok', 'rules', 'briefing.md')
}

function stripMemoryBlock(markdown: string, projectId: string): string {
  const start = `<!-- grokcode-project ${projectId} -->`
  const end = `<!-- /grokcode-project ${projectId} -->`
  const escapedStart = start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\\n*${escapedStart}[\\s\\S]*?${escapedEnd}\\n*`)
  const stripped = markdown.replace(pattern, '\n\n')
  const withoutEmpty = stripped.replace(/\n*## (Grok Build Workbench|GrokCode) projects\s*(?=\n#|\n*$)/, '\n')
  return withoutEmpty.trim() + (stripped.trim() ? '\n' : '')
}

async function stripLegacyMemory(projectId: string): Promise<void> {
  const path = memoryPath()
  let current: string
  try {
    current = await readFile(path, 'utf8')
  } catch {
    return
  }
  await writeFile(path, stripMemoryBlock(current, projectId), 'utf8')
}

async function writeGrokMemory(project: Project, intake: ProjectIntake): Promise<void> {
  await stripLegacyMemory(project.id)
  const path = briefingPath(project)
  if (!path) return
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${memoryBlock(project, intake)}\n`, 'utf8')
}

async function persistIntake(project: Project, intake: ProjectIntake): Promise<void> {
  const profiles = await loadIntakes()
  profiles[project.id] = intake
  await saveIntakes(profiles)
  if (intake.status !== 'completed') return
  await writeGrokMemory(project, intake)
}

async function askRound(
  chatId: string,
  title: string,
  questions: UserQuestion[]
): Promise<QuestionOutcome> {
  return askUserQuestions(id(), `intake:${chatId}`, questions, 'ext', {
    chatId,
    title
  })
}

function derivedAnswers(scan: ProjectScan): ProjectIntakeAnswer[] {
  const answers: ProjectIntakeAnswer[] = []
  if (scan.stackLabel) {
    answers.push({
      question: 'Detected stack',
      values: [scan.stackLabel],
      source: 'repository files'
    })
  }
  if (scan.summary) {
    answers.push({
      question: 'What the repo says about itself',
      values: [scan.summary],
      source: 'README / project rules'
    })
  }
  for (const item of scan.findings) {
    answers.push({
      question: FIELD_LABEL[item.field],
      values: item.values,
      source: item.source
    })
  }
  return answers
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size))
  }
  return out
}

async function runIntake(project: Project, chatId: string): Promise<void> {
  const scan = await scanProject(project.path)
  const derived = derivedAnswers(scan)
  const generated = await generateIntakeQuestions(project, scan)
  const rounds: ProjectIntakeRound[] = []
  if (derived.length > 0) {
    rounds.push({ title: 'From the repo', answers: derived })
  }

  if (generated.questions.length === 0) {
    await persistIntake(project, {
      projectId: project.id,
      status: 'completed',
      updatedAt: now(),
      rounds
    })
    return
  }

  let asked: ProjectIntakeAnswer[] = []
  const groups = chunk(generated.questions, 5)
  for (let index = 0; index < groups.length; index += 1) {
    const questions = groups[index]
    const title = index === 0 ? generated.title : 'A few more details'
    const outcome = await askRound(chatId, title, questions)
    if (outcome.type !== 'Accepted') {
      if (asked.length === 0 && derived.length === 0) {
        await persistIntake(project, {
          projectId: project.id,
          status: 'skipped',
          updatedAt: now(),
          rounds: []
        })
        return
      }
      break
    }
    asked = asked.concat(answersFromOutcome(questions, outcome))
  }

  if (asked.length > 0) rounds.push({ title: 'From you', answers: asked })
  await persistIntake(project, {
    projectId: project.id,
    status: 'completed',
    updatedAt: now(),
    rounds
  })
}

export function scheduleProjectIntake(project: Project, chatId: string): void {
  setTimeout(() => {
    void maybeStartProjectIntake(project.id, chatId)
  }, 80)
}

export async function maybeStartProjectIntake(projectId: string, chatId: string): Promise<void> {
  if (!projectId || !chatId) return
  if (inflight.has(projectId)) return
  inflight.add(projectId)
  try {
    if (!(await needsProjectIntake(projectId))) return
    const chat = await getChat(chatId).catch(() => null)
    if (!chat || chat.projectId !== projectId) return
    const projects = await listProjects()
    const project = projects.find((item) => item.id === projectId)
    if (!project) return
    await runIntake(project, chatId)
  } finally {
    inflight.delete(projectId)
  }
}
