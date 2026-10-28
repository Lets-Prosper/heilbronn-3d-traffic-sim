// Ribbon geometry for smart-mode detection zones: the stretch of each approach road
// (stop line -> `metres` upstream) that the max-pressure controller counts.
// Pure math (no Three.js) so it can be unit-tested.
import type { Network } from '../engine/network/types'
import { LANE_WIDTH, laneOffset, offsetPolyline, slicePolyline, type RoadLayout } from './layout'

export interface ZoneMesh {
  /** xyz per vertex (y = 0; lifted by the renderer). */
  positions: Float32Array
  /** Fade factor per vertex: 1 at the stop line -> 0 at the far end. */
  fade: Float32Array
  indices: number[]
}

/** Follow the approach upstream (preferring the same street) and build a fading ribbon over its lanes. */
export function buildZoneMesh(net: Network, layout: RoadLayout, edge: number, metres: number): ZoneMesh {
  const pos: number[] = []
  const fade: number[] = []
  const idx: number[] = []
  let e = net.edges[edge]
  let fromStop = 0 // distance from the stop line to the downstream end of `e`
  for (let depth = 0; depth < 6 && fromStop < metres; depth++) {
    const len = e.length
    const s0 = Math.max(0, len - (metres - fromStop))
    const pts = slicePolyline(e.points, s0, len)
    if (pts.length >= 2) {
      const mid = (laneOffset(layout, e, 0) + laneOffset(layout, e, e.lanes - 1)) / 2
      const w = e.lanes * LANE_WIDTH
      const l = offsetPolyline(pts, mid - w / 2)
      const r = offsetPolyline(pts, mid + w / 2)
      // Arc length from each point to this edge's end.
      const toEnd: number[] = new Array(pts.length).fill(0)
      for (let i = pts.length - 2; i >= 0; i--) {
        toEnd[i] = toEnd[i + 1] + Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z)
      }
      const base = pos.length / 3
      for (let i = 0; i < pts.length; i++) {
        const f = Math.max(0, 1 - (fromStop + toEnd[i]) / metres)
        pos.push(l[i].x, 0, l[i].z, r[i].x, 0, r[i].z)
        fade.push(f, f)
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = base + i * 2
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
    fromStop += len
    const preds = net.nodes.get(e.from)!.in.map((i) => net.edges[i]).filter((p) => !(p.from === e.to && p.wayId === e.wayId))
    const next = preds.find((p) => p.name === e.name) ?? preds[0]
    if (!next) break
    e = next
  }
  return { positions: new Float32Array(pos), fade: new Float32Array(fade), indices: idx }
}
