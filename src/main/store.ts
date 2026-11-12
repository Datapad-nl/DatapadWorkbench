import { normalizeMaxSubagents } from '../shared/conductor'
import { app } from 'electron'
import { mkdir, readdir, rm, stat } from 'fs/promises'
import { join, normalize } from 'path'
import { type McpServers, parseMcpServers } from '../shared/mcp'
import { normalizeHexColor, pickProjectColor } from '../shared/projectColor'
import { plainReply } from '../shared/steps'
import { DEFAULT_THEME_ID } from '../shared/theme'
import {
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  normalizeChatAgent,
  normalizeReasoningEffort,
  normalizeVoiceSettings,
  type Chat,
  type ChatAgent,
  type ChatSummary,
  type Project,
  type PublicSettings,
  type ReasoningEffort,
  type UpdateProjectInput,
  type VoiceSettings
} from '../shared/types'
import { forgetProjectIndex, isUnsafeProjectPath, queueIndex } from './codegraph'
import { id, now, titleFromPrompt } from './ids'
import { getClaudeCliInfo, peekClaudeCliInfo } from './claudeCli'
import { listClaudeSessions, readClaudeHistory } from './claudeSessions'
import { getGrokCliInfo, grokBinary, peekGrokCliInfo } from './grokCli'
import { readJsonFile, withLock, writeFileAtomic } from './storeIo'
import {
  findGrokSessionDir,
  grokBuildSignedIn,
  listGrokSessions,
  readGrokHistory,
  readGrokPlan
} from './sessions'

type SettingsFile = {
  /** Agent for new chats. Missing means Grok. */
  defaultAgent?: ChatAgent
  /** Claude Code model alias. Empty means its default. */
  claudeModel?: string
  /** Claude Code model of a conductor chat. Empty means `claudeModel`. */
  orchestratorModel?: string
  /** Claude Code model of every worker. Empty lets the conductor pick one per task. */
  subagentModel?: string
  /** How many workers of one chat run at the same time. */
  maxSubagents?: number
  apiKey: string
  model: string
  effort: ReasoningEffort | ''
  themeId: string
  voice: VoiceSettings
  /** MCP servers every chat gets, next to the built-in browser. */
  mcpServers?: McpServers
}

type StoreData = {
  projects: Project[]
}

/** Chats deleted in this run. A late save from a stream that outlived its chat must not bring it back. */
const deletedChats = new Set<string>()

/** Where an unreadable projects.json was moved in this run, so the user can be told. */
let projectsMovedTo: string | null = null
let recoveryWrite: Promise<void> = Promise.resolve()
let projectsRecoveredListener: ((aside: string) => void) | null = null

/**
 * projects.json didn't parse and was moved aside. A marker on disk keeps Grok sessions from creating
 * projects on top of the empty list, across restarts, until the list has a project again.
 */
function markProjectsRecovered(aside: string): void {
  projectsMovedTo = aside
  recoveryWrite = writeJson(recoveryMarkerFile(), { movedTo: aside, at: now() }).catch(() => undefined)
  projectsRecoveredListener?.(aside)
}

export function unreadableProjectsMovedTo(): string | null {
  return projectsMovedTo
}

/** Hears of each later time projects.json is found unreadable, e.g. after another program wrote it. */
export function onUnreadableProjects(listener: (aside: string) => void): void {
  projectsRecoveredListener = listener
}

/** Whether the list is still the empty one left by a recovery. A restored or added project ends it. */
async function awaitingProjectsRestore(projects: Project[]): Promise<boolean> {
  await recoveryWrite
  const marker = await readJson<unknown>(recoveryMarkerFile(), null)
  if (!marker) return false
  if (projects.length === 0) return true
  await rm(recoveryMarkerFile(), { force: true })
  return false
}

function dataDir(): string {
  return join(app.getPath('userData'), 'workbench')
}

function projectsPath(): string {
  return join(dataDir(), 'projects.json')
}

function dismissedPathsFile(): string {
  return join(dataDir(), 'dismissed-paths.json')
}

