// Engine vehicle state -> world poses, plus sim/render interpolation. Pure math (no Three.js).
import type { Sim } from '../engine/engine'
import { STOPPED_SPEED } from '../engine/metrics'
import type { VehicleKind } from '../engine/vehicles'
import type { SignalAspect } from '../engine/controllers'
import type { Network } from '../engine/network/types'
import { laneOffset, samplePolyline, type RoadLayout } from './layout'
import type { SignalState } from './signals'

export interface Pose {
  x: number
  z: number
  /** Yaw about +Y, radians (matches the car mesh: atan2(-dz, dx)). */
  yaw: number
  /** Stopped (queued) — drives brake lights. */
  stopped: boolean
  kind: VehicleKind
}

/** One published engine tick: pose per vehicle id. */
export type VehicleFrame = Map<number, Pose>

/** Lane changes (which happen at nodes in the engine) are drawn as a sideways glide over this distance, m. */
const LANE_SHIFT_M = 5

const smoothstep = (t: number) => t * t * (3 - 2 * t)

/**
 * World pose of every vehicle. Engine positions are the front bumper and vehicle meshes are
 * centred, so the centre is placed `length/2` back along the route — onto the previous edge
 * when the vehicle has only just crossed a node (otherwise long vehicles on short edges jump).
 *
 * Lateral position glides from the previous lane to the new one over the first LANE_SHIFT_M
 * of the new edge. It depends only on position along the road, so vehicles side by side shift
 * together and never slide into each other.
 */
export function projectVehicles(sim: Sim, net: Network, layout: RoadLayout): VehicleFrame {
  const out: VehicleFrame = new Map()
  for (const v of sim.state.vehicles.values()) {
    let ri = v.ri
    let e = net.edges[v.edge]
    let s = v.pos - v.length / 2
    while (s < 0 && ri > 0) {
      ri--
      e = net.edges[v.route[ri]]
      s += e.length
    }
    s = Math.max(0, s)
    const cur = net.edges[v.edge]
    let off = laneOffset(layout, cur, Math.min(v.lane, Math.max(1, cur.lanes) - 1))
    if (v.ri > 0 && v.prevLane >= 0) {
      const prev = net.edges[v.route[v.ri - 1]]
      const from = laneOffset(layout, prev, Math.min(v.prevLane, Math.max(1, prev.lanes) - 1))
      const t = smoothstep(Math.min(1, Math.max(0, v.pos / Math.min(LANE_SHIFT_M, cur.length))))
      off = from + (off - from) * t
    }
    const p = samplePolyline(e.points, s, off)
    out.set(v.id, { x: p.x, z: p.z, yaw: Math.atan2(-p.dz, p.dx), stopped: v.speed < STOPPED_SPEED, kind: v.kind })
  }
  return out
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return a + d * t
}

/**
 * Pose between the previous and current tick. `alpha` ∈ [0, 1) is the fraction of
 * a tick accumulated since `curr`. Vehicles new this tick appear at `curr`.
 */
export function interpolate(prev: VehicleFrame, curr: Pose, id: number, alpha: number): Pose {
  const p = prev.get(id)
  if (!p) return curr
  // A jump of > 15 m in one tick is an edge re-projection artifact, not motion: snap.
  if (Math.hypot(curr.x - p.x, curr.z - p.z) > 15) return curr
  return { x: p.x + (curr.x - p.x) * alpha, z: p.z + (curr.z - p.z) * alpha, yaw: lerpAngle(p.yaw, curr.yaw, alpha), stopped: curr.stopped, kind: curr.kind }
}

export const toLamp = (a: SignalAspect): SignalState => (a === 'amber' ? 'yellow' : a)
