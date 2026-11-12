import { useCallback, useEffect, useState } from 'react'
import type { Bot, BotSkill } from '../../../shared/types'

type Draft = { previousName: string | null; name: string; description: string; body: string }

const field =
  'mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/60'

function errorText(error: unknown, fallback: string): string {
  // IPC errors arrive as "Error invoking remote method '…': Error: <message>".
  const message = error instanceof Error ? error.message : ''
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || fallback
}

/** The bot's own skills, each a `skills/<name>/SKILL.md` in its folder. */
export function BotSkills({ bot }: { bot: Bot }): React.JSX.Element {
  const [skills, setSkills] = useState<BotSkill[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [grokNames, setGrokNames] = useState<Set<string>>(new Set())

  const reload = useCallback(async () => {
    setSkills(await window.workbench.listBotSkills(bot.id))
  }, [bot.id])

  useEffect(() => {
    setDraft(null)
    setError(null)
    void reload().catch(() => setSkills([]))
  }, [reload])

  // Grok lists a bot's skills under their bare names, so one named like a global command clashes with it.
  useEffect(() => {
    if (bot.agent !== 'grok') return
    let live = true
    void window.workbench
      .grokCommandNames()
      .then((names) => {
        if (live) setGrokNames(new Set(names))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [bot.agent])

  const clashes = (name: string): boolean => bot.agent === 'grok' && grokNames.has(name.trim())

  async function run(action: () => Promise<unknown>, fallback: string): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await action()
      await reload()
      return true
    } catch (caught) {
      setError(errorText(caught, fallback))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function save(current: Draft): Promise<void> {
    const ok = await run(
      () => window.workbench.saveBotSkill({ botId: bot.id, ...current }),
      'Could not save the skill'
    )
    if (ok) setDraft(null)
  }

  async function remove(name: string): Promise<void> {
    if (!confirm(`Delete the skill ${name}?\n\nIts folder goes to the Trash.`)) return
    const ok = await run(() => window.workbench.removeBotSkill(bot.id, name), 'Could not delete the skill')
    if (ok) setDraft(null)
  }

  function editor(current: Draft): React.JSX.Element {
    const edit = (patch: Partial<Draft>): void => setDraft({ ...current, ...patch })
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-line-strong bg-canvas/60 p-3" data-testid="bot-skill-editor">
        <label className="block text-[12px] text-muted">
          Name
          <input
            data-testid="bot-skill-name"
            value={current.name}
            placeholder="weekly-report"
            onChange={(event) => edit({ name: event.target.value.toLowerCase().replace(/\s+/g, '-') })}
            className={`${field} font-mono text-[12px]`}
          />
          {clashes(current.name) && (
            <span className="mt-1 block text-[11px] text-danger">
              Grok already has a command named /{current.name.trim()}. Pick another name so both stay usable.
            </span>
          )}
        </label>
        <label className="block text-[12px] text-muted">
          Description
          <input
            data-testid="bot-skill-description"
            value={current.description}
            placeholder="What it does and when to use it. The agent reads this to decide."
            onChange={(event) => edit({ description: event.target.value })}
            className={field}
          />
        </label>
        <label className="block text-[12px] text-muted">
          Instructions
          <textarea
            data-testid="bot-skill-body"
            value={current.body}
            rows={10}
            placeholder="The steps the agent follows when it uses this skill, in Markdown."
            onChange={(event) => edit({ body: event.target.value })}
            className={`${field} resize-y font-mono text-[12px] leading-5`}
          />
        </label>
        <div className="flex items-center gap-2">
          {current.previousName && (
            <button
              className="rounded-md px-2.5 py-1.5 text-[12px] text-muted hover:text-danger disabled:opacity-50"
              disabled={busy}
              onClick={() => void remove(current.previousName as string)}
            >
              Delete skill
            </button>
          )}
          <div className="flex-1" />
          <button
            className="rounded-md px-2.5 py-1.5 text-[12px] text-muted hover:text-ink"
            disabled={busy}
            onClick={() => {
              setDraft(null)
              setError(null)
            }}
          >
            Cancel
          </button>
          <button
            data-testid="bot-skill-save"
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink disabled:opacity-50"
            disabled={busy || !current.name.trim() || !current.description.trim()}
            onClick={() => void save(current)}
          >
            Save skill
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2" data-testid="bot-skills">
      <div className="flex items-center">
        <div className="text-[12px] text-muted">Skills</div>
        <div className="flex-1" />
        {!draft && (
          <button
            data-testid="bot-skill-new"
            className="rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-2 hover:border-line-strong hover:text-ink"
            onClick={() => {
              setError(null)
              setDraft({ previousName: null, name: '', description: '', body: '' })
            }}
          >
            New skill
          </button>
        )}
      </div>

      {draft && draft.previousName === null && editor(draft)}

      {skills.length === 0 && !draft && (
        <div className="rounded-lg border border-dashed border-line px-3 py-3 text-[12px] text-faint">
          No skills of its own yet. It still has every global skill.
        </div>
      )}

      {skills.map((skill) =>
        draft && draft.previousName === skill.name ? (
          <div key={skill.name}>{editor(draft)}</div>
        ) : (
          <button
            key={skill.name}
            data-testid="bot-skill-row"
            className="flex flex-col items-start rounded-lg border border-line bg-canvas px-3 py-2 text-left hover:border-line-strong disabled:opacity-50"
            disabled={busy || draft !== null}
            onClick={() => {
              setError(null)
              setDraft({ previousName: skill.name, ...skill })
            }}
          >
            <span className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-ink">{skill.name}</span>
              {clashes(skill.name) && (
                <span className="text-[11px] text-danger" title={`Grok already has a command named /${skill.name}`}>
                  name clash
                </span>
              )}
            </span>
            <span className="mt-0.5 line-clamp-2 text-[12px] text-muted">{skill.description || 'No description'}</span>
          </button>
        )
      )}

      {error && <div className="text-[12px] text-danger">{error}</div>}
    </div>
  )
}