function recoveryMarkerFile(): string {
  return join(dataDir(), 'projects-recovered.json')
}

/** Agent sessions the import leaves out: the app's own one-off prompts, and those of chats deleted here. */
function skippedSessionsFile(): string {
  return join(dataDir(), 'skipped-sessions.json')
}

function normalizeProjectPath(value: string): string {
  const normalized = normalize(value.trim())
  return normalized.replace(/[/\\]+$/, '') || normalized
}

function settingsPath(): string {
  return join(dataDir(), 'settings.json')
}

function chatsDir(): string {
  return join(dataDir(), 'chats')
}

function chatPath(chatId: string): string {
  return join(chatsDir(), `${chatId}.json`)
}

/** Saves what a chat hands to the chat that continues it, and returns the file's path. */
export async function saveHandoff(chatId: string, markdown: string): Promise<string> {
  const dir = join(dataDir(), 'handoffs')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${chatId.replace(/[^\w-]/g, '_')}-${Date.now()}.md`)
  await writeFileAtomic(file, markdown)
  return file
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  return readJsonFile(path, fallback)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2))
}

export async function ensureStore(): Promise<void> {
  await mkdir(chatsDir(), { recursive: true })
  const existing = await readJsonFile<StoreData | null>(projectsPath(), null, markProjectsRecovered)
  if (!existing) {
    await writeJson(projectsPath(), { projects: [] } satisfies StoreData)
  }
  const settings = await readJson<SettingsFile | null>(settingsPath(), null)
  if (!settings) {
    await writeJson(settingsPath(), {
      apiKey: '',
      model: DEFAULT_MODEL,
      effort: '',
      themeId: DEFAULT_THEME_ID,
      voice: DEFAULT_VOICE
    } satisfies SettingsFile)
  }
  await mkdir(join(dataDir(), 'themes'), { recursive: true })
}

/** Fills in missing colors. They are deterministic, so they reach disk with the next locked save. */
function withProjectColors(projects: Project[]): Project[] {
  const taken: string[] = []
  return projects.map((project) => {
    const existing = normalizeHexColor(project.color)
    if (existing) {
      taken.push(existing)
      if (existing === project.color) return project
      return { ...project, color: existing }
    }
    const color = pickProjectColor(taken)
    taken.push(color)
    return { ...project, color }
  })
}

async function loadProjects(): Promise<Project[]> {
  const data = await readJsonFile<StoreData>(projectsPath(), { projects: [] }, markProjectsRecovered)
  return withProjectColors(data.projects)
}

/** Every projects.json read-modify-write runs under this lock. */
function withProjectsLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(projectsPath(), fn)
}

async function saveProjects(projects: Project[]): Promise<void> {
  await writeJson(projectsPath(), { projects } satisfies StoreData)
}

async function loadDismissedPaths(): Promise<Set<string>> {
  const paths = await readJson<string[]>(dismissedPathsFile(), [])
  return new Set(paths.filter((item) => typeof item === 'string').map(normalizeProjectPath))
}

async function saveDismissedPaths(paths: Set<string>): Promise<void> {
  await writeJson(dismissedPathsFile(), [...paths])
}

async function dismissProjectPath(path: string | null | undefined): Promise<void> {
  if (!path?.trim()) return
  await withLock(dismissedPathsFile(), async () => {
    const dismissed = await loadDismissedPaths()
    dismissed.add(normalizeProjectPath(path))
    await saveDismissedPaths(dismissed)
  })
}

async function loadSkippedSessions(): Promise<Set<string>> {
  const ids = await readJson<string[]>(skippedSessionsFile(), [])
  return new Set(ids.filter((item) => typeof item === 'string'))
}

async function skipSessionImport(sessionId: string): Promise<void> {
  await withLock(skippedSessionsFile(), async () => {
    const skipped = await loadSkippedSessions()
    if (skipped.has(sessionId)) return
    skipped.add(sessionId)
    await writeJson(skippedSessionsFile(), [...skipped])
  })
}

/** One-off sessions still starting. An import waits for them, so it cannot take one for a chat first. */
const startingSkipped = new Set<Promise<unknown>>()

/** Opens a one-off agent session, such as an aside, that must never show up as a chat. */
export function skipNewSession<T extends { sessionId: string }>(start: Promise<T>): Promise<T> {
  const recorded = start.then(async (created) => {
    await skipSessionImport(created.sessionId)
    return created
  })
  startingSkipped.add(recorded)
  void recorded.catch(() => undefined).finally(() => startingSkipped.delete(recorded))
  return recorded
}

/** Leaves out skipped sessions. Call it after reading the chats, so a delete in between is seen. */
async function importable<T extends { id: string }>(sessions: T[]): Promise<T[]> {
  await Promise.allSettled([...startingSkipped])
  const skipped = await loadSkippedSessions()
  return sessions.filter((session) => !skipped.has(session.id))
}

async function rememberProjectPath(path: string | null | undefined): Promise<void> {
  if (!path?.trim()) return
  await withLock(dismissedPathsFile(), async () => {
    const dismissed = await loadDismissedPaths()
    if (!dismissed.delete(normalizeProjectPath(path))) return
    await saveDismissedPaths(dismissed)
  })
}

async function loadSettingsFile(): Promise<SettingsFile> {
  const file = await readJson<Partial<SettingsFile>>(settingsPath(), {})
  return {
    defaultAgent: normalizeChatAgent(file.defaultAgent),
    claudeModel: file.claudeModel?.trim() ?? '',
    orchestratorModel: file.orchestratorModel?.trim() ?? '',
    subagentModel: file.subagentModel?.trim() ?? '',
    maxSubagents: normalizeMaxSubagents(file.maxSubagents),
    apiKey: file.apiKey ?? '',
    model: file.model || DEFAULT_MODEL,
    effort: normalizeReasoningEffort(file.effort) ?? '',
    themeId: file.themeId || DEFAULT_THEME_ID,
    voice: normalizeVoiceSettings(file.voice),
    mcpServers: readMcpServers(file.mcpServers)
  }
}

/** A hand-edited settings file with a broken server list loads with none, instead of failing. */
function readMcpServers(value: unknown): McpServers {
  try {
    return parseMcpServers(JSON.stringify(value ?? {}))
  } catch {
    return {}
  }
}

export async function getMcpServers(): Promise<McpServers> {
  return (await loadSettingsFile()).mcpServers ?? {}
}

/** Save the MCP editor text. Throws the parse error so the editor can show it. */
export async function setMcpServers(text: string): Promise<McpServers> {
  const mcpServers = parseMcpServers(text)
  await withLock(settingsPath(), async () => {
    const current = await loadSettingsFile()
    await writeJson(settingsPath(), { ...current, mcpServers } satisfies SettingsFile)
  })
  return mcpServers
}

export async function getThemeId(): Promise<string> {
  const file = await loadSettingsFile()
  return file.themeId || DEFAULT_THEME_ID
}

export async function setThemeId(themeId: string): Promise<void> {
  await withLock(settingsPath(), async () => {
    const current = await loadSettingsFile()
    await writeJson(settingsPath(), {
      ...current,
      themeId: themeId || DEFAULT_THEME_ID,
      voice: normalizeVoiceSettings(current.voice)
    } satisfies SettingsFile)
  })
}

function maskKey(key: string): string {
  if (key.length < 8) return '••••'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

let cliChanged: () => void = () => undefined

/** Called when a CLI probe lands with something the windows haven't seen. */
export function onCliInfoChange(listener: () => void): void {
  cliChanged = listener
}

/**
 * What the CLIs said last, at once. Each probe can take seconds (`grok models`, `claude auth status`),
 * so it runs behind the answer and its news reaches the windows through `onCliInfoChange`.
 */
function currentCliInfo(): Pick<PublicSettings, 'grokCli' | 'claude' | 'cliChecking'> {
  const grokCli = peekGrokCliInfo()
  const claude = peekClaudeCliInfo()
  const shown = JSON.stringify([grokCli, claude])
  void Promise.all([getGrokCliInfo(), getClaudeCliInfo()])
    .then((fresh) => {
      if (JSON.stringify(fresh) !== shown) cliChanged()
    })
    .catch(() => undefined)
  return {
    grokCli: grokCli ?? { path: grokBinary(), version: null, channel: 'unknown', models: [DEFAULT_MODEL] },
    claude: claude ?? { signedIn: false, subscription: null, email: null },
    cliChecking: !grokCli || !claude
  }
}

export async function getPublicSettings(): Promise<PublicSettings> {
  const envKey = process.env.XAI_API_KEY?.trim() ?? ''
  const file = await loadSettingsFile()
  const stored = file.apiKey.trim()
  const signedIn = grokBuildSignedIn()
  const model = file.model || DEFAULT_MODEL
  const effort = file.effort || null
  const voice = file.voice
  const { grokCli, claude, cliChecking } = currentCliInfo()
  const agent = {
    defaultAgent: normalizeChatAgent(file.defaultAgent),
    claude,
    claudeModel: file.claudeModel ?? '',
    orchestratorModel: file.orchestratorModel ?? '',
    subagentModel: file.subagentModel ?? '',
    maxSubagents: normalizeMaxSubagents(file.maxSubagents),
    cliChecking
  }
  if (signedIn) {
    return {
      ...agent,
      hasKey: true,
      keyPreview: 'Grok Build',
      model,
      effort,
      keySource: 'grok-build',
      grokBuildSignedIn: true,
      voice,
      grokCli
    }
  }
  if (envKey) {
    return {
      ...agent,
      hasKey: true,
      keyPreview: maskKey(envKey),
      model,
      effort,
      keySource: 'env',
      grokBuildSignedIn: false,
      voice,
      grokCli
    }
  }
  if (stored) {
    return {
      ...agent,
      hasKey: true,
      keyPreview: maskKey(stored),
      model,
      effort,
      keySource: 'settings',
      grokBuildSignedIn: false,
      voice,
      grokCli
    }
  }
  return {
    ...agent,
    hasKey: false,
    keyPreview: null,
    model,
    effort,
    keySource: 'none',
    grokBuildSignedIn: false,
    voice,
    grokCli
  }
}

export async function getApiKey(): Promise<string | null> {
  const envKey = process.env.XAI_API_KEY?.trim()
  if (envKey) return envKey
  const file = await loadSettingsFile()
  return file.apiKey.trim() || null
}

export async function getModel(): Promise<string> {
  const file = await loadSettingsFile()
  return file.model || DEFAULT_MODEL
}

export async function getDefaultAgent(): Promise<ChatAgent> {
  const file = await loadSettingsFile()
  return normalizeChatAgent(file.defaultAgent)
}

export async function getClaudeModel(): Promise<string> {
  const file = await loadSettingsFile()
  return file.claudeModel ?? ''
}

/** The Claude Code model a chat runs on: its own, the orchestrator's for a conductor, else the setting. */
export async function claudeModelFor(chatId: string | undefined): Promise<string> {
  const file = await loadSettingsFile()
  const chat = chatId ? await readChat(chatId) : null
  return chat?.model || (chat?.conductor && file.orchestratorModel) || file.claudeModel || ''
}

export async function getSubagentModel(): Promise<string> {
  const file = await loadSettingsFile()
  return file.subagentModel ?? ''
}

export async function getMaxSubagents(): Promise<number> {
  const file = await loadSettingsFile()
  return normalizeMaxSubagents(file.maxSubagents)
}

export async function getEffort(): Promise<ReasoningEffort | null> {
  const file = await loadSettingsFile()
  return file.effort || null
}

export async function updateSettings(input: {
  apiKey?: string
  model?: string
  effort?: string | null
  voice?: Partial<VoiceSettings>
  defaultAgent?: ChatAgent
  claudeModel?: string
  orchestratorModel?: string
  subagentModel?: string
  maxSubagents?: number
}): Promise<PublicSettings> {
  await withLock(settingsPath(), async () => {
    const current = await loadSettingsFile()
    await writeJson(settingsPath(), {
      defaultAgent:
        input.defaultAgent !== undefined ? normalizeChatAgent(input.defaultAgent) : current.defaultAgent,
      claudeModel: input.claudeModel !== undefined ? input.claudeModel.trim() : current.claudeModel,
      orchestratorModel:
        input.orchestratorModel !== undefined ? input.orchestratorModel.trim() : current.orchestratorModel,
      subagentModel: input.subagentModel !== undefined ? input.subagentModel.trim() : current.subagentModel,
      maxSubagents:
        input.maxSubagents !== undefined ? normalizeMaxSubagents(input.maxSubagents) : current.maxSubagents,
      apiKey: input.apiKey !== undefined ? input.apiKey.trim() : current.apiKey,
      model: input.model?.trim() || current.model || DEFAULT_MODEL,
      effort:
        input.effort !== undefined ? (normalizeReasoningEffort(input.effort) ?? '') : current.effort,
      themeId: current.themeId || DEFAULT_THEME_ID,
      voice: normalizeVoiceSettings({ ...current.voice, ...input.voice }),
      mcpServers: current.mcpServers
    } satisfies SettingsFile)
  })
  return getPublicSettings()
}

export async function listProjects(): Promise<Project[]> {
  const projects = (await loadProjects()).filter((project) => !project.removedAt)
  return [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function createProject(name: string, path: string | null, color?: string): Promise<Project> {
  if (path && isUnsafeProjectPath(path)) {
    throw new Error('Choose a project folder, not your home directory or a whole disk.')
  }
  await rememberProjectPath(path)
  return withProjectsLock(async () => {
    const projects = await loadProjects()
    const timestamp = now()
    // Adding a removed project's folder again brings it back with its chats.
    const removed = path
      ? projects.find(
          (item) => item.removedAt && item.path && normalizeProjectPath(item.path) === normalizeProjectPath(path)
        )
      : undefined
    if (removed) {
      delete removed.removedAt
      removed.updatedAt = timestamp
      await saveProjects(projects)
      queueIndex(removed.id, removed.path)
      return removed
    }
    const project: Project = {
      id: id(),
      name: name.trim() || 'Untitled project',
      path,
      color: normalizeHexColor(color) ?? pickProjectColor(projects.map((item) => item.color)),
      createdAt: timestamp,
      updatedAt: timestamp
    }
    projects.unshift(project)
    await saveProjects(projects)
    queueIndex(project.id, project.path)
    return project
  })
}

export async function updateProject(input: UpdateProjectInput): Promise<Project> {
  return withProjectsLock(async () => {
    const projects = await loadProjects()
    const index = projects.findIndex((project) => project.id === input.id)
    if (index === -1) throw new Error('Project not found')
    const current = projects[index]
    const nextName = input.name !== undefined ? input.name.trim() || current.name : current.name
    const nextPath = input.path !== undefined ? input.path : current.path
    if (nextPath && isUnsafeProjectPath(nextPath)) {
      throw new Error('Choose a project folder, not your home directory or a whole disk.')
    }
    const nextColor =
      input.color !== undefined ? (normalizeHexColor(input.color) ?? current.color) : current.color
    const renamed = nextName !== current.name
    const moved = nextPath !== current.path
    const next: Project = {
      ...current,
      name: nextName,
      path: nextPath,
      color: nextColor,
      updatedAt: renamed || moved ? now() : current.updatedAt
    }
    projects[index] = next
    // The dismissed-paths lock is only ever taken inside the projects lock, never the other way round.
    if (moved) {
      if (current.path) await dismissProjectPath(current.path)
      if (next.path) await rememberProjectPath(next.path)
    }
    await saveProjects(projects)
    if (next.path && next.path !== current.path) {
      queueIndex(next.id, next.path)
    }
    return next
  })
}

export async function purgeUnsafeProjects(): Promise<void> {
  const projects = await loadProjects()
  const bad = projects.filter(
    (project) => !project.removedAt && project.path && isUnsafeProjectPath(project.path)
  )
  for (const project of bad) {
    await removeProject(project.id)
  }
}

/** Hides the project from the sidebar. Its chats stay on record for when its folder is added again. */
export async function removeProject(projectId: string): Promise<void> {
  await withProjectsLock(async () => {
    const projects = await loadProjects()
    const project = projects.find((item) => item.id === projectId)
    if (!project) return
    await dismissProjectPath(project.path)
    project.removedAt = now()
    await saveProjects(projects)
    forgetProjectIndex(projectId)
  })
}

async function readChat(chatId: string): Promise<Chat | null> {
  return readJson<Chat | null>(chatPath(chatId), null)
}

export async function chatMediaRoots(chatId: string): Promise<string[]> {
  const chat = await readChat(chatId)
  if (!chat) return []
  const roots: string[] = []
  if (chat.worktreePath) roots.push(chat.worktreePath)
  const project = (await loadProjects()).find((item) => item.id === chat.projectId)
  if (project?.path) roots.push(project.path)
  if (chat.grokSessionId && normalizeChatAgent(chat.agent) === 'grok') {
    const dir = findGrokSessionDir(chat.grokSessionId)
    if (dir) roots.push(dir)
  }
  return roots
}

export async function getChat(chatId: string): Promise<Chat> {
  const chat = await readChat(chatId)
  if (!chat) throw new Error('Chat not found')
  const onGrok = normalizeChatAgent(chat.agent) === 'grok'
  if (chat.messages.length === 0 && chat.grokSessionId) {
    const project = (await loadProjects()).find((item) => item.id === chat.projectId)
    const cwd = chat.worktreePath || project?.path
    if (cwd) {
      chat.messages = onGrok
        ? await readGrokHistory(chat.grokSessionId, cwd)
        : await readClaudeHistory(chat.grokSessionId, cwd)
    }
  }
  if (onGrok && chat.grokSessionId) {
    const disk = readGrokPlan(chat.grokSessionId)
    if (disk?.awaitingApproval) {
      const markdown = chat.plan?.markdown || disk.markdown
      const entries = chat.plan?.entries?.length ? chat.plan.entries : disk.plan.entries
      chat.plan = {
        title:
          chat.plan?.title && chat.plan.title !== 'Plan' && chat.plan.title !== 'No plan written yet'
            ? chat.plan.title
            : disk.plan.title,
        entries,
        markdown,
        awaitingApproval: chat.plan?.awaitingApproval === false ? false : true
      }
    } else if (chat.plan?.awaitingApproval && !disk?.awaitingApproval) {
      chat.plan = { ...chat.plan, awaitingApproval: false }
    }
  }
  return {
    ...chat,
    grokSessionId: chat.grokSessionId ?? null
  }
}

// Each chat file's summary, kept until the file changes. A chat is saved by renaming a new file
// over the old one, so a change shows as a new inode, time or size, and listing reads only those.
const summaries = new Map<string, { ino: number; mtimeMs: number; size: number; summary: ChatSummary }>()

export async function listChats(): Promise<ChatSummary[]> {
  await mkdir(chatsDir(), { recursive: true })
  const files = (await readdir(chatsDir())).filter((file) => file.endsWith('.json'))
  const stats = await Promise.all(files.map((file) => stat(join(chatsDir(), file)).catch(() => null)))
  const chats: ChatSummary[] = []
  for (const [index, file] of files.entries()) {
    const info = stats[index]
    if (!info) continue
    let entry = summaries.get(file)
    if (!entry || entry.ino !== info.ino || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
      const chat = await readJson<Chat | null>(join(chatsDir(), file), null).catch(() => null)
      if (!chat) continue
      entry = {
        ino: info.ino,
        mtimeMs: info.mtimeMs,
        size: info.size,
        summary: {
          id: chat.id,
          projectId: chat.projectId,
          title: chat.title,
          agent: normalizeChatAgent(chat.agent),
          grokSessionId: chat.grokSessionId ?? null,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          messageCount: chat.messages.length,
          worktreePath: chat.worktreePath ?? null,
          worktreeBranch: chat.worktreeBranch ?? null,
          schedule: chat.schedule ?? null,
          pr: chat.pr ?? null
        }
      }
      summaries.set(file, entry)
    }
    chats.push(entry.summary)
  }
  const present = new Set(files)
  for (const file of summaries.keys()) {
    if (!present.has(file)) summaries.delete(file)
  }
  return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// Each chat's lowercased message text, kept until the chat changes. Reading imported
// histories from the agents' session files is slow, so only the first search pays for it.
const searchText = new Map<string, { updatedAt: string; text: string }>()

/** Ids of the chats whose messages contain `query`, ignoring case. */
export async function searchChats(query: string): Promise<string[]> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  await mkdir(chatsDir(), { recursive: true })
  const ids: string[] = []
  for (const file of await readdir(chatsDir())) {
    if (!file.endsWith('.json')) continue
    const stored = await readChat(file.slice(0, -'.json'.length)).catch(() => null)
    if (!stored) continue
    let entry = searchText.get(stored.id)
    if (entry?.updatedAt !== stored.updatedAt) {
      // getChat also reads the messages an imported chat keeps in its agent's session files.
      const chat = await getChat(stored.id).catch(() => null)
      const text = (chat?.messages ?? []).map((message) => plainReply(message.content)).join('\n').toLowerCase()
      entry = { updatedAt: stored.updatedAt, text }
      searchText.set(stored.id, entry)
    }
    if (entry.text.includes(needle)) ids.push(stored.id)
  }
  return ids
}

export async function createChat(
  projectId: string,
  input?: {
    id?: string
    title?: string
    agent?: ChatAgent
    model?: string
    parentChatId?: string
    grokSessionId?: string | null
    messages?: Chat['messages']
  }
): Promise<Chat> {
  const projects = await loadProjects()
  if (!projects.some((project) => project.id === projectId)) {
    throw new Error('Project not found')
  }
  const timestamp = now()
  const chatId = input?.id ?? id()
  const chat: Chat = {
    id: chatId,
    projectId,
    title: input?.title ?? 'New chat',
    agent: input?.agent ?? (await getDefaultAgent()),
    model: input?.model || undefined,
    parentChatId: input?.parentChatId,
    grokSessionId: input?.grokSessionId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: input?.messages ?? []
  }
  // An imported chat deleted here comes back from its session file with the same id.
  deletedChats.delete(chatId)
  await withLock(chatId, () => writeJson(chatPath(chat.id), chat))
  await touchProject(projectId)
  return chat
}

const GROK_DEFAULT_TITLE = 'Grok session'
const retitleTried = new Set<string>()

async function grokPromptTitle(sessionId: string, cwd: string): Promise<string | null> {
  const first = (await readGrokHistory(sessionId, cwd)).find((message) => message.role === 'user')
  return first ? titleFromPrompt(first.content) : null
}

/** Sets an imported chat's title without touching its history or its place in the list. */
async function retitleChat(chatId: string, title: string): Promise<void> {
  await withLock(chatId, async () => {
    const chat = await readChat(chatId)
    if (!chat || chat.title !== GROK_DEFAULT_TITLE) return
    await writeJson(chatPath(chatId), { ...chat, title })
  })
}

let grokSync: Promise<void> | null = null
let claudeSync: Promise<void> | null = null

/** Overlapping calls share one run, so two runs can't import the same new folder twice. */
export function syncGrokSessions(): Promise<void> {
  grokSync ??= importGrokSessions().finally(() => {
    grokSync = null
  })
  return grokSync
}

export function syncClaudeSessions(): Promise<void> {
  claudeSync ??= importClaudeSessions().finally(() => {
    claudeSync = null
  })
  return claudeSync
}

async function importGrokSessions(): Promise<void> {
  const sessions = await listGrokSessions()
  if (sessions.length === 0) return
  const projects = await loadProjects()
  const chats = await listChats()
  const known = new Set(chats.map((chat) => chat.grokSessionId).filter(Boolean))
  const dismissed = await loadDismissedPaths()
  const restoring = await awaitingProjectsRestore(projects)

  // Sessions Grok never titled read as their first prompt instead of "Grok session".
  for (const chat of chats) {
    if (chat.title !== GROK_DEFAULT_TITLE || !chat.grokSessionId || retitleTried.has(chat.id)) continue
    retitleTried.add(chat.id)
    const session = sessions.find((item) => item.id === chat.grokSessionId)
    const title = session ? await grokPromptTitle(session.id, session.cwd) : null
    if (title) await retitleChat(chat.id, title)
  }

  for (const session of await importable(sessions)) {
    if (known.has(session.id)) continue
    const cwd = normalizeProjectPath(session.cwd)
    if (isUnsafeProjectPath(cwd)) continue
    let project = projects.find((item) => item.path && normalizeProjectPath(item.path) === cwd)
    if (!project) {
      if (dismissed.has(cwd) || restoring) continue
      const name = session.cwd.split(/[/\\]/).filter(Boolean).at(-1) || 'Project'
      project = await createProject(name, session.cwd)
      projects.unshift(project)
    }
    await createChat(project.id, {
      id: session.id,
      title:
        session.title === GROK_DEFAULT_TITLE
          ? ((await grokPromptTitle(session.id, session.cwd)) ?? session.title)
          : session.title,
      agent: 'grok',
      grokSessionId: session.id
    })
    known.add(session.id)
  }
}

/** Claude Code sessions are imported into projects that already exist, never new ones. */
async function importClaudeSessions(): Promise<void> {
  const projects = (await loadProjects()).filter((project) => project.path)
  if (projects.length === 0) return
  const sessions = await listClaudeSessions(projects.map((project) => project.path as string))
  if (sessions.length === 0) return
  const known = new Set((await listChats()).map((chat) => chat.grokSessionId).filter(Boolean))
  for (const session of await importable(sessions)) {
    if (known.has(session.id)) continue
    const cwd = normalizeProjectPath(session.cwd)
    const project = projects.find((item) => normalizeProjectPath(item.path as string) === cwd)
    if (!project) continue
    await createChat(project.id, {
      id: session.id,
      title: session.title,
      agent: 'claude',
      grokSessionId: session.id
    })
    known.add(session.id)
  }
}

export async function mutateChat(chatId: string, fn: (chat: Chat) => void): Promise<Chat> {
  const next = await withLock(chatId, async () => {
    const chat = deletedChats.has(chatId) ? null : await readChat(chatId)
    if (!chat) throw new Error('Chat not found')
    fn(chat)
    const next = { ...chat, updatedAt: now() }
    await writeJson(chatPath(chatId), next)
    return next
  })
  await touchProject(next.projectId)
  return next
}

export async function deleteChat(chatId: string): Promise<void> {
  deletedChats.add(chatId)
  // Its agent session stays on disk, and the import would bring the chat back from it.
  const sessionId = (await readChat(chatId).catch(() => null))?.grokSessionId
  if (sessionId) await skipSessionImport(sessionId)
  await withLock(chatId, async () => {
    await rm(chatPath(chatId), { force: true })
  })
}

/** Changes only the title, so an imported chat keeps reading its history from its session file. */
export async function renameChat(chatId: string, title: string): Promise<Chat> {
  await mutateChat(chatId, (chat) => {
    chat.title = title.trim() || chat.title
  })
  return getChat(chatId)
}

async function touchProject(projectId: string): Promise<void> {
  await withProjectsLock(async () => {
    const projects = await loadProjects()
    const index = projects.findIndex((project) => project.id === projectId)
    if (index === -1) return
    projects[index] = { ...projects[index], updatedAt: now() }
    await saveProjects(projects)
  })
}

export async function snapshot(): Promise<{ projects: Project[]; chats: ChatSummary[]; settings: PublicSettings }> {
  await syncGrokSessions()
  await syncClaudeSessions()
  const [projects, chats, settings] = await Promise.all([listProjects(), listChats(), getPublicSettings()])
  const visible = new Set(projects.map((project) => project.id))
  return { projects, chats: chats.filter((chat) => visible.has(chat.projectId)), settings }
}
