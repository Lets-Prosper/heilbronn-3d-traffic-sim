import { describe, expect, it } from 'vitest'
import { interpolate } from './vehicleFrame'

describe('render interpolation', () => {
  it('lerps position and takes the short way round on yaw', () => {
    const prev = new Map([[1, { x: 0, z: 0, yaw: Math.PI - 0.1, stopped: false, kind: 'car' as const }]])
    const p = interpolate(prev, { x: 1, z: 2, yaw: -Math.PI + 0.1, stopped: false, kind: 'car' as const }, 1, 0.5)
    expect(p.x).toBeCloseTo(0.5)
    expect(p.z).toBeCloseTo(1)
    expect(Math.abs(Math.abs(p.yaw) - Math.PI)).toBeLessThan(1e-9)
  })

  it('shows new vehicles at their current pose and snaps big jumps', () => {
    const curr = { x: 5, z: 5, yaw: 0, stopped: true, kind: 'car' as const }
    expect(interpolate(new Map(), curr, 9, 0.5)).toBe(curr)
    expect(interpolate(new Map([[9, { x: 100, z: 0, yaw: 0, stopped: false, kind: 'car' as const }]]), curr, 9, 0.5)).toBe(curr)
  })
})
