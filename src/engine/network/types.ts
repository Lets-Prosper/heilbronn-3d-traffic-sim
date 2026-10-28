import type { BBox, GeoOrigin, XZ } from './geo'

/** Source-agnostic OSM input (decoupled from Overpass JSON shape). */
export interface OsmNode {
  id: number
  lat: number
  lon: number
  tags?: Record<string, string>
}

export interface OsmWay {
  id: number
  nodes: number[]
  tags?: Record<string, string>
}

export interface OsmData {
  bbox: BBox
  nodes: OsmNode[]
  ways: OsmWay[]
}

/** Graph vertex: an intersection, a way endpoint, or a signal location. */
export interface NetNode {
  id: number // OSM node id
  pos: XZ
  geo: GeoOrigin
  signal: boolean
  /** Outgoing / incoming directed edge indices. */
  out: number[]
  in: number[]
}

/** Directed road segment between two graph nodes. */
export interface NetEdge {
  index: number
  from: number // NetNode id
  to: number
  wayId: number
  name: string
  highway: string
  lanes: number // lanes in this direction
  speedLimit: number // m/s
  length: number // meters, along the polyline
  points: XZ[] // from -> to, inclusive
  geo: GeoOrigin[]
}

export interface Network {
  origin: GeoOrigin
  bbox: BBox
  nodes: Map<number, NetNode>
  edges: NetEdge[]
}

export interface Building {
  id: number
  footprint: XZ[] // closed ring, last point != first
  height: number // meters
  kind: string // OSM building=* value
}
