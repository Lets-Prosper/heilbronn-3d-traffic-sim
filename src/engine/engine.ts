// Pure simulation engine. MUST NOT import React, Three.js, or any DOM API.
//
// Deterministic: fixed 10 Hz tick, all randomness from one seeded RNG consumed
// in a fixed order, all iteration over arrays / insertion-ordered Maps.
// Car-following is IDM (see models/) — continuous, not cellular.
import {
  buildIntersections,
  createFixedCycleController,
  createMaxPressureController,
  type ControllerMode,
  type FixedCycleConfig,
  type Intersection,
  type MaxPressureConfig,
  type SignalController,
  type TrafficView,
} from './controllers'
import { createMetrics, MOVING_SPEED, STOPPED_SPEED, type Metrics, type MetricsSnapshot } from './metrics'
import { DEFAULT_IDM, idmAccel, integrate, type IdmParams } from './models'
import { entryEdges, exitEdges, pathTo, shortestPathTree, type PathTree } from './network/routing'
import type { Network } from './network/types'
import { createRng, type Rng } from './rng'
import type { Vehicle } from './vehicles'

/** Fixed timestep: 10 Hz. */
export const TICK_HZ = 10
export const DT = 1 / TICK_HZ

/** Default spawn rate per entry edge, veh/s (≈ 180 veh/h). */
export const DEFAULT_INFLOW = 0.05
/** How far ahead (m) a lane leader looks for queues / stop lines on downstream edges. */
const LOOKAHEAD_M = 200
/** Stop this far (m) before the signal node. */
const STOP_LINE_SETBACK = 0.5
/** Above this required deceleration (m/s²) a driver facing amber/red is committed and proceeds. */
const COMMIT_DECEL = 4.5
/** Desired speed = speedLimit * U(1 - x, 1 + x). */
const V0_SPREAD = 0.1

export interface EntryFlow {
  edge: number
  /** veh/s, Poisson arrivals. */
  rate: number
  /** Fixed route starting at `edge` (calibrated movements). Default: shortest path to a random exit. */
  route?: number[]
  /** Free-form label (e.g. detector id) for reporting. */
  tag?: string
}

/** An arrival waiting for space on its entry edge. Drawn at arrival time so demand is controller-independent. */
interface Pending {
  route: number[] | null
  v0Factor: number
}

export interface SimConfig {
  seed: number
  network?: Network
  /** Per-entry flows. Default: every boundary entry edge at `inflow`. */
  entries?: EntryFlow[]
  /** veh/s for each default entry. */
  inflow?: number
  /** Signal control: 'fixed' (Mode A, default) or 'maxPressure' (Mode B). */
  mode?: ControllerMode
  signals?: Partial<FixedCycleConfig>
  maxPressure?: Partial<MaxPressureConfig>
  driver?: Partial<IdmParams>
}

export interface SimState {
  tick: number
  /** Simulated seconds elapsed (tick * DT). */
  time: number
  /** Active vehicles by id, in spawn order. */
  vehicles: Map<number, Vehicle>
  /** Arrivals per entry (same order as `entries`) still waiting for space to enter. */
  backlog: Pending[][]
}

export interface Sim {
  readonly config: SimConfig
  readonly state: SimState
  readonly network: Network
  readonly entries: readonly EntryFlow[]
  readonly intersections: readonly Intersection[]
  readonly signals: SignalController
  readonly mode: ControllerMode
  /** Hot-swap the signal controller; vehicles and demand stream are untouched. */
  setMode(mode: ControllerMode): void
  readonly metrics: Metrics
  /** Vehicles currently on an edge, all lanes. */
  edgeCount(edge: number): number
  step(): void
  /** Advance `seconds` of sim time (whole ticks). */
  run(seconds: number): void
  snapshot(): MetricsSnapshot
}

/** Stopped vehicles on each intersection's approach edges (same order as sim.intersections). */
export function approachQueues(sim: Sim): number[] {
  const edgeTo = new Map<number, number>()
  sim.intersections.forEach((x, i) => x.approaches.forEach((a) => edgeTo.set(a.edge, i)))
  const q = sim.intersections.map(() => 0)
  for (const v of sim.state.vehicles.values()) {
    const i = edgeTo.get(v.edge)
    if (i !== undefined && v.speed < STOPPED_SPEED) q[i]++
  }
  return q
}

