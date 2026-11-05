import { useMemo } from 'react'
import type { ActivityDiff } from '../../../shared/types'
import { sideBySideDiff, type DiffCell } from '../lineDiff'

function Cell({ cell, side }: { cell: DiffCell | null; side: 'left' | 'right' }): React.JSX.Element {
  const kind = cell?.kind ?? 'empty'
  const tone =
    kind === 'del'
      ? 'bg-diff-del-bg text-diff-del'
      : kind === 'add'
        ? 'bg-diff-add-bg text-diff-add'
        : kind === 'same'
          ? 'text-ink/55'
          : 'bg-transparent text-transparent'
  return (
    <div
      className={`min-w-0 whitespace-pre-wrap break-all px-2 py-[2px] ${tone} ${
        side === 'left' ? 'border-r border-line' : ''
      }`}
    >
      {cell?.text === '' ? ' ' : (cell?.text ?? ' ')}
    </div>
  )
}

export function CodeDiff({ diff }: { diff: ActivityDiff }): React.JSX.Element {
  const rows = useMemo(() => sideBySideDiff(diff.oldText, diff.newText), [diff.oldText, diff.newText])
  const name = diff.path.split(/[/\\]/).at(-1) || diff.path || 'file'

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-line bg-canvas">
      <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-1">
        <div className="min-w-0 truncate font-mono text-[10px] text-ink/80" title={diff.path || name}>
          {name}
        </div>
        <div className="shrink-0 text-[11px] text-muted">
          <span className="text-diff-del">old</span>
          <span className="mx-1 text-muted">·</span>
          <span className="text-diff-add">new</span>
        </div>
      </div>
      {diff.path && diff.path !== name && (
        <div className="truncate border-b border-line px-2 py-0.5 font-mono text-[9px] text-muted">
          {diff.path}
        </div>
      )}
      <div className="grid grid-cols-2 border-b border-line text-[11px] text-muted">
        <div className="border-r border-line/70 px-1.5 py-0.5">Before</div>
        <div className="px-1.5 py-0.5">After</div>
      </div>
      <div className="max-h-[480px] overflow-auto font-mono text-[12px] leading-[18px]">
        {rows.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-muted">No content</div>
        ) : (
          rows.map((row, index) => (
            <div key={index} className="grid grid-cols-2">
              <Cell cell={row.left} side="left" />
              <Cell cell={row.right} side="right" />
            </div>
          ))
        )}
      </div>
    </div>
  )
}
