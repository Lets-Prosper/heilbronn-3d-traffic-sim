// Calibrated demand: Zählstelle movements -> fixed-route entry flows on the OSM network.
//
// Each detector counts one movement (approach + turn) at the Karlsruher Straße ×
// Theresienstraße junction. A movement becomes one Poisson flow whose route is
//   nearest boundary entry -> junction approach -> through the junction -> departure
//   arm -> nearest boundary exit,
// with no part of the lead-in / lead-out passing through the junction itself.
//
// Uncounted movements (Karlsruher Straße through traffic, etc.) are NOT invented
// by default; `assumedThroughVph` adds a clearly-labelled assumed through flow.
import type { EntryFlow } from '../engine/engine'
import { entryEdges, exitEdges, pathTo, shortestPathTree } from '../engine/network/routing'
import type { NetEdge, Network } from '../engine/network/types'
import { DETECTORS, type Approach, type Movement } from './counts'
import demand2023 from './demand2023.json'

export const JUNCTION_STREETS = ['Karlsruher Straße', 'Theresienstraße'] as const

export interface ScenarioOptions {
  /** Interval start hour, 0–23. Default 7 (07:00–08:00, the weekday AM peak). */
  hour?: number
  day?: 'weekday' | 'all'
  /** Multiplies every calibrated (and assumed) flow. */
  scale?: number
  /** Uncalibrated random-route traffic per boundary entry, veh/s. */
  backgroundRate?: number
  /** ASSUMED (not measured) Karlsruher Straße through flow per direction, veh/h. */
  assumedThroughVph?: number
}

export interface MovementFlow {
  tag: string
  approach: Approach
  movement: Movement
  vph: number
  assumed: boolean
  route: number[]
}

export interface Scenario {
  entries: EntryFlow[]
  movements: MovementFlow[]
  /** Movements that couldn't be mapped onto the network. */
  unmapped: string[]
  options: Required<ScenarioOptions>
}

type Side = Approach
const OPPOSITE: Record<Side, Side> = { north: 'south', south: 'north', east: 'west', west: 'east' }
const RIGHT_OF: Record<Side, Side> = { north: 'west', east: 'north', south: 'east', west: 'south' }

/** Side a vehicle exits toward, for right-hand traffic. */
export function departSide(from: Approach, m: Movement): Side {
  if (m === 'straight') return OPPOSITE[from]
  return m === 'right' ? RIGHT_OF[from] : OPPOSITE[RIGHT_OF[from]]
}

/** Compass side of a direction vector (+X east, −Z north). */
function sideOf(dx: number, dz: number): Side {
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : dz > 0 ? 'south' : 'north'
}

/** Junction = nodes touched by both streets. */
export function junctionNodes(net: Network, streets: readonly string[] = JUNCTION_STREETS): Set<number> {
  const out = new Set<number>()
  for (const n of net.nodes.values()) {
    const names = new Set([...n.in, ...n.out].map((i) => net.edges[i].name))
    if (streets.every((s) => names.has(s))) out.add(n.id)
  }
  return out
}

/** Point `dist` m along the street away from the junction (upstream for approaches, downstream for departures). */
function armPoint(net: Network, e: NetEdge, dir: 'up' | 'down', dist = 30) {
  let cur = e
  let left = dist
  for (;;) {
    // Walk this edge's polyline away from the junction.
    const pts = dir === 'up' ? [...cur.points].reverse() : cur.points
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
      if (l >= left) {
        const t = left / l
        return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t }
      }
      left -= l
    }
    const node = net.nodes.get(dir === 'up' ? cur.from : cur.to)!
    const cands = (dir === 'up' ? node.in : node.out)
      .map((i) => net.edges[i])
      .filter((c) => (dir === 'up' ? c.from !== cur.to : c.to !== cur.from))
    const next = cands.find((c) => c.name === cur.name) ?? cands[0]
    if (!next) return node.pos
    cur = next
  }
}

