import { useEffect, useState } from 'react'
import {
  CLAUDE_MODELS,
  GROK_REASONING_EFFORTS,
  REASONING_EFFORTS,
  normalizeChatAgent,
  normalizeReasoningEffort,
  reasoningEffortLabel,
  type Bot,
  type ChatAgent,
  type ClaudeOptions,
  type ReasoningEffort
} from '../../../shared/types'
import { BOT_TOOLS, WORKBENCH_MCP_SERVERS, mcpServerTool, toolsForAgent } from '../../../shared/botTools'
import { BotAvatar, useBots } from '../bots'
import { BotSchedules } from './BotSchedules'
import { BotSkills } from './BotSkills'
import { useWorkspace } from '../workspace'
import { IconButton } from './icons'

function errorText(error: unknown, fallback: string): string {
  // IPC errors arrive as "Error invoking remote method '…': Error: <message>".
  const message = error instanceof Error ? error.message : ''
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || fallback
}

type Draft = {
  name: string
  agent: ChatAgent
  model: string
  effort: string
  instructions: string
  allowedTools: string
}

function draftOf(bot: Bot): Draft {
  return {
    name: bot.name,
    agent: bot.agent,
    model: bot.model,
    effort: bot.effort,
    instructions: bot.instructions,
    allowedTools: bot.allowedTools.join('\n')
  }
}

const field =
  'mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/60'

