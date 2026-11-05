import { contextBridge, ipcRenderer } from 'electron'
import type { McpServers } from '../shared/mcp'
import type { ThemeFile, ThemeSummary } from '../shared/theme'
import type { YoutubeTranscriptResult } from '../shared/youtube'
import type {
  AgentCommand,
  ActivityFeed,
  ActivitySnapshot,
  BrowserAnnotationHit,
  BrowserBounds,
  BrowserState,
  Chat,
  ChatAgent,
  ChatEvent,
  CreateProjectInput,
  FileHit,
  FileMention,
  GitActionResult,
  GitDiffResult,
  GitSnapshot,
  GitSummary,
  IndexEvent,
  KnowledgeNote,
  KnowledgeSnapshot,
  PermissionMode,
  PlanVerdict,
  UpdateProjectInput,
  UsageSnapshot,
  ClaudeOptions,
  ClaudeUsage,
  VoiceModelStatus,
  VoiceSettings
} from '../shared/types'

const api = {
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  createProject: (input: CreateProjectInput) => ipcRenderer.invoke('project:create', input),
  updateProject: (input: UpdateProjectInput) => ipcRenderer.invoke('project:update', input),
  deleteProject: (projectId: string) => ipcRenderer.invoke('project:delete', projectId),
  indexProject: (projectId: string) => ipcRenderer.invoke('project:index', projectId),
  getOrientation: (projectId: string) => ipcRenderer.invoke('project:orientation', projectId),
  getProjectIcon: (projectId: string) =>
    ipcRenderer.invoke('project:icon', projectId) as Promise<string | null>,
  ensureProjectIntake: (projectId: string, chatId: string) =>
    ipcRenderer.invoke('project:ensureIntake', { projectId, chatId }),
  pickFolder: () => ipcRenderer.invoke('project:pickFolder'),
  createChat: (projectId: string) => ipcRenderer.invoke('chat:create', projectId),
  getChat: (chatId: string) => ipcRenderer.invoke('chat:get', chatId),
  searchChats: (query: string): Promise<string[]> => ipcRenderer.invoke('chat:search', query),
  getMcpServers: (): Promise<McpServers> => ipcRenderer.invoke('mcp:get'),
  setMcpServers: (text: string): Promise<{ servers: McpServers } | { error: string }> =>
    ipcRenderer.invoke('mcp:set', text),
  exportChatMarkdown: (title: string, markdown: string): Promise<string | null> =>
    ipcRenderer.invoke('chat:exportMarkdown', { title, markdown }),
  getChatCommands: (chatId: string) => ipcRenderer.invoke('chat:commands', chatId) as Promise<AgentCommand[]>,
  deleteChat: (chatId: string) => ipcRenderer.invoke('chat:delete', chatId),
  renameChat: (id: string, title: string) => ipcRenderer.invoke('chat:rename', { id, title }),
  setChatAgent: (id: string, agent: ChatAgent) =>
    ipcRenderer.invoke('chat:setAgent', { id, agent }) as Promise<Chat>,
  sendMessage: (
    chatId: string,
    content: string,
    attachments?: Array<{ id: string; mimeType: string; data: string }>,
    mentions?: FileMention[]
  ) => ipcRenderer.invoke('chat:send', { chatId, content, attachments, mentions }),
  searchFiles: (projectId: string, query: string, chatId?: string) =>
    ipcRenderer.invoke('project:searchFiles', { projectId, query, chatId }) as Promise<FileHit[]>,
  stopChat: (chatId: string) => ipcRenderer.invoke('chat:stop', chatId),
  setChatMode: (chatId: string, mode: PermissionMode) =>
    ipcRenderer.invoke('chat:setMode', { chatId, mode }),
  resolvePermission: (requestId: string, decision: 'allow' | 'deny') =>
    ipcRenderer.invoke('chat:resolvePermission', { requestId, decision }),
  resolveQuestion: (
    requestId: string,
    decision: { type: 'skip' } | { type: 'submit'; answers: string[][] }
  ) => ipcRenderer.invoke('chat:resolveQuestion', { requestId, ...decision }),
  resolvePlanApproval: (chatId: string, decision?: 'allow' | 'deny' | PlanVerdict) =>
    ipcRenderer.invoke('chat:resolvePlanApproval', { chatId, decision }) as Promise<boolean>,
  rewindChat: (chatId: string, checkpointId: string) =>
    ipcRenderer.invoke('chat:rewind', { chatId, checkpointId }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (input: {
    apiKey?: string
    model?: string
    effort?: string | null
    voice?: Partial<VoiceSettings>
    defaultAgent?: ChatAgent
    claudeModel?: string
  }) =>
    ipcRenderer.invoke('settings:set', input),
  getVoiceModelStatus: () => ipcRenderer.invoke('voice:modelStatus') as Promise<VoiceModelStatus>,
  ensureVoiceModel: () => ipcRenderer.invoke('voice:ensureModel') as Promise<VoiceModelStatus>,
  ensureMic: () => ipcRenderer.invoke('voice:ensureMic') as Promise<boolean>,
  getMicAccess: () =>
    ipcRenderer.invoke('voice:micAccess') as Promise<
      'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
    >,
  openMicSettings: () => ipcRenderer.invoke('voice:openMicSettings') as Promise<void>,
  onVoiceModelStatus: (listener: (status: VoiceModelStatus) => void) => {
    const wrapped = (_event: unknown, payload: VoiceModelStatus): void => listener(payload)
    ipcRenderer.on('voice:modelStatus', wrapped)
    return () => {
      ipcRenderer.removeListener('voice:modelStatus', wrapped)
    }
  },
  getThemeState: (): Promise<{ active: ThemeFile; themes: ThemeSummary[]; activeId: string }> =>
    ipcRenderer.invoke('theme:state'),
  activateTheme: (id: string): Promise<{ active: ThemeFile; themes: ThemeSummary[]; activeId: string }> =>
    ipcRenderer.invoke('theme:activate', id),
  saveTheme: (theme: ThemeFile): Promise<{ active: ThemeFile; themes: ThemeSummary[]; activeId: string }> =>
    ipcRenderer.invoke('theme:save', theme),
  deleteTheme: (id: string): Promise<{ active: ThemeFile; themes: ThemeSummary[]; activeId: string }> =>
    ipcRenderer.invoke('theme:delete', id),
  importTheme: (): Promise<{ active: ThemeFile; themes: ThemeSummary[]; activeId: string } | null> =>
    ipcRenderer.invoke('theme:import'),
  exportTheme: (id: string): Promise<boolean> => ipcRenderer.invoke('theme:export', id),
  onChatEvent: (listener: (event: ChatEvent) => void) => {
    const wrapped = (_event: unknown, payload: ChatEvent): void => listener(payload)
    ipcRenderer.on('chat:event', wrapped)
    return () => {
      ipcRenderer.removeListener('chat:event', wrapped)
    }
  },
  onIndexEvent: (listener: (event: IndexEvent) => void) => {
    const wrapped = (_event: unknown, payload: IndexEvent): void => listener(payload)
    ipcRenderer.on('index:event', wrapped)
    return () => {
      ipcRenderer.removeListener('index:event', wrapped)
    }
  },
  getActivity: () => ipcRenderer.invoke('activity:get') as Promise<ActivitySnapshot>,
  clearActivity: () => ipcRenderer.invoke('activity:clear') as Promise<ActivitySnapshot>,
  onActivityEvent: (listener: (event: ActivityFeed) => void) => {
    const wrapped = (_event: unknown, payload: ActivityFeed): void => listener(payload)
    ipcRenderer.on('activity:event', wrapped)
    return () => {
      ipcRenderer.removeListener('activity:event', wrapped)
    }
  },
  getBrowserState: () => ipcRenderer.invoke('browser:getState') as Promise<BrowserState>,
  setBrowserVisible: (visible: boolean) =>
    ipcRenderer.invoke('browser:setVisible', visible) as Promise<BrowserState>,
  setBrowserBounds: (bounds: BrowserBounds) =>
    ipcRenderer.invoke('browser:setBounds', bounds) as Promise<BrowserState>,
  navigateBrowser: (url: string) =>
    ipcRenderer.invoke('browser:navigate', url) as Promise<BrowserState>,
  browserBack: () => ipcRenderer.invoke('browser:back') as Promise<BrowserState>,
  browserForward: () => ipcRenderer.invoke('browser:forward') as Promise<BrowserState>,
  reloadBrowser: () => ipcRenderer.invoke('browser:reload') as Promise<BrowserState>,
  stopBrowser: () => ipcRenderer.invoke('browser:stop') as Promise<BrowserState>,
  clearBrowserData: () => ipcRenderer.invoke('browser:clearData') as Promise<BrowserState>,
  startBrowserAnnotate: () =>
    ipcRenderer.invoke('browser:annotateStart') as Promise<BrowserAnnotationHit | null>,
  cancelBrowserAnnotate: () => ipcRenderer.invoke('browser:annotateCancel') as Promise<void>,
  transcribeYoutube: (url: string, lang?: string) =>
    ipcRenderer.invoke('youtube:transcribe', { url, lang }) as Promise<YoutubeTranscriptResult>,
  onBrowserState: (listener: (state: BrowserState) => void) => {
    const wrapped = (_event: unknown, payload: BrowserState): void => listener(payload)
    ipcRenderer.on('browser:state', wrapped)
    return () => {
      ipcRenderer.removeListener('browser:state', wrapped)
    }
  },
  onBrowserRequestShow: (listener: () => void) => {
    const wrapped = (): void => listener()
    ipcRenderer.on('browser:requestShow', wrapped)
    return () => {
      ipcRenderer.removeListener('browser:requestShow', wrapped)
    }
  },
  getGitSnapshot: (projectId: string, chatId?: string | null) =>
    ipcRenderer.invoke('git:snapshot', { projectId, chatId }) as Promise<GitSnapshot>,
  getGitSummaries: () => ipcRenderer.invoke('git:summaries') as Promise<Record<string, GitSummary>>,
  getGitDiff: (projectId: string, path: string, staged: boolean, chatId?: string | null) =>
    ipcRenderer.invoke('git:diff', { projectId, path, staged, chatId }) as Promise<GitDiffResult>,
  stageGitPath: (projectId: string, path: string, chatId?: string | null) =>
    ipcRenderer.invoke('git:stage', { projectId, path, chatId }) as Promise<GitActionResult>,
  unstageGitPath: (projectId: string, path: string, chatId?: string | null) =>
    ipcRenderer.invoke('git:unstage', { projectId, path, chatId }) as Promise<GitActionResult>,
  discardGitPath: (projectId: string, path: string, chatId?: string | null) =>
    ipcRenderer.invoke('git:discard', { projectId, path, chatId }) as Promise<GitActionResult>,
  commitGit: (projectId: string, message: string, chatId?: string | null) =>
    ipcRenderer.invoke('git:commit', { projectId, message, chatId }) as Promise<GitActionResult>,
  checkoutGit: (projectId: string, ref: string, chatId?: string | null) =>
    ipcRenderer.invoke('git:checkout', { projectId, ref, chatId }) as Promise<GitActionResult>,
  createGitBranch: (projectId: string, name: string, chatId?: string | null) =>
    ipcRenderer.invoke('git:createBranch', { projectId, name, chatId }) as Promise<GitActionResult>,
  mergeChatBranch: (projectId: string, chatId: string) =>
    ipcRenderer.invoke('git:mergeChat', { projectId, chatId }) as Promise<GitActionResult>,
  setGitActiveProject: (projectId: string | null, chatId?: string | null) =>
    ipcRenderer.invoke('git:setActive', { projectId, chatId }) as Promise<boolean>,
  onGitSnapshot: (listener: (snapshot: GitSnapshot) => void) => {
    const wrapped = (_event: unknown, payload: GitSnapshot): void => listener(payload)
    ipcRenderer.on('git:snapshot', wrapped)
    return () => {
      ipcRenderer.removeListener('git:snapshot', wrapped)
    }
  },
  onGitSummaries: (listener: (summaries: Record<string, GitSummary>) => void) => {
    const wrapped = (_event: unknown, payload: Record<string, GitSummary>): void => listener(payload)
    ipcRenderer.on('git:summaries', wrapped)
    return () => {
      ipcRenderer.removeListener('git:summaries', wrapped)
    }
  },
  getKnowledgeSnapshot: (projectId: string) =>
    ipcRenderer.invoke('knowledge:snapshot', projectId) as Promise<KnowledgeSnapshot>,
  rebuildKnowledge: (projectId: string) =>
    ipcRenderer.invoke('knowledge:rebuild', projectId) as Promise<KnowledgeSnapshot>,
  getKnowledgeNote: (projectId: string, path: string) =>
    ipcRenderer.invoke('knowledge:note', { projectId, path }) as Promise<KnowledgeNote | null>,
  openKnowledgeVault: (projectId: string) =>
    ipcRenderer.invoke('knowledge:openVault', projectId) as Promise<boolean>,
  revealKnowledgeVault: (projectId: string) =>
    ipcRenderer.invoke('knowledge:revealVault', projectId) as Promise<boolean>,
  setKnowledgeActiveProject: (projectId: string | null) =>
    ipcRenderer.invoke('knowledge:setActive', projectId) as Promise<boolean>,
  onKnowledgeSnapshot: (listener: (snapshot: KnowledgeSnapshot) => void) => {
    const wrapped = (_event: unknown, payload: KnowledgeSnapshot): void => listener(payload)
    ipcRenderer.on('knowledge:snapshot', wrapped)
    return () => {
      ipcRenderer.removeListener('knowledge:snapshot', wrapped)
    }
  },
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url) as Promise<boolean>,
  openMedia: (chatId: string, src: string) =>
    ipcRenderer.invoke('media:open', { chatId, src }) as Promise<boolean>,
  getUsage: () => ipcRenderer.invoke('usage:get') as Promise<UsageSnapshot>,
  getClaudeUsage: () => ipcRenderer.invoke('usage:claude') as Promise<ClaudeUsage>,
  getClaudeOptions: (model: string) =>
    ipcRenderer.invoke('claude:options', model) as Promise<ClaudeOptions | null>,
  quitApp: () => ipcRenderer.invoke('app:quit') as Promise<boolean>
}

export type WorkbenchApi = typeof api

contextBridge.exposeInMainWorld('workbench', api)
