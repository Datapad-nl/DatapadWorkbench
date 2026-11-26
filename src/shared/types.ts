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

/** A configured agent with its own instructions and skills, kept apart from projects. */
export type Bot = {
  id: string
  name: string
  agent: ChatAgent
  /** Model for the bot's agent. Empty means the agent's default. */
  model: string
  /** Reasoning effort for the bot's chats. Empty follows the setting. */
  effort: ReasoningEffort | ''
  /** Whether the bot's chats are told to answer briefly. */
  conciseReplies: boolean
  instructions: string
  /** Tools the bot may use without asking, one name each. */
  allowedTools: string[]
  /** Names of the MCP servers from Settings this bot's chats get. The Workbench's own servers come always. */
  mcpServers: string[]
  /** File name of the avatar in the bot's folder, or null for initials. */
  avatar: string | null
  /** The bot's folder: its avatar, and its skills as a plugin. */
  folder: string
  /** The bot's own chat, shown in the Chat tab of its window. Made the first time the window opens. */
  chatId?: string | null
  /** Messages in the bot's chat that came in since the user last had its Chat tab open. */
  unread?: number
  /** The built-in chief of staff: it alone has a heartbeat, and hands the other bots their due work. Exactly one bot is. */
  chief?: boolean
  createdAt: string
  updatedAt: string
}

/** One of the avatars that ship with the app. */
export type DefaultBotAvatar = {
  /** File name in the bundled folder, such as accountant.webp. */
  name: string
  label: string
  /** The image as a data URL for an `<img>`. */
  url: string
}

export type UpdateBotInput = {
  id: string
  name?: string
  agent?: ChatAgent
  model?: string
  effort?: string | null
  conciseReplies?: boolean
  instructions?: string
  allowedTools?: string[]
  mcpServers?: string[]
}

/** One of a bot's own skills, `skills/<name>/SKILL.md` in its folder. */
export type BotSkill = { name: string; description: string; body: string }
/** `previousName` is null for a new skill. */
export type SaveBotSkillInput = { botId: string; previousName: string | null; name: string; description: string; body: string }
/** A skill listed on skills.sh. `source` is `owner/repo` on GitHub, or the domain that publishes it. */
export type SkillListing = { id: string; source: string; skill: string; installs: number }
/** A listed skill's SKILL.md and the paths of all its files, to look at before adding it to a bot. */
export type SkillPreview = BotSkill & { source: string; skill: string; files: string[] }

/** An image carries its base64 `data`. Any other file has `data` '' and `path`, its copy in the app's folder. */
export type Attachment = {
  id: string
  mimeType: string
  data: string
  /** A file's original name. */
  name?: string
  path?: string
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
  /** Bots the user named with @ in this message. */
  bots?: BotMention[]
  /** The message starts with @bots and went only to them: the chat's agent did not answer it. */
  toBots?: boolean
  /** Set on a bot's answer posted in a project chat. */
  fromBot?: BotAnswer
  createdAt: string
}

export type BotMention = { id: string; name: string }

export type BotAnswer = {
  botId: string
  name: string
  /** The bot's own chat the answer comes from. */
  runChatId: string
  /** What the user asked the bot in a message addressed to it, which the chat's agent never got. */
  question?: string
  /** Set once the chat's agent got the answer with a prompt. */
  delivered?: boolean
  /** The bot's acknowledgement while its run works: no answer yet. The answer replaces it, posted last. */
  pending?: boolean
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
  /** Set when the edit would change files another chat in the same folder changed and has not committed. */
  clash?: EditClash
  shownIn?: ShownIn
}

/** A bot asked from another chat: its run's requests are shown in the asking chat, where the user waits. */
export type ShownIn = { chatId: string; botName: string }

export type EditClash = {
  /** The chat that changed the files last. */
  chatId: string
  chatTitle: string
  files: string[]
  /** That chat's turn is still running, so the edit can wait for it. */
  running: boolean
  /** The user chose to wait; the edit goes ahead when that chat's turn ends. */
  waiting?: boolean
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
  /** Asks for a secret: a password field in place of the options. The answer goes to the vault, not the agent. */
  secret?: { name: string }
}

