// Lat/lon -> local metric XZ plane (equirectangular, tangent at origin).
// Accurate to well under 0.1% over a few km, which is plenty for a city bbox.
// Convention (matches Three.js): +X = east, -Z = north, Y = up.

const EARTH_RADIUS_M = 6_378_137
const DEG = Math.PI / 180

export interface BBox {
  south: number
  west: number
  north: number
  east: number
}

export interface GeoOrigin {
  lat: number
  lon: number
}

export interface XZ {
  x: number
  z: number
}

export function bboxCenter(b: BBox): GeoOrigin {
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 }
}

export function createProjection(origin: GeoOrigin) {
  const kx = EARTH_RADIUS_M * DEG * Math.cos(origin.lat * DEG)
  const kz = EARTH_RADIUS_M * DEG
  return {
    origin,
    toXZ(lat: number, lon: number): XZ {
      return { x: (lon - origin.lon) * kx, z: (origin.lat - lat) * kz }
    },
    toLatLon(p: XZ): GeoOrigin {
      return { lat: origin.lat - p.z / kz, lon: origin.lon + p.x / kx }
    },
  }
}

export type Projection = ReturnType<typeof createProjection>

export function polylineLength(pts: XZ[]): number {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
  return len
}
