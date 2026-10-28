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
  approachKey,
  type PriorityRequest,
  type SignalController,
  type TrafficView,
  type ZoneReading,
} from './controllers'
import { createMetrics, MOVING_SPEED, STOPPED_SPEED, type Metrics, type MetricsSnapshot } from './metrics'
import { DEFAULT_IDM, idmAccel, integrate, MAX_DECEL, type IdmParams } from './models'
import { createConflictTable, turnAngle, turnDirection } from './network/conflicts'
import { createLaneGeometry } from './network/lanes'
import { entryEdges, exitEdges, pathTo, shortestPathTree, successors, type PathTree } from './network/routing'
import type { Network } from './network/types'
import { createRng, type Rng } from './rng'
import { KIND_PROFILES, type Vehicle, type VehicleKind } from './vehicles'

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
/** A lane leader claims the next node when it is this close in time (s) or distance (m). */
const CLAIM_ETA_S = 2.5
const CLAIM_MIN_M = 8
/** Links shorter than this are treated as inside a junction for "don't block the box", m. */
const BOX_LINK_M = 25
/** Emergency vehicles claim nodes this far out so cross traffic yields to them, m. */
const EMERGENCY_CLAIM_M = 40
/** Vehicles move into the lane for their next turn when it is within this distance, m. */
const TURN_LANE_LOOKAHEAD_M = 120
/** A claim is released once the vehicle's rear is this far past the node, m. */
const CLEAR_M = 2

/** A vehicle's right to pass through a node on one movement (first come, first served). */
interface Claim {
  v: Vehicle
  inE: number
  outE: number
  /** Route index of outE. */
  outRi: number
  /** Lane reserved on outE (sticky: the vehicle enters exactly this lane). */
  outLane: number
  /** Lane on inE when the claim was made. */
  inLane: number
}

/** Pedestrian push-button presses per crossing, per s. ASSUMPTION (no pedestrian counts): one per 90 s. */
export const PED_CALL_RATE = 1 / 90

/** How far ahead (m) priority vehicles are detected by the junction (transponder / camera range). */
export const PRIORITY_RANGE_M: Record<'bus' | 'emergency', number> = { bus: 150, emergency: 250 }

export interface EntryFlow {
  edge: number
  /** veh/s, Poisson arrivals. */
  rate: number
  /** Fixed route starting at `edge` (calibrated movements). Default: shortest path to a random exit. */
  route?: number[]
  /** Free-form label (e.g. detector id) for reporting. */
  tag?: string
  kind?: VehicleKind
  /** Timetabled flow: one arrival every `headway` s starting at `offset` (instead of Poisson `rate`). */
  headway?: number
  offset?: number
}

/** An arrival waiting for space on its entry edge. Drawn at arrival time so demand is controller-independent. */
interface Pending {
  route: number[] | null
  v0Factor: number
  kind: VehicleKind
  tag?: string
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
  /** What the junction detectors currently see (same view the controller gets). */
  readonly view: TrafficView
  /**
   * Inject a vehicle (e.g. an ambulance) at route[0] on the next tick. Uses no RNG, so calling
   * it on both A/B sims at the same sim time keeps them comparable. `tag` labels the trip.
   */
  dispatch(route: number[], kind: VehicleKind, tag?: string): void
  /** Debug/test: current node claims (node -> vehicle id, movement, reserved lane). */
  claims(): { node: number; vehicle: number; inE: number; outE: number; outLane: number }[]
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
  const idmOf: Record<VehicleKind, IdmParams> = {
    car: idm,
    bus: { ...idm, ...KIND_PROFILES.bus.idm },
    emergency: { ...idm, ...KIND_PROFILES.emergency.idm },
  }
  const intersections = buildIntersections(net)
  const metrics = createMetrics(TICK_HZ)
  const entries: EntryFlow[] =
    config.entries ?? entryEdges(net).map((edge) => ({ edge, rate: config.inflow ?? DEFAULT_INFLOW }))
  const exits = exitEdges(net)
  const state: SimState = { tick: 0, time: 0, vehicles: new Map(), backlog: entries.map(() => []) }
  /** Dispatched vehicles waiting to enter their first edge. */
  const dispatched: Pending[] = []
  /** Active buses / emergency vehicles (for priority detection). */
  const special = new Set<Vehicle>()

