function startReorder(event: React.PointerEvent<HTMLButtonElement>, onSwap: () => void): void {
  event.preventDefault()
  event.stopPropagation()
  const startX = event.clientX
  const startY = event.clientY
  const target = event.currentTarget
  target.setPointerCapture(event.pointerId)
  let swapped = false

  function onMove(move: PointerEvent): void {
    if (swapped) return
    if (Math.abs(move.clientX - startX) >= 48 || Math.abs(move.clientY - startY) >= 24) {
      swapped = true
      onSwap()
    }
  }

  function stop(): void {
    target.removeEventListener('pointermove', onMove)
    target.removeEventListener('pointerup', onUp)
    target.removeEventListener('pointercancel', stop)
    target.removeEventListener('lostpointercapture', stop)
  }

  function onUp(up: PointerEvent): void {
    stop()
    if (!swapped && Math.abs(up.clientX - startX) < 6 && Math.abs(up.clientY - startY) < 6) onSwap()
  }

  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onUp)
  target.addEventListener('pointercancel', stop)
  target.addEventListener('lostpointercapture', stop)
}

export function ReorderGrip({
  onSwap,
  label
}: {
  onSwap: () => void
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="reorder-pane"
      className="no-drag flex h-7 w-5 shrink-0 cursor-grab flex-col items-center justify-center gap-[3px] rounded-md text-muted hover:bg-raised hover:text-ink active:cursor-grabbing"
      title={label}
      aria-label={label}
      onPointerDown={(event) => startReorder(event, onSwap)}
    >
      <span className="flex gap-[2px]">
        <i className="block h-[3px] w-[3px] rounded-full bg-current" />
        <i className="block h-[3px] w-[3px] rounded-full bg-current" />
      </span>
      <span className="flex gap-[2px]">
        <i className="block h-[3px] w-[3px] rounded-full bg-current" />
        <i className="block h-[3px] w-[3px] rounded-full bg-current" />
      </span>
      <span className="flex gap-[2px]">
        <i className="block h-[3px] w-[3px] rounded-full bg-current" />
        <i className="block h-[3px] w-[3px] rounded-full bg-current" />
      </span>
    </button>
  )
}
