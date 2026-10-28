// Movement conflicts at a node: do two (in-edge -> out-edge) movements cross or merge?
//
// Each movement is approximated by its lane-centre path: 6 m before the node on
// the in-edge, then straight to the start of the out-edge, then 6 m along it, each
// laterally offset to the middle of that edge's lanes (right-hand traffic). The path
// deliberately does not pass through the bare node point: where a dual carriageway
// merges into a two-way road, both directions' centrelines meet at that point although
// their lanes never touch. Two movements conflict
// if they merge into the same out-edge or their paths come closer than
// CLEARANCE_M anywhere (i.e. two vehicles on them could touch).
// Opposite through movements on a two-way street run on different sides of the
// centre line, so they don't conflict. Pure TS only.
import type { XZ } from './geo'
import type { NetEdge, Network } from './types'

/** Must match render/layout LANE_WIDTH so the geometry matches what's drawn. */
const LANE_W = 3.2
const STUB_M = 6
/** Lane-centre paths closer than this mean two vehicles on them could touch (≈ car width + margin), m. */
const CLEARANCE_M = 2.2

/** Point at arc length s along a polyline, shifted `off` to the right of travel. */
function along(pts: XZ[], s: number, off: number): XZ {
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const l = Math.hypot(b.x - a.x, b.z - a.z)
    if (l === 0) continue
    if (acc + l >= s || i === pts.length - 1) {
      const t = Math.min(1, Math.max(0, (s - acc) / l))
      const dx = (b.x - a.x) / l
      const dz = (b.z - a.z) / l
      return { x: a.x + (b.x - a.x) * t - dz * off, z: a.z + (b.z - a.z) * t + dx * off }
    }
    acc += l
  }
  return pts[0]
}

function pointSegDist(p: XZ, a: XZ, b: XZ): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const l2 = dx * dx + dz * dz
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2))
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t))
}

function properCross(p1: XZ, p2: XZ, p3: XZ, p4: XZ): boolean {
  const d = (p2.x - p1.x) * (p4.z - p3.z) - (p2.z - p1.z) * (p4.x - p3.x)
  if (Math.abs(d) < 1e-9) return false
  const t = ((p3.x - p1.x) * (p4.z - p3.z) - (p3.z - p1.z) * (p4.x - p3.x)) / d
  const u = ((p3.x - p1.x) * (p2.z - p1.z) - (p3.z - p1.z) * (p2.x - p1.x)) / d
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

/** Minimum distance between two segments. */
function segDist(a1: XZ, a2: XZ, b1: XZ, b2: XZ): number {
  if (properCross(a1, a2, b1, b2)) return 0
  return Math.min(pointSegDist(a1, b1, b2), pointSegDist(a2, b1, b2), pointSegDist(b1, a1, a2), pointSegDist(b2, a1, a2))
}

export function createConflictTable(net: Network) {
  const twin = new Set<number>()
  const byKey = new Map<string, number>()
  for (const e of net.edges) byKey.set(`${e.wayId}:${e.from}:${e.to}`, e.index)
  for (const e of net.edges) if (byKey.has(`${e.wayId}:${e.to}:${e.from}`)) twin.add(e.index)
  /** Offset of the middle of an edge's lanes from its centreline (matches render/layout). */
  const mid = (e: NetEdge) => (twin.has(e.index) ? (e.lanes * LANE_W) / 2 : 0)

  const pathCache = new Map<string, XZ[]>()
  const path = (inE: number, outE: number): XZ[] => {
    const k = `${inE}>${outE}`
    let p = pathCache.get(k)
    if (!p) {
      const a = net.edges[inE]
      const b = net.edges[outE]
      // Where a one-way carriageway meets a two-way road, OSM draws the carriageway converging
      // onto the two-way road's centreline; physically its lanes sit where the two-way road's
      // lanes for that direction are. So near the node, use the two-way side's lane offset.
      const atNode = twin.has(a.index) ? mid(a) : twin.has(b.index) ? mid(b) : 0
      p = [
        along(a.points, Math.max(0, a.length - STUB_M), mid(a)),
        along(a.points, Math.max(0, a.length - 1), atNode),
        along(b.points, Math.min(b.length, 1), atNode),
        along(b.points, Math.min(b.length, STUB_M), mid(b)),
      ]
      pathCache.set(k, p)
    }
    return p
  }

  const cache = new Map<string, boolean>()
  /** Do movements (in1->out1) and (in2->out2) through the same node conflict? */
  return function conflicts(in1: number, out1: number, in2: number, out2: number): boolean {
    if (in1 === in2) return false // same approach: ordered by the lane queue
    if (out1 === out2) return true // merge
    const k = in1 < in2 ? `${in1},${out1}|${in2},${out2}` : `${in2},${out2}|${in1},${out1}`
    let c = cache.get(k)
    if (c === undefined) {
      const p = path(in1, out1)
      const q = path(in2, out2)
      c = false
      for (let i = 0; i < 3 && !c; i++) for (let j = 0; j < 3 && !c; j++) c = segDist(p[i], p[i + 1], q[j], q[j + 1]) < CLEARANCE_M
      cache.set(k, c)
    }
    return c
  }
}

/** Signed turn angle from edge a into edge b, radians: < 0 left, > 0 right (+X east, −Z north). */
export function turnAngle(a: NetEdge, b: NetEdge): number {
  const pa = a.points
  const pb = b.points
  const h1 = { x: pa[pa.length - 1].x - pa[Math.max(0, pa.length - 2)].x, z: pa[pa.length - 1].z - pa[Math.max(0, pa.length - 2)].z }
  const h2 = { x: pb[Math.min(pb.length - 1, 1)].x - pb[0].x, z: pb[Math.min(pb.length - 1, 1)].z - pb[0].z }
  return Math.atan2(h1.x * h2.z - h1.z * h2.x, h1.x * h2.x + h1.z * h2.z)
}

/** Turn direction from edge a into edge b: -1 left, 0 straight, 1 right (right-hand traffic, +X east, −Z north). */
export function turnDirection(a: NetEdge, b: NetEdge): -1 | 0 | 1 {
  const pa = a.points
  const pb = b.points
  const h1 = { x: pa[pa.length - 1].x - pa[Math.max(0, pa.length - 2)].x, z: pa[pa.length - 1].z - pa[Math.max(0, pa.length - 2)].z }
  const h2 = { x: pb[Math.min(pb.length - 1, 1)].x - pb[0].x, z: pb[Math.min(pb.length - 1, 1)].z - pb[0].z }
  const cross = h1.x * h2.z - h1.z * h2.x
  const dot = h1.x * h2.x + h1.z * h2.z
  const ang = Math.atan2(cross, dot) // >0 = clockwise seen from above = right turn in this frame
  if (Math.abs(ang) < Math.PI / 6) return 0
  return ang > 0 ? 1 : -1
}
