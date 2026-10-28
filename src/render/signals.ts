import type { Network } from '../engine/network/types'
import { curbOffset, LANE_WIDTH, laneOffset, rightOf, type RoadLayout } from './layout'

export type SignalState = 'red' | 'yellow' | 'green'

export interface SignalHead {
  key: string
  nodeId: number
  edgeIndex: number
  x: number
  z: number
  rotY: number
  /** Stop bar across the approach lanes, just before the stop line. */
  bar: { x: number; z: number; width: number }
}

/**
 * One signal head per approach (incoming edge) at each signal node, on the right-hand curb.
 * `only` restricts heads to controlled approaches (keys `${node}:${edge}`).
 */
export function signalHeads(network: Network, layout: RoadLayout, only?: Set<string>): SignalHead[] {
  const heads: SignalHead[] = []
  for (const n of network.nodes.values()) {
    if (!n.signal) continue
    for (const i of n.in) {
      if (only && !only.has(`${n.id}:${i}`)) continue
      const e = network.edges[i]
      const p = e.points
      const a = p[p.length - 2]
      const b = p[p.length - 1]
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1
      const dx = (b.x - a.x) / len
      const dz = (b.z - a.z) / len
      const r = rightOf(dx, dz)
      const off = curbOffset(layout, e) + 0.8
      // Lamps sit on local +Z; rotate so they face oncoming drivers (-d).
      // Bar centred across this direction's lanes, 2.5 m back from the node (engine stops ~2.5 m short).
      const mid = (laneOffset(layout, e, 0) + laneOffset(layout, e, e.lanes - 1)) / 2
      const bar = { x: b.x - dx * 1.2 + r.x * mid, z: b.z - dz * 1.2 + r.z * mid, width: e.lanes * LANE_WIDTH }
      heads.push({ key: `${n.id}:${i}`, nodeId: n.id, edgeIndex: i, x: b.x + r.x * off, z: b.z + r.z * off, rotY: Math.atan2(-dx, -dz), bar })
    }
  }
  return heads
}
