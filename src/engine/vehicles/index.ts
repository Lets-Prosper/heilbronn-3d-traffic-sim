// Vehicle state. Pure TS only (no React/Three/DOM).

export interface Vehicle {
  id: number
  /** Edge indices from entry to exit, inclusive. */
  route: number[]
  /** Index into `route` of the current edge. */
  ri: number
  edge: number
  lane: number
  /** Front bumper, metres from the start of `edge`. */
  pos: number
  speed: number
  accel: number
  /** Desired speed = speedLimit * v0Factor (driver variance). */
  v0Factor: number
  spawnTime: number
  /** Seconds spent stopped so far. */
  wait: number
  /** Has been above MOVING_SPEED since its last stop (a new stop counts only after real motion). */
  moving: boolean
  /** Highest speed since the last stop, m/s (sets the re-acceleration energy of the next stop). */
  vPeak: number
}