  // lanes[edge][lane] = vehicles ordered front (largest pos) -> back.
  const lanes: Vehicle[][][] = net.edges.map((e) => Array.from({ length: Math.max(1, e.lanes) }, () => []))
  let nextId = 1

  const edgeCount = (edge: number) => {
    let n = 0
    for (const l of lanes[edge]) n += l.length
    return n
  }
  /** Vehicles on `edge` with pos in [from, to]; moving ones arriving at the edge end within etaS. */
  const countRange = (edge: number, from: number, to: number, etaS: number, endDist: number, out: ZoneReading) => {
    for (const l of lanes[edge]) {
      for (const v of l) {
        if (v.pos < from || v.pos > to) continue
        out.count++
        if (v.speed > MOVING_SPEED && (endDist + net.edges[edge].length - v.pos) / v.speed <= etaS) out.arriving++
      }
    }
  }
  const upstream = (edge: number, metres: number, etaS: number): ZoneReading => {
    const out = { count: 0, arriving: 0 }
    // (edge, metres of zone left at its end, distance from its end to the stop line)
    const stack: [number, number, number, number][] = [[edge, metres, 0, 0]]
    while (stack.length) {
      const [e, left, endDist, depth] = stack.pop()!
      const len = net.edges[e].length
      countRange(e, Math.max(0, len - left), len, etaS, endDist, out)
      if (left <= len || depth >= 4) continue
      const ed = net.edges[e]
      for (const p of net.nodes.get(ed.from)!.in) {
        const pe = net.edges[p]
        if (pe.from === ed.to && pe.wayId === ed.wayId) continue // U-turn twin
        stack.push([p, left - len, endDist + len, depth + 1])
      }
    }
    return out
  }
  const downstream = (edge: number, metres: number): number => {
    let n = 0
    const stack: [number, number, number][] = successors(net, edge).map((s) => [s, metres, 0])
    while (stack.length) {
      const [e, left, depth] = stack.pop()!
      for (const l of lanes[e]) for (const v of l) if (v.pos <= left) n++
      const len = net.edges[e].length
      if (left > len && depth < 3) for (const s of successors(net, e)) stack.push([s, left - len, depth + 1])
    }
    return n
  }
  const approachKeys = new Set(intersections.flatMap((x) => x.approaches.map((a) => a.key)))
  let reqTick = -1
  let reqCache: PriorityRequest[] = []
  const requests = (): PriorityRequest[] => {
    if (reqTick === state.tick) return reqCache
    reqTick = state.tick
    reqCache = []
    for (const v of special) {
      const kind = v.kind as 'bus' | 'emergency'
      let dist = net.edges[v.edge].length - v.pos
      for (let ri = v.ri; ri < v.route.length && dist <= PRIORITY_RANGE_M[kind]; ri++) {
        const e = net.edges[v.route[ri]]
        if (ri > v.ri) dist += e.length
        if (approachKeys.has(approachKey(e.to, e.index))) {
          reqCache.push({ node: e.to, edge: e.index, kind, distance: dist, vehicle: v.id })
          break
        }
      }
    }
    return reqCache
  }
  // Pedestrian push-button calls at single-phase (crossing) intersections. Own RNG stream so the
  // car arrivals are unaffected and both modes see exactly the same pedestrians.
  const pedRng = createRng((config.seed ^ 0x9e3779b9) >>> 0)
  const pedCrossings = intersections.filter((x) => x.groups.length < 2).map((x) => x.id)
  const pedCalls = new Map<number, number>()
  const view: TrafficView = {
    count: edgeCount, lanes: (edge) => lanes[edge].length, upstream, downstream, requests,
    pedCall: (x) => pedCalls.get(x) ?? null,
    pedServed: (x) => void pedCalls.delete(x),
  }

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
  const conflicts = createConflictTable(net)
  const laneGeo = createLaneGeometry(net)
  const claims = new Map<number, Claim[]>()
  const claimOf = (node: number, v: Vehicle) => claims.get(node)?.find((c) => c.v === v)
  const dropClaim = (node: number, v: Vehicle) => {
    const list = claims.get(node)
    if (!list) return
    const i = list.findIndex((c) => c.v === v)
    if (i >= 0) list.splice(i, 1)
  }
  /**
   * Another vehicle holds a crossing/merging movement here, has reserved the same target lane,
   * or is coming from the same road and our lane changes would cross (side-by-side lane swap).
   */
  const blockedAt = (node: number, v: Vehicle, inE: number, outE: number, lane: number) =>
    claims.get(node)?.some((c) => {
      if (c.v === v) return false
      if (c.outE === outE && c.outLane === lane) return true
      if (c.inE === inE) {
        if (c.inLane === v.lane) return false // same lane: ordered by the queue
        // Side by side from the same road: lane order must match destination order, else paths cross.
        if (c.outE === outE) return (c.inLane - v.lane) * (c.outLane - lane) < 0
        const ea = net.edges[inE]
        return (c.inLane - v.lane) * (turnAngle(ea, net.edges[c.outE]) - turnAngle(ea, net.edges[outE])) < 0
      }
      return conflicts(c.inE, c.outE, inE, outE)
    }) ?? false
  /** Conflicting vehicles already inside the node (on their out-edge, or within 3 m of it). */
  const blockedInside = (node: number, v: Vehicle, inE: number, outE: number, lane: number) =>
    claims.get(node)?.some((c) => {
      if (c.v === v) return false
      const inside = c.v.ri >= c.outRi || net.edges[c.v.edge].length - c.v.pos < 3
      return inside && ((c.outE === outE && c.outLane === lane) || (c.inE !== inE && conflicts(c.inE, c.outE, inE, outE)))
    }) ?? false
  const laneClaimed = (node: number, v: Vehicle, outE: number, lane: number) =>
    claims.get(node)?.some((c) => c.v !== v && c.outE === outE && c.outLane === lane) ?? false
  /** Free space at the start of a lane, and whether its tail is still moving away. */
  const laneRoom = (edge: number, lane: number) => {
    const t = tail(lanes[edge][lane])
    return t ? { room: t.pos - t.length, moving: t.speed > MOVING_SPEED } : { room: Infinity, moving: true }
  }

