import { describe, expect, it } from 'vitest'
import { crossNetworkForTests } from '../engine/testNetworks'
import { buildRoadLayout } from './layout'
import { buildZoneMesh } from './zoneGeometry'

describe('detection zone ribbon', () => {
  it('covers the approach lanes and fades from the stop line upstream', () => {
    const net = crossNetworkForTests()
    const layout = buildRoadLayout(net)
    const approach = net.edges.find((e) => e.to === 1)!
    const z = buildZoneMesh(net, layout, approach.index, 100)
    expect(z.indices.length).toBeGreaterThan(0)
    expect(Math.max(...z.fade)).toBeCloseTo(1)
    expect(Math.min(...z.fade)).toBeCloseTo(0, 1)
    expect(z.positions.length / 3).toBe(z.fade.length)
  })
})