/** The names of the secrets kept for a project id or `bot:<id>`. */
export type SecretScope = { scope: string; names: string[] }

export type UserQuestionRequest = {
  requestId: string
  chatId: string
  questions: UserQuestion[]
  title?: string | null
  shownIn?: ShownIn
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
  /** 'git': a commit in the project's repository. 'shadow': a commit in the chat's own repository, for a folder outside git. 'files': only the per-file copies. */
  kind: 'git' | 'shadow' | 'files'
  gitSha: string | null
  label: string
  files: string[]
}

/** `workbench` is the app's own agent, which runs the providers' models. */
export type ChatAgent = 'grok' | 'claude' | 'workbench'

/** `model` is the stored one: a provider's (wb-) model saved under Grok, as before the app's own agent, is on that agent. */
export function normalizeChatAgent(value: unknown, model?: unknown): ChatAgent {
  if (value === 'claude' || value === 'workbench') return value
  return typeof model === 'string' && model.startsWith('wb-') ? 'workbench' : 'grok'
}

export function chatAgentLabel(agent: ChatAgent): string {
  return agent === 'claude' ? 'Claude' : agent === 'workbench' ? 'Workbench' : 'Grok'
}

/** The app's own agent process: not started yet or stopped on purpose, answering, or gone or failed to start. */
export type WorkbenchAgentStatus = 'idle' | 'running' | 'failed'

export type Chat = {
  id: string
  /** Empty for a chat of a bot, which works in the bot's folder. A bot's run asked with @ from a project chat works in this project. */
  projectId: string
  /** The bot this chat belongs to: it runs with the bot's instructions and skills. */
  botId?: string
  /** A bot's run asked with @ or ask_bot: the chat its answer is posted in, a project chat or another bot's own chat. */
  replyTo?: string
  /** The last message of the replyTo chat when the bot was asked: its first prompt gets the conversation up to there. */
  askedAfter?: string
  title: string
  /** Which coding agent runs this chat. Missing means Grok. */
  agent?: ChatAgent
  /** Model of this chat, for its agent. Missing means the one in Settings (Claude) or the CLI's default (Grok). */
  model?: string
  /** Reasoning effort of this chat. Missing means the one in Settings. */
  effort?: ReasoningEffort
  /** Its next session gets the conversation so far: set by an agent switch, a rewind or a lost session. */
  carryOver?: boolean
  /** Set by /conduct: the chat plans and hands the work to workers, on the orchestrator model. */
  conductor?: boolean
  /** The chat that started this one with `delegate`. */
  parentChatId?: string
  /** The chat this one continues, from its handoff file. */
  handoffFrom?: string
  /** The chat that continues this one with a fresh context. */
  handoffTo?: string
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
  /** A bot's follow-up (`follow_up`): this chat wakes once at `at`, in the session that set it. */
  wake?: ChatWake | null
  /** A scheduled run or follow-up running here. Still set at start means the app closed during it. */
  unattended?: UnattendedRun | null
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
  /** The chief of staff's heartbeat: each run builds its prompt from the checklist and the bots' open work. */
  heartbeat?: boolean
}

export type ChatWake = {
  at: string
  /** What the bot wants to check, in its own words. It is the message the chat wakes with. */
  note: string
  /** The session the follow-up was set in, which it resumes. */
  sessionId: string | null
}

export type UnattendedRun = { kind: 'schedule' | 'followUp'; startedAt: string }

/** A memory folder, a bot's own or the one all bots share: its MEMORY.md index and the other files in it. */
export type BotMemory = { folder: string; index: string; files: string[] }

/** A book or document a bot can read: converted into one Markdown file per chapter in its own folder. */
export type BotDocument = { id: string; title: string; source: string; addedAt: string; chapters: number; words: number }

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

/** The wire protocol of an inference provider. */
export type ProviderBackend = 'chat_completions' | 'responses' | 'messages'

