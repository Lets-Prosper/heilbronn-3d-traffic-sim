// GeoJSON (overpass-turbo export) -> engine OsmData.
//
// The export carries way geometry as raw coordinates without OSM node ids, so
// topology is rebuilt by coordinate identity: OSM serializes a shared node with
// the same lat/lon in every way, so identical coordinates = same node.
import type { BBox } from '../engine/network/geo'
import type { OsmData, OsmNode, OsmWay } from '../engine/network/types'

type Position = [number, number] | number[]

interface Feature {
  type: 'Feature'
  id?: string | number
  properties: Record<string, unknown>
  geometry:
    | { type: 'Point'; coordinates: Position }
    | { type: 'LineString'; coordinates: Position[] }
    | { type: 'Polygon'; coordinates: Position[][] }
    | { type: 'MultiPolygon'; coordinates: Position[][][] }
    | { type: string; coordinates: unknown }
    | null
}

export interface FeatureCollection {
  type: 'FeatureCollection'
  features: Feature[]
}

export interface GeojsonOptions {
  /** Study area. Default: extent of building footprints (≈ the Overpass query bbox). */
  bbox?: BBox
  /** Clip road geometry to bbox (Overpass returns whole ways that extend outside). Default true. */
  clipRoads?: boolean
}

function osmId(f: Feature, fallback: number): { type: string; id: number } {
  const raw = String(f.properties['@id'] ?? f.id ?? '')
  const m = /^(node|way|relation)\/(\d+)$/.exec(raw)
  return m ? { type: m[1], id: Number(m[2]) } : { type: '', id: fallback }
}

function stringTags(p: Record<string, unknown>): Record<string, string> {
  const t: Record<string, string> = {}
  for (const [k, v] of Object.entries(p)) if (!k.startsWith('@') && k !== 'id' && v != null) t[k] = String(v)
  return t
}

export function extentOf(features: Feature[]): BBox | undefined {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return
    if (typeof c[0] === 'number') {
      w = Math.min(w, c[0]); e = Math.max(e, c[0])
      s = Math.min(s, c[1] as number); n = Math.max(n, c[1] as number)
    } else c.forEach(walk)
  }
  for (const f of features) if (f.geometry) walk((f.geometry as { coordinates: unknown }).coordinates)
  return Number.isFinite(s) ? { south: s, west: w, north: n, east: e } : undefined
}

const inBBox = (b: BBox, lon: number, lat: number) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east

export function geojsonToOsmData(fc: FeatureCollection, opts: GeojsonOptions = {}): OsmData {
  const buildings = fc.features.filter((f) => f.properties.building != null)
  const bbox = opts.bbox ?? extentOf(buildings) ?? extentOf(fc.features)
  if (!bbox) throw new Error('GeoJSON has no geometry')
  const clip = opts.clipRoads ?? true

  const nodes = new Map<string, OsmNode>()
  let nextNodeId = -1 // synthetic ids are negative; real OSM node ids (signals) are kept when available
  const nodeAt = (pos: Position, id?: number, tags?: Record<string, string>): OsmNode => {
    const key = `${pos[0]},${pos[1]}`
    let n = nodes.get(key)
    if (!n) {
      n = { id: id ?? nextNodeId--, lat: pos[1], lon: pos[0] }
      nodes.set(key, n)
    }
    if (tags) n.tags = { ...n.tags, ...tags }
    return n
  }

  // Points first, so signal nodes keep their real OSM ids when ways reference them.
  for (const f of fc.features) {
    if (f.geometry?.type !== 'Point') continue
    const { type, id } = osmId(f, 0)
    nodeAt(f.geometry.coordinates as Position, type === 'node' ? id : undefined, stringTags(f.properties))
  }

  const ways: OsmWay[] = []
  let nextWayId = -1
  for (const f of fc.features) {
    const g = f.geometry
    if (!g || g.type === 'Point') continue
    const { id } = osmId(f, nextWayId--)
    const tags = stringTags(f.properties)
    if (g.type === 'LineString') {
      const coords = g.coordinates as Position[]
      if (!clip || !tags.highway) {
        ways.push({ id, tags, nodes: coords.map((c) => nodeAt(c).id) })
        continue
      }
      // Keep runs of in-bbox vertices; a way that leaves and re-enters becomes several pieces.
      let run: number[] = []
      const flush = () => {
        if (run.length >= 2) ways.push({ id, tags, nodes: run })
        run = []
      }
      for (const c of coords) {
        if (inBBox(bbox, c[0], c[1])) run.push(nodeAt(c).id)
        else flush()
      }
      flush()
    } else if (g.type === 'Polygon') {
      const outer = (g.coordinates as Position[][])[0]
      if (outer?.length >= 4) ways.push({ id, tags, nodes: outer.map((c) => nodeAt(c).id) })
    } else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates as Position[][][]) {
        const outer = poly[0]
        if (outer?.length >= 4) ways.push({ id, tags, nodes: outer.map((c) => nodeAt(c).id) })
      }
    }
  }

  return { bbox, nodes: [...nodes.values()], ways }
}
