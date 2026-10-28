// Parse the OSM GeoJSON extract and print a summary of the network + buildings.
//   npm run inspect-city [-- path/to/file.geojson]
import { readFileSync } from 'node:fs'
import { loadCityFromGeojson, type FeatureCollection } from '../src/data'

const file = process.argv[2] ?? 'public/data/heilbronn.geojson'
const fc = JSON.parse(readFileSync(file, 'utf8')) as FeatureCollection
const { network, buildings } = loadCityFromGeojson(fc)
const nodes = [...network.nodes.values()]
const { bbox, origin } = network
const f = (n: number, d = 1) => n.toFixed(d)

const bbW = (bbox.east - bbox.west) * 111_320 * Math.cos((origin.lat * Math.PI) / 180)
const bbH = (bbox.north - bbox.south) * 111_320
console.log(`file: ${file}`)
console.log(`bbox: S ${f(bbox.south, 5)} W ${f(bbox.west, 5)} N ${f(bbox.north, 5)} E ${f(bbox.east, 5)}  (~${f(bbW, 0)} x ${f(bbH, 0)} m)`)
console.log(`origin: ${f(origin.lat, 6)}, ${f(origin.lon, 6)}`)

const intersections = nodes.filter((n) => new Set([...n.in, ...n.out].map((i) => network.edges[i].wayId)).size > 1)
const signals = nodes.filter((n) => n.signal)
const totalKm = network.edges.reduce((s, e) => s + e.length, 0) / 1000
console.log(`\nNETWORK`)
console.log(`  nodes:          ${nodes.length}  (intersections ${intersections.length}, signal nodes ${signals.length})`)
console.log(`  directed edges: ${network.edges.length}  (${f(totalKm, 2)} lane-direction km)`)

const byClass = new Map<string, number>()
for (const e of network.edges) byClass.set(e.highway, (byClass.get(e.highway) ?? 0) + 1)
console.log(`  edges by class: ${[...byClass].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`)

const streetsAt = (id: number) => {
  const n = network.nodes.get(id)!
  return new Set([...n.in, ...n.out].map((i) => network.edges[i].name).filter(Boolean))
}

console.log(`\nKarlsruher Straße × Theresienstraße junction:`)
const junction = nodes.filter((n) => {
  const s = streetsAt(n.id)
  return s.has('Karlsruher Straße') && s.has('Theresienstraße')
})
if (!junction.length) console.log('  NOT FOUND')
for (const n of junction) {
  const edges = [...n.in.map((i) => ({ dir: 'in ', e: network.edges[i] })), ...n.out.map((i) => ({ dir: 'out', e: network.edges[i] }))]
  console.log(`  node ${n.id} @ ${f(n.geo.lat, 6)}, ${f(n.geo.lon, 6)}  -> XZ (${f(n.pos.x)}, ${f(n.pos.z)}) m  signal=${n.signal}`)
  for (const { dir, e } of edges) {
    const other = dir === 'in ' ? e.from : e.to
    console.log(`    ${dir} ${e.name.padEnd(18)} ${e.highway.padEnd(10)} lanes ${e.lanes}  ${f(e.length).padStart(6)} m  ${f(e.speedLimit * 3.6, 0)} km/h  ${dir === 'in ' ? 'from' : 'to'} ${other}`)
  }
}

// Signals within 60 m of the junction (signals often sit on approaches, not the junction node itself).
for (const j of junction) {
  const near = signals.filter((s) => Math.hypot(s.pos.x - j.pos.x, s.pos.z - j.pos.z) < 60)
  console.log(`  signal nodes within 60 m: ${near.length}  ${near.map((s) => `${s.id}(${f(Math.hypot(s.pos.x - j.pos.x, s.pos.z - j.pos.z), 0)}m)`).join(' ')}`)
}

const unmatchedSignals = fc.features.filter((x) => x.geometry?.type === 'Point' && x.properties.highway === 'traffic_signals').length - signals.length
console.log(`  signal points not on a drivable road in bbox: ${unmatchedSignals}`)

const heights = buildings.map((b) => b.height).sort((a, b) => a - b)
const defaulted = fc.features.filter((x) => x.properties.building && !x.properties.height && !x.properties['building:levels']).length
console.log(`\nBUILDINGS`)
console.log(`  count: ${buildings.length}  (height from tags: ${buildings.length - defaulted}, default 9 m: ${defaulted})`)
console.log(`  height min/median/max: ${f(heights[0])} / ${f(heights[heights.length >> 1])} / ${f(heights[heights.length - 1])} m`)
