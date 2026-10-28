// Road cross-section layout derived from the engine network. Pure math (no
// Three.js) so it can be unit-tested and reused for car placement.
import type { XZ } from '../engine/network/geo'
import type { NetEdge, Network } from '../engine/network/types'

export const LANE_WIDTH = 3.2
export const SIDEWALK_WIDTH = 2.5

/** One drawable road: an undirected OSM way segment (a directed edge plus its reverse twin, if any). */
export interface RoadSegment {
  edge: NetEdge // forward edge; points define the centerline
  twin?: NetEdge // reverse direction on the same way, if two-way
  width: number
}

export interface RoadLayout {
  roads: RoadSegment[]
  twinOf: Map<number, NetEdge>
  /** Half-width of the widest road touching each node (for junction fills / trimming). */
  nodeRadius: Map<number, number>
}

export function buildRoadLayout(net: Network): RoadLayout {
  const byKey = new Map<string, NetEdge>()
  for (const e of net.edges) byKey.set(`${e.wayId}:${e.from}:${e.to}`, e)

  const twinOf = new Map<number, NetEdge>()
  const roads: RoadSegment[] = []
  for (const e of net.edges) {
    const twin = byKey.get(`${e.wayId}:${e.to}:${e.from}`)
    if (twin && twin !== e) twinOf.set(e.index, twin)
    if (twin && twin.index < e.index) continue // drawn with its twin
    roads.push({ edge: e, twin, width: (e.lanes + (twin?.lanes ?? 0)) * LANE_WIDTH })
  }

  const nodeRadius = new Map<number, number>()
  for (const r of roads) {
    for (const id of [r.edge.from, r.edge.to]) nodeRadius.set(id, Math.max(nodeRadius.get(id) ?? 0, r.width / 2))
  }
  return { roads, twinOf, nodeRadius }
}

/** Total paved width of the road an edge belongs to. */
export function roadWidth(layout: RoadLayout, e: NetEdge): number {
  return (e.lanes + (layout.twinOf.get(e.index)?.lanes ?? 0)) * LANE_WIDTH
}

/**
 * Lateral offset (to the right of travel direction) of lane `lane` of edge `e`.
 * Lane 0 is the innermost (leftmost) lane. Right-hand traffic.
 */
export function laneOffset(layout: RoadLayout, e: NetEdge, lane: number): number {
  const twoWay = layout.twinOf.has(e.index)
  const base = twoWay ? 0 : -roadWidth(layout, e) / 2
  return base + (lane + 0.5) * LANE_WIDTH
}

/** Offset of the right-hand curb relative to the edge centerline. */
export function curbOffset(layout: RoadLayout, e: NetEdge): number {
  return layout.twinOf.has(e.index) ? e.lanes * LANE_WIDTH : roadWidth(layout, e) / 2
}

/** Right-hand unit normal of direction (dx, dz) in our XZ convention (+X east, -Z north). */
export function rightOf(dx: number, dz: number): XZ {
  return { x: -dz, z: dx }
}

/** Position and heading at arc length `s` along a polyline, shifted `offset` to the right. */
export function samplePolyline(pts: XZ[], s: number, offset = 0): { x: number; z: number; dx: number; dz: number } {
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    if (len === 0) continue
    if (acc + len >= s || i === pts.length - 1) {
      const t = Math.min(1, Math.max(0, (s - acc) / len))
      const dx = (b.x - a.x) / len
      const dz = (b.z - a.z) / len
      const r = rightOf(dx, dz)
      return { x: a.x + (b.x - a.x) * t + r.x * offset, z: a.z + (b.z - a.z) * t + r.z * offset, dx, dz }
    }
    acc += len
  }
  const p = pts[0]
  return { x: p.x, z: p.z, dx: 1, dz: 0 }
}

/** Polyline offset to the right by `offset`, with clamped miter joins. */
export function offsetPolyline(pts: XZ[], offset: number): XZ[] {
  if (offset === 0) return pts
  const out: XZ[] = []
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)]
    const next = pts[Math.min(pts.length - 1, i + 1)]
    const a = i > 0 ? dir(prev, pts[i]) : dir(pts[i], next)
    const b = i < pts.length - 1 ? dir(pts[i], next) : a
    const n1 = rightOf(a.x, a.z)
    const n2 = rightOf(b.x, b.z)
    let mx = n1.x + n2.x
    let mz = n1.z + n2.z
    const ml = Math.hypot(mx, mz)
    if (ml < 1e-6) {
      mx = n1.x
      mz = n1.z
    } else {
      mx /= ml
      mz /= ml
    }
    const cos = mx * n1.x + mz * n1.z
    const scale = Math.min(2, 1 / Math.max(cos, 0.5))
    out.push({ x: pts[i].x + mx * offset * scale, z: pts[i].z + mz * offset * scale })
  }
  return out
}

function dir(a: XZ, b: XZ): XZ {
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l }
}

/** Sub-polyline between arc lengths s0..s1. */
export function slicePolyline(pts: XZ[], s0: number, s1: number): XZ[] {
  const out: XZ[] = []
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    const segStart = acc
    const segEnd = acc + len
    acc = segEnd
    if (segEnd < s0 || segStart > s1 || len === 0) continue
    const lerp = (s: number): XZ => {
      const t = (s - segStart) / len
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }
    }
    if (out.length === 0) out.push(lerp(Math.max(s0, segStart)))
    out.push(lerp(Math.min(s1, segEnd)))
  }
  return out
}
