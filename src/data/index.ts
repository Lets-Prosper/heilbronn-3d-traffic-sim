// Loaders: OSM geometry (counts CSV in a later stage).
import { buildBuildings, buildNetwork } from '../engine/network'
import type { Building, Network, OsmData } from '../engine/network/types'
import { geojsonToOsmData, type FeatureCollection, type GeojsonOptions } from './geojson'

export * from './geojson'

export interface CityGeometry {
  network: Network
  buildings: Building[]
}

export function buildCity(osm: OsmData): CityGeometry {
  return { network: buildNetwork(osm), buildings: buildBuildings(osm) }
}

export function loadCityFromGeojson(fc: FeatureCollection, opts?: GeojsonOptions): CityGeometry {
  return buildCity(geojsonToOsmData(fc, opts))
}
