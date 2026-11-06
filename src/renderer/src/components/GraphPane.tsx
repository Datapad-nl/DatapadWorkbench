import { useEffect, useRef, useState } from 'react'
import type { KnowledgeNode, KnowledgeSnapshot } from '../../../shared/types'
import { useWorkspace } from '../workspace'
import { Markdown } from './Markdown'
import { IconButton } from './icons'
import { ReorderGrip } from './ReorderGrip'

const empty: KnowledgeSnapshot = {
  projectId: null,
  path: null,
  available: false,
  reason: 'no-folder',
  error: null,
  nodes: [],
  edges: []
}

type SimNode = KnowledgeNode & { x: number; y: number; vx: number; vy: number }

function reasonCopy(snapshot: KnowledgeSnapshot): string {
  if (snapshot.reason === 'no-folder') return 'Attach a folder to this project to build a knowledge vault.'
  if (snapshot.reason === 'error') return snapshot.error || 'Could not read the knowledge vault.'
  return 'Select a project.'
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end < 0) return text
  return text.slice(end + 4).replace(/^\s+/, '')
}

function nodeColor(kind: KnowledgeNode['kind'], accent: string, note: string, ink: string): string {
  if (kind === 'home') return ink
  if (kind === 'generated') return accent
  return note
}

function nodeRadius(kind: KnowledgeNode['kind']): number {
  if (kind === 'home') return 9
  if (kind === 'generated') return 5.5
  return 6.5
}