export function buildScenario(net: Network, opts: ScenarioOptions = {}): Scenario {
  const o: Required<ScenarioOptions> = {
    hour: 7, day: 'weekday', scale: 1, backgroundRate: 0.004, assumedThroughVph: 0, ...opts,
  }
  const J = junctionNodes(net)
  const inJ = (id: number) => J.has(id)
  // Arm sides are judged from the junction centroid: dual carriageways and slip lanes
  // make the heading of individual short edges unreliable.
  const jn = [...J].map((id) => net.nodes.get(id)!.pos)
  const cx = jn.reduce((s, p) => s + p.x, 0) / jn.length
  const cz = jn.reduce((s, p) => s + p.z, 0) / jn.length
  const arm = (e: NetEdge, dir: 'up' | 'down') => {
    const p = armPoint(net, e, dir)
    return { e, side: sideOf(p.x - cx, p.z - cz) }
  }
  const approaches = net.edges.filter((e) => inJ(e.to) && !inJ(e.from)).map((e) => arm(e, 'up'))
  const departures = net.edges.filter((e) => inJ(e.from) && !inJ(e.to)).map((e) => arm(e, 'down'))

  const entries = entryEdges(net)
  const exits = exitEdges(net)
  const entryTrees = entries.map((i) => shortestPathTree(net, i))

  /** Cheapest boundary-entry lead-in to approach edge `a` that doesn't cross the junction. */
  const leadIn = (a: number): number[] | null => {
    let best: number[] | null = null
    let bestCost = Infinity
    for (const t of entryTrees) {
      const p = pathTo(t, a)
      if (!p || t.cost[a] >= bestCost) continue
      if (p.slice(0, -1).some((i) => inJ(net.edges[i].to))) continue
      best = p
      bestCost = t.cost[a]
    }
    return best
  }
  /** Cheapest lead-out from departure edge `d` to a boundary exit that doesn't re-enter the junction. */
  const leadOut = (d: number): number[] | null => {
    const t = shortestPathTree(net, d)
    let best: number[] | null = null
    let bestCost = Infinity
    for (const x of exits) {
      const p = pathTo(t, x)
      if (!p || t.cost[x] >= bestCost) continue
      if (p.slice(1).some((i) => inJ(net.edges[i].to))) continue
      best = p
      bestCost = t.cost[x]
    }
    return best
  }

  const routeFor = (from: Approach, street: string, m: Movement): number[] | null => {
    const to = departSide(from, m)
    let best: number[] | null = null
    let bestCost = Infinity
    for (const a of approaches) {
      if (a.side !== from || a.e.name !== street) continue
      const t = shortestPathTree(net, a.e.index)
      for (const d of departures) {
        if (d.side !== to) continue
        const mid = pathTo(t, d.e.index)
        if (!mid || t.cost[d.e.index] >= bestCost) continue
        // Through the junction only: every intermediate edge stays inside it.
        if (mid.slice(1, -1).some((i) => !inJ(net.edges[i].from) || !inJ(net.edges[i].to))) continue
        const lin = leadIn(a.e.index)
        const lout = leadOut(d.e.index)
        if (!lin || !lout) continue
        best = [...lin, ...mid.slice(1), ...lout.slice(1)]
        bestCost = t.cost[d.e.index]
      }
    }
    return best
  }

  const profiles = demand2023[o.day] as Record<string, number[]>
  const movements: MovementFlow[] = []
  const unmapped: string[] = []
  const add = (tag: string, approach: Approach, street: string, movement: Movement, vph: number, assumed: boolean) => {
    if (vph <= 0) return
    const route = routeFor(approach, street, movement)
    if (!route) unmapped.push(tag)
    else movements.push({ tag, approach, movement, vph: vph * o.scale, assumed, route })
  }
  for (const d of Object.values(DETECTORS)) add(d.id, d.approach, d.street, d.movement, profiles[d.id][o.hour], false)
  add('ASSUMED-KA-E-through', 'east', 'Karlsruher Straße', 'straight', o.assumedThroughVph, true)
  add('ASSUMED-KA-W-through', 'west', 'Karlsruher Straße', 'straight', o.assumedThroughVph, true)

  const flows: EntryFlow[] = movements.map((m) => ({ edge: m.route[0], rate: m.vph / 3600, route: m.route, tag: m.tag }))
  if (o.backgroundRate > 0) for (const edge of entries) flows.push({ edge, rate: o.backgroundRate, tag: 'background' })
  return { entries: flows, movements, unmapped, options: o }
}