const EMPTY_NETWORK: Network = {
  origin: { lat: 0, lon: 0 },
  bbox: { south: 0, west: 0, north: 0, east: 0 },
  nodes: new Map(),
  edges: [],
}

export function createSim(config: SimConfig): Sim {
  const rng: Rng = createRng(config.seed)
  const net = config.network ?? EMPTY_NETWORK
  const idm: IdmParams = { ...DEFAULT_IDM, ...config.driver }
  const intersections = buildIntersections(net)
  const metrics = createMetrics(TICK_HZ)
  const entries: EntryFlow[] =
    config.entries ?? entryEdges(net).map((edge) => ({ edge, rate: config.inflow ?? DEFAULT_INFLOW }))
  const exits = exitEdges(net)
  const state: SimState = { tick: 0, time: 0, vehicles: new Map(), backlog: entries.map(() => []) }

  // lanes[edge][lane] = vehicles ordered front (largest pos) -> back.
  const lanes: Vehicle[][][] = net.edges.map((e) => Array.from({ length: Math.max(1, e.lanes) }, () => []))
  let nextId = 1

  const edgeCount = (edge: number) => {
    let n = 0
    for (const l of lanes[edge]) n += l.length
    return n
  }
  const view: TrafficView = { count: edgeCount, lanes: (edge) => lanes[edge].length }

  const makeController = (mode: ControllerMode, prev?: SignalController): SignalController =>
    mode === 'maxPressure'
      ? createMaxPressureController(net, config.maxPressure, intersections, config.signals, prev && {
          // Continue from whatever phase the previous controller was showing.
          phaseOf: (x) => {
            for (const g of x.groups) {
              const a = x.approaches.find((ap) => ap.group === g)!
              if (prev.aspect(a.node, a.edge) !== 'red') return g
            }
            return null
          },
        })
      : createFixedCycleController(net, config.signals, intersections)
  let signals = makeController(config.mode ?? 'fixed')

  // Per entry: shortest-path tree + exits reachable without leaving via the entry's own boundary node.
  const routing = new Map<number, { tree: PathTree; exits: number[] }>()
  const routingFor = (entry: number) => {
    let r = routing.get(entry)
    if (!r) {
      const tree = shortestPathTree(net, entry)
      const back = net.edges[entry].from
      r = { tree, exits: exits.filter((x) => tree.cost[x] < Infinity && net.edges[x].to !== back) }
      routing.set(entry, r)
    }
    return r
  }

  const tail = (lane: Vehicle[]) => lane[lane.length - 1] as Vehicle | undefined
  /** Lane with the most free space at its start (lowest index on ties). */
  const bestLane = (edge: number): number => {
    const ls = lanes[edge]
    let best = 0
    let room = -Infinity
    for (let i = 0; i < ls.length; i++) {
      const t = tail(ls[i])
      const r = t ? t.pos - idm.length : Infinity
      if (r > room) {
        room = r
        best = i
      }
    }
    return best
  }

  /** Nearest obstacle ahead of a lane leader: queue tail or non-green stop line on its route. */
  const lookahead = (v: Vehicle): { gap: number; vLead: number } => {
    let dist = net.edges[v.edge].length - v.pos
    for (let ri = v.ri; ri < v.route.length - 1; ri++) {
      const e = net.edges[v.route[ri]]
      if (signals.aspect(e.to, e.index) !== 'green') {
        const d = Math.max(dist - STOP_LINE_SETBACK, 0.01)
        if ((v.speed * v.speed) / (2 * d) <= COMMIT_DECEL) return { gap: d, vLead: 0 }
      }
      const next = v.route[ri + 1]
      const t = tail(lanes[next][bestLane(next)])
      if (t) return { gap: dist + t.pos - idm.length, vLead: t.speed }
      dist += net.edges[next].length
      if (dist > LOOKAHEAD_M) break
    }
    return { gap: Infinity, vLead: 0 }
  }

  /** Draw an arrival's route + driver now (fixed RNG order, independent of signal control). */
  const arrive = (i: number): Pending => {
    const f = entries[i]
    let route: number[] | null = f.route ?? null
    if (!route) {
      const { tree, exits: reachable } = routingFor(f.edge)
      const u = rng.next()
      route = reachable.length ? pathTo(tree, reachable[Math.floor(u * reachable.length)])! : null
    }
    return { route, v0Factor: 1 - V0_SPREAD + 2 * V0_SPREAD * rng.next() }
  }

  /** Place the head of entry i's backlog on the network if there's room. */
  const spawn = (i: number): boolean => {
    const { edge } = entries[i]
    const p = state.backlog[i][0]
    if (!p.route) return true // nowhere to go: drop the arrival
    const lane = bestLane(edge)
    const t = tail(lanes[edge][lane])
    const limit = net.edges[edge].speedLimit
    const speed = (t ? Math.min(t.speed, limit) : limit) * Math.min(1, p.v0Factor)
    if (t && t.pos - idm.length < idm.s0 + speed * idm.T) return false
    const v: Vehicle = {
      id: nextId++, route: p.route, ri: 0, edge, lane,
      pos: 0, speed, accel: 0, v0Factor: p.v0Factor, spawnTime: state.time, wait: 0,
      moving: speed > MOVING_SPEED, vPeak: speed,
    }
    lanes[edge][lane].push(v)
    state.vehicles.set(v.id, v)
    metrics.recordSpawn()
    return true
  }

  const step = () => {
    signals.update(state.time, view)

    // 1. Accelerations from the current state (parallel update: order-independent).
    for (const e of net.edges) {
      for (const lane of lanes[e.index]) {
        for (let k = 0; k < lane.length; k++) {
          const v = lane[k]
          const v0 = e.speedLimit * v.v0Factor
          let gap: number
          let vLead: number
          if (k > 0) {
            gap = lane[k - 1].pos - idm.length - v.pos
            vLead = lane[k - 1].speed
          } else {
            ;({ gap, vLead } = lookahead(v))
          }
          v.accel = idmAccel(idm, v.speed, v0, gap, v.speed - vLead)
        }
      }
    }

    // 2. Integrate; collect vehicles that crossed their edge end (front of lane, in edge order).
    const movers: Vehicle[] = []
    for (const e of net.edges) {
      for (const lane of lanes[e.index]) {
        for (const v of lane) {
          const [speed, dx] = integrate(v.speed, v.accel, DT)
          v.speed = speed
          v.pos += dx
        }
        while (lane.length && lane[0].pos >= e.length) movers.push(lane.shift()!)
      }
    }

    // 3. Edge transitions / exits.
    const touched = new Set<Vehicle[]>()
    for (const v of movers) {
      while (v.pos >= net.edges[v.edge].length && v.ri < v.route.length - 1) {
        v.pos -= net.edges[v.edge].length
        v.ri++
        v.edge = v.route[v.ri]
      }
      if (v.pos >= net.edges[v.edge].length) {
        state.vehicles.delete(v.id)
        metrics.recordExit({
          id: v.id, entry: v.route[0], exit: v.edge, wait: v.wait, travel: state.time + DT - v.spawnTime,
        })
        continue
      }
      v.lane = bestLane(v.edge)
      const lane = lanes[v.edge][v.lane]
      lane.push(v)
      touched.add(lane)
    }
    for (const lane of touched) lane.sort((a, b) => b.pos - a.pos) // stable: merges in the same tick

    // 4. Arrivals (Poisson via Bernoulli per tick), then drain backlog into free entry space.
    for (let i = 0; i < entries.length; i++) {
      if (rng.next() < entries[i].rate * DT) state.backlog[i].push(arrive(i))
      while (state.backlog[i].length && spawn(i)) state.backlog[i].shift()
    }

    // 5. Metrics.
    let stopped = 0
    for (const v of state.vehicles.values()) {
      if (v.speed > v.vPeak) v.vPeak = v.speed
      if (v.speed > MOVING_SPEED) v.moving = true
      if (v.speed < STOPPED_SPEED) {
        v.wait += DT
        stopped++
        if (v.moving) {
          metrics.recordStop(v.vPeak)
          v.moving = false
          v.vPeak = 0
        }
      }
    }
    metrics.sample(stopped, DT)

    state.tick += 1
    state.time = state.tick * DT
  }

  return {
    config,
    state,
    network: net,
    entries,
    intersections,
    get signals() {
      return signals
    },
    get mode() {
      return signals.mode
    },
    setMode(mode: ControllerMode) {
      if (mode !== signals.mode) signals = makeController(mode, signals)
    },
    metrics,
    edgeCount,
    step,
    run(seconds: number) {
      const n = Math.round(seconds * TICK_HZ)
      for (let i = 0; i < n; i++) step()
    },
    snapshot: () =>
      metrics.snapshot(state.time, state.vehicles.size, state.backlog.reduce((s, b) => s + b.length, 0)),
  }
}