function GraphCanvas({
  snapshot,
  selectedId,
  active,
  onSelect
}: {
  snapshot: KnowledgeSnapshot
  selectedId: string | null
  active: boolean
  onSelect: (id: string | null) => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const simRef = useRef<SimNode[]>([])
  const snapshotRef = useRef(snapshot)
  const selectedRef = useRef(selectedId)
  const hoverRef = useRef<string | null>(null)
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const movedRef = useRef(false)
  snapshotRef.current = snapshot
  selectedRef.current = selectedId

  useEffect(() => {
    const prev = new Map(simRef.current.map((node) => [node.id, node]))
    const width = wrapRef.current?.clientWidth ?? 400
    const height = wrapRef.current?.clientHeight ?? 280
    const cx = width / 2
    const cy = height / 2
    simRef.current = snapshot.nodes.map((node, index) => {
      const existing = prev.get(node.id)
      if (existing) {
        return { ...node, x: existing.x, y: existing.y, vx: existing.vx, vy: existing.vy }
      }
      const angle = (index / Math.max(1, snapshot.nodes.length)) * Math.PI * 2
      const radius = Math.min(width, height) * 0.28
      return {
        ...node,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        vx: 0,
        vy: 0
      }
    })
  }, [snapshot])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let frame = 0
    let running = true
    let lastW = 0
    let lastH = 0

    function size(): { width: number; height: number } {
      const width = Math.max(1, wrap!.clientWidth)
      const height = Math.max(1, wrap!.clientHeight)
      if (width !== lastW || height !== lastH) {
        const dpr = window.devicePixelRatio || 1
        canvas!.width = Math.floor(width * dpr)
        canvas!.height = Math.floor(height * dpr)
        canvas!.style.width = `${width}px`
        canvas!.style.height = `${height}px`
        ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
        lastW = width
        lastH = height
      }
      return { width, height }
    }

    function colors(): { accent: string; note: string; ink: string; line: string; muted: string } {
      const styles = getComputedStyle(canvas!)
      return {
        accent: styles.getPropertyValue('--color-accent').trim() || '#c4a35a',
        note: '#7aa2c4',
        ink: styles.getPropertyValue('--color-ink').trim() || '#f2f2f0',
        line: styles.getPropertyValue('--color-line').trim() || '#2c2c2c',
        muted: styles.getPropertyValue('--color-muted').trim() || '#8e8e86'
      }
    }

    function hit(x: number, y: number): SimNode | null {
      const nodes = simRef.current
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i]
        const r = nodeRadius(node.kind) + 4
        const dx = node.x - x
        const dy = node.y - y
        if (dx * dx + dy * dy <= r * r) return node
      }
      return null
    }

    function step(width: number, height: number): void {
      const nodes = simRef.current
      const edges = snapshotRef.current.edges
      const drag = dragRef.current
      const byId = new Map(nodes.map((node) => [node.id, node]))
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          let dx = b.x - a.x
          let dy = b.y - a.y
          const dist2 = dx * dx + dy * dy || 1
          const force = 520 / dist2
          dx *= force
          dy *= force
          if (drag?.id !== a.id) {
            a.vx -= dx
            a.vy -= dy
          }
          if (drag?.id !== b.id) {
            b.vx += dx
            b.vy += dy
          }
        }
      }
      for (const edge of edges) {
        const a = byId.get(edge.from)
        const b = byId.get(edge.to)
        if (!a || !b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.hypot(dx, dy) || 1
        const pull = (dist - 86) * 0.012
        const fx = (dx / dist) * pull
        const fy = (dy / dist) * pull
        if (drag?.id !== a.id) {
          a.vx += fx
          a.vy += fy
        }
        if (drag?.id !== b.id) {
          b.vx -= fx
          b.vy -= fy
        }
      }
      const cx = width / 2
      const cy = height / 2
      for (const node of nodes) {
        if (drag?.id === node.id) {
          node.vx = 0
          node.vy = 0
          continue
        }
        node.vx += (cx - node.x) * 0.01
        node.vy += (cy - node.y) * 0.01
        node.vx *= 0.84
        node.vy *= 0.84
        node.x += node.vx
        node.y += node.vy
        node.x = Math.min(width - 16, Math.max(16, node.x))
        node.y = Math.min(height - 16, Math.max(16, node.y))
      }
    }

    function draw(width: number, height: number): void {
      const palette = colors()
      const nodes = simRef.current
      const byId = new Map(nodes.map((node) => [node.id, node]))
      ctx!.clearRect(0, 0, width, height)
      ctx!.lineWidth = 1
      for (const edge of snapshotRef.current.edges) {
        const a = byId.get(edge.from)
        const b = byId.get(edge.to)
        if (!a || !b) continue
        const active = edge.from === selectedRef.current || edge.to === selectedRef.current
        ctx!.strokeStyle = active ? palette.accent : palette.line
        ctx!.globalAlpha = active ? 0.85 : 0.55
        ctx!.beginPath()
        ctx!.moveTo(a.x, a.y)
        ctx!.lineTo(b.x, b.y)
        ctx!.stroke()
      }
      ctx!.globalAlpha = 1
      for (const node of nodes) {
        const r = nodeRadius(node.kind)
        const selected = node.id === selectedRef.current
        const hover = node.id === hoverRef.current
        ctx!.beginPath()
        ctx!.arc(node.x, node.y, r + (selected ? 2 : 0), 0, Math.PI * 2)
        ctx!.fillStyle = nodeColor(node.kind, palette.accent, palette.note, palette.ink)
        ctx!.fill()
        if (selected || hover) {
          ctx!.strokeStyle = palette.ink
          ctx!.lineWidth = 1.2
          ctx!.stroke()
        }
      }
      const labeled = nodes.filter(
        (node) =>
          node.id === selectedRef.current ||
          node.id === hoverRef.current ||
          node.kind === 'home'
      )
      ctx!.font = '11px "SF Pro Text", "Segoe UI", system-ui, sans-serif'
      ctx!.textAlign = 'center'
      ctx!.textBaseline = 'top'
      for (const node of labeled) {
        const label = node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title
        ctx!.fillStyle = palette.muted
        ctx!.fillText(label, node.x, node.y + nodeRadius(node.kind) + 5)
      }
    }

    function loop(): void {
      if (!running) return
      const { width, height } = size()
      if (width >= 8 && height >= 8) {
        step(width, height)
        draw(width, height)
      }
      frame = requestAnimationFrame(loop)
    }

    function localPoint(event: PointerEvent): { x: number; y: number } {
      const rect = canvas!.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    function onDown(event: PointerEvent): void {
      const point = localPoint(event)
      const node = hit(point.x, point.y)
      if (!node) {
        dragRef.current = null
        onSelect(null)
        return
      }
      movedRef.current = false
      dragRef.current = { id: node.id, dx: node.x - point.x, dy: node.y - point.y }
      canvas!.setPointerCapture(event.pointerId)
    }

    function onMove(event: PointerEvent): void {
      const point = localPoint(event)
      const drag = dragRef.current
      if (drag) {
        const node = simRef.current.find((item) => item.id === drag.id)
        if (node) {
          node.x = point.x + drag.dx
          node.y = point.y + drag.dy
          movedRef.current = true
        }
        return
      }
      hoverRef.current = hit(point.x, point.y)?.id ?? null
      canvas!.style.cursor = hoverRef.current ? 'pointer' : 'default'
    }

    function onUp(): void {
      const drag = dragRef.current
      if (drag && !movedRef.current) onSelect(drag.id)
      dragRef.current = null
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    if (active) loop()
    return () => {
      running = false
      cancelAnimationFrame(frame)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    }
  }, [active, onSelect])

  return (
    <div ref={wrapRef} className="relative min-h-[180px] flex-1 bg-canvas">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" data-testid="knowledge-graph" />
    </div>
  )
}

