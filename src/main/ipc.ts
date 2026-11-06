import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'fs/promises'
import { basename, join } from 'path'
import type {
  BrowserBounds,
  Chat,
  ChatAgent,
  ChatEvent,
  CreateProjectInput,
  FileMention,
  IndexEvent,
  PermissionMode,
  PlanVerdict,
  UpdateProjectInput,
  UserQuestionAnswer,
  VoiceSettings
} from '../shared/types'
import { normalizeChatAgent, normalizePermissionMode } from '../shared/types'
import { notifyChat, watchAttention } from './attention'
import {
  clearActivity,
  emitPermissionActivity,
  getActivitySnapshot,
  startActivityBridge
} from './activity'
import {
  cancelBrowserAnnotate,
  clearBrowserData,
  getBrowserState,
  goBack,
  goForward,
  navigateBrowser,
  reloadBrowser,
  sanitizeUrl,
  setBrowserBounds,
  setBrowserVisible,
  startBrowserAnnotate,
  stopBrowser
} from './browser'
import { openChatMedia } from './media'
import { transcribeYoutube } from './youtube'
import { buildOrientation, collectIndexes, onIndexChange, queueIndex } from './codegraph'
import {
  getKnowledgeNote,
  getKnowledgeSnapshot,
  maintainVault,
  maintainVaultForProjectId,
  openKnowledgeVault,
  rebuildKnowledge,
  revealKnowledgeVault,
  setKnowledgeActiveProject,
  syncKnowledgeWatchers
} from './knowledge'
import { searchProjectFiles } from './files'
import { projectIcon } from './projectIcon'
import { killProcessesUnder } from './worktreeProcs'
import { deleteAllCheckpoints } from './checkpoints'
import {
  chatCommands,
  conversationEnded,
  endConversation,
  forgetChat,
  isStreaming,
  liveState,
  loadChat,
  onChatLive,
  rewindChat,
  sendUserTurn,
  setChatMode,
  settleChatPlan,
  startAside,
  stopAndWait,
  stopStream
} from './grok'
import {
  applyClaudeModelToLiveSessions,
  applyEffortToLiveSessions,
  fetchUsage,
  getClaudeOptions
} from './acp'
import { fetchClaudeUsage } from './claudeUsage'
import {
  onPermissionDenied,
  onPermissionPrompt,
  onPermissionSettled,
  resolvePermission
} from './permissions'
import { cancelProjectIntake, maybeStartProjectIntake, scheduleProjectIntake } from './intake'
import { registerChatTools, stopSchedule } from './chatTools'
import { unlinkPr } from './pullRequests'
import { cancelChatQuestions, onUserQuestionPrompt, onUserQuestionSettled, resolveUserQuestion } from './questions'
import {
  createChat,
  createProject,
  deleteChat,
  removeProject,
  getChat,
  listChats,
  listProjects,
  mutateChat,
  renameChat,
  searchChats,
  getMcpServers,
  getPublicSettings,
  onCliInfoChange,
  setMcpServers,
  snapshot,
  updateProject,
  updateSettings
} from './store'
import {
  ensureMicAccess,
  ensureVoiceModel,
  getMicAccess,
  onVoiceModelStatus,
  openMicPrivacySettings,
  readVoiceModelStatus
} from './voice'
import { checkForUpdates, getUpdateState, installUpdate, onUpdateState } from './updater'
import { replySteps } from '../shared/steps'
import {
  checkoutGit,
  chatWorkingDir,
  commitGit,
  createGitBranch,
  mergeChatBranch,
  discardGitPath,
  getGitDiff,
  getGitSnapshot,
  getGitSummaries,
  removeChatWorktree,
  setGitActiveProject,
  setMergeGuard,
  stageGitPath,
  syncGitWatchers,
  unstageGitPath
} from './git'
import {
  activateTheme,
  deleteUserTheme,
  exportThemeFile,
  getThemeState,
  importThemeFile,
  saveUserTheme
} from './themes'

function emit(event: ChatEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('chat:event', event)
  }
}

function openFromNotice(chatId: string): void {
  emit({ type: 'open', chatId })
}

