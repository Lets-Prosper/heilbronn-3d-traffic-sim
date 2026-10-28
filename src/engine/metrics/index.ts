// Metrics accumulator. Pure TS only (no React/Three/DOM).

/** Below this speed a vehicle counts as stopped (queued / idling), m/s. */
export const STOPPED_SPEED = 0.5
/** A vehicle must exceed this before its next drop below STOPPED_SPEED counts as a new stop, m/s. */
export const MOVING_SPEED = 2

export interface CompletedTrip {
  id: number
  entry: number
  exit: number
  /** Seconds spent stopped. */
  wait: number
  /** Seconds from spawn to exit. */
  travel: number
}

export interface MetricsSnapshot {
  time: number
  spawned: number
  exited: number
  active: number
  /** Vehicles waiting to enter a full entry edge. */
  backlog: number
  /** Exited vehicles per simulated hour. */
  throughputPerHour: number
  /** Mean / max stopped time per exited vehicle, s. */
  meanWait: number
  maxWait: number
  meanTravel: number
  /** Time-averaged number of stopped vehicles in the network. */
  meanQueue: number
  maxQueue: number
  /** Stopped vehicles right now. */
  queueNow: number
  /** Mean stopped vehicles over the last RECENT_WINDOW_S seconds (tracks mode switches). */
  queueRecent: number
  /** Total stopped vehicle-seconds, all vehicles (exited + active). */
  totalIdle: number
  /** Stop events (moving -> stopped), all vehicles. */
  stops: number
  /** Σ vPeak² over stops, m²/s² — re-acceleration kinetic energy per unit mass ×2. */
  stopV2Sum: number
}

/** Window for `queueRecent`, s. */
export const RECENT_WINDOW_S = 60

export function createMetrics(tickHz = 10) {
  const trips: CompletedTrip[] = []
  const ring = new Float64Array(RECENT_WINDOW_S * tickHz)
  let ringSum = 0
  let last = 0
  let spawned = 0
  let samples = 0
  let queueSum = 0
  let maxQueue = 0
  let totalIdle = 0
  let stops = 0
  let stopV2Sum = 0

  return {
    trips: trips as readonly CompletedTrip[],
    recordSpawn() {
      spawned++
    },
    recordStop(vPeak: number) {
      stops++
      stopV2Sum += vPeak * vPeak
    },
    recordExit(trip: CompletedTrip) {
      trips.push(trip)
    },
    /** Once per tick: number of stopped vehicles, tick length. */
    sample(stopped: number, dt: number) {
      const slot = samples % ring.length
      ringSum += stopped - ring[slot]
      ring[slot] = stopped
      last = stopped
      samples++
      queueSum += stopped
      if (stopped > maxQueue) maxQueue = stopped
      totalIdle += stopped * dt
    },
    snapshot(time: number, active: number, backlog: number): MetricsSnapshot {
      const n = trips.length
      let w = 0
      let wMax = 0
      let tr = 0
      for (const t of trips) {
        w += t.wait
        tr += t.travel
        if (t.wait > wMax) wMax = t.wait
      }
      return {
        time,
        spawned,
        exited: n,
        active,
        backlog,
        throughputPerHour: time > 0 ? (n / time) * 3600 : 0,
        meanWait: n ? w / n : 0,
        maxWait: wMax,
        meanTravel: n ? tr / n : 0,
        meanQueue: samples ? queueSum / samples : 0,
        maxQueue,
        queueNow: last,
        queueRecent: samples ? ringSum / Math.min(samples, ring.length) : 0,
        totalIdle,
        stops,
        stopV2Sum,
      }
    },
  }
}

export type Metrics = ReturnType<typeof createMetrics>
