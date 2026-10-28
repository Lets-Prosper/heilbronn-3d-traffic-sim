import { describe, expect, it } from 'vitest'
import { crossNetworkForTests } from '../testNetworks'
import { createSim } from '../engine'
import { estimateEmissions, IDLE_CO2_G_PER_S } from './emissions'

describe('emissions estimate', () => {
  it('idle term = TRL 17 g CO2/min', () => {
    const e = estimateEmissions({ totalIdle: 60, stopV2Sum: 0 })
    expect(e.co2Kg * 1000).toBeCloseTo(17)
    expect(e.noxG).toBeCloseTo(0.07)
    expect(IDLE_CO2_G_PER_S * 3600).toBeCloseTo(1020)
  })

  it('one stop from 50 km/h costs ≈ 50 g CO2 (re-acceleration energy)', () => {
    const v = 50 / 3.6
    const e = estimateEmissions({ totalIdle: 0, stopV2Sum: v * v })
    expect(e.stopCo2Kg * 1000).toBeGreaterThan(45)
    expect(e.stopCo2Kg * 1000).toBeLessThan(55)
    expect(e.noxG).toBe(0)
  })

  it('counts stops at red lights and fewer with max-pressure', () => {
    const run = (mode: 'fixed' | 'maxPressure') => {
      const sim = createSim({ seed: 2, network: crossNetworkForTests(), inflow: 0.05, mode })
      sim.run(1200)
      return sim.snapshot()
    }
    const a = run('fixed')
    const b = run('maxPressure')
    expect(a.stops).toBeGreaterThan(20)
    expect(a.stopV2Sum).toBeGreaterThan(0)
    expect(b.stops).toBeLessThan(a.stops)
    expect(estimateEmissions(b).co2Kg).toBeLessThan(estimateEmissions(a).co2Kg)
  })
})
