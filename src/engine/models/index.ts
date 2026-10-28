// Car-following: Intelligent Driver Model (Treiber, Hennecke & Helbing 2000).
//
// Chosen over Nagel–Schreckenberg: the engine ticks at a fixed 10 Hz and OSM
// edges have arbitrary lengths (many are shorter than one 7.5 m NaSch cell), so
// a continuous model avoids cell discretization and gives smooth positions for
// rendering. Pure TS only (no React/Three/DOM).

export interface IdmParams {
  /** Max acceleration, m/s². */
  a: number
  /** Comfortable deceleration, m/s². */
  b: number
  /** Jam distance (bumper to bumper), m. */
  s0: number
  /** Desired time headway, s. */
  T: number
  /** Acceleration exponent. */
  delta: number
  /** Vehicle length, m. */
  length: number
}

export const DEFAULT_IDM: IdmParams = { a: 1.5, b: 2.0, s0: 2.0, T: 1.2, delta: 4, length: 4.5 }

/** Physical braking limit, m/s². IDM can demand more when a gap closes suddenly. */
export const MAX_DECEL = 9

/**
 * IDM acceleration.
 * @param v own speed, m/s
 * @param v0 desired speed, m/s
 * @param gap bumper-to-obstacle distance, m (Infinity = free road)
 * @param dv approach rate v - vLeader, m/s
 */
export function idmAccel(p: IdmParams, v: number, v0: number, gap: number, dv: number): number {
  const free = 1 - Math.pow(v / v0, p.delta)
  if (gap === Infinity) return p.a * free
  const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)))
  const s = Math.max(gap, 0.1)
  return Math.max(-MAX_DECEL, p.a * (free - (sStar / s) ** 2))
}

/** Ballistic update that never reverses: returns [newSpeed, distanceMoved]. */
export function integrate(v: number, acc: number, dt: number): [number, number] {
  const v1 = v + acc * dt
  if (v1 < 0) return [0, acc < 0 ? (-0.5 * v * v) / acc : 0]
  return [v1, v * dt + 0.5 * acc * dt * dt]
}