/** System notification for a chat that needs the user, when the app is in the background. */
async function noticeFor(chatId: string, body: string, urgent = false): Promise<void> {
  const chat = await getChat(chatId).catch(() => null)
  if (chat) notifyChat(chat, body, openFromNotice, urgent)
}

function emitIndex(event: IndexEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('index:event', event)
  }
}

/** Add the user's message and run the turn; `done` settles when the reply is in. */
async function sendTurn(
  chatId: string,
  content: string,
  attachments: Array<{ id: string; mimeType: string; data: string }> = [],
  mentions: FileMention[] = []
): Promise<{ chat: Chat; done: Promise<Chat | null> }> {
  // The turn sends its own done or error event; this only adds the system notification.
  const { chat, done } = await sendUserTurn(chatId, content, attachments, mentions)
  const notified = done.then(
    (saved) => {
      const reply = saved?.messages.at(-1)
      const answer = reply?.role === 'assistant' ? replySteps(reply.content).at(-1) : undefined
      if (saved) notifyChat(saved, answer || 'Finished', openFromNotice)
      return saved
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Grok request failed'
      void noticeFor(chatId, `Stopped: ${message}`)
      throw error
    }
  )
  return { chat, done: notified }
}

export function registerIpc(): void {
  // A merge mid-turn would take files the agent is still writing.
  setMergeGuard((_projectId, chatId) =>
    isStreaming(chatId) ? 'This chat is still working. Merge once it finishes.' : null
  )
  registerChatTools({ send: sendTurn, emit, isStreaming })
  startActivityBridge()
  watchAttention()
  onIndexChange((index) => {
    emitIndex({ type: 'status', projectId: index.projectId, index })
    if (index.state === 'indexing' || index.state === 'installing' || index.state === 'no-folder') return
    void maintainVaultForProjectId(index.projectId)
  })
  onChatLive((event) => emit(event))
  onPermissionPrompt((request) => {
    emit({ type: 'permission', chatId: request.chatId, request })
    void noticeFor(request.chatId, `Needs approval: ${request.title}`, true)
    emitPermissionActivity({
      chatId: request.chatId,
      sessionId: null,
      title: request.title,
      detail: request.detail,
      status: 'running',
      requestId: request.requestId
    })
  })
  onPermissionSettled((request) => {
    emit({ type: 'permission-clear', chatId: request.chatId, requestId: request.requestId })
    emitPermissionActivity({
      chatId: request.chatId,
      sessionId: null,
      title: request.title,
      detail: request.detail,
      status: 'done',
      requestId: request.requestId
    })
  })
  onPermissionDenied((request) => {
    emitPermissionActivity({
      chatId: request.chatId,
      sessionId: null,
      title: request.title,
      detail: request.detail,
      status: 'done',
      requestId: request.requestId
    })
  })
  onUserQuestionPrompt((request) => {
    emit({ type: 'question', chatId: request.chatId, request })
    void noticeFor(request.chatId, request.questions[0]?.question || request.title || 'Has a question for you', true)
  })
  onUserQuestionSettled((request) => {
    emit({ type: 'question-clear', chatId: request.chatId, requestId: request.requestId })
  })

  ipcMain.handle('workspace:get', async () => {
    const current = await snapshot()
    return { ...current, indexes: await collectIndexes(current.projects) }
  })

  ipcMain.handle('project:create', async (_event, input: CreateProjectInput) => {
    const name = input.name?.trim() || (input.path ? basename(input.path) : 'Untitled project')
    const project = await createProject(name, input.path ?? null, input.color)
    const chat = await createChat(project.id)
    void syncGitWatchers()
    void syncKnowledgeWatchers()
    void maintainVault(project)
    scheduleProjectIntake(project, chat.id)
    return { project, chat }
  })

  ipcMain.handle('project:update', async (_event, input: UpdateProjectInput) => {
    const project = await updateProject(input)
    void syncGitWatchers()
    void syncKnowledgeWatchers()
    void maintainVault(project)
    return project
  })

  ipcMain.handle('project:delete', async (_event, projectId: string) => {
    // Removing a project only hides it. Its chats, intake and files on disk are kept.
    const chats = await listChats()
    for (const chat of chats.filter((item) => item.projectId === projectId)) {
      await stopAndWait(chat.id)
      // Asked again if the project comes back, rather than recorded as declined.
      cancelProjectIntake(chat.id)
      if (chat.worktreePath) await killProcessesUnder(chat.worktreePath)
    }
    await removeProject(projectId)
    void syncGitWatchers()
    void syncKnowledgeWatchers()
    return snapshot()
  })

  ipcMain.handle('project:index', async (_event, projectId: string) => {
    const projects = await listProjects()
    const project = projects.find((item) => item.id === projectId)
    if (!project) throw new Error('Project not found')
    if (!project.path) throw new Error('Attach a folder before indexing')
    queueIndex(project.id, project.path)
    return true
  })

  ipcMain.handle('project:orientation', async (_event, projectId: string) => {
    const projects = await listProjects()
    const project = projects.find((item) => item.id === projectId)
    if (!project) throw new Error('Project not found')
    return buildOrientation(project)
  })

  ipcMain.handle('project:icon', async (_event, projectId: string) => {
    const projects = await listProjects()
    const project = projects.find((item) => item.id === projectId)
    return project?.path ? projectIcon(project.path) : null
  })

  ipcMain.handle(
    'project:searchFiles',
    async (_event, input: { projectId: string; query: string; chatId?: string }) => {
      return searchProjectFiles(input.projectId, String(input.query ?? ''), input.chatId)
    }
  )

  ipcMain.handle('project:pickFolder', async () => {
    const window = BrowserWindow.getFocusedWindow()
    const options = {
      title: 'Choose project folder',
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('project:ensureIntake', async (_event, input: { projectId: string; chatId: string }) => {
    void maybeStartProjectIntake(input.projectId, input.chatId)
    return true
  })

  ipcMain.handle('chat:create', async (_event, projectId: string) => {
    const chat = await createChat(projectId)
    void maybeStartProjectIntake(projectId, chat.id)
    return chat
  })

  ipcMain.handle('chat:stopSchedule', (_event, chatId: string) => stopSchedule(String(chatId)))
  ipcMain.handle('chat:unlinkPr', (_event, chatId: string) => unlinkPr(String(chatId)))
  ipcMain.handle('chat:search', (_event, query: string) => searchChats(String(query ?? '')))
  ipcMain.handle('mcp:get', () => getMcpServers())
  ipcMain.handle('mcp:set', async (_event, text: string) => {
    try {
      return { servers: await setMcpServers(String(text ?? '')) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('chat:exportMarkdown', async (_event, input: { title: string; markdown: string }) => {
    const window = BrowserWindow.getFocusedWindow()
    const name = String(input.title ?? '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Chat'
    const options = {
      title: 'Export chat',
      defaultPath: join(app.getPath('downloads'), `${name}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, String(input.markdown ?? ''), 'utf8')
    return result.filePath
  })

  ipcMain.handle('chat:get', async (_event, chatId: string) => {
    return loadChat(chatId)
  })
  ipcMain.handle('chat:commands', async (_event, chatId: string) => {
    return chatCommands(String(chatId ?? '')).catch(() => [])
  })

  ipcMain.handle('chat:delete', async (_event, chatId: string) => {
    // Let a running turn save before its files go, so it cannot write the chat back.
    await stopAndWait(chatId)
    // Cancelled, not declined: a declined intake is recorded and never asked again.
    cancelProjectIntake(chatId)
    cancelChatQuestions(chatId)
    const chat = await getChat(chatId).catch(() => null)
    const projects = await listProjects()
    const project = chat ? projects.find((item) => item.id === chat.projectId) : null
    let cwd = chat && project ? chatWorkingDir(chat, project.path) : project?.path ?? null
    if (chat?.worktreePath && project?.path) {
      const removed = await removeChatWorktree(project.path, chat.worktreePath)
      // Deleting the chat now would leave its worktree with nothing pointing at it.
      if (!removed) {
        throw new Error(`Could not remove the worktree at ${chat.worktreePath}, so the chat was kept. Close anything using it and try again.`)
      }
      // A worktree shares its refs with the project's repo, so its checkpoints are deleted from there.
      cwd = project.path
    }
    // Only once the chat is sure to go: a chat that stays keeps its checkpoints.
    await deleteAllCheckpoints(chatId, cwd)
    await deleteChat(chatId)
    forgetChat(chatId)
    return snapshot()
  })

  ipcMain.handle('chat:rename', async (_event, input: { id: string; title: string }) => {
    return renameChat(input.id, input.title)
  })

  ipcMain.handle('chat:setAgent', async (_event, input: { id: string; agent: ChatAgent }) => {
    return mutateChat(input.id, (chat) => {
      // A started chat belongs to its agent's session. Only a fresh chat can switch.
      if (chat.grokSessionId || chat.messages.length > 0) {
        throw new Error('This chat already started. Open a new chat to switch agents.')
      }
      chat.agent = normalizeChatAgent(input.agent)
    })
  })

  ipcMain.handle(
    'chat:send',
    async (
      _event,
      input: {
        chatId: string
        content: string
        attachments?: Array<{ id: string; mimeType: string; data: string }>
        mentions?: FileMention[]
        conversation?: string
      }
    ) => {
    const conversation = typeof input.conversation === 'string' ? input.conversation : undefined
    // Nothing is awaited before a new turn is reserved, so a Stop sent right after this finds it.
    if (isStreaming(input.chatId)) {
      const projects = await listProjects()
      const current = await getChat(input.chatId)
      const project = projects.find((item) => item.id === current.projectId)
      const started = await startAside(
        input.chatId,
        project,
        input.content,
        input.attachments ?? [],
        input.mentions ?? [],
        conversation
      )
      return started
    }
    // A clip from a conversation that ended while it was on its way does not start a turn.
    if (conversationEnded(conversation)) return getChat(input.chatId)
    const { chat, done } = await sendTurn(
      input.chatId,
      input.content,
      input.attachments ?? [],
      input.mentions ?? []
    )
    done.catch(() => {})
    return chat
  })

  // The turn ends itself and sends done once its reply is saved. False when nothing was running.
  ipcMain.handle('chat:stop', async (_event, chatId: string) => {
    return stopStream(chatId)
  })

  ipcMain.handle('chat:endConversation', async (_event, conversation: unknown) => {
    if (typeof conversation === 'string') await endConversation(conversation)
  })

  ipcMain.handle('chat:liveState', async () => liveState())

  ipcMain.handle('chat:setMode', async (_event, input: { chatId: string; mode: PermissionMode }) => {
    return setChatMode(input.chatId, normalizePermissionMode(input.mode))
  })

  ipcMain.handle(
    'chat:resolvePermission',
    async (_event, input: { requestId: string; decision: 'allow' | 'deny' }) => {
      const decision = input.decision === 'deny' ? 'deny' : 'allow'
      return resolvePermission(input.requestId, decision)
    }
  )

  ipcMain.handle(
    'chat:resolveQuestion',
    async (
      _event,
      input:
        | { requestId: string; type: 'skip' }
        | { requestId: string; type: 'submit'; answers: UserQuestionAnswer[] }
    ) => {
      if (input.type === 'submit') {
        return resolveUserQuestion(input.requestId, { type: 'submit', answers: input.answers })
      }
      return resolveUserQuestion(input.requestId, { type: 'skip' })
    }
  )

  ipcMain.handle(
    'chat:resolvePlanApproval',
    async (
      _event,
      input: { chatId: string; decision?: 'allow' | 'deny' | PlanVerdict }
    ) => {
      const verdict: PlanVerdict =
        input.decision === 'deny' || input.decision === 'abandon'
          ? 'abandon'
          : input.decision === 'revise'
            ? 'revise'
            : 'approve'
      return settleChatPlan(input.chatId, verdict)
    }
  )

  ipcMain.handle('chat:rewind', async (_event, input: { chatId: string; checkpointId: string }) => {
    const chat = await getChat(input.chatId)
    const projects = await listProjects()
    const project = projects.find((item) => item.id === chat.projectId)
    return rewindChat(input.chatId, input.checkpointId, chatWorkingDir(chat, project?.path))
  })

  ipcMain.handle('settings:get', async () => {
    const { settings } = await snapshot()
    return settings
  })

  ipcMain.handle(
    'settings:set',
    async (
      _event,
      input: {
        apiKey?: string
        model?: string
        effort?: string | null
        voice?: Partial<VoiceSettings>
        defaultAgent?: ChatAgent
        claudeModel?: string
      }
    ) => {
      const settings = await updateSettings(input)
      if (input.effort !== undefined) await applyEffortToLiveSessions(settings.effort)
      if (input.claudeModel !== undefined) await applyClaudeModelToLiveSessions(settings.claudeModel)
      return settings
    }
  )
  // Settings answer before the CLI probes finish; what they find arrives here.
  onCliInfoChange(() => {
    void getPublicSettings()
      .then((settings) => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('settings:changed', settings)
      })
      .catch(() => undefined)
  })

  ipcMain.handle('claude:options', (_event, model: string) => getClaudeOptions(model ?? ''))
  ipcMain.handle('voice:modelStatus', () => readVoiceModelStatus())
  ipcMain.handle('voice:ensureModel', async () => ensureVoiceModel())
  ipcMain.handle('voice:ensureMic', async () => ensureMicAccess())
  ipcMain.handle('voice:micAccess', () => getMicAccess())
  ipcMain.handle('voice:openMicSettings', () => {
    openMicPrivacySettings()
  })
  // A hidden or covered window slows its timers and stops animation frames, which voice relies on.
  ipcMain.on('voice:active', (event, active: unknown) => {
    event.sender.setBackgroundThrottling(active !== true)
  })
  onVoiceModelStatus((payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('voice:modelStatus', payload)
    }
  })

  ipcMain.handle('update:state', () => getUpdateState())
  ipcMain.handle('update:check', async () => checkForUpdates())
  ipcMain.handle('update:install', () => {
    installUpdate()
  })
  onUpdateState((payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('update:state', payload)
    }
  })

  ipcMain.handle('theme:state', async () => {
    return getThemeState()
  })

  // Every window hears about a change, the one that made it too, ahead of its reply.
  function themeChanged<T>(state: T): T {
    if (state) {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('theme:changed', state)
    }
    return state
  }

  ipcMain.handle('theme:activate', async (_event, id: string) => {
    return themeChanged(await activateTheme(id))
  })

  ipcMain.handle('theme:save', async (_event, theme: unknown) => {
    return themeChanged(await saveUserTheme(theme))
  })

  ipcMain.handle('theme:delete', async (_event, id: string) => {
    return themeChanged(await deleteUserTheme(id))
  })

  ipcMain.handle('theme:import', async () => {
    return themeChanged(await importThemeFile())
  })

  ipcMain.handle('theme:export', async (_event, id: string) => {
    return exportThemeFile(id)
  })

  ipcMain.handle('activity:get', async () => {
    return getActivitySnapshot()
  })

  ipcMain.handle('activity:clear', async () => {
    return clearActivity()
  })

  ipcMain.handle('browser:getState', () => getBrowserState())
  ipcMain.handle('browser:setVisible', (_event, next: boolean) => setBrowserVisible(Boolean(next)))
  ipcMain.handle('browser:setBounds', (_event, bounds: BrowserBounds) => setBrowserBounds(bounds))
  ipcMain.handle('browser:navigate', (_event, url: string) => navigateBrowser(String(url ?? '')))
  ipcMain.handle('browser:back', () => goBack())
  ipcMain.handle('browser:forward', () => goForward())
  ipcMain.handle('browser:reload', () => reloadBrowser())
  ipcMain.handle('browser:stop', () => stopBrowser())
  ipcMain.handle('browser:clearData', () => clearBrowserData())
  ipcMain.handle('browser:annotateStart', () => startBrowserAnnotate())
  ipcMain.handle('browser:annotateCancel', () => cancelBrowserAnnotate())
  ipcMain.handle('youtube:transcribe', (_event, input: { url?: string; lang?: string }) =>
    transcribeYoutube(String(input?.url ?? ''), input?.lang)
  )

  ipcMain.handle('git:snapshot', async (_event, input: { projectId: string; chatId?: string | null }) => {
    return getGitSnapshot(String(input?.projectId ?? ''), input?.chatId)
  })
  ipcMain.handle('git:summaries', async () => {
    return getGitSummaries()
  })
  ipcMain.handle(
    'git:diff',
    async (_event, input: { projectId: string; path: string; staged: boolean; chatId?: string | null }) => {
      return getGitDiff(
        String(input.projectId ?? ''),
        String(input.path ?? ''),
        Boolean(input.staged),
        input.chatId
      )
    }
  )
  ipcMain.handle(
    'git:stage',
    async (_event, input: { projectId: string; path: string; chatId?: string | null }) => {
      return stageGitPath(String(input.projectId ?? ''), String(input.path ?? ''), input.chatId)
    }
  )
  ipcMain.handle(
    'git:unstage',
    async (_event, input: { projectId: string; path: string; chatId?: string | null }) => {
      return unstageGitPath(String(input.projectId ?? ''), String(input.path ?? ''), input.chatId)
    }
  )
  ipcMain.handle(
    'git:discard',
    async (_event, input: { projectId: string; path: string; chatId?: string | null }) => {
      return discardGitPath(String(input.projectId ?? ''), String(input.path ?? ''), input.chatId)
    }
  )
  ipcMain.handle(
    'git:commit',
    async (_event, input: { projectId: string; message: string; chatId?: string | null }) => {
      return commitGit(String(input.projectId ?? ''), String(input.message ?? ''), input.chatId)
    }
  )
  ipcMain.handle(
    'git:checkout',
    async (_event, input: { projectId: string; ref: string; chatId?: string | null }) => {
      return checkoutGit(String(input.projectId ?? ''), String(input.ref ?? ''), input.chatId)
    }
  )
  ipcMain.handle(
    'git:createBranch',
    async (_event, input: { projectId: string; name: string; chatId?: string | null }) => {
      return createGitBranch(String(input.projectId ?? ''), String(input.name ?? ''), input.chatId)
    }
  )
  ipcMain.handle('git:mergeChat', async (_event, input: { projectId: string; chatId: string }) => {
    return mergeChatBranch(String(input.projectId ?? ''), String(input.chatId ?? ''))
  })
  ipcMain.handle(
    'git:setActive',
    async (_event, input: { projectId: string | null; chatId?: string | null }) => {
      await setGitActiveProject(input?.projectId ? String(input.projectId) : null, input?.chatId)
      return true
    }
  )

  void syncGitWatchers()
  void syncKnowledgeWatchers()

  ipcMain.handle('knowledge:snapshot', async (_event, projectId: string) => {
    return getKnowledgeSnapshot(String(projectId ?? ''))
  })
  ipcMain.handle('knowledge:rebuild', async (_event, projectId: string) => {
    return rebuildKnowledge(String(projectId ?? ''))
  })
  ipcMain.handle('knowledge:note', async (_event, input: { projectId: string; path: string }) => {
    return getKnowledgeNote(String(input?.projectId ?? ''), String(input?.path ?? ''))
  })
  ipcMain.handle('knowledge:openVault', async (_event, projectId: string) => {
    return openKnowledgeVault(String(projectId ?? ''))
  })
  ipcMain.handle('knowledge:revealVault', async (_event, projectId: string) => {
    return revealKnowledgeVault(String(projectId ?? ''))
  })
  ipcMain.handle('knowledge:setActive', async (_event, projectId: string | null) => {
    await setKnowledgeActiveProject(projectId ? String(projectId) : null)
    return true
  })

  ipcMain.handle('usage:get', async () => fetchUsage())
  ipcMain.handle('usage:claude', async () => fetchClaudeUsage())

  ipcMain.handle('app:quit', () => {
    app.quit()
    return true
  })

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    const clean = sanitizeUrl(String(url ?? ''))
    if (!clean) return false
    await shell.openExternal(clean)
    return true
  })

  ipcMain.handle('media:open', async (_event, input: { chatId?: string; src?: string }) => {
    return openChatMedia(String(input?.chatId ?? ''), String(input?.src ?? ''))
  })
}
