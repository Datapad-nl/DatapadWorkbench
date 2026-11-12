import { useEffect, useMemo, useRef, useState } from 'react'
import type { KnowledgeNode, KnowledgeSnapshot } from '../../../shared/types'
import {
  fitScale,
  project,
  startPosition,
  stepLayout,
  unproject,
  type Camera,
  type LayoutNode,
  type Projected
} from '../graphLayout'
import { linkNotes } from '../noteLinks'
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

type SimNode = KnowledgeNode & LayoutNode

function failureText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

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

/** The graph has its own night palette, the same in every theme. */
const NIGHT = '#070a12'
const HUB_COLOR = '#ff7a1a'
const GROUP_COLORS = ['#ff9a3c', '#f4efe6', '#ffc56b', '#e8502a', '#c98a4b']
const OTHER_COLOR = '#6b7890'
const NOTE_COLOR = '#8fb4d9'
const LABEL_FONT = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace'

type Group = { name: string; color: string; count: number }
type GraphStyle = { groups: Group[]; colorOf: Map<string, string>; degree: Map<string, number> }

/** A concept note says how one thing in the project works, so its node is drawn larger and always named. */
function isFeature(node: KnowledgeNode): boolean {
  return node.kind === 'generated' && node.tags.includes('concept')
}

/**
 * Colours the notes by the part of the project they are about, and counts each note's links.
 * A concept note carries that part as an `area/` tag; the generated notes without one are about the whole project.
 * The five largest parts have a colour of their own.
 */
