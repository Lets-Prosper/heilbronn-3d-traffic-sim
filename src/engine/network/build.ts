import { bboxCenter, createProjection, polylineLength, type GeoOrigin, type Projection, type XZ } from './geo'
import type { Building, NetEdge, NetNode, Network, OsmData, OsmNode, OsmWay } from './types'

/** Car-drivable highway classes. `service` excluded: mostly parking aisles/driveways. */
export const DRIVABLE_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
])

const KMH = 1 / 3.6

/** German defaults when maxspeed is missing (innerorts). */
const DEFAULT_SPEED_KMH: Record<string, number> = {
  motorway: 100, motorway_link: 60, trunk: 70, trunk_link: 50,
  living_street: 7,
}

const LEVEL_HEIGHT_M = 3
const DEFAULT_BUILDING_HEIGHT_M = 9

export function isDrivable(way: OsmWay): boolean {
  const t = way.tags ?? {}
  if (!t.highway || !DRIVABLE_HIGHWAYS.has(t.highway)) return false
  if (t.area === 'yes') return false
  if (t.access === 'no' || t.access === 'private') return false
  if (t.motor_vehicle === 'no' || t.motorcar === 'no') return false
  return way.nodes.length >= 2
}

/** 1 = forward only, -1 = reverse only, 0 = both directions. */
function onewayDir(t: Record<string, string>): 1 | -1 | 0 {
  const v = t.oneway
  if (v === 'yes' || v === 'true' || v === '1') return 1
  if (v === '-1' || v === 'reverse') return -1
  if (v === 'no') return 0
  if (t.junction === 'roundabout' || t.junction === 'circular') return 1
  if (t.highway === 'motorway' || t.highway === 'motorway_link') return 1
  return 0
}

function parseIntTag(v: string | undefined): number | undefined {
  if (!v) return undefined
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function lanesPerDirection(t: Record<string, string>, dir: 1 | -1 | 0): { fwd: number; bwd: number } {
  const total = parseIntTag(t.lanes)
  if (dir !== 0) {
    const n = total ?? 1
    return dir === 1 ? { fwd: n, bwd: 0 } : { fwd: 0, bwd: n }
  }
  const f = parseIntTag(t['lanes:forward'])
  const b = parseIntTag(t['lanes:backward'])
  const half = total ? Math.max(1, Math.floor(total / 2)) : 1
  return { fwd: f ?? (total && b ? Math.max(1, total - b) : half), bwd: b ?? (total && f ? Math.max(1, total - f) : half) }
}

function speedLimit(t: Record<string, string>): number {
  const m = /^(\d+)\s*(mph)?/.exec(t.maxspeed ?? '')
  if (m) return parseInt(m[1], 10) * (m[2] ? 1.609344 : 1) * KMH
  if (t.maxspeed === 'DE:living_street' || t.maxspeed === 'walk') return 7 * KMH
  if (t.maxspeed === 'DE:zone30' || t.maxspeed === 'DE:zone:30') return 30 * KMH
  return (DEFAULT_SPEED_KMH[t.highway] ?? 50) * KMH
}

function isSignal(n: OsmNode | undefined): boolean {
  return n?.tags?.highway === 'traffic_signals' || n?.tags?.crossing === 'traffic_signals'
}

export function buildNetwork(osm: OsmData): Network {
  const origin = bboxCenter(osm.bbox)
  const proj = createProjection(origin)
  const nodeById = new Map(osm.nodes.map((n) => [n.id, n]))
  const ways = osm.ways.filter(isDrivable).map((w) => ({ ...w, nodes: w.nodes.filter((id) => nodeById.has(id)) }))

  // A node becomes a graph vertex if it's a way endpoint, shared by 2+ drivable
  // ways (or appears twice in one way, e.g. loops), or carries a traffic signal.
  const refCount = new Map<number, number>()
  for (const w of ways) for (const id of w.nodes) refCount.set(id, (refCount.get(id) ?? 0) + 1)
  const isVertex = (id: number, i: number, len: number) =>
    i === 0 || i === len - 1 || (refCount.get(id) ?? 0) > 1 || isSignal(nodeById.get(id))

  const nodes = new Map<number, NetNode>()
  const vertex = (id: number): NetNode => {
    let v = nodes.get(id)
    if (!v) {
      const n = nodeById.get(id)!
      v = { id, pos: proj.toXZ(n.lat, n.lon), geo: { lat: n.lat, lon: n.lon }, signal: isSignal(n), out: [], in: [] }
      nodes.set(id, v)
    }
    return v
  }

  const edges: NetEdge[] = []
  const addEdge = (ids: number[], way: OsmWay, lanes: number) => {
    const t = way.tags ?? {}
    const geo: GeoOrigin[] = ids.map((id) => ({ lat: nodeById.get(id)!.lat, lon: nodeById.get(id)!.lon }))
    const points: XZ[] = geo.map((g) => proj.toXZ(g.lat, g.lon))
    const length = polylineLength(points)
    if (length < 1e-3) return
    const from = vertex(ids[0])
    const to = vertex(ids[ids.length - 1])
    const index = edges.length
    edges.push({
      index, from: from.id, to: to.id, wayId: way.id, name: t.name ?? '', highway: t.highway,
      lanes, speedLimit: speedLimit(t), length, points, geo,
    })
    from.out.push(index)
    to.in.push(index)
  }

  for (const w of ways) {
    const t = w.tags ?? {}
    const dir = onewayDir(t)
    const { fwd, bwd } = lanesPerDirection(t, dir)
    let start = 0
    for (let i = 1; i < w.nodes.length; i++) {
      if (!isVertex(w.nodes[i], i, w.nodes.length)) continue
      const seg = w.nodes.slice(start, i + 1)
      if (fwd > 0) addEdge(seg, w, fwd)
      if (bwd > 0) addEdge([...seg].reverse(), w, bwd)
      start = i
    }
  }

  return { origin, bbox: osm.bbox, nodes, edges }
}

function buildingHeight(t: Record<string, string>): number {
  const h = parseFloat(t.height ?? '')
  if (Number.isFinite(h) && h > 0) return h
  const levels = parseFloat(t['building:levels'] ?? '')
  if (Number.isFinite(levels) && levels > 0) return levels * LEVEL_HEIGHT_M + (parseFloat(t['roof:levels'] ?? '') || 0) * 1.5
  return DEFAULT_BUILDING_HEIGHT_M
}

/** Closed building ways -> XZ footprints. (Multipolygon relations not handled yet.) */
export function buildBuildings(osm: OsmData, proj: Projection = createProjection(bboxCenter(osm.bbox))): Building[] {
  const nodeById = new Map(osm.nodes.map((n) => [n.id, n]))
  const out: Building[] = []
  for (const w of osm.ways) {
    const t = w.tags ?? {}
    if (!t.building || t.building === 'no') continue
    if (w.nodes.length < 4 || w.nodes[0] !== w.nodes[w.nodes.length - 1]) continue
    const ring = w.nodes.slice(0, -1).map((id) => nodeById.get(id))
    if (ring.some((n) => !n)) continue
    out.push({
      id: w.id,
      footprint: ring.map((n) => proj.toXZ(n!.lat, n!.lon)),
      height: buildingHeight(t),
      kind: t.building,
    })
  }
  return out
}
