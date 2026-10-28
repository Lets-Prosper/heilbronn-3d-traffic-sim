import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { geojsonToOsmData, loadCityFromGeojson, type FeatureCollection } from '.'

const LAT = 49.138
const LON = 9.205

// Two roads crossing at a shared coordinate, a signal on one, a building, and a
// road that leaves the bbox.
const fc: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { '@id': 'way/1', highway: 'primary', name: 'A', oneway: 'yes' },
      geometry: { type: 'LineString', coordinates: [[LON - 0.001, LAT], [LON, LAT], [LON + 0.001, LAT]] },
    },
    {
      type: 'Feature',
      properties: { '@id': 'way/2', highway: 'residential', name: 'B' },
      geometry: { type: 'LineString', coordinates: [[LON, LAT + 0.001], [LON, LAT], [LON, LAT - 0.001], [LON, LAT - 0.05]] },
    },
    {
      type: 'Feature',
      properties: { '@id': 'node/77', highway: 'traffic_signals' },
      geometry: { type: 'Point', coordinates: [LON + 0.001, LAT] },
    },
    {
      type: 'Feature',
      properties: { '@id': 'way/3', building: 'yes', 'building:levels': 2 },
      geometry: {
        type: 'Polygon',
        coordinates: [[[LON - 0.001, LAT - 0.001], [LON + 0.001, LAT - 0.001], [LON + 0.001, LAT + 0.001], [LON - 0.001, LAT + 0.001], [LON - 0.001, LAT - 0.001]]],
      },
    },
  ],
}

describe('geojsonToOsmData', () => {
  const osm = geojsonToOsmData(fc)

  it('defaults bbox to the building extent', () => {
    expect(osm.bbox).toEqual({ south: LAT - 0.001, west: LON - 0.001, north: LAT + 0.001, east: LON + 0.001 })
  })

  it('merges identical coordinates into one node and keeps real signal ids', () => {
    const a = osm.ways.find((w) => w.id === 1)!
    const b = osm.ways.find((w) => w.id === 2)!
    expect(a.nodes[1]).toBe(b.nodes[1])
    expect(a.nodes[2]).toBe(77)
    expect(osm.nodes.find((n) => n.id === 77)!.tags?.highway).toBe('traffic_signals')
  })

  it('clips roads to the bbox', () => {
    expect(osm.ways.find((w) => w.id === 2)!.nodes).toHaveLength(3)
  })

  it('stringifies tags and drops @-metadata', () => {
    expect(osm.ways.find((w) => w.id === 3)!.tags).toEqual({ building: 'yes', 'building:levels': '2' })
  })
})

describe('loadCityFromGeojson', () => {
  it('builds a connected crossing with a signal node and one building', () => {
    const { network, buildings } = loadCityFromGeojson(fc)
    const centre = [...network.nodes.values()].find((n) => n.geo.lat === LAT && n.geo.lon === LON)!
    expect(centre.in.length + centre.out.length).toBe(2 + 4) // A: in+out, B: two-way both sides
    expect(network.nodes.get(77)!.signal).toBe(true)
    expect(buildings).toHaveLength(1)
    expect(buildings[0].height).toBe(6)
  })
})

describe('Heilbronn extract (public/data/heilbronn.geojson)', () => {
  const file = join(import.meta.dirname, '../../public/data/heilbronn.geojson')
  const city = loadCityFromGeojson(JSON.parse(readFileSync(file, 'utf8')))
  const { network } = city

  it('contains the Karlsruher Straße × Theresienstraße junction', () => {
    const streetsAt = (id: number) => {
      const n = network.nodes.get(id)!
      return new Set([...n.in, ...n.out].map((i) => network.edges[i].name))
    }
    const junction = [...network.nodes.keys()].filter((id) => {
      const s = streetsAt(id)
      return s.has('Karlsruher Straße') && s.has('Theresienstraße')
    })
    expect(junction.length).toBeGreaterThan(0)
  })

  it('places every traffic signal on the drivable network', () => {
    expect([...network.nodes.values()].filter((n) => n.signal)).toHaveLength(19)
  })

  it('keeps all edges inside the bbox and with positive length', () => {
    const { bbox } = network
    for (const e of network.edges) {
      expect(e.length).toBeGreaterThan(0)
      for (const g of e.geo) {
        expect(g.lat).toBeGreaterThanOrEqual(bbox.south)
        expect(g.lat).toBeLessThanOrEqual(bbox.north)
      }
    }
  })

  it('has buildings', () => {
    expect(city.buildings.length).toBeGreaterThan(300)
  })
})