function graphStyle(snapshot: KnowledgeSnapshot): GraphStyle {
  const generated = snapshot.nodes.filter((node) => node.kind === 'generated')
  const areaOf = (node: KnowledgeNode): string =>
    node.tags.find((tag) => tag.startsWith('area/'))?.slice('area/'.length) ?? 'project'
  const counts = new Map<string, number>()
  for (const node of generated) counts.set(areaOf(node), (counts.get(areaOf(node)) ?? 0) + 1)
  const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
  const top = new Map(ranked.slice(0, GROUP_COLORS.length).map(([name], index) => [name, GROUP_COLORS[index]]))
  const groups: Group[] = ranked
    .slice(0, GROUP_COLORS.length)
    .map(([name, count], index) => ({ name, color: GROUP_COLORS[index], count }))
  const other = ranked.slice(GROUP_COLORS.length).reduce((sum, [, count]) => sum + count, 0)
  if (other) groups.push({ name: 'other', color: OTHER_COLOR, count: other })
  const notes = snapshot.nodes.filter((node) => node.kind !== 'generated' && node.kind !== 'home').length
  if (notes) groups.push({ name: 'your notes', color: NOTE_COLOR, count: notes })
  const colorOf = new Map(
    snapshot.nodes.map((node) => [
      node.id,
      node.kind === 'home' ? HUB_COLOR : node.kind === 'generated' ? (top.get(areaOf(node)) ?? OTHER_COLOR) : NOTE_COLOR
    ])
  )
  const degree = new Map<string, number>()
  for (const edge of snapshot.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  return { groups, colorOf, degree }
}

/** A note with more links is drawn larger. */
function nodeRadius(node: KnowledgeNode, links: number): number {
  if (node.kind === 'home') return 11
  return Math.min(9, 2.4 + Math.sqrt(links) * 0.95) + (isFeature(node) ? 1.5 : 0)
}

/** A press that moves less than this many pixels is a click, not a drag. */
const CLICK_SLOP = 4
const MIN_ZOOM = 0.3
const MAX_ZOOM = 6
/** How far a drag of one pixel turns the graph, in radians. */
const TURN = 0.006
const MAX_PITCH = 1.45
/** The graph turns slowly by itself while the pointer is elsewhere. */
const IDLE_TURN = 0.0012

function GraphCanvas({
  snapshot,
  selectedId,
  active,
  onSelect,
  children
}: {
  snapshot: KnowledgeSnapshot
  selectedId: string | null
  active: boolean
  onSelect: (id: string | null) => void
  /** Drawn over the graph. */
  children?: React.ReactNode
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const simRef = useRef<SimNode[]>([])
  const snapshotRef = useRef(snapshot)
  const selectedRef = useRef(selectedId)
  const hoverRef = useRef<string | null>(null)
  /**
   * How the graph is seen. It turns around the selected note, or its middle when none is selected.
   * `fit` is the scale that shows the whole graph, null until the first frame; `zoom` is the user's own on top of it.
   * `panX` and `panY` are how far the user moved the graph from the middle of the pane, in pixels.
   */
  const viewRef = useRef({
    yaw: 0.5,
    pitch: 0.3,
    zoom: 1,
    fit: null as number | null,
    pivot: { x: 0, y: 0, z: 0 },
    panX: 0,
    panY: 0
  })
  const style = useMemo(() => graphStyle(snapshot), [snapshot])
  const styleRef = useRef(style)
  styleRef.current = style
  snapshotRef.current = snapshot
  selectedRef.current = selectedId

  useEffect(() => {
    const prev = new Map(simRef.current.map((node) => [node.id, node]))
    simRef.current = snapshot.nodes.map((node, index) => {
      const existing = prev.get(node.id)
      if (existing) {
        const { x, y, z, vx, vy, vz } = existing
        return { ...node, x, y, z, vx, vy, vz }
      }
      return { ...node, ...startPosition(index, snapshot.nodes.length), vx: 0, vy: 0, vz: 0 }
    })
    // Another vault starts from a view of the whole graph.
    if (!snapshot.nodes.some((node) => prev.has(node.id))) {
      viewRef.current = { yaw: 0.5, pitch: 0.3, zoom: 1, fit: null, pivot: { x: 0, y: 0, z: 0 }, panX: 0, panY: 0 }
    }
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
    let pointerInside = false
    /** Where each node was drawn in the last frame, for the pointer to find it. */
    let drawn = new Map<string, Projected>()
    /** The press in progress: on a node it drags the node, on the background it turns the graph. The right button moves the graph. */
    let press:
      | { kind: 'node'; id: string; dx: number; dy: number; near: number; startX: number; startY: number; moved: boolean }
      | { kind: 'turn'; yaw: number; pitch: number; startX: number; startY: number; moved: boolean }
      | { kind: 'pan'; panX: number; panY: number; startX: number; startY: number; moved: boolean }
      | null = null

    function size(): { width: number; height: number } {
      const width = Math.max(1, wrap!.clientWidth)
      const height = Math.max(1, wrap!.clientHeight)
      const dpr = window.devicePixelRatio || 1
      if (width !== lastW || height !== lastH) {
        canvas!.width = Math.floor(width * dpr)
        canvas!.height = Math.floor(height * dpr)
        canvas!.style.width = `${width}px`
        canvas!.style.height = `${height}px`
        lastW = width
        lastH = height
      }
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      return { width, height }
    }

    function camera(): Camera {
      const view = viewRef.current
      return { yaw: view.yaw, pitch: view.pitch, scale: (view.fit ?? 1) * view.zoom, pivot: view.pivot }
    }

    function radiusOf(node: SimNode, near: number): number {
      return nodeRadius(node, styleRef.current.degree.get(node.id) ?? 0) * Math.min(2.2, Math.max(0.45, near))
    }

    /** The node under a point of the pane; of two that overlap, the nearer one. */
    function hit(x: number, y: number): SimNode | null {
      let found: SimNode | null = null
      let foundNear = 0
      for (const node of simRef.current) {
        const at = drawn.get(node.id)
        if (!at || at.near <= foundNear) continue
        const r = radiusOf(node, at.near) + 4
        if ((at.x - x) ** 2 + (at.y - y) ** 2 <= r * r) {
          found = node
          foundNear = at.near
        }
      }
      return found
    }

    /** Eases the view to the whole graph, and its pivot to the selected note. */
    function follow(width: number, height: number): void {
      const view = viewRef.current
      const fit = fitScale(simRef.current, width, height)
      view.fit = view.fit === null ? fit : view.fit + (fit - view.fit) * 0.15
      const selected = selectedRef.current
      const target = (selected && simRef.current.find((node) => node.id === selected)) || { x: 0, y: 0, z: 0 }
      view.pivot = {
        x: view.pivot.x + (target.x - view.pivot.x) * 0.12,
        y: view.pivot.y + (target.y - view.pivot.y) * 0.12,
        z: view.pivot.z + (target.z - view.pivot.z) * 0.12
      }
      if (!press && !pointerInside) view.yaw += IDLE_TURN
    }

    function draw(width: number, height: number): void {
      const { colorOf } = styleRef.current
      const view = camera()
      const selectedId = selectedRef.current
      const { panX, panY } = viewRef.current
      const at = new Map(
        simRef.current.map((node) => {
          const point = project(node, view, width, height)
          return [node.id, { x: point.x + panX, y: point.y + panY, near: point.near }]
        })
      )
      drawn = at
      // Far nodes are drawn first and dimmer, so the near ones lie over them.
      const nodes = [...simRef.current].sort((a, b) => at.get(a.id)!.near - at.get(b.id)!.near)
      const light = (near: number): number => Math.min(1, Math.max(0.28, near * near * 0.85))
      const hubs = new Set(nodes.filter((node) => node.kind === 'home' || isFeature(node)).map((node) => node.id))
      ctx!.clearRect(0, 0, width, height)

      // Links add their light where they cross. The ones to a hub are the bright spokes.
      ctx!.globalCompositeOperation = 'lighter'
      for (const edge of snapshotRef.current.edges) {
        const a = at.get(edge.from)
        const b = at.get(edge.to)
        if (!a || !b) continue
        const chosen = edge.from === selectedId || edge.to === selectedId
        const spoke = hubs.has(edge.from) || hubs.has(edge.to)
        ctx!.strokeStyle = colorOf.get(hubs.has(edge.to) ? edge.to : edge.from) ?? OTHER_COLOR
        ctx!.globalAlpha = (chosen ? 0.95 : spoke ? 0.36 : 0.14) * (chosen ? 1 : light((a.near + b.near) / 2))
        ctx!.lineWidth = chosen ? 1.6 : spoke ? 1 : 0.6
        ctx!.beginPath()
        ctx!.moveTo(a.x, a.y)
        ctx!.lineTo(b.x, b.y)
        ctx!.stroke()
      }
      for (const node of nodes) {
        const point = at.get(node.id)!
        const color = colorOf.get(node.id) ?? OTHER_COLOR
        const reach = radiusOf(node, point.near) * 3.4
        const glow = ctx!.createRadialGradient(point.x, point.y, 0, point.x, point.y, reach)
        glow.addColorStop(0, color)
        glow.addColorStop(1, `${color}00`)
        ctx!.globalAlpha = (node.id === selectedId || node.id === hoverRef.current ? 0.6 : 0.3) * light(point.near)
        ctx!.fillStyle = glow
        ctx!.beginPath()
        ctx!.arc(point.x, point.y, reach, 0, Math.PI * 2)
        ctx!.fill()
      }
      ctx!.globalCompositeOperation = 'source-over'
      ctx!.textAlign = 'center'
      for (const node of nodes) {
        const point = at.get(node.id)!
        const r = radiusOf(node, point.near)
        const marked = node.id === selectedId || node.id === hoverRef.current
        ctx!.globalAlpha = marked ? 1 : light(point.near)
        ctx!.beginPath()
        ctx!.arc(point.x, point.y, r, 0, Math.PI * 2)
        ctx!.fillStyle = colorOf.get(node.id) ?? OTHER_COLOR
        ctx!.fill()
        if (marked) {
          ctx!.strokeStyle = '#ffffff'
          ctx!.lineWidth = 1.4
          ctx!.stroke()
        }
        if (node.kind === 'home') {
          ctx!.font = `bold ${Math.round(r * 0.95)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`
          ctx!.textBaseline = 'middle'
          ctx!.fillStyle = NIGHT
          ctx!.fillText(node.title.slice(0, 1).toUpperCase(), point.x, point.y + 0.5)
        }
      }

      // A hub, the selected note and the one under the pointer are named, each in a pill under its node.
      ctx!.font = LABEL_FONT
      ctx!.textBaseline = 'middle'
      for (const node of nodes) {
        const marked = node.id === selectedId || node.id === hoverRef.current
        if (!hubs.has(node.id) && !marked) continue
        const point = at.get(node.id)!
        const label = node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title
        const w = ctx!.measureText(label).width + 14
        const top = point.y + radiusOf(node, point.near) + 6
        const alpha = marked ? 1 : Math.min(1, light(point.near) + 0.15)
        ctx!.globalAlpha = alpha
        ctx!.beginPath()
        ctx!.roundRect(point.x - w / 2, top, w, 16, 8)
        ctx!.fillStyle = 'rgba(7, 10, 18, 0.86)'
        ctx!.fill()
        ctx!.globalAlpha = alpha * 0.7
        ctx!.strokeStyle = colorOf.get(node.id) ?? OTHER_COLOR
        ctx!.lineWidth = 1
        ctx!.stroke()
        ctx!.globalAlpha = alpha
        ctx!.fillStyle = '#e9e4da'
        ctx!.fillText(label, point.x, top + 8.5)
      }

      // The corner marks that frame the graph, and how it is turned.
      ctx!.strokeStyle = HUB_COLOR
      ctx!.lineWidth = 1
      ctx!.globalAlpha = 0.8
      ctx!.beginPath()
      for (const [x, sx] of [[6.5, 1], [width - 6.5, -1]]) {
        for (const [y, sy] of [[6.5, 1], [height - 6.5, -1]]) {
          ctx!.moveTo(x + 10 * sx, y)
          ctx!.lineTo(x, y)
          ctx!.lineTo(x, y + 10 * sy)
        }
      }
      ctx!.stroke()
      const degrees = (angle: number): string => (((angle * 180) / Math.PI) % 360).toFixed(1)
      ctx!.globalAlpha = 0.6
      ctx!.fillStyle = '#8f98a8'
      ctx!.textAlign = 'right'
      ctx!.fillText(
        `yaw ${degrees(((view.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2))}° · pitch ${degrees(view.pitch)}°`,
        width - 18,
        height - 18
      )
      ctx!.globalAlpha = 1
    }

    function loop(): void {
      if (!running) return
      const { width, height } = size()
      if (width >= 8 && height >= 8) {
        stepLayout(simRef.current, snapshotRef.current.edges, press?.kind === 'node' ? press.id : null)
        follow(width, height)
        draw(width, height)
      }
      frame = requestAnimationFrame(loop)
    }

    function localPoint(event: MouseEvent): { x: number; y: number } {
      const rect = canvas!.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    function onDown(event: PointerEvent): void {
      if (event.button !== 0 && event.button !== 2) return
      const point = localPoint(event)
      if (event.button === 2) {
        const { panX, panY } = viewRef.current
        press = { kind: 'pan', panX, panY, startX: point.x, startY: point.y, moved: false }
        canvas!.setPointerCapture(event.pointerId)
        return
      }
      const node = hit(point.x, point.y)
      const at = node && drawn.get(node.id)
      press =
        node && at
          ? {
              kind: 'node',
              id: node.id,
              dx: at.x - point.x,
              dy: at.y - point.y,
              near: at.near,
              startX: point.x,
              startY: point.y,
              moved: false
            }
          : {
              kind: 'turn',
              yaw: viewRef.current.yaw,
              pitch: viewRef.current.pitch,
              startX: point.x,
              startY: point.y,
              moved: false
            }
      canvas!.setPointerCapture(event.pointerId)
    }

    function onMove(event: PointerEvent): void {
      const point = localPoint(event)
      if (!press) {
        hoverRef.current = hit(point.x, point.y)?.id ?? null
        canvas!.style.cursor = hoverRef.current ? 'pointer' : 'grab'
        return
      }
      if (!press.moved && Math.hypot(point.x - press.startX, point.y - press.startY) < CLICK_SLOP) return
      press.moved = true
      if (press.kind === 'turn') {
        canvas!.style.cursor = 'grabbing'
        viewRef.current.yaw = press.yaw - (point.x - press.startX) * TURN
        viewRef.current.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, press.pitch + (point.y - press.startY) * TURN))
        return
      }
      if (press.kind === 'pan') {
        canvas!.style.cursor = 'move'
        viewRef.current.panX = press.panX + point.x - press.startX
        viewRef.current.panY = press.panY + point.y - press.startY
        return
      }
      // A dragged node moves across the view and keeps its depth.
      const id = press.id
      const node = simRef.current.find((item) => item.id === id)
      if (node) {
        Object.assign(
          node,
          unproject(
            {
              x: point.x + press.dx - viewRef.current.panX,
              y: point.y + press.dy - viewRef.current.panY,
              near: press.near
            },
            camera(),
            lastW,
            lastH
          )
        )
      }
    }

    function onUp(): void {
      if (press && !press.moved && press.kind !== 'pan') onSelect(press.kind === 'node' ? press.id : null)
      press = null
    }

    // A drag the system takes over ends without counting as a click.
    function onCancel(): void {
      press = null
    }

    /** Zooms on the pivot. A pinch arrives as a wheel with the control key held, in smaller steps. */
    function onWheel(event: WheelEvent): void {
      event.preventDefault()
      const view = viewRef.current
      view.zoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, view.zoom * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)))
      )
    }

    /** A double click on the background shows the whole graph again, in the middle of the pane. */
    function onDoubleClick(event: MouseEvent): void {
      const point = localPoint(event)
      if (!hit(point.x, point.y)) Object.assign(viewRef.current, { zoom: 1, panX: 0, panY: 0 })
    }

    /** The right button moves the graph, so it opens no menu. */
    function onContextMenu(event: MouseEvent): void {
      event.preventDefault()
    }

    function onEnter(): void {
      pointerInside = true
    }

    function onLeave(): void {
      pointerInside = false
      hoverRef.current = null
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onCancel)
    canvas.addEventListener('lostpointercapture', onCancel)
    canvas.addEventListener('pointerenter', onEnter)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dblclick', onDoubleClick)
    canvas.addEventListener('contextmenu', onContextMenu)
    if (active) loop()
    return () => {
      running = false
      cancelAnimationFrame(frame)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('lostpointercapture', onCancel)
      canvas.removeEventListener('pointerenter', onEnter)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDoubleClick)
      canvas.removeEventListener('contextmenu', onContextMenu)
    }
  }, [active, onSelect])

  return (
    <div
      ref={wrapRef}
      className="@container relative min-h-[180px] flex-1 overflow-hidden"
      style={{ background: `radial-gradient(circle at 50% 45%, #101827, ${NIGHT} 72%)` }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" data-testid="knowledge-graph" />
      {style.groups.length > 0 && (
        <ul
          className="pointer-events-none absolute left-4 top-4 space-y-1.5 border border-white/10 px-2.5 py-2 font-mono text-[10px] text-[#c9c4ba]"
          style={{ background: 'rgba(7, 10, 18, 0.78)' }}
          data-testid="knowledge-legend"
        >
          {style.groups.map((group) => (
            <li key={group.name} className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: group.color }} />
              <span className="max-w-[140px] truncate">{group.name}</span>
              <span className="ml-auto pl-4" style={{ color: HUB_COLOR }}>
                {group.count}
              </span>
            </li>
          ))}
        </ul>
      )}
      {children}
    </div>
  )
}