  /**
   * Lane on route[ri] for vehicle v: turn lane for the next turn (left -> innermost,
   * right -> outermost), otherwise keep the same position counted from the kerb so
   * vehicles don't hop sideways at every node. Falls back to the roomiest lane if the
   * preferred one is jammed at its start.
   */
  const chooseLane = (v: Vehicle, ri: number): number => {
    const edge = v.route[ri]
    const n = lanes[edge].length
    if (n === 1) return 0
    let pref: number
    // Just turned onto this edge: take the near-side lane (right turn -> kerb lane, left -> inner),
    // as drivers do; don't sweep across lanes used by straight-on traffic.
    const entry = ri > 0 ? turnDirection(net.edges[v.route[ri - 1]], net.edges[edge]) : 0
    // Get into the turn lane early: first real turn within TURN_LANE_LOOKAHEAD_M of this edge's start.
    let turn: -1 | 0 | 1 = 0
    for (let j = ri, acc = 0; j + 1 < v.route.length && acc < TURN_LANE_LOOKAHEAD_M; j++) {
      turn = turnDirection(net.edges[v.route[j]], net.edges[v.route[j + 1]])
      if (turn !== 0) break
      acc += net.edges[v.route[j]].length
    }
    if (entry > 0) pref = n - 1
    else if (entry < 0) pref = 0
    else if (turn < 0) pref = 0
    else if (turn > 0) pref = n - 1
    else {
      // Straight on: the lane physically continuing the one we're in (no sideways hop).
      const from = v.route[Math.max(0, ri - 1)]
      pref = laneGeo.continueLane(from, Math.min(v.lane, lanes[from].length - 1), edge)
    }
    const need = v.length + idmOf[v.kind].s0
    const node = net.edges[edge].from
    const ok = (l: number) => {
      const r = laneRoom(edge, l)
      return (r.room >= need || r.moving) && !laneClaimed(node, v, edge, l)
    }
    if (ok(pref)) return pref
    // Nearest alternative lane that is free; else stay with the preference and wait for it.
    for (let d = 1; d < n; d++) {
      for (const l of [pref - d, pref + d]) if (l >= 0 && l < n && ok(l)) return l
    }
    return pref
  }

