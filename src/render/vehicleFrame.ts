// Engine vehicle state -> world poses, plus sim/render interpolation. Pure math (no Three.js).
import type { Sim } from '../engine/engine'
import { STOPPED_SPEED } from '../engine/metrics'
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
}

/** One published engine tick: pose per vehicle id. */
export type VehicleFrame = Map<number, Pose>

/** Engine positions are the front bumper; the car mesh is centred. */
const HALF_CAR = 2.15

export function projectVehicles(sim: Sim, net: Network, layout: RoadLayout): VehicleFrame {
  const out: VehicleFrame = new Map()
  for (const v of sim.state.vehicles.values()) {
    const e = net.edges[v.edge]
    const p = samplePolyline(e.points, Math.max(0, v.pos - HALF_CAR), laneOffset(layout, e, v.lane))
    out.set(v.id, { x: p.x, z: p.z, yaw: Math.atan2(-p.dz, p.dx), stopped: v.speed < STOPPED_SPEED })
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
  return { x: p.x + (curr.x - p.x) * alpha, z: p.z + (curr.z - p.z) * alpha, yaw: lerpAngle(p.yaw, curr.yaw, alpha), stopped: curr.stopped }
}

export const toLamp = (a: SignalAspect): SignalState => (a === 'amber' ? 'yellow' : a)
