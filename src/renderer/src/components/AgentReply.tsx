import { useState } from 'react'
import { replySteps } from '../../../shared/steps'
import { Icon } from './icons'
import { Markdown } from './Markdown'

/** Steps left in view while a run is live; earlier ones fold away. */
const LIVE_STEPS = 3
const VISUAL_BLOCK = /```visual\n[\s\S]*?\n```/g

/**
 * An agent reply. The notes the agent wrote between tool calls show as a compact
 * list of steps, folded once the run is done; the text after its last tool call
 * reads as the answer.
 */
export function AgentReply({
  text,
  chatId,
  live = false
}: {
  text: string
  chatId: string
  live?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const parts = replySteps(text)
  if (parts.length < 2) return <Markdown text={text} chatId={chatId} />

  const steps = parts.slice(0, -1)
  const answer = parts[parts.length - 1]
  const foldable = live ? steps.length > LIVE_STEPS : true
  const hidden = !foldable || open ? 0 : live ? steps.length - LIVE_STEPS : steps.length
  const shown = steps.slice(hidden)
  // A page the agent showed stays in view even when its step is folded.
  const visuals = steps.slice(0, hidden).flatMap((step) => step.match(VISUAL_BLOCK) ?? [])
  const label = live
    ? `${steps.length - LIVE_STEPS} earlier ${steps.length - LIVE_STEPS === 1 ? 'step' : 'steps'}`
    : `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`

  return (
    <>
      <div className="mb-3" data-testid="reply-steps">
        {foldable && (
          <button
            type="button"
            data-testid="reply-steps-toggle"
            aria-expanded={open}
            className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-[12.5px] text-muted hover:text-ink"
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? 'chevronDown' : 'chevron'} size={12} />
            {label}
          </button>
        )}
        {shown.length > 0 && (
          <ol className="reply-steps mt-1">
            {shown.map((step, index) => (
              <li key={hidden + index} className="reply-step">
                <Markdown text={step.replace(/:$/, '.')} chatId={chatId} />
              </li>
            ))}
          </ol>
        )}
        {visuals.length > 0 && (
          <div className="mt-3">
            <Markdown text={visuals.join('\n\n')} chatId={chatId} />
          </div>
        )}
      </div>
      <Markdown text={answer} chatId={chatId} />
    </>
  )
}