  /** Drop claims of vehicles that have cleared the node, left, or stopped short of it. */
  const releaseClaims = () => {
    for (const [node, list] of claims) {
      const keep = list.filter(({ v, outRi }) => {
        if (!state.vehicles.has(v.id)) return false
        if (v.ri > outRi || (v.ri === outRi && v.pos - v.length >= CLEAR_M)) return false
        // Stopped before the node (red light, queue ahead): it isn't using the node, give it up.
        if (v.ri < outRi && v.speed < STOPPED_SPEED) return false
        return true
      })
      if (keep.length) claims.set(node, keep)
      else claims.delete(node)
    }
  }

  /** Lane with the most free space at its start (lowest index on ties). */
  const bestLane = (edge: number): number => {
    const ls = lanes[edge]
    let best = 0
    let room = -Infinity
    for (let i = 0; i < ls.length; i++) {
      const t = tail(ls[i])
      const r = t ? t.pos - t.length : Infinity
      if (r > room) {
        room = r
        best = i
      }
    }
    return best
  }

  const stopFor = (v: Vehicle, d: number) => (v.speed * v.speed) / (2 * Math.max(d, 0.01))

  /**
   * The node at the end of route[ri], `dist` metres ahead: must v stop before it? Handles the
   * signal, first-come-first-served claims (yield to crossing/merging movements and to anyone
   * who reserved our target lane) and "don't block the box" (no room to clear the node).
   * Claims the node once close enough. Returns the gap to stop at, or null to proceed, plus
   * the lane we'll enter. Called in a fixed order (edge, lane, front-to-back) every tick.
   */
  const nodeGate = (v: Vehicle, ri: number, dist: number): { stop: number | null; lane: number } => {
    const e = net.edges[v.route[ri]]
    const next = v.route[ri + 1]
    if (!KIND_PROFILES[v.kind].ignoresSignals && signals.aspect(e.to, e.index) !== 'green') {
      const d = Math.max(dist - STOP_LINE_SETBACK, 0.01)
      if (stopFor(v, d) <= COMMIT_DECEL) {
        dropClaim(e.to, v) // stopping for the light: don't hold the node against cross traffic
        return { stop: d, lane: v.lane }
      }
    }
    const held = claimOf(e.to, v)
    if (held) return { stop: null, lane: held.outLane }
    const lane = chooseLane(v, ri + 1)
    // Only react once within comfortable stopping distance (+ margin): conflicts further away
    // will usually have cleared by the time we arrive, so don't slow down for them.
    const horizon = (v.speed * v.speed) / (2 * idmOf[v.kind].b) + 10
    if (dist > (v.kind === 'emergency' ? Math.max(horizon, EMERGENCY_CLAIM_M) : horizon)) return { stop: null, lane }
    // Don't block the box. On normal roads only a stopped tail counts (a moving one clears and
    // car-following keeps the gap). On short internal junction links a moving tail can stop any
    // moment and strand us inside the junction, blocking cross traffic -> require full room.
    const r = laneRoom(next, lane)
    const insideJunction = net.edges[next].length < BOX_LINK_M
    const noRoom = r.room < v.length + idmOf[v.kind].s0 && (insideJunction || !r.moving)
    const d = Math.max(dist - 1, 0.01)
    const emergency = v.kind === 'emergency'
    // Blue lights: only yield to vehicles already in the node; everyone else yields to us.
    const blocked = emergency ? blockedInside(e.to, v, e.index, next, lane) : blockedAt(e.to, v, e.index, next, lane)
    if ((noRoom || blocked) && stopFor(v, d) <= MAX_DECEL) return { stop: d, lane }
    const claimDist = emergency ? Math.max(EMERGENCY_CLAIM_M, v.speed * 4) : Math.max(CLAIM_MIN_M, v.speed * CLAIM_ETA_S)
    if (dist <= claimDist) {
      let list = claims.get(e.to)
      if (!list) claims.set(e.to, (list = []))
      list.push({ v, inE: e.index, outE: next, outRi: ri + 1, outLane: lane, inLane: v.lane })
    }
    return { stop: null, lane }
  }