/** Shown in place of the chat pane while a bot is open. */
export function BotPage({ bot }: { bot: Bot }): React.JSX.Element {
  const { settings, showSidebar, setShowSidebar, openBot, chats, deleteChat } = useWorkspace()
  const { updateBot, deleteBot, pickAvatar, clearAvatar } = useBots()
  const [draft, setDraft] = useState<Draft>(() => draftOf(bot))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [claudeOptions, setClaudeOptions] = useState<ClaudeOptions | null>(null)
  const [mcpNames, setMcpNames] = useState<string[]>([])
  const [otherTool, setOtherTool] = useState('')

  // The MCP servers from Settings that are switched on, next to the Workbench's own.
  useEffect(() => {
    void window.workbench.getMcpServers().then((servers) =>
      setMcpNames(Object.keys(servers).filter((name) => !servers[name].disabled))
    )
  }, [])

  // Another bot opened, or this one changed elsewhere: start from what is saved.
  useEffect(() => {
    setDraft(draftOf(bot))
    setError(null)
  }, [bot])

  const saved = draftOf(bot)
  const dirty = (Object.keys(draft) as Array<keyof Draft>).some((key) => draft[key] !== saved[key])

  // Claude Code names the models this plan offers, and each model has its own effort levels.
  const onClaude = draft.agent === 'claude'
  useEffect(() => {
    if (!onClaude) return
    let cancelled = false
    void window.workbench.getClaudeOptions(draft.model).then((options) => {
      if (!cancelled && options) setClaudeOptions(options)
    })
    return () => {
      cancelled = true
    }
  }, [onClaude, draft.model])

  const models: Array<{ value: string; label: string }> =
    onClaude
      ? (claudeOptions?.models.map((option) => ({ value: option.value, label: option.name })) ?? CLAUDE_MODELS)
      : [
          { value: '', label: 'Default' },
          ...(settings?.grokCli.models ?? []).map((model) => ({ value: model, label: model }))
        ]
  const modelKnown = models.some((option) => option.value === draft.model)
  const efforts: readonly ReasoningEffort[] = onClaude
    ? (claudeOptions?.efforts ?? REASONING_EFFORTS)
    : GROK_REASONING_EFFORTS
  const draftEffort = normalizeReasoningEffort(draft.effort)
  const settingEffort = settings?.effort ? `, ${reasoningEffortLabel(settings.effort)}` : ''

  const allowed = draft.allowedTools ? draft.allowedTools.split('\n') : []
  const agentTools = BOT_TOOLS.flatMap((tool) => {
    const name = tool[draft.agent]
    return name ? [{ name, label: tool.label }] : []
  })
  const serverTools = [...WORKBENCH_MCP_SERVERS, ...mcpNames].map((server) => ({
    name: mcpServerTool(server),
    label: server
  }))
  const listed = new Set([...agentTools, ...serverTools].map((tool) => tool.name))
  const otherTools = allowed.filter((name) => !listed.has(name))

  function setAllowed(tools: string[]): void {
    edit({ allowedTools: [...new Set(tools)].join('\n') })
  }

  function addOtherTool(): void {
    const name = otherTool.trim()
    if (name) setAllowed([...allowed, name])
    setOtherTool('')
  }

  function edit(patch: Partial<Draft>): void {
    setDraft((current) => ({ ...current, ...patch }))
  }

  async function run(action: () => Promise<unknown>, fallback: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(errorText(caught, fallback))
    } finally {
      setBusy(false)
    }
  }

  function save(): Promise<void> {
    return run(
      () =>
        updateBot({
          id: bot.id,
          name: draft.name,
          agent: draft.agent,
          model: draft.model,
          effort: draft.effort || null,
          instructions: draft.instructions,
          allowedTools: allowed
        }),
      'Could not save the bot'
    )
  }

  return (
    <section className="night-pane relative flex min-w-[320px] flex-1 flex-col bg-surface" data-testid="bot-page">
      <header className="drag flex h-titlebar shrink-0 items-center gap-2 border-b border-line bg-canvas px-3">
        {!showSidebar && (
          <div className="flex shrink-0 items-center pl-traffic">
            <IconButton icon="sidebar" label="Show sidebar" onClick={() => setShowSidebar(true)} />
          </div>
        )}
        <BotAvatar bot={bot} size={18} />
        <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <span className="text-muted">Bots</span>
          <span className="text-faint">/</span>
          <span className="truncate font-semibold text-ink">{bot.name}</span>
        </div>
        <div className="flex-1" />
        <IconButton icon="close" label="Close bot" onClick={() => openBot(null)} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[620px] flex-col gap-5 px-6 py-8">
          <div className="flex flex-col items-center gap-3">
            <BotAvatar bot={bot} size={96} />
            <div className="text-[17px] font-medium text-ink">{bot.name}</div>
            <div className="flex gap-2">
              <button
                className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-50"
                disabled={busy}
                onClick={() => void run(() => pickAvatar(bot.id), 'Could not set the avatar')}
              >
                {bot.avatar ? 'Change avatar' : 'Choose avatar'}
              </button>
              {bot.avatar && (
                <button
                  className="rounded-md px-2.5 py-1 text-[12px] text-muted hover:text-ink disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void run(() => clearAvatar(bot.id), 'Could not remove the avatar')}
                >
                  Remove
                </button>
              )}
            </div>
            <div className="text-[11px] text-faint">SVG (animated too), PNG, APNG, JPEG, GIF or WebP, up to 5 MB</div>
          </div>

          <label className="block text-[12px] text-muted">
            Name
            <input
              data-testid="bot-name"
              value={draft.name}
              onChange={(event) => edit({ name: event.target.value })}
              className={field}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[12px] text-muted">Agent</div>
              <div className="mt-1 flex rounded-md bg-canvas p-0.5">
                {(
                  [
                    ['grok', 'Grok Build'],
                    ['claude', 'Claude Code']
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={draft.agent === value}
                    className={`flex-1 rounded px-2.5 py-1.5 text-[12px] ${
                      draft.agent === value ? 'bg-raised text-ink' : 'text-muted hover:text-ink'
                    }`}
                    onClick={() => {
                      const agent = normalizeChatAgent(value)
                      if (agent === draft.agent) return
                      edit({
                        agent,
                        model: '',
                        allowedTools: toolsForAgent(allowed, draft.agent, agent).join('\n')
                      })
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="block text-[12px] text-muted">
              Model
              <select
                data-testid="bot-model"
                value={draft.model}
                onChange={(event) => edit({ model: event.target.value })}
                className={field}
              >
                {modelKnown ? null : <option value={draft.model}>{draft.model}</option>}
                {models.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[12px] text-muted">
              Effort
              <select
                data-testid="bot-effort"
                value={draft.effort}
                onChange={(event) => edit({ effort: event.target.value })}
                className={field}
              >
                <option value="">{`As in Settings${settingEffort}`}</option>
                {draftEffort && !efforts.includes(draftEffort) && (
                  <option value={draftEffort}>{reasoningEffortLabel(draftEffort)}</option>
                )}
                {efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {reasoningEffortLabel(effort)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block text-[12px] text-muted">
            Instructions
            <textarea
              data-testid="bot-instructions"
              value={draft.instructions}
              rows={8}
              placeholder="Who this bot is, what it does and how it answers."
              onChange={(event) => edit({ instructions: event.target.value })}
              className={`${field} resize-y leading-5`}
            />
          </label>

          <div data-testid="bot-allowed-tools">
            <div className="text-[12px] text-muted">Tools it may use without asking</div>
            <div className="mt-1 rounded-lg border border-line bg-canvas px-3 py-2">
              {[
                { title: null, tools: agentTools },
                { title: 'MCP servers, with all their tools', tools: serverTools }
              ].map((group) => (
                <div key={group.title ?? 'agent'}>
                  {group.title && <div className="mb-0.5 mt-2.5 text-[11px] text-faint">{group.title}</div>}
                  <div className="grid grid-cols-2 gap-x-4">
                    {group.tools.map((tool) => (
                      <label
                        key={tool.name}
                        className="flex min-w-0 cursor-pointer items-center gap-2 py-1 text-[12.5px] text-ink-2 hover:text-ink"
                      >
                        <input
                          type="checkbox"
                          className="shrink-0 accent-accent"
                          checked={allowed.includes(tool.name)}
                          onChange={(event) =>
                            setAllowed(
                              event.target.checked
                                ? [...allowed, tool.name]
                                : allowed.filter((name) => name !== tool.name)
                            )
                          }
                        />
                        <span className="truncate">{tool.label}</span>
                        <span className="truncate font-mono text-[11px] text-faint">{tool.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              <div className="mb-0.5 mt-2.5 text-[11px] text-faint">Other tools</div>
              <div className="flex flex-wrap items-center gap-1.5">
                {otherTools.map((name) => (
                  <span
                    key={name}
                    className="flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-2"
                  >
                    {name}
                    <button
                      aria-label={`Remove ${name}`}
                      className="text-faint hover:text-ink"
                      onClick={() => setAllowed(allowed.filter((item) => item !== name))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  data-testid="bot-other-tool"
                  value={otherTool}
                  placeholder="Tool name, e.g. mcp__github__create_issue"
                  onChange={(event) => setOtherTool(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') addOtherTool()
                  }}
                  onBlur={addOtherTool}
                  className="min-w-[200px] flex-1 bg-transparent py-0.5 font-mono text-[11.5px] text-ink outline-none placeholder:text-faint"
                />
              </div>
            </div>
            <span className="mt-1 block text-[11px] text-faint">
              Anything else waits and asks you with a notification.
            </span>
          </div>

          <BotSkills bot={bot} />

          <BotSchedules bot={bot} />

          <div className="rounded-lg border border-line bg-canvas px-3 py-2.5">
            <div className="text-[12px] text-muted">Folder</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2" title={bot.folder}>
                {bot.folder}
              </span>
              <button
                className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-2 hover:border-line-strong hover:text-ink"
                onClick={() => void run(() => window.workbench.openBotFolder(bot.id), 'Could not open the folder')}
              >
                Open
              </button>
            </div>
            <div className="mt-1 text-[11px] text-faint">
              Its skills are saved as <span className="font-mono">skills/&lt;name&gt;/SKILL.md</span> here. Scripts
              or files a skill uses can go next to its SKILL.md.
            </div>
          </div>

          {error && <div className="text-[12px] text-danger">{error}</div>}

          <div className="flex items-center gap-2">
            <button
              className="rounded-md px-2.5 py-1.5 text-[12px] text-muted hover:text-danger disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                if (
                  !confirm(
                    `Delete ${bot.name}?\n\nIts chats and schedules are deleted, and its folder, with its skills and avatar, goes to the Trash.`
                  )
                )
                  return
                void run(async () => {
                  for (const chat of chats.filter((item) => item.botId === bot.id)) await deleteChat(chat.id)
                  await deleteBot(bot.id)
                  openBot(null)
                }, 'Could not delete the bot')
              }}
            >
              Delete bot
            </button>
            <div className="flex-1" />
            {dirty && (
              <button
                className="rounded-md px-2.5 py-1.5 text-[12px] text-muted hover:text-ink"
                disabled={busy}
                onClick={() => setDraft(saved)}
              >
                Discard
              </button>
            )}
            <button
              data-testid="bot-save"
              className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink disabled:opacity-50"
              disabled={busy || !dirty || !draft.name.trim()}
              onClick={() => void save()}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
