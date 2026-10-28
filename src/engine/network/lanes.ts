// Lane lateral positions, shared by the engine (lane choice, conflicts) and matching
// render/layout's laneOffset: right-hand traffic; on a two-way road a direction's
// lanes sit right of the centreline, on a one-way road they are centred on it.
// Lane 0 is the innermost (leftmost) lane. Pure TS only.
import type { Network } from './types'

export const LANE_WIDTH_M = 3.2

export function createLaneGeometry(net: Network) {
  const byKey = new Set(net.edges.map((e) => `${e.wayId}:${e.from}:${e.to}`))
  const twoWay = net.edges.map((e) => byKey.has(`${e.wayId}:${e.to}:${e.from}`))
  /** Offset of lane `lane` of edge `edge` to the right of its centreline, m (fractional lanes ok). */
  const lateral = (edge: number, lane: number) => {
    const e = net.edges[edge]
    const base = twoWay[edge] ? 0 : (-e.lanes * LANE_WIDTH_M) / 2
    return base + (lane + 0.5) * LANE_WIDTH_M
  }
  /** Lane of `toEdge` whose position is closest to `lane` of `fromEdge` (straight-on continuation). */
  const continueLane = (fromEdge: number, lane: number, toEdge: number) => {
    const x = lateral(fromEdge, lane)
    const n = Math.max(1, net.edges[toEdge].lanes)
    let best = 0
    for (let l = 1; l < n; l++) if (Math.abs(lateral(toEdge, l) - x) < Math.abs(lateral(toEdge, best) - x)) best = l
    return best
  }
  return { lateral, continueLane }
}