  /** Nearest obstacle ahead of a lane leader along its route: a node it must stop at, or the queue tail beyond. */
  const lookahead = (v: Vehicle): { gap: number; vLead: number } => {
    let dist = net.edges[v.edge].length - v.pos
    for (let ri = v.ri; ri < v.route.length - 1; ri++) {
      const g = nodeGate(v, ri, dist)
      if (g.stop !== null) return { gap: g.stop, vLead: 0 }
      const next = v.route[ri + 1]
      const t = tail(lanes[next][g.lane])
      if (t) return { gap: dist + t.pos - t.length, vLead: t.speed }
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
    const kind = f.kind ?? 'car'
    const u = rng.next() // drawn for every arrival so the stream order doesn't depend on kind
    return { route, kind, tag: f.tag, v0Factor: KIND_PROFILES[kind].v0Factor ?? 1 - V0_SPREAD + 2 * V0_SPREAD * u }
  }

  /** Nearest rear (position on `edge`) of a vehicle that just left `edge` from `lane` and still overhangs it. */
  const overhangRear = (edge: number, lane: number): { rear: number; speed: number } | null => {
    let best: { rear: number; speed: number } | null = null
    for (const v of state.vehicles.values()) {
      if (v.ri === 0 || v.prevLane !== lane || v.route[v.ri - 1] !== edge || v.pos >= v.length) continue
      const rear = net.edges[edge].length + v.pos - v.length
      if (!best || rear < best.rear) best = { rear, speed: v.speed }
    }
    return best
  }

  /** Place a pending arrival on `edge` if there's room. Returns false if it must keep waiting. */
  const place = (edge: number, p: Pending): boolean => {
    if (!p.route) return true // nowhere to go: drop the arrival
    const prof = idmOf[p.kind]
    const lane = bestLane(edge)
    const t = tail(lanes[edge][lane])
    const o = overhangRear(edge, lane)
    const limit = net.edges[edge].speedLimit
    const ahead = t ? { room: t.pos - t.length, speed: t.speed } : o ? { room: o.rear, speed: o.speed } : null
    const speed = (ahead ? Math.min(ahead.speed, limit) : limit) * Math.min(1, p.v0Factor)
    if (ahead && ahead.room < prof.s0 + speed * prof.T) return false
    if (o && o.rear < prof.s0 + speed * prof.T) return false
    const freeFlow = p.route.reduce((s, i) => s + net.edges[i].length / (net.edges[i].speedLimit * p.v0Factor), 0)
    const v: Vehicle = {
      id: nextId++, kind: p.kind, length: prof.length, tag: p.tag, route: p.route, ri: 0, edge, lane, prevLane: -1,
      pos: 0, speed, accel: 0, v0Factor: p.v0Factor, spawnTime: state.time, freeFlow, wait: 0,
      moving: speed > MOVING_SPEED, vPeak: speed,
    }
    lanes[edge][lane].push(v)
    state.vehicles.set(v.id, v)
    if (v.kind !== 'car') special.add(v)
    metrics.recordSpawn()
    return true
  }
  const spawn = (i: number) => place(entries[i].edge, state.backlog[i][0])

  const step = () => {
    for (const x of pedCrossings) {
      if (pedRng.next() < PED_CALL_RATE * DT && !pedCalls.has(x)) pedCalls.set(x, state.time)
    }
    signals.update(state.time, view)
    releaseClaims()

    // Rear ends that still overhang back into a previous edge's lane (just crossed a node):
    // key `${edge}:${lane}` -> nearest such rear (position on that edge) and its speed.
    const overhang = new Map<string, { rear: number; speed: number }>()
    for (const v of state.vehicles.values()) {
      if (v.ri === 0 || v.prevLane < 0 || v.pos >= v.length) continue
      const prev = v.route[v.ri - 1]
      const rear = net.edges[prev].length + v.pos - v.length
      const k = `${prev}:${v.prevLane}`
      const o = overhang.get(k)
      if (!o || rear < o.rear) overhang.set(k, { rear, speed: v.speed })
    }

    // 1. Accelerations from the current state (parallel update: order-independent).
    for (const e of net.edges) {
      for (const lane of lanes[e.index]) {
        for (let k = 0; k < lane.length; k++) {
          const v = lane[k]
          const v0 = e.speedLimit * v.v0Factor
          let gap: number
          let vLead: number
          if (k > 0) {
            gap = lane[k - 1].pos - lane[k - 1].length - v.pos
            vLead = lane[k - 1].speed
            // Followers near the node run the same gate: a platoon may not cut across a
            // crossing stream that claimed the node after its leader went through.
            if (v.ri < v.route.length - 1) {
              const dist = e.length - v.pos
              const g = nodeGate(v, v.ri, dist)
              if (g.stop !== null && g.stop < gap) {
                gap = g.stop
                vLead = 0
              }
            }
          } else {
            ;({ gap, vLead } = lookahead(v))
            // Don't drive into the rear of a vehicle that just left this lane (whatever it turned onto).
            const o = overhang.get(`${e.index}:${v.lane}`)
            if (o && o.rear - v.pos < gap) {
              gap = o.rear - v.pos
              vLead = o.speed
            }
          }
          v.accel = idmAccel(idmOf[v.kind], v.speed, v0, gap, v.speed - vLead)
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
        special.delete(v)
        const travel = state.time + DT - v.spawnTime
        metrics.recordExit({
          id: v.id, kind: v.kind, tag: v.tag, entry: v.route[0], exit: v.edge, wait: v.wait, travel,
          delay: Math.max(0, travel - v.freeFlow),
        })
        continue
      }
      v.prevLane = v.lane
      // Enter the lane reserved when the node was claimed (so we follow the queue we planned for).
      const reserved = claimOf(net.edges[v.edge].from, v)
      v.lane = reserved && reserved.outE === v.edge ? reserved.outLane : chooseLane(v, v.ri)
      const lane = lanes[v.edge][v.lane]
      lane.push(v)
      touched.add(lane)
    }
    for (const lane of touched) lane.sort((a, b) => b.pos - a.pos) // stable: merges in the same tick

    // 4. Arrivals (Poisson via Bernoulli per tick, or timetabled), then drain backlog into free entry space.
    for (let i = 0; i < entries.length; i++) {
      const f = entries[i]
      let due: boolean
      if (f.headway) {
        const h = Math.max(1, Math.round(f.headway * TICK_HZ))
        const o = Math.round((f.offset ?? 0) * TICK_HZ)
        due = state.tick >= o && (state.tick - o) % h === 0
      } else due = rng.next() < f.rate * DT
      if (due) state.backlog[i].push(arrive(i))
      while (state.backlog[i].length && spawn(i)) state.backlog[i].shift()
    }
    while (dispatched.length && place(dispatched[0].route![0], dispatched[0])) dispatched.shift()

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
    view,
    claims: () =>
      [...claims].flatMap(([node, list]) =>
        list.map((c) => ({ node, vehicle: c.v.id, inE: c.inE, outE: c.outE, outLane: c.outLane })),
      ),
    dispatch(route, kind, tag) {
      dispatched.push({ route, kind, tag, v0Factor: KIND_PROFILES[kind].v0Factor ?? 1 })
    },
    step,
    run(seconds: number) {
      const n = Math.round(seconds * TICK_HZ)
      for (let i = 0; i < n; i++) step()
    },
    snapshot: () =>
      metrics.snapshot(state.time, state.vehicles.size, state.backlog.reduce((s, b) => s + b.length, 0)),
  }
}
