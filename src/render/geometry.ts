// Merged static geometry for the city: one BufferGeometry per visual layer.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { polylineLength as polylineLen, type XZ } from '../engine/network/geo'
import type { Building, Network } from '../engine/network/types'
import { LANE_WIDTH, SIDEWALK_WIDTH, offsetPolyline, slicePolyline, type RoadLayout } from './layout'

/** Accumulates flat (y-up) triangles into a single indexed geometry. */
class FlatMesh {
  private pos: number[] = []
  private idx: number[] = []
  private y: number
  constructor(y: number) {
    this.y = y
  }

  /** Ribbon of `width` centered on polyline (optionally shifted right by `offset`). */
  ribbon(pts: XZ[], width: number, offset = 0) {
    if (pts.length < 2) return
    const l = offsetPolyline(pts, offset - width / 2)
    const r = offsetPolyline(pts, offset + width / 2)
    const base = this.pos.length / 3
    for (let i = 0; i < pts.length; i++) {
      this.pos.push(l[i].x, this.y, l[i].z, r[i].x, this.y, r[i].z)
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = base + i * 2
      // l_i, r_i, l_i+1, r_i+1 — wound so the face points +Y
      this.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }

  disc(c: XZ, radius: number, segments = 20) {
    const base = this.pos.length / 3
    this.pos.push(c.x, this.y, c.z)
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2
      this.pos.push(c.x + Math.cos(t) * radius, this.y, c.z + Math.sin(t) * radius)
    }
    for (let i = 1; i <= segments; i++) this.idx.push(base, base + i + 1, base + i)
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(this.pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    return g
  }
}

export const LAYER_Y = { sidewalk: 0.06, road: 0.12, marking: 0.18 }

const DASH = 3
const GAP = 6
const MARK_W = 0.15

export interface RoadGeometries {
  sidewalks: THREE.BufferGeometry
  roads: THREE.BufferGeometry
  markings: THREE.BufferGeometry
}

export function buildRoadGeometries(net: Network, layout: RoadLayout): RoadGeometries {
  const sidewalks = new FlatMesh(LAYER_Y.sidewalk)
  const roads = new FlatMesh(LAYER_Y.road)
  const marks = new FlatMesh(LAYER_Y.marking)

  for (const { edge, twin, width } of layout.roads) {
    roads.ribbon(edge.points, width)
    sidewalks.ribbon(edge.points, width + 2 * SIDEWALK_WIDTH)

    // Keep markings out of junction areas.
    const len = polylineLen(edge.points)
    const s0 = (layout.nodeRadius.get(edge.from) ?? 0) + 1
    const s1 = len - (layout.nodeRadius.get(edge.to) ?? 0) - 1
    if (s1 - s0 < DASH) continue
    const inner = slicePolyline(edge.points, s0, s1)

    const dashed = (offset: number) => {
      for (let s = 0; s < s1 - s0; s += DASH + GAP) marks.ribbon(slicePolyline(inner, s, Math.min(s + DASH, s1 - s0)), MARK_W, offset)
    }
    if (twin) {
      // Center line between directions (solid on multi-lane roads), then lane dividers per side.
      if (edge.lanes + twin.lanes >= 4) marks.ribbon(inner, MARK_W, 0)
      else dashed(0)
      for (let i = 1; i < edge.lanes; i++) dashed(i * LANE_WIDTH)
      for (let i = 1; i < twin.lanes; i++) dashed(-i * LANE_WIDTH)
    } else {
      for (let i = 1; i < edge.lanes; i++) dashed(-width / 2 + i * LANE_WIDTH)
    }
  }

  // Junction fills: cover ribbon seams where roads meet.
  for (const [id, r] of layout.nodeRadius) {
    const n = net.nodes.get(id)!
    if (n.in.length + n.out.length <= 2) continue
    roads.disc(n.pos, r * 1.05)
    sidewalks.disc(n.pos, r * 1.05 + SIDEWALK_WIDTH)
  }

  // Stop lines at signal nodes, across the lanes of each approach.
  for (const n of net.nodes.values()) {
    if (!n.signal) continue
    for (const i of n.in) {
      const e = net.edges[i]
      const len = polylineLen(e.points)
      if (len < 2) continue
      const seg = slicePolyline(e.points, len - 1.6, len - 1.1)
      const twoWay = layout.twinOf.has(e.index)
      const w = e.lanes * LANE_WIDTH
      marks.ribbon(seg, w, twoWay ? w / 2 : 0)
    }
  }

  return { sidewalks: sidewalks.build(), roads: roads.build(), markings: marks.build() }
}

const WALL_COLORS = ['#f3e3c9', '#f0d5bf', '#ead2b0', '#e2e4e2', '#f6efe2', '#dcc6b2', '#ecdccb', '#d9dfe3', '#f1e6d6']
const ROOF_COLORS = ['#b9886f', '#a9a49c', '#c7a184', '#9fa7ad', '#bdb3a4']

function hash(n: number): number {
  let x = n | 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  return (x ^ (x >>> 16)) >>> 0
}

export function buildBuildingGeometry(buildings: Building[]): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = []
  const wall = new THREE.Color()
  const roof = new THREE.Color()
  for (const b of buildings) {
    if (b.footprint.length < 3) continue
    // Shape in XY with y = -z; rotating -90° about X maps (x, y, depth) -> (x, depth, -y) = (x, height, z).
    const shape = new THREE.Shape(b.footprint.map((p) => new THREE.Vector2(p.x, -p.z)))
    let g: THREE.BufferGeometry
    try {
      g = new THREE.ExtrudeGeometry(shape, { depth: b.height, bevelEnabled: false })
    } catch {
      continue
    }
    g.rotateX(-Math.PI / 2)
    g.deleteAttribute('uv')
    const h = hash(b.id)
    wall.set(WALL_COLORS[h % WALL_COLORS.length])
    roof.set(ROOF_COLORS[(h >>> 8) % ROOF_COLORS.length])
    g.computeVertexNormals()
    const normals = g.getAttribute('normal')
    const colors = new Float32Array(normals.count * 3)
    for (let i = 0; i < normals.count; i++) {
      const c = normals.getY(i) > 0.5 ? roof : wall
      colors.set([c.r, c.g, c.b], i * 3)
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    parts.push(g)
  }
  if (!parts.length) return null
  const merged = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  return merged
}

/** Low-poly car, forward = +X, length ~4.3 m. Vertex colors: 1 = tinted by instance color, dark = wheels/glass. */
export function buildCarGeometry(): THREE.BufferGeometry {
  const parts: [THREE.BufferGeometry, number][] = []
  const body = new THREE.BoxGeometry(4.3, 0.8, 1.8)
  body.translate(0, 0.65, 0)
  parts.push([body, 1])
  const cabin = new THREE.BoxGeometry(2.3, 0.65, 1.6)
  cabin.translate(-0.25, 1.37, 0)
  parts.push([cabin, 0.92])
  const glass = new THREE.BoxGeometry(2.0, 0.5, 1.64)
  glass.translate(-0.25, 1.37, 0)
  parts.push([glass, 0.18])
  for (const [x, z] of [[1.35, 0.85], [1.35, -0.85], [-1.35, 0.85], [-1.35, -0.85]]) {
    const w = new THREE.CylinderGeometry(0.36, 0.36, 0.3, 10)
    w.rotateX(Math.PI / 2)
    w.translate(x, 0.36, z)
    parts.push([w, 0.08])
  }
  const geos = parts.map(([g, shade]) => {
    const ng = g.index ? g.toNonIndexed() : g
    ng.deleteAttribute('uv')
    ng.setAttribute('color', new THREE.Float32BufferAttribute(new Array(ng.getAttribute('position').count * 3).fill(shade), 3))
    return ng
  })
  return mergeGeometries(geos, false)!
}

/** Pair of tail lamps at the rear of the car mesh (same local frame as buildCarGeometry). */
export function buildBrakeLightGeometry(): THREE.BufferGeometry {
  const lamps = [0.58, -0.58].map((z) => {
    const g = new THREE.BoxGeometry(0.1, 0.26, 0.55)
    g.translate(-2.18, 0.82, z)
    return g
  })
  const merged = mergeGeometries(lamps, false)!
  for (const g of lamps) g.dispose()
  return merged
}

type Part = [THREE.BufferGeometry, string]

/** Merge boxes with baked vertex colors (hex), forward = +X. */
function coloredParts(parts: Part[]): THREE.BufferGeometry {
  const c = new THREE.Color()
  const geos = parts.map(([g, hex]) => {
    const ng = g.index ? g.toNonIndexed() : g
    ng.deleteAttribute('uv')
    c.set(hex)
    const n = ng.getAttribute('position').count
    const col = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3)
    ng.setAttribute('color', new THREE.BufferAttribute(col, 3))
    return ng
  })
  return mergeGeometries(geos, false)!
}

