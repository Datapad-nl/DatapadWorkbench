// Line icons on a 16px grid, drawn with currentColor so they follow the theme.
const PATHS = {
  folder: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z',
  branch:
    'M5 2.5v7M5 9.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM11 3a1.75 1.75 0 1 0 0 3.5A1.75 1.75 0 0 0 11 3zM11 6.5c0 2.5-6 1.5-6 3',
  commit: 'M8 1.5v4M8 10.5v4M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM3 8h2.5M10.5 8H13',
  globe:
    'M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5zM1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.9 2.5 6.25S9.7 12.45 8 14.25C6.3 12.45 5.5 10.35 5.5 8S6.3 3.55 8 1.75z',
  pulse: 'M1.5 8.5h2.8l1.7-4.5 3 8 1.8-4.5h3.7',
  book: 'M3 2.5h6.5a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2zM3 11.5a2 2 0 0 1 2-2h6.5M13 4v9.5',
  sidebar: 'M2.5 3.5h11v9h-11zM6 3.5v9',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.3 10.3l3.2 3.2',
  plus: 'M8 3v10M3 8h10',
  chevron: 'M6 3.5 10.5 8 6 12.5',
  chevronDown: 'M3.5 6 8 10.5 12.5 6',
  gear:
    'M8 5.75a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5zM8 1.5l1.2 1.6 2-.3.5 2 1.8 1-.8 1.9.8 1.9-1.8 1-.5 2-2-.3L8 14.5l-1.2-1.6-2 .3-.5-2-1.8-1 .8-1.9-.8-1.9 1.8-1 .5-2 2 .3z',
  trash: 'M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9M6.75 7v4M9.25 7v4',
  close: 'M4 4l8 8M12 4l-8 8',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  retry: 'M2.75 8a5.25 5.25 0 1 0 1.6-3.8M2.5 2.5v2.75h2.75',
  check: 'M3 8.5 6.5 12 13 4.5',
  sparkle: 'M8 1.5c.5 3.3 1.8 4.9 5 5.5-3.2.6-4.5 2.2-5 5.5-.5-3.3-1.8-4.9-5-5.5 3.2-.6 4.5-2.2 5-5.5z',
  pencil: 'M10.5 2.5l3 3-8 8H2.5v-3zM9 4l3 3',
  bubble: 'M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z',
  shield: 'M8 1.75 13.25 3.5v4c0 3.2-2.2 5.6-5.25 6.75C4.95 13.1 2.75 10.7 2.75 7.5v-4z',
  clip: 'M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5l5.5-5.5a2.1 2.1 0 0 1 3 3L6.5 11a1 1 0 0 1-1.5-1.5L10 4.5',
  at: 'M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM10.5 8v1.25a1.75 1.75 0 0 0 3.5 0V8A6 6 0 1 0 11 13.2',
  slash: 'M2.5 2.5h11v11h-11zM9.75 4.75l-3.5 6.5',
  arrowUp: 'M8 13V3.5M3.75 7.75 8 3.5l4.25 4.25',
  database: 'M8 2c3 0 5.25.9 5.25 2S11 6 8 6 2.75 5.1 2.75 4 5 2 8 2zM2.75 4v8c0 1.1 2.25 2 5.25 2s5.25-.9 5.25-2V4M2.75 8c0 1.1 2.25 2 5.25 2s5.25-.9 5.25-2',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  clock: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 4.75V8l2.25 1.5',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  command: 'M6 6h4v4H6zM6 6V4.5A1.5 1.5 0 1 0 4.5 6zM10 6V4.5A1.5 1.5 0 1 1 11.5 6zM6 10v1.5A1.5 1.5 0 1 1 4.5 10zM10 10v1.5a1.5 1.5 0 1 0 1.5-1.5z'
} as const

export type IconName = keyof typeof PATHS

export function Icon({
  name,
  size = 14,
  className,
  strokeWidth = 1.4
}: {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 2.4 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className ?? ''}`}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

/** The agent glyphs used in the assistant tile and the empty state. */
export function AgentGlyph({ agent, size = 14 }: { agent: 'grok' | 'claude'; size?: number }): React.JSX.Element {
  if (agent === 'claude') {
    // Claude's starburst: twelve rays from the centre.
    const rays = Array.from({ length: 12 }, (_, index) => {
      const angle = (index * Math.PI) / 6
      const inner = 1.6
      const outer = index % 2 === 0 ? 6.4 : 5.2
      return `M${8 + inner * Math.cos(angle)} ${8 + inner * Math.sin(angle)}L${8 + outer * Math.cos(angle)} ${8 + outer * Math.sin(angle)}`
    }).join('')
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
        <path d={rays} stroke="#d97757" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    )
  }
  return <Icon name="sparkle" size={size} strokeWidth={1.5} />
}

/** A square icon button for title bars and toolbars. */
export function IconButton({
  icon,
  label,
  onClick,
  active,
  disabled,
  size = 28,
  testId,
  className
}: {
  icon: IconName
  label: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  active?: boolean
  disabled?: boolean
  size?: number
  testId?: string
  className?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      style={{ width: size, height: size }}
      className={`no-drag flex shrink-0 items-center justify-center rounded-[7px] transition-colors disabled:opacity-40 ${
        active
          ? 'bg-raised text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)]'
          : 'text-muted hover:bg-hover hover:text-ink'
      } ${className ?? ''}`}
    >
      <Icon name={icon} />
    </button>
  )
}
