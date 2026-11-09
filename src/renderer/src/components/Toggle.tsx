export function Toggle({
  on,
  onClick,
  label
}: {
  on: boolean
  onClick: () => void
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? 'bg-accent' : 'bg-line'}`}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-accent-ink transition"
        style={{ left: on ? 18 : 2 }}
      />
    </button>
  )
}