/** The night palette for the text of a note, whatever the theme of the app. */
const OVERLAY_COLORS = {
  '--color-ink': '#f1ece2',
  '--color-ink-2': '#d9d3c7',
  '--color-muted': '#9aa3b5',
  '--color-faint': '#6b7890',
  '--color-line': 'rgba(255, 154, 60, 0.22)',
  '--color-raised': 'rgba(255, 255, 255, 0.06)',
  '--color-accent': '#ffb45e',
  '--color-scrollbar': 'rgba(255, 154, 60, 0.3)'
} as React.CSSProperties

const CORNERS = [
  'left-[-1px] top-[-1px] border-l border-t',
  'right-[-1px] top-[-1px] border-r border-t'
]

/**
 * The selected note, on a pane of dark glass over the graph, standing on the bottom edge of the pane so the note's
 * node in the middle stays in view.
 */
function NoteOverlay({
  path,
  body,
  nodes,
  onNoteLink,
  onClose
}: {
  path: string
  body: string
  nodes: KnowledgeNode[]
  onNoteLink: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const node = nodes.find((item) => item.id === path)
  const kind = node?.kind === 'home' ? 'home' : node?.kind === 'note' ? 'your note' : node && isFeature(node) ? 'concept' : 'generated'
  return (
    <div
      // A new note comes in again.
      key={path}
      className="note-overlay absolute inset-x-3 bottom-0 mx-auto flex max-h-[46%] max-w-[860px] flex-col border border-b-0"
      style={{
        ...OVERLAY_COLORS,
        borderColor: 'rgba(255, 154, 60, 0.28)',
        background: 'linear-gradient(180deg, rgba(16, 24, 39, 0.62), rgba(7, 10, 18, 0.74))',
        backdropFilter: 'blur(14px) saturate(140%)',
        boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.4), 0 0 42px rgba(255, 122, 26, 0.12), inset 0 1px 0 rgba(255, 196, 120, 0.18)'
      }}
      data-testid="knowledge-note"
    >
      {CORNERS.map((corner) => (
        <span key={corner} className={`pointer-events-none absolute h-2.5 w-2.5 ${corner}`} style={{ borderColor: HUB_COLOR }} />
      ))}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2 font-mono text-[10px] tracking-[0.14em] uppercase"
        style={{ borderColor: 'rgba(255, 154, 60, 0.22)', color: HUB_COLOR }}
      >
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: HUB_COLOR, boxShadow: `0 0 8px ${HUB_COLOR}` }} />
        <span className="shrink-0">{kind}</span>
        <span className="min-w-0 flex-1 truncate tracking-normal normal-case text-faint" title={path}>
          {path}
        </span>
        <button
          className="shrink-0 px-1 text-[12px] leading-none text-muted hover:text-ink"
          onClick={onClose}
          aria-label="Close note"
          title="Close note"
        >
          ✕
        </button>
      </div>
      <div className="note-overlay-body min-h-0 flex-1 overflow-y-auto px-4 py-3 select-text">
        <Markdown text={linkNotes(stripFrontmatter(body), path, nodes)} onNoteLink={onNoteLink} />
      </div>
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
  /** A failed read or rebuild, shown only for the project it failed for. */
  const [failed, setFailed] = useState<{ projectId: string; message: string } | null>(null)
  const error = failed && failed.projectId === activeProjectId ? failed.message : null
  const projectIdRef = useRef(activeProjectId)
  projectIdRef.current = activeProjectId
  const project = projects.find((item) => item.id === activeProjectId) ?? null
  const otherPanes = showGit || showBrowser || showActivity
  // Until the new project's graph arrives, the last project's must not show under its name.
  const loading = Boolean(activeProjectId) && snapshot.projectId !== activeProjectId

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
    // A newer graph replaces an earlier failure to get one.
    const show = (next: KnowledgeSnapshot): void => {
      setSnapshot(next)
      setFailed((current) => (current?.projectId === next.projectId ? null : current))
    }
    window.workbench.getKnowledgeSnapshot(activeProjectId).then(
      (next) => {
        if (!cancelled) show(next)
      },
      (caught: unknown) => {
        if (!cancelled) {
          setFailed({ projectId: activeProjectId, message: failureText(caught, 'Could not read the knowledge vault') })
        }
      }
    )
    const unsubscribe = window.workbench.onKnowledgeSnapshot((next) => {
      if (next.projectId !== activeProjectId) return
      show(next)
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
    const projectId = activeProjectId
    setBusy(true)
    setFailed(null)
    try {
      const next = await window.workbench.rebuildKnowledge(projectId)
      if (next.projectId === projectIdRef.current) setSnapshot(next)
    } catch (caught) {
      setFailed({ projectId, message: failureText(caught, 'Could not rebuild the knowledge vault') })
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
            <p
              className={`no-drag min-w-0 truncate font-mono text-[11px] ${error ? 'text-danger' : 'text-faint'}`}
              title={error ?? undefined}
            >
              {error ??
                (snapshot.available && !loading
                  ? `${snapshot.nodes.length} notes · ${snapshot.edges.length} links`
                  : project?.name ?? 'No project')}
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

      {!activeProjectId || loading || !snapshot.available ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-muted">
          {error ?? (loading ? 'Loading…' : reasonCopy(snapshot))}
        </div>
      ) : (
        <div className="no-drag flex min-h-0 flex-1 flex-col">
          <GraphCanvas
            snapshot={snapshot}
            selectedId={selectedId}
            active={showKnowledge}
            onSelect={setSelectedId}
          >
            {note && selectedId ? (
              <NoteOverlay
                path={selectedId}
                body={note.body}
                nodes={snapshot.nodes}
                onNoteLink={setSelectedId}
                onClose={() => setSelectedId(null)}
              />
            ) : null}
          </GraphCanvas>
          <div className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-1.5 font-mono text-[10px] text-muted">
            <span className="min-w-0 truncate">Click a node to read its note · drag to turn the graph around it · right-drag to move it · scroll to zoom</span>
            <button
              className="ml-auto shrink-0 rounded px-1.5 py-0.5 hover:bg-raised hover:text-ink"
              onClick={() => {
                if (activeProjectId) void window.workbench.revealKnowledgeVault(activeProjectId)
              }}
            >
              Reveal vault
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