export type ProviderModel = {
  /** Model id sent to the provider, such as anthropic/claude-sonnet-4.5. */
  id: string
  name: string
  contextWindow?: number
  /** Effort levels the model takes. Empty: no effort control. */
  efforts: ReasoningEffort[]
  /** False for a model that takes text only, so no image is sent to it. Unset: images are sent. */
  images?: boolean
}

/** An inference provider whose models the app's own agent runs. Its key reaches only the main process and that agent. */
export type Provider = {
  /** Slug, unique, [a-z0-9-], such as openrouter. */
  id: string
  name: string
  baseUrl: string
  backend: ProviderBackend
  hasKey: boolean
  keyPreview: string | null
  models: ProviderModel[]
}

export type SaveProviderInput = {
  /** Missing for a new provider: the id is made from the name. */
  id?: string
  name: string
  baseUrl: string
  backend: ProviderBackend
  /** undefined keeps the stored key; '' clears it. */
  apiKey?: string
  models: ProviderModel[]
}

export const PROVIDER_PRESETS: Array<{ name: string; baseUrl: string; backend: ProviderBackend; needsKey: boolean }> = [
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', backend: 'chat_completions', needsKey: true },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', backend: 'responses', needsKey: true },
  { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', backend: 'messages', needsKey: true },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', backend: 'chat_completions', needsKey: false }
]

/** Lower case, with every run of other characters one dash. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The key of a provider's model in Chat.model / Bot.model: wb-<providerId>-<slug of model id>. */
export function providerModelKey(providerId: string, modelId: string): string {
  return `wb-${providerId}-${slugify(modelId)}`
}

export type GrokModelChoice = {
  value: string
  name: string
  /** 'Grok' or the provider's name. */
  group: string
  efforts: ReasoningEffort[]
}

/** Grok's own models (ids from `grok models` that do not start with wb-) with GROK_REASONING_EFFORTS, then every provider's models. */
export function grokModelChoices(grokModels: string[], providers: Provider[]): GrokModelChoice[] {
  const own = grokModels
    .filter((value) => !value.startsWith('wb-'))
    .map((value) => ({ value, name: value, group: 'Grok', efforts: GROK_REASONING_EFFORTS }))
  const added = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: providerModelKey(provider.id, model.id),
      name: model.name,
      group: provider.name,
      efforts: model.efforts
    }))
  )
  return [...own, ...added]
}

/**
 * What a chat runs on, as the user picks it: Claude, Grok, or a provider whose models the app's own agent runs.
 * `key` is 'claude', 'grok', 'provider-<id>', or 'workbench' for that agent with no provider left.
 */
export type ChatProviderChoice = { key: string; agent: ChatAgent; provider: Provider | null; name: string }

/** Claude, Grok, then each provider with at least one model. */
export function chatProviderChoices(providers: Provider[]): ChatProviderChoice[] {
  return [
    { key: 'claude', agent: 'claude', provider: null, name: 'Claude' },
    { key: 'grok', agent: 'grok', provider: null, name: 'Grok' },
    ...providers
      .filter((provider) => provider.models.length > 0)
      .map((provider) => ({ key: `provider-${provider.id}`, agent: 'workbench' as const, provider, name: provider.name }))
  ]
}

/**
 * The choice an agent and model are on. On the app's own agent: the provider of the model, else for no
 * model the first provider, as that agent then runs the first provider's first model. A model whose
 * provider was removed is on none, so the chat does not look as if it runs on another provider.
 */
export function chatProviderOf(agent: ChatAgent, model: string, providers: Provider[]): ChatProviderChoice {
  const choices = chatProviderChoices(providers)
  if (agent === 'claude') return choices[0]
  if (agent === 'grok') return choices[1]
  const listed = choices.slice(2)
  // A listed model first, then the longest id, as one provider's id can start another's.
  return (
    listed.find((choice) => choice.provider?.models.some((item) => providerModelKey(choice.provider!.id, item.id) === model)) ??
    listed
      .filter((choice) => model.startsWith(`wb-${choice.provider!.id}-`))
      .sort((a, b) => b.key.length - a.key.length)[0] ??
    (model.startsWith('wb-') ? { key: 'workbench', agent: 'workbench', provider: null, name: 'Removed provider' } : null) ??
    listed[0] ?? { key: 'workbench', agent: 'workbench', provider: null, name: chatAgentLabel('workbench') }
  )
}