export function GraphPane(): React.JSX.Element {
  const {
    projects,
    activeProjectId,
    showKnowledge,
    showGit,
    showBrowser,
    showActivity,
    setShowKnowledge,
    swapRightPanes
  } = useWorkspace()
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot>(empty)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [note, setNote] = useState<{ title: string; body: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const projectIdRef = useRef(activeProjectId)
  projectIdRef.current = activeProjectId
  const project = projects.find((item) => item.id === activeProjectId) ?? null
  const otherPanes = showGit || showBrowser || showActivity

  useEffect(() => {
    if (!showKnowledge) {
      void window.workbench.setKnowledgeActiveProject(null)
      return
    }
    void window.workbench.setKnowledgeActiveProject(activeProjectId)
    return () => {
      void window.workbench.setKnowledgeActiveProject(null)
    }
  }, [showKnowledge, activeProjectId])

  useEffect(() => {
    if (!activeProjectId) {
      setSnapshot(empty)
      return
    }
    let cancelled = false
    void window.workbench.getKnowledgeSnapshot(activeProjectId).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    const unsubscribe = window.workbench.onKnowledgeSnapshot((next) => {
      if (next.projectId !== activeProjectId) return
      setSnapshot(next)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [activeProjectId])

  useEffect(() => {
    if (!activeProjectId || !selectedId) {
      setNote(null)
      return
    }
    let cancelled = false
    void window.workbench.getKnowledgeNote(activeProjectId, selectedId).then((next) => {
      if (cancelled) return
      setNote(next ? { title: next.title, body: next.body } : null)
    })
    return () => {
      cancelled = true
    }
  }, [activeProjectId, selectedId, snapshot])

  useEffect(() => {
    if (selectedId && !snapshot.nodes.some((node) => node.id === selectedId)) {
      setSelectedId(null)
    }
  }, [snapshot, selectedId])

  async function rebuild(): Promise<void> {
    if (!activeProjectId || busy) return
    setBusy(true)
    try {
      const next = await window.workbench.rebuildKnowledge(activeProjectId)
      if (next.projectId === projectIdRef.current) setSnapshot(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-sidebar">
      <header className="drag shrink-0">
        <div className="flex h-titlebar items-center justify-between gap-2 border-b border-line px-3">
          {otherPanes && <ReorderGrip onSwap={swapRightPanes} label="Reorder panes" />}
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h1 className="shrink-0 text-[13px] font-semibold text-ink">Knowledge</h1>
            <p className="no-drag min-w-0 truncate font-mono text-[11px] text-faint">
              {snapshot.available
                ? `${snapshot.nodes.length} notes · ${snapshot.edges.length} links`
                : project?.name ?? 'No project'}
            </p>
          </div>
          <div className="no-drag flex shrink-0 items-center gap-1">
            <button
              className="h-7 rounded-[7px] px-2 text-[12px] text-muted hover:bg-hover hover:text-ink disabled:opacity-40"
              onClick={() => {
                if (activeProjectId) void window.workbench.openKnowledgeVault(activeProjectId)
              }}
              disabled={!activeProjectId}
            >
              Obsidian
            </button>
            <IconButton
              icon="retry"
              label={busy ? 'Updating…' : 'Rebuild'}
              onClick={() => void rebuild()}
              disabled={!activeProjectId || busy}
              className={busy ? 'animate-spin' : ''}
            />
            <IconButton icon="close" label="Close Knowledge" onClick={() => setShowKnowledge(false)} />
          </div>
        </div>
      </header>

      {!activeProjectId || !snapshot.available ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-muted">
          {reasonCopy(snapshot)}
        </div>
      ) : (
        <div className="no-drag flex min-h-0 flex-1 flex-col">
          <GraphCanvas
            snapshot={snapshot}
            selectedId={selectedId}
            active={showKnowledge}
            onSelect={setSelectedId}
          />
          <div className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-1.5 font-mono text-[10px] text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-ink" />
              Home
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Generated
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#7aa2c4' }} />
              Your notes
            </span>
            <button
              className="ml-auto rounded px-1.5 py-0.5 hover:bg-raised hover:text-ink"
              onClick={() => {
                if (activeProjectId) void window.workbench.revealKnowledgeVault(activeProjectId)
              }}
            >
              Reveal vault
            </button>
          </div>
          <div className="min-h-[140px] max-h-[42%] overflow-y-auto border-t border-line px-3 py-3">
            {note ? (
              <div className="select-text">
                <div className="text-[11px] text-muted">
                  {selectedId}
                </div>
                <Markdown text={stripFrontmatter(note.body)} />
              </div>
            ) : (
              <p className="text-[12px] text-muted">Click a node to read the note. Open the `knowledge` folder in Obsidian for the full vault.</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