function box(w: number, h: number, d: number, x: number, y: number, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  return g
}

function wheels(xs: number[], halfTrack: number, r: number): Part[] {
  return xs.flatMap((x) =>
    [halfTrack, -halfTrack].map((z): Part => {
      const w = new THREE.CylinderGeometry(r, r, 0.32, 12)
      w.rotateX(Math.PI / 2)
      w.translate(x, r, z)
      return [w, '#1b1d21']
    }),
  )
}

/** 12 m city bus, centred, forward = +X. */
export function buildBusGeometry(): THREE.BufferGeometry {
  return coloredParts([
    [box(11.8, 2.2, 2.5, 0, 1.55), '#d8392f'],
    [box(11.4, 0.85, 2.54, -0.1, 2.05), '#20262e'], // window band
    [box(11.8, 0.25, 2.45, 0, 2.95), '#f2f2ee'], // roof
    [box(0.06, 1.2, 2.2, 5.92, 1.9), '#20262e'], // windscreen
    ...wheels([3.9, -3.4], 1.05, 0.5),
  ])
}

/** Ambulance-style van, centred, forward = +X. */
export function buildEmergencyGeometry(): THREE.BufferGeometry {
  return coloredParts([
    [box(5.6, 2.0, 2.1, -0.2, 1.4), '#f7f7f2'],
    [box(1.2, 1.1, 2.0, 2.4, 0.95), '#f7f7f2'], // bonnet
    [box(5.62, 0.35, 2.12, -0.2, 1.15), '#d0201b'], // red stripe
    [box(0.06, 0.7, 1.8, 1.82, 1.85), '#20262e'], // windscreen
    ...wheels([1.9, -1.9], 0.9, 0.38),
  ])
}

/** Light bar on the emergency vehicle's roof. */
export function buildLightBarGeometry(): THREE.BufferGeometry {
  return box(0.5, 0.18, 1.6, 1.3, 2.5)
}

/** Brake lamps for a vehicle of half-length `half`, in its local frame. */
export function buildBrakeLightGeometryFor(half: number, y = 0.82, spread = 0.58): THREE.BufferGeometry {
  const lamps = [spread, -spread].map((z) => box(0.1, 0.26, 0.55, -half - 0.03, y, z))
  const merged = mergeGeometries(lamps, false)!
  for (const g of lamps) g.dispose()
  return merged
}
