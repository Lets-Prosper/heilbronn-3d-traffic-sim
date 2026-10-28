import { describe, expect, it } from 'vitest'
import { buildNetwork } from '../engine/network/build'
import type { OsmData } from '../engine/network/types'
import { LANE_WIDTH, buildRoadLayout, curbOffset, laneOffset, offsetPolyline, rightOf, samplePolyline, slicePolyline } from './layout'

const LAT = 49.138
const LON = 9.205
const osm: OsmData = {
  bbox: { south: LAT - 0.002, west: LON - 0.002, north: LAT + 0.002, east: LON + 0.002 },
  nodes: [
    { id: 1, lat: LAT, lon: LON - 0.001 },
    { id: 2, lat: LAT, lon: LON + 0.001 },
    { id: 3, lat: LAT + 0.001, lon: LON - 0.001 },
    { id: 4, lat: LAT + 0.001, lon: LON + 0.001 },
  ],
  ways: [
    { id: 10, nodes: [1, 2], tags: { highway: 'primary', lanes: '4' } }, // two-way, 2+2
    { id: 11, nodes: [3, 4], tags: { highway: 'primary', lanes: '3', oneway: 'yes' } },
  ],
}
const net = buildNetwork(osm)
const layout = buildRoadLayout(net)
const edge = (from: number, to: number) => net.edges.find((e) => e.from === from && e.to === to)!

describe('road layout', () => {
  it('draws each two-way road once, with combined width', () => {
    expect(layout.roads).toHaveLength(2)
    const twoWay = layout.roads.find((r) => r.edge.wayId === 10)!
    expect(twoWay.twin).toBeDefined()
    expect(twoWay.width).toBe(4 * LANE_WIDTH)
    expect(layout.roads.find((r) => r.edge.wayId === 11)!.width).toBe(3 * LANE_WIDTH)
  })

  it('places two-way lanes right of the centerline (right-hand traffic)', () => {
    const e = edge(1, 2)
    expect(laneOffset(layout, e, 0)).toBe(0.5 * LANE_WIDTH)
    expect(laneOffset(layout, e, 1)).toBe(1.5 * LANE_WIDTH)
    expect(curbOffset(layout, e)).toBe(2 * LANE_WIDTH)
  })

  it('centers one-way lanes on the centerline', () => {
    const e = edge(3, 4)
    expect(laneOffset(layout, e, 0)).toBeCloseTo(-LANE_WIDTH)
    expect(laneOffset(layout, e, 1)).toBeCloseTo(0)
    expect(laneOffset(layout, e, 2)).toBeCloseTo(LANE_WIDTH)
    expect(curbOffset(layout, e)).toBeCloseTo(1.5 * LANE_WIDTH)
  })

  it('records node radius as half the widest incident road', () => {
    expect(layout.nodeRadius.get(1)).toBe(2 * LANE_WIDTH)
  })
})

describe('polyline helpers', () => {
  it('right of east is south (+Z), right of north (-Z) is east', () => {
    expect(rightOf(1, 0)).toEqual({ x: -0, z: 1 })
    expect(rightOf(0, -1)).toEqual({ x: 1, z: 0 })
  })

  it('samples position and heading with lateral offset', () => {
    const p = samplePolyline([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }], 15, 1)
    expect(p.x).toBeCloseTo(9)
    expect(p.z).toBeCloseTo(5)
    expect([p.dx, p.dz]).toEqual([0, 1])
  })

  it('offsets with mitered corners', () => {
    const out = offsetPolyline([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }], 1)
    expect(out[0]).toEqual({ x: 0, z: 1 })
    expect(out[1].x).toBeCloseTo(9)
    expect(out[1].z).toBeCloseTo(1)
    expect(out[2]).toEqual({ x: 9, z: 10 })
  })

  it('slices by arc length across vertices', () => {
    const s = slicePolyline([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }], 5, 12)
    expect(s).toEqual([{ x: 5, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 2 }])
  })
})
