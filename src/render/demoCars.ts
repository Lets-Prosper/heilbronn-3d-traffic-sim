// Static placeholder cars for verifying the look (replaced by engine vehicles later).
import { polylineLength } from '../engine/network/geo'
import type { Network } from '../engine/network/types'
import { createRng } from '../engine/rng'
import { laneOffset, samplePolyline, type RoadLayout } from './layout'

export interface CarPose {
  x: number
  z: number
  /** Unit travel direction. */
  dx: number
  dz: number
  color: string
}

export const CAR_COLORS = ['#e8e6e1', '#2f3542', '#c0392b', '#2e86de', '#95a5a6', '#f5f6fa', '#27ae60', '#e1b12c', '#40407a', '#b33939']

const SPACING = 7

/** `target` (optional) pads with random cars up to that count, for instancing stress tests. */
export function demoCars(net: Network, layout: RoadLayout, seed = 7, target = 0): CarPose[] {
  const rng = createRng(seed)
  const color = () => CAR_COLORS[Math.floor(rng.next() * CAR_COLORS.length)]
  const cars: CarPose[] = []

  // Queues waiting at each signal approach.
  for (const n of net.nodes.values()) {
    if (!n.signal) continue
    for (const i of n.in) {
      const e = net.edges[i]
      const len = polylineLength(e.points)
      for (let lane = 0; lane < e.lanes; lane++) {
        const q = Math.floor(rng.next() * 5)
        for (let k = 0; k < q; k++) {
          const s = len - 4.5 - k * SPACING
          if (s < 3) break
          cars.push({ ...samplePolyline(e.points, s, laneOffset(layout, e, lane)), color: color() })
        }
      }
    }
  }

  // A sprinkling of free-flowing cars elsewhere.
  for (const e of net.edges) {
    const len = polylineLength(e.points)
    if (len < 40 || rng.next() > 0.35) continue
    const s = 15 + rng.next() * (len - 30)
    const lane = Math.floor(rng.next() * e.lanes)
    cars.push({ ...samplePolyline(e.points, s, laneOffset(layout, e, lane)), color: color() })
  }

  while (cars.length < target) {
    const e = net.edges[Math.floor(rng.next() * net.edges.length)]
    const s = rng.next() * polylineLength(e.points)
    const lane = Math.floor(rng.next() * e.lanes)
    cars.push({ ...samplePolyline(e.points, s, laneOffset(layout, e, lane)), color: color() })
  }
  return cars
}
