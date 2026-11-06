import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type {
  Project,
  ProjectIntake,
  ProjectIntakeAnswer,
  ProjectIntakeRound,
  ProjectIntakeStatus,
  UserQuestion
} from '../shared/types'
import { id, now } from './ids'
import { generateIntakeQuestions, type GeneratedIntake } from './intakeQuestions'
import { scanProject, type ProjectScan, type ScanField } from './projectScan'
import { askUserQuestions, cancelSessionQuestions, type QuestionOutcome } from './questions'
import { getChat, listProjects } from './store'
import { readJsonFile, withLock, writeFileAtomic } from './storeIo'

/** An intake still being answered: its questions, and the answers to the rounds already submitted. */
type IntakeDraft = GeneratedIntake & { asked: ProjectIntakeAnswer[] }

type IntakeFile = {
  profiles: Record<string, ProjectIntake>
  /** By project id. Kept until the intake is recorded, so a restart resumes it instead of losing it. */
  drafts?: Record<string, IntakeDraft>
}

const inflight = new Set<string>()
/** Chat ids of running intakes, true once cancelled. */
const running = new Map<string, boolean>()
/** A card nobody answers would hold its project's intake for good. Cancel it, and ask again later. */
const ROUND_TIMEOUT_MS = 30 * 60_000

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

async function loadIntakeFile(): Promise<Required<IntakeFile>> {
  const file = await readJsonFile<IntakeFile>(profilesPath(), { profiles: {} })
  return { profiles: file.profiles ?? {}, drafts: file.drafts ?? {} }
}

async function loadIntakes(): Promise<Record<string, ProjectIntake>> {
  return (await loadIntakeFile()).profiles
}

/** Reads, changes and writes the file under its lock, so a profile and a draft written together both land. */
async function updateIntakes(change: (file: Required<IntakeFile>) => void): Promise<void> {
  await withLock(profilesPath(), async () => {
    const file = await loadIntakeFile()
    change(file)
    await writeFileAtomic(profilesPath(), JSON.stringify(file satisfies IntakeFile, null, 2))
  })
}

export async function getProjectIntake(projectId: string): Promise<ProjectIntake | null> {
  const profiles = await loadIntakes()
  return profiles[projectId] ?? null
}

export async function needsProjectIntake(projectId: string): Promise<boolean> {
  const existing = await getProjectIntake(projectId)
  if (!existing) return true
  return existing.status !== 'completed' && existing.status !== 'declined' && existing.status !== 'skipped'
}

/** A declined intake keeps what was gathered before the user stopped, the same as a completed one. */
function hasAnswers(intake: ProjectIntake): boolean {
  return intake.status === 'completed' || intake.status === 'declined'
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
  if (!intake || !hasAnswers(intake) || intake.rounds.length === 0) return null
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
  await updateIntakes((file) => {
    file.profiles[project.id] = intake
    delete file.drafts[project.id]
  })
  if (!hasAnswers(intake)) return
  // The questions can wait a long time. Write the briefing for the project's current name and folder.
  const current = (await listProjects()).find((item) => item.id === project.id)
  if (current) await writeGrokMemory(current, intake)
}

async function askRound(
  chatId: string,
  title: string,
  questions: UserQuestion[]
): Promise<QuestionOutcome> {
  // Timing out is a cancel, not a decline: nothing is recorded, and a draft keeps the earlier rounds.
  const timer = setTimeout(() => cancelProjectIntake(chatId), ROUND_TIMEOUT_MS)
  try {
    return await askUserQuestions(id(), `intake:${chatId}`, questions, 'ext', {
      chatId,
      title
    })
  } finally {
    clearTimeout(timer)
  }
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
  // Resume a draft with its own questions: new ones would not line up with its answers.
  const draft = (await loadIntakeFile()).drafts[project.id]
  const generated = draft ?? (await generateIntakeQuestions(project, scan))
  if (running.get(chatId)) return
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

  let asked: ProjectIntakeAnswer[] = draft?.asked ?? []
  let status: ProjectIntakeStatus = 'completed'
  const groups = chunk(generated.questions.slice(asked.length), 5)
  for (let index = 0; index < groups.length; index += 1) {
    const questions = groups[index]
    const title = asked.length === 0 ? generated.title : 'A few more details'
    const outcome = await askRound(chatId, title, questions)
    // Cancelled is not declined: record nothing, so the project is asked again.
    if (running.get(chatId)) return
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
      status = 'declined'
      break
    }
    asked = asked.concat(answersFromOutcome(questions, outcome))
    // Each submitted round reaches disk, so quitting before the last one loses nothing.
    await updateIntakes((file) => {
      file.drafts[project.id] = { title: generated.title, questions: generated.questions, asked }
    })
    // A cancel while saving must not post the next card.
    if (running.get(chatId)) return
  }

  if (asked.length > 0) rounds.push({ title: 'From you', answers: asked })
  await persistIntake(project, {
    projectId: project.id,
    status,
    updatedAt: now(),
    rounds
  })
}

/**
 * Ends the intake running in `chatId`, if any, without recording it as skipped.
 * Call it when its chat is stopped or deleted.
 */
export function cancelProjectIntake(chatId: string): void {
  if (!running.has(chatId)) return
  running.set(chatId, true)
  cancelSessionQuestions(`intake:${chatId}`)
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
  // Registered before the first wait, so deleting the chat meanwhile cancels it.
  running.set(chatId, false)
  try {
    if (!(await needsProjectIntake(projectId))) return
    const chat = await getChat(chatId).catch(() => null)
    if (!chat || chat.projectId !== projectId) return
    const projects = await listProjects()
    const project = projects.find((item) => item.id === projectId)
    if (!project) return
    await runIntake(project, chatId)
  } finally {
    running.delete(chatId)
    inflight.delete(projectId)
  }
}
