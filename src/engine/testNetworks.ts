// Synthetic networks for tests. Pure TS only (no React/Three/DOM).
import { buildNetwork } from './network/build'
import type { Network, OsmData } from './network/types'

/** Four 2-way arms (~220 m) meeting at one signalized node. */
export function crossNetworkForTests(): Network {
  const c = { lat: 49.14, lon: 9.21 }
  const d = { lat: 0.002, lon: 0.003 }
  const osm: OsmData = {
    bbox: { south: c.lat - d.lat, west: c.lon - d.lon, north: c.lat + d.lat, east: c.lon + d.lon },
    nodes: [
      { id: 1, ...c, tags: { highway: 'traffic_signals' } },
      { id: 2, lat: c.lat + d.lat, lon: c.lon }, // N
      { id: 3, lat: c.lat - d.lat, lon: c.lon }, // S
      { id: 4, lat: c.lat, lon: c.lon + d.lon }, // E
      { id: 5, lat: c.lat, lon: c.lon - d.lon }, // W
    ],
    ways: [2, 3, 4, 5].map((id) => ({ id: 100 + id, nodes: [id, 1], tags: { highway: 'residential', maxspeed: '50' } })),
  }
  return buildNetwork(osm)
}
