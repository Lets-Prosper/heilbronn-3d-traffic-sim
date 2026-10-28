// Vehicle state. Pure TS only (no React/Three/DOM).
import type { IdmParams } from '../models'

export type VehicleKind = 'car' | 'bus' | 'emergency'

export interface KindProfile {
  /** Overrides on top of the car IDM parameters. */
  idm: Partial<IdmParams>
  /** Desired speed = speedLimit × this (cars: random 0.9–1.1). */
  v0Factor?: number
  /** Proceeds through red/amber (blue lights + siren). Still can't pass the car ahead in its lane. */
  ignoresSignals: boolean
}

export const KIND_PROFILES: Record<VehicleKind, KindProfile> = {
  car: { idm: {}, ignoresSignals: false },
  // 12 m city bus: slower to accelerate, longer headway.
  bus: { idm: { a: 1.0, b: 1.5, T: 1.5, length: 12 }, v0Factor: 0.9, ignoresSignals: false },
  // Ambulance / fire car on an emergency run: drives ~30% over the limit, brisk acceleration.
  emergency: { idm: { a: 2.5, b: 3.0, T: 1.0, length: 6 }, v0Factor: 1.3, ignoresSignals: true },
}

export interface Vehicle {
  id: number
  kind: VehicleKind
  /** Bumper-to-bumper length, m. */
  length: number
  /** Optional label (e.g. dispatch ticket) to match the same vehicle across A/B sims. */
  tag?: string
  /** Edge indices from entry to exit, inclusive. */
  route: number[]
  /** Index into `route` of the current edge. */
  ri: number
  edge: number
  lane: number
  /** Lane on the previous route edge (-1 at spawn) — the rear overhangs into it right after a node. */
  prevLane: number
  /** Front bumper, metres from the start of `edge`. */
  pos: number
  speed: number
  accel: number
  /** Desired speed = speedLimit * v0Factor (driver variance). */
  v0Factor: number
  spawnTime: number
  /** Unimpeded travel time of the whole route at the desired speed, s (for delay). */
  freeFlow: number
  /** Seconds spent stopped so far. */
  wait: number
  /** Has been above MOVING_SPEED since its last stop (a new stop counts only after real motion). */
  moving: boolean
  /** Highest speed since the last stop, m/s (sets the re-acceleration energy of the next stop). */
  vPeak: number
}
