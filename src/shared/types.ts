export type Project = {
  id: string
  name: string
  path: string | null
  color?: string
  createdAt: string
  updatedAt: string
  /** Set when the project was removed from the sidebar. Its chats are kept for when it is added again. */
  removedAt?: string
}

export type Attachment = {
  id: string
  mimeType: string
  data: string
}

export type FileMention = {
  path: string
  kind: 'file' | 'folder'
}

export type FileHit = {
  path: string
  name: string
  kind: 'file' | 'folder'
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  kind?: 'btw' | 'steer'
  attachments?: Attachment[]
  mentions?: FileMention[]
  createdAt: string
}

export type PermissionMode = 'ask' | 'accept' | 'plan'

export type PlanEntry = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type ChatPlan = {
  title: string
  entries: PlanEntry[]
  markdown?: string
  awaitingApproval?: boolean
}

export type PlanVerdict = 'approve' | 'revise' | 'abandon'

export type PermissionRequest = {
  requestId: string
  chatId: string
  title: string
  detail: string | null
  toolKind: string | null
}

export type UserQuestionOption = {
  label: string
  description: string | null
  preview: string | null
}

export type UserQuestion = {
  question: string
  header: string | null
  multiSelect: boolean
  options: UserQuestionOption[]
}

export type UserQuestionRequest = {
  requestId: string
  chatId: string
  questions: UserQuestion[]
  title?: string | null
}

/** `declined`: the user stopped answering after something was gathered. `skipped`: nothing was. */
export type ProjectIntakeStatus = 'completed' | 'declined' | 'skipped'

export type ProjectIntakeAnswer = {
  question: string
  values: string[]
  source?: string | null
}

export type ProjectIntakeRound = {
  title: string
  answers: ProjectIntakeAnswer[]
}

export type ProjectIntake = {
  projectId: string
  status: ProjectIntakeStatus
  updatedAt: string
  rounds: ProjectIntakeRound[]
}

export type UserQuestionAnswer = string[]

export type Checkpoint = {
  id: string
  chatId: string
  messageId: string
  createdAt: string
  kind: 'git' | 'files'
  gitSha: string | null
  label: string
  files: string[]
}

export type ChatAgent = 'grok' | 'claude'

export function normalizeChatAgent(value: unknown): ChatAgent {
  return value === 'claude' ? 'claude' : 'grok'
}

export function chatAgentLabel(agent: ChatAgent): string {
  return agent === 'claude' ? 'Claude' : 'Grok'
}

export type Chat = {
  id: string
  projectId: string
  title: string
  /** Which coding agent runs this chat. Missing means Grok. */
  agent?: ChatAgent
  /** ACP session id of the chat's agent (Grok or Claude). */
  grokSessionId: string | null
  createdAt: string
  updatedAt: string
  messages: Message[]
  mode?: PermissionMode
  /** The mode before the chat went into plan mode. Settling the plan returns to it. */
  prePlanMode?: PermissionMode | null
  plan?: ChatPlan | null
  checkpoints?: Checkpoint[]
  worktreePath?: string | null
  worktreeBranch?: string | null
  /** Sends `prompt` to this chat once (`at`) or on a cron schedule. */
  schedule?: ChatSchedule | null
  /** A GitHub pull request linked to this chat (`link_pr`). */
  pr?: ChatPullRequest | null
}

export type ChatPullRequest = {
  number: number
  url: string
  title: string
  /** OPEN, CLOSED or MERGED. */
  state: string
  isDraft: boolean
  checks: 'none' | 'pending' | 'passing' | 'failing'
  /** "3 passed, 1 failed (build)". */
  checksSummary: string
  /** GitHub's reviewDecision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null. */
  review: string | null
  reviewCount: number
  /** Wake the chat when checks finish, a review comes in or the PR closes. */
  watch: boolean
  checkedAt: string
}

export type ChatSchedule = {
  prompt: string
  /** Five-field cron in local time; missing for a one-off run. */
  cron?: string
  /** When the next run is due; null once a one-off has run. */
  nextRunAt: string | null
  lastRunAt?: string
}

export type ChatSummary = Omit<Chat, 'messages'> & {
  messageCount: number
}

export type VoiceSettings = {
  enabled: boolean
  speakReplies: boolean
  autoSend: boolean
  handsFree: boolean
  conversation: boolean
  voiceURI: string
  micDeviceId: string
  rate: number
  /** A Supertonic language code, or 'auto' to pick one per reply. */
  language: string
}

/** The languages Supertonic 3 speaks. `na` reads text without a language. */
export const VOICE_LANGUAGES = [
  'en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu',
  'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi', 'na'
] as const
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number]

export const DEFAULT_VOICE: VoiceSettings = {
  enabled: false,
  speakReplies: true,
  autoSend: true,
  handsFree: false,
  conversation: false,
  voiceURI: 'M1',
  micDeviceId: '',
  rate: 1,
  language: 'auto'
}

const NEURAL_VOICE = /^(F|M)[1-5]$/

