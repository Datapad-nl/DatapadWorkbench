/** The force layout of the knowledge graph, in three dimensions around 0,0,0, and the camera that draws it in the pane. */

export type Point = { x: number; y: number; z: number }
export type LayoutNode = Point & { id: string; vx: number; vy: number; vz: number }
export type LayoutEdge = { from: string; to: string }

const REPULSION = 200
const LINK_LENGTH = 86
const LINK_PULL = 0.04
const GRAVITY = 0.05
const DAMPING = 0.84
/** Two nodes closer than this push apart no harder than at this distance, so a pile does not fling its nodes away. */
const MIN_DISTANCE = 10
const MAX_SPEED = 30

/** Where a node starts: spread evenly over a sphere that grows with the number of nodes, so none start on top of each other. */
export function startPosition(index: number, count: number): Point {
  const radius = Math.cbrt(Math.max(1, count)) * 70
  const y = count > 1 ? 1 - (2 * index) / (count - 1) : 0
  const ring = Math.sqrt(Math.max(0, 1 - y * y))
  const angle = index * 2.399963
  return { x: Math.cos(angle) * ring * radius, y: y * radius, z: Math.sin(angle) * ring * radius }
}

/** Moves every node one step. The node being dragged stays where the pointer put it. */
export function stepLayout(nodes: LayoutNode[], edges: LayoutEdge[], dragId: string | null): void {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let dz = b.z - a.z
      if (dx === 0 && dy === 0 && dz === 0) {
        // Two nodes on the same spot have no direction to part in, so they get one.
        const angle = (i * 31 + j) * 2.399963
        const lift = Math.sin(i * 7 + j * 3)
        dx = Math.cos(angle) * Math.sqrt(1 - lift * lift)
        dy = lift
        dz = Math.sin(angle) * Math.sqrt(1 - lift * lift)
      }
      const force = REPULSION / Math.max(dx * dx + dy * dy + dz * dz, MIN_DISTANCE * MIN_DISTANCE)
      a.vx -= dx * force
      a.vy -= dy * force
      a.vz -= dz * force
      b.vx += dx * force
      b.vy += dy * force
      b.vz += dz * force
    }
  }
  for (const edge of edges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (!a || !b || a === b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dz = b.z - a.z
    const dist = Math.hypot(dx, dy, dz) || 1
    const pull = ((dist - LINK_LENGTH) * LINK_PULL) / dist
    a.vx += dx * pull
    a.vy += dy * pull
    a.vz += dz * pull
    b.vx -= dx * pull
    b.vy -= dy * pull
    b.vz -= dz * pull
  }
  for (const node of nodes) {
    if (node.id === dragId) {
      node.vx = 0
      node.vy = 0
      node.vz = 0
      continue
    }
    node.vx = (node.vx - node.x * GRAVITY) * DAMPING
    node.vy = (node.vy - node.y * GRAVITY) * DAMPING
    node.vz = (node.vz - node.z * GRAVITY) * DAMPING
    const speed = Math.hypot(node.vx, node.vy, node.vz)
    if (speed > MAX_SPEED) {
      node.vx *= MAX_SPEED / speed
      node.vy *= MAX_SPEED / speed
      node.vz *= MAX_SPEED / speed
    }
    node.x += node.vx
    node.y += node.vy
    node.z += node.vz
  }
}

/** The camera turns around its pivot, which is drawn at the middle of the pane. Angles are in radians. */
export type Camera = { yaw: number; pitch: number; scale: number; pivot: Point }
/** A point on the pane. `near` is how much perspective enlarges it: 1 at the pivot's depth, more when nearer. */
export type Projected = { x: number; y: number; near: number }

/** How far the eye is from the pivot, in pixels of the pane. */
const EYE = 900

export function project(point: Point, camera: Camera, width: number, height: number): Projected {
  const x = point.x - camera.pivot.x
  const y = point.y - camera.pivot.y
  const z = point.z - camera.pivot.z
  const turnedX = x * Math.cos(camera.yaw) + z * Math.sin(camera.yaw)
  const turnedZ = -x * Math.sin(camera.yaw) + z * Math.cos(camera.yaw)
  const tiltedY = y * Math.cos(camera.pitch) - turnedZ * Math.sin(camera.pitch)
  const depth = y * Math.sin(camera.pitch) + turnedZ * Math.cos(camera.pitch)
  const near = EYE / Math.max(EYE * 0.1, EYE + depth * camera.scale)
  return {
    x: width / 2 + turnedX * camera.scale * near,
    y: height / 2 + tiltedY * camera.scale * near,
    near
  }
}

/** The point that `project` puts at this place on the pane, at this nearness. */
export function unproject(at: Projected, camera: Camera, width: number, height: number): Point {
  const turnedX = (at.x - width / 2) / (camera.scale * at.near)
  const tiltedY = (at.y - height / 2) / (camera.scale * at.near)
  const depth = (EYE / at.near - EYE) / camera.scale
  const y = tiltedY * Math.cos(camera.pitch) + depth * Math.sin(camera.pitch)
  const turnedZ = -tiltedY * Math.sin(camera.pitch) + depth * Math.cos(camera.pitch)
  return {
    x: turnedX * Math.cos(camera.yaw) - turnedZ * Math.sin(camera.yaw) + camera.pivot.x,
    y: y + camera.pivot.y,
    z: turnedX * Math.sin(camera.yaw) + turnedZ * Math.cos(camera.yaw) + camera.pivot.z
  }
}

/** The scale at which the whole graph is in the pane from every side, with room for the names. It is enlarged to fill the pane, up to twice. */
export function fitScale(nodes: Point[], width: number, height: number, pad = 56): number {
  let reach = 0
  for (const node of nodes) reach = Math.max(reach, Math.hypot(node.x, node.y, node.z))
  if (!reach) return 2
  // Perspective enlarges the near nodes, which are drawn towards the middle, so the margin covers it.
  const half = Math.max(1, Math.min(width, height) / 2 - pad)
  return Math.min(2, half / reach)
}
