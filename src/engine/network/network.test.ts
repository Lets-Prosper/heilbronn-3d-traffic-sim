import { describe, expect, it } from 'vitest'
import { buildBuildings, buildNetwork } from './build'
import { createProjection, type BBox } from './geo'
import type { OsmData } from './types'

// Roughly central Heilbronn. 0.001° lat ≈ 111 m.
const LAT = 49.142
const LON = 9.21
const bbox: BBox = { south: LAT - 0.002, west: LON - 0.003, north: LAT + 0.002, east: LON + 0.003 }

/**
 *            N(1)
 *             |
 *   W(2) -- C(0) -- S1(5,signal) -- E(3)        way 100: W-C-S1-E (two-way, lanes=4)
 *             |                                  way 101: N-C-S(4)  (oneway, southbound)
 *            S(4)                                way 102: footway C-N (ignored)
 */
const osm: OsmData = {
  bbox,
  nodes: [
    { id: 0, lat: LAT, lon: LON },
    { id: 1, lat: LAT + 0.001, lon: LON },
    { id: 2, lat: LAT, lon: LON - 0.001 },
    { id: 3, lat: LAT, lon: LON + 0.002 },
    { id: 4, lat: LAT - 0.001, lon: LON },
    { id: 5, lat: LAT, lon: LON + 0.001, tags: { highway: 'traffic_signals' } },
    // building corners
    { id: 10, lat: LAT + 0.0005, lon: LON + 0.0005 },
    { id: 11, lat: LAT + 0.0005, lon: LON + 0.0007 },
    { id: 12, lat: LAT + 0.0007, lon: LON + 0.0007 },
    { id: 13, lat: LAT + 0.0007, lon: LON + 0.0005 },
  ],
  ways: [
    { id: 100, nodes: [2, 0, 5, 3], tags: { highway: 'primary', lanes: '4', name: 'Karlsruher Straße', maxspeed: '50' } },
    { id: 101, nodes: [1, 0, 4], tags: { highway: 'residential', oneway: 'yes', name: 'Theresienstraße' } },
    { id: 102, nodes: [0, 1], tags: { highway: 'footway' } },
    { id: 200, nodes: [10, 11, 12, 13, 10], tags: { building: 'yes', 'building:levels': '4' } },
  ],
}

describe('projection', () => {
  it('maps bbox center to origin, east to +X, north to -Z, in meters', () => {
    const p = createProjection({ lat: LAT, lon: LON })
    expect(p.toXZ(LAT, LON)).toEqual({ x: 0, z: 0 })
    const north = p.toXZ(LAT + 0.001, LON)
    expect(north.x).toBeCloseTo(0)
    expect(north.z).toBeCloseTo(-111.3, 0)
    const east = p.toXZ(LAT, LON + 0.001)
    expect(east.x).toBeCloseTo(111.3 * Math.cos((LAT * Math.PI) / 180), 0)
    expect(east.z).toBeCloseTo(0)
  })

  it('round-trips', () => {
    const p = createProjection({ lat: LAT, lon: LON })
    const ll = p.toLatLon(p.toXZ(49.15, 9.2))
    expect(ll.lat).toBeCloseTo(49.15, 9)
    expect(ll.lon).toBeCloseTo(9.2, 9)
  })
})

describe('buildNetwork', () => {
  const net = buildNetwork(osm)
  const edge = (from: number, to: number) => net.edges.find((e) => e.from === from && e.to === to)

  it('creates vertices at intersections, endpoints and signals only', () => {
    expect([...net.nodes.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5])
    expect(net.nodes.get(5)!.signal).toBe(true)
    expect(net.nodes.get(0)!.signal).toBe(false)
  })

  it('origin is bbox center', () => {
    expect(net.origin.lat).toBeCloseTo(LAT)
    expect(net.origin.lon).toBeCloseTo(LON)
  })

  it('splits two-way roads into both directions with lanes per direction', () => {
    // way 100: 3 segments x 2 directions; way 101: 2 segments x 1 direction
    expect(net.edges).toHaveLength(8)
    for (const [a, b] of [[2, 0], [0, 2], [0, 5], [5, 0], [5, 3], [3, 5]]) {
      const e = edge(a, b)!
      expect(e, `${a}->${b}`).toBeDefined()
      expect(e.lanes).toBe(2)
      expect(e.name).toBe('Karlsruher Straße')
      expect(e.speedLimit).toBeCloseTo(50 / 3.6)
    }
  })

  it('respects oneway', () => {
    expect(edge(1, 0)).toBeDefined()
    expect(edge(0, 4)).toBeDefined()
    expect(edge(0, 1)).toBeUndefined()
    expect(edge(4, 0)).toBeUndefined()
    expect(edge(1, 0)!.lanes).toBe(1)
  })

  it('ignores non-drivable ways', () => {
    expect(net.edges.some((e) => e.wayId === 102)).toBe(false)
  })

  it('computes metric lengths and geo coords along the polyline', () => {
    const e = edge(0, 1)
    expect(e).toBeUndefined()
    const n = edge(1, 0)!
    expect(n.length).toBeCloseTo(111.2, 0)
    expect(n.points[0]).toEqual(net.nodes.get(1)!.pos)
    expect(n.geo[0]).toEqual({ lat: LAT + 0.001, lon: LON })
  })

  it('maintains in/out adjacency', () => {
    const c = net.nodes.get(0)!
    expect(c.out.map((i) => net.edges[i].to).sort()).toEqual([2, 4, 5])
    expect(c.in.map((i) => net.edges[i].from).sort()).toEqual([1, 2, 5])
  })
})

describe('buildBuildings', () => {
  it('extracts closed footprints with height from levels', () => {
    const b = buildBuildings(osm)
    expect(b).toHaveLength(1)
    expect(b[0].footprint).toHaveLength(4)
    expect(b[0].height).toBe(12)
  })
})