/** Where the app update stands. `unsupported` is a dev build, which cannot update itself. */
export type UpdateState =
  | { status: 'unsupported' }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'latest' }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }

export type VoiceModelStatus = {
  state: 'idle' | 'downloading' | 'ready' | 'error'
  error: string | null
  file: string | null
  /** Files fetched so far, out of filesTotal. */
  filesDone: number
  filesTotal: number
}

export type GrokChannel = 'stable' | 'alpha' | 'unknown'

export type GrokCliInfo = {
  path: string
  version: string | null
  channel: GrokChannel
  models: string[]
}

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** Grok Build stops at Extra high. Claude Code adds Max on the models that support it. */
export const GROK_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']

/** The models and effort levels Claude Code offers this account, as its picker shows them. */
export type ClaudeOptions = {
  models: Array<{ value: string; name: string; description?: string }>
  efforts: ReasoningEffort[]
}

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== 'string') return null
  const id = value.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (id === 'low' || id === 'medium' || id === 'high' || id === 'xhigh' || id === 'max') return id
  if (id === 'extrahigh') return 'xhigh'
  return null
}

export function reasoningEffortLabel(effort: ReasoningEffort): string {
  if (effort === 'xhigh') return 'Extra high'
  if (effort === 'max') return 'Max'
  return effort.slice(0, 1).toUpperCase() + effort.slice(1)
}

export type ClaudeCliInfo = {
  signedIn: boolean
  subscription: string | null
  email: string | null
}

/** Claude Code model aliases. Empty means Claude Code's own default for the plan. */
export const CLAUDE_MODELS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' }
]

export type PublicSettings = {
  defaultAgent: ChatAgent
  claude: ClaudeCliInfo
  claudeModel: string
  hasKey: boolean
  keyPreview: string | null
  model: string
  effort: ReasoningEffort | null
  keySource: 'grok-build' | 'env' | 'settings' | 'none'
  grokBuildSignedIn: boolean
  voice: VoiceSettings
  grokCli: GrokCliInfo
  /** The first CLI probe is still running, so `grokCli` and `claude` are placeholders. */
  cliChecking: boolean
}

export function formatGrokCli(cli: GrokCliInfo): string {
  if (!cli.version) return 'CLI missing'
  const version = cli.version.replace(/^v/i, '')
  if (cli.channel === 'unknown') return `v${version}`
  return `v${version} ${cli.channel}`
}

export type UsagePeriodKind = 'weekly' | 'monthly' | 'unknown'

/** Claude plan limits, one row per window (5-hour, weekly, per model). */
export type ClaudeUsage = {
  plan: string | null
  limits: Array<{ label: string; usedPercent: number; resets: string | null }>
}

export type UsageSnapshot = {
  tier: string | null
  usedPercent: number | null
  period: UsagePeriodKind
  periodStart: string | null
  periodEnd: string | null
  prepaidBalance: number | null
  onDemandCap: number | null
  onDemandUsed: number | null
  unifiedBilling: boolean
}

export function normalizeVoiceSettings(value: unknown): VoiceSettings {
  const raw = value && typeof value === 'object' ? (value as Partial<VoiceSettings>) : {}
  const rate = typeof raw.rate === 'number' && Number.isFinite(raw.rate) ? raw.rate : DEFAULT_VOICE.rate
  return {
    enabled: Boolean(raw.enabled),
    speakReplies: raw.speakReplies !== false,
    autoSend: raw.autoSend !== false,
    handsFree: Boolean(raw.handsFree),
    conversation: Boolean(raw.conversation),
    voiceURI: typeof raw.voiceURI === 'string' && NEURAL_VOICE.test(raw.voiceURI) ? raw.voiceURI : DEFAULT_VOICE.voiceURI,
    micDeviceId: typeof raw.micDeviceId === 'string' ? raw.micDeviceId : '',
    rate: Math.min(2, Math.max(0.7, rate)),
    language:
      typeof raw.language === 'string' && (VOICE_LANGUAGES as readonly string[]).includes(raw.language)
        ? raw.language
        : 'auto'
  }
}

export type IndexState =
  | 'no-folder'
  | 'missing-cli'
  | 'installing'
  | 'not-indexed'
  | 'indexing'
  | 'indexed'
  | 'error'

export type ProjectIndex = {
  projectId: string
  state: IndexState
  error: string | null
  fileCount: number | null
  nodeCount: number | null
  languages: string[]
}

export type OrientationCard = {
  projectId: string
  name: string
  path: string | null
  stack: string | null
  summary: string | null
  rulesFile: string | null
  tree: string | null
  fileCount: number | null
  nodeCount: number | null
  languages: string[]
  state: IndexState
  error: string | null
}

export type IndexEvent = {
  type: 'status'
  projectId: string
  index: ProjectIndex
}

export type WorkspaceSnapshot = {
  projects: Project[]
  chats: ChatSummary[]
  settings: PublicSettings
  indexes: Record<string, ProjectIndex>
}

/**
 * Every turn has an id. `turn-start` comes first; `delta`, `done` and `error`
 * carry the id, so events from a turn that already ended can be told apart.
 */
