import { describe, expect, it } from 'vitest'
import {
  fitScale,
  project,
  startPosition,
  stepLayout,
  unproject,
  type Camera,
  type LayoutEdge,
  type LayoutNode
} from './graphLayout'

/** A vault the size of a real one: every note links to an earlier one, and some link across. */
function vault(count: number, links: number): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    ...startPosition(index, count),
    vx: 0,
    vy: 0,
    vz: 0
  }))
  const edges: LayoutEdge[] = []
  for (let i = 1; i < count; i++) edges.push({ from: `n${i}`, to: `n${Math.floor(i / 3)}` })
  for (let i = 0; edges.length < links; i++) edges.push({ from: `n${(i * 7) % count}`, to: `n${(i * 13 + 5) % count}` })
  return { nodes, edges }
}

function settle(nodes: LayoutNode[], edges: LayoutEdge[], steps = 600): void {
  for (let i = 0; i < steps; i++) stepLayout(nodes, edges, null)
}

function closestPair(nodes: LayoutNode[]): number {
  let closest = Infinity
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      closest = Math.min(
        closest,
        Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y, nodes[i].z - nodes[j].z)
      )
    }
  }
  return closest
}

const reach = (nodes: LayoutNode[]): number => Math.max(...nodes.map((node) => Math.hypot(node.x, node.y, node.z)))

describe('stepLayout', () => {
  it('settles a large vault into a compact ball with its nodes apart', () => {
    const { nodes, edges } = vault(137, 309)
    settle(nodes, edges)
    const speed = Math.max(...nodes.map((node) => Math.hypot(node.vx, node.vy, node.vz)))
    expect(reach(nodes)).toBeLessThan(800)
    expect(closestPair(nodes)).toBeGreaterThan(12)
    expect(speed).toBeLessThan(0.5)
    // It has depth: the nodes are not all in one plane.
    expect(Math.max(...nodes.map((node) => Math.abs(node.z)))).toBeGreaterThan(100)
  })

  it('parts nodes that start on the same spot without flinging them away', () => {
    const nodes = Array.from({ length: 20 }, (_, index) => ({ id: `n${index}`, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }))
    settle(nodes, [])
    expect(closestPair(nodes)).toBeGreaterThan(12)
    expect(reach(nodes)).toBeLessThan(400)
  })

  it('leaves the dragged node where it is', () => {
    const { nodes, edges } = vault(10, 12)
    Object.assign(nodes[3], { x: 500, y: -200, z: 80 })
    for (let i = 0; i < 50; i++) stepLayout(nodes, edges, 'n3')
    expect(nodes[3]).toMatchObject({ x: 500, y: -200, z: 80, vx: 0, vy: 0, vz: 0 })
  })
})

describe('the camera', () => {
  const camera: Camera = { yaw: 0.7, pitch: -0.4, scale: 0.8, pivot: { x: 30, y: -20, z: 50 } }

  it('draws its pivot at the middle of the pane, whichever way it is turned', () => {
    expect(project(camera.pivot, camera, 600, 400)).toEqual({ x: 300, y: 200, near: 1 })
  })

  it('draws a nearer node larger', () => {
    const level: Camera = { yaw: 0, pitch: 0, scale: 1, pivot: { x: 0, y: 0, z: 0 } }
    expect(project({ x: 0, y: 0, z: -200 }, level, 600, 400).near).toBeGreaterThan(1)
    expect(project({ x: 0, y: 0, z: 200 }, level, 600, 400).near).toBeLessThan(1)
  })

  it('finds the point back from where it is drawn', () => {
    const point = { x: 120, y: 45, z: -210 }
    const back = unproject(project(point, camera, 600, 400), camera, 600, 400)
    expect(back.x).toBeCloseTo(point.x, 6)
    expect(back.y).toBeCloseTo(point.y, 6)
    expect(back.z).toBeCloseTo(point.z, 6)
  })

  it('fits every node inside the pane from every side', () => {
    const { nodes, edges } = vault(137, 309)
    settle(nodes, edges)
    const scale = fitScale(nodes, 600, 400)
    for (const yaw of [0, 1, 2.5, 4]) {
      for (const pitch of [-1.2, 0, 0.9]) {
        for (const node of nodes) {
          const at = project(node, { yaw, pitch, scale, pivot: { x: 0, y: 0, z: 0 } }, 600, 400)
          expect(Math.abs(at.x - 300)).toBeLessThanOrEqual(200)
          expect(Math.abs(at.y - 200)).toBeLessThanOrEqual(200)
        }
      }
    }
  })

  it('enlarges a small graph no more than twice', () => {
    expect(fitScale([{ x: -20, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }], 600, 400)).toBe(2)
  })
})