/** The effort levels a Grok model value takes: its choice's; none for a provider model no longer listed; else Grok's own. */
export function grokModelEfforts(choices: GrokModelChoice[], value: string): ReasoningEffort[] {
  const choice = choices.find((item) => item.value === value)
  if (choice) return choice.efforts
  return value.startsWith('wb-') ? [] : GROK_REASONING_EFFORTS
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
  /** Claude Code model of a conductor chat. Empty means `claudeModel`. */
  orchestratorModel: string
  /** Model of every worker: Claude Code's, or a provider's (wb-), which runs on that provider. Empty lets the conductor pick one per task. */
  subagentModel: string
  /** How many workers of one chat run at the same time. */
  maxSubagents: number
  /** Chats the user talks to are told to reply short and to the point. */
  conciseReplies: boolean
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
  /** Inference providers whose models Grok chats can run on. */
  providers: Provider[]
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

/**
 * Which plans the usage panel shows. Grok's is shown when signed in, or as before when there is no Claude,
 * unless the user has only providers: their own key has no plan, so asking Grok for one only fails.
 */
export function usagePlans(
  settings: Pick<PublicSettings, 'claude' | 'grokBuildSignedIn' | 'defaultAgent' | 'hasKey' | 'providers'>
): { grok: boolean; claude: boolean; claudeFirst: boolean } {
  const claude = settings.claude.signedIn === true
  const providersOnly = !settings.hasKey && settings.providers.length > 0
  const grok = settings.grokBuildSignedIn === true || (!claude && !providersOnly)
  return { grok, claude, claudeFirst: claude && (settings.defaultAgent === 'claude' || !grok) }
}

/** The plan the status bar meter shows: none for a provider's chat, which runs on the user's own key. */
export function usageMeterPlan(
  plans: { grok: boolean; claude: boolean; claudeFirst: boolean },
  agent: ChatAgent | undefined
): 'grok' | 'claude' | null {
  if (agent === 'workbench') return null
  if (plans.claudeFirst) return 'claude'
  return plans.grok ? 'grok' : null
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
  /** The user picked this bot in the menu bar menu, or clicked a notification of its chat. */
  | { type: 'open-bot'; botId: string }
  /** A bot changed in the main process, for example its unread count. */
  | { type: 'bot'; bot: Bot }
  /**
   * A new message landed in a bot's own chat: its reply, or a scheduled run's answer posted there.
   * `source` names the run it came from, if any. The window shows a toast unless the bot's Chat tab is open.
   */
  | { type: 'bot-message'; botId: string; chatId: string; text: string; source?: string }
  /** The slash commands the chat's agent offers, as it announced them. */
  | { type: 'commands'; chatId: string; commands: AgentCommand[] }
  /** How full the context window of the chat's session is. */
  | { type: 'context'; chatId: string; context: ChatContext }

export type AgentCommand = { name: string; description: string; hint?: string }

/** What is running right now, for a window that loads or reloads mid-turn. */
/** Tokens the conversation takes in each model call, and the model's window when known. */
export type ChatContext = {
  used: number
  size: number | null
  /** Grok Build reports a turn's total, so `used` is the turn's average per model call. */
  estimate?: boolean
}

export type ChatLiveState = {
  turns: Array<{ chatId: string; turnId: number; draft: string }>
  contexts: Record<string, ChatContext>
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

export type BrowserTab = {
  id: string
  url: string
  title: string
  loading: boolean
}

/** The scope's active tab, with the scope's tabs in order. */
export type BrowserState = {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  visible: boolean
  error: string | null
  tabs: BrowserTab[]
  activeTabId: string | null
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