export type ChatEvent =
  | { type: 'turn-start'; chatId: string; turnId: number }
  | { type: 'delta'; chatId: string; turnId: number; text: string }
  | { type: 'done'; chatId: string; turnId: number; chat: Chat }
  | { type: 'error'; chatId: string; turnId: number; error: string }
  | { type: 'plan'; chatId: string; plan: ChatPlan }
  | { type: 'permission'; chatId: string; request: PermissionRequest }
  | { type: 'permission-clear'; chatId: string; requestId: string }
  | { type: 'question'; chatId: string; request: UserQuestionRequest }
  | { type: 'question-clear'; chatId: string; requestId: string }
  | { type: 'chat'; chatId: string; chat: Chat }
  | { type: 'aside-delta'; chatId: string; messageId: string; text: string }
  | { type: 'aside-done'; chatId: string; chat: Chat }
  /** The user clicked a notification for this chat. */
  | { type: 'open'; chatId: string }
  /** The slash commands the chat's agent offers, as it announced them. */
  | { type: 'commands'; chatId: string; commands: AgentCommand[] }

export type AgentCommand = { name: string; description: string; hint?: string }

/** What is running right now, for a window that loads or reloads mid-turn. */
export type ChatLiveState = {
  turns: Array<{ chatId: string; turnId: number; draft: string }>
  permissions: PermissionRequest[]
  questions: UserQuestionRequest[]
}

export function normalizePermissionMode(value: unknown): PermissionMode {
  if (value === 'ask' || value === 'accept' || value === 'plan') return value
  return 'accept'
}

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  if (mode === 'ask') return 'accept'
  if (mode === 'accept') return 'plan'
  return 'ask'
}

export type ActivityKind = 'turn' | 'thought' | 'tool' | 'write' | 'plan' | 'goal' | 'permission' | 'error'

export type ActivityStatus = 'running' | 'done' | 'error'

export type ActivityDiff = {
  path: string
  oldText: string
  newText: string
}

export type ActivityEvent = {
  id: string
  at: string
  chatId: string | null
  chatTitle: string | null
  sessionId: string | null
  kind: ActivityKind
  title: string
  detail: string | null
  status: ActivityStatus | null
  toolKind?: string | null
  diffs?: ActivityDiff[]
  coalesceKey?: string
  /** When a running event finished; absent for events that never ran. */
  endedAt?: string
}

export type ActivityFeed =
  | { type: 'upsert'; event: ActivityEvent }
  | { type: 'reset'; events: ActivityEvent[] }

export type ActivitySnapshot = {
  events: ActivityEvent[]
}

export type CreateProjectInput = {
  name: string
  path?: string | null
  color?: string
}

export type UpdateProjectInput = {
  id: string
  name?: string
  path?: string | null
  color?: string
}

export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserState = {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  visible: boolean
  error: string | null
}

export type BrowserAnnotationHit = {
  url: string
  title: string
  selector: string
  tag: string
  text: string
  html: string
  rect: { x: number; y: number; width: number; height: number }
  screenshotData: string
}

export const DEFAULT_MODEL = 'grok-4.6'

export type GitChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflict'

export type GitFile = {
  path: string
  oldPath: string | null
  staged: GitChangeKind | null
  unstaged: GitChangeKind | null
}

export type GitGraphNode = {
  sha: string
  shortSha: string
  subject: string
  author: string
  date: string
  refs: string[]
  parents: string[]
  lane: number
  openLanes: number[]
  isHead: boolean
}

export type GitReason = 'ok' | 'no-folder' | 'not-a-repo' | 'error'

export type GitSnapshot = {
  projectId: string | null
  chatId: string | null
  path: string | null
  available: boolean
  reason: GitReason
  error: string | null
  branch: string | null
  detached: boolean
  ahead: number
  behind: number
  dirtyCount: number
  files: GitFile[]
  graph: GitGraphNode[]
  /** For a chat in its own worktree: the project checkout's branch and how many commits it lacks. */
  merge: { into: string; commits: number } | null
}

export type GitSummary = {
  projectId: string
  available: boolean
  branch: string | null
  dirtyCount: number
}

export type GitDiffResult = {
  path: string
  oldText: string
  newText: string
  staged: boolean
}

export type GitActionResult = {
  ok: boolean
  error: string | null
  snapshot: GitSnapshot
}

export type KnowledgeReason = 'ok' | 'no-folder' | 'error'

export type KnowledgeNodeKind = 'home' | 'generated' | 'note'

export type KnowledgeNode = {
  id: string
  title: string
  kind: KnowledgeNodeKind
  path: string
  tags: string[]
}

export type KnowledgeEdge = {
  from: string
  to: string
}

export type KnowledgeSnapshot = {
  projectId: string | null
  path: string | null
  available: boolean
  reason: KnowledgeReason
  error: string | null
  nodes: KnowledgeNode[]
  edges: KnowledgeEdge[]
}

export type KnowledgeNote = {
  path: string
  title: string
  body: string
}
