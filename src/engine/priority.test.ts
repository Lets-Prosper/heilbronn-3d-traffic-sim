import { describe, expect, it } from 'vitest'
import { phaseGroup } from './controllers'
import { createSim, type EntryFlow } from './engine'
import { entryEdges, shortestPath, exitEdges } from './network/routing'
import { crossNetworkForTests } from './testNetworks'

const net = crossNetworkForTests()
const entries = entryEdges(net)
const exits = exitEdges(net)
/** Straight-through route from an entry: the exit on the opposite arm. */
const straight = (entry: number) => {
  const e = net.edges[entry]
  const x = exits.find((i) => net.edges[i].to !== e.from && phaseGroup(net.edges[i]) === phaseGroup(e))!
  return shortestPath(net, entry, x)!
}
// Heavy cross traffic on E–W; the ambulance / bus come from N–S.
const ns = entries.find((i) => phaseGroup(net.edges[i]) === 0)!
const heavyEW: EntryFlow[] = entries.map((edge) => ({ edge, rate: phaseGroup(net.edges[edge]) === 1 ? 0.15 : 0.06 }))

describe('timetabled flows', () => {
  it('spawns exactly one bus per headway', () => {
    const sim = createSim({ seed: 1, network: net, entries: [{ edge: ns, rate: 0, route: straight(ns), kind: 'bus', headway: 120, offset: 10 }] })
    sim.run(600)
    const buses = sim.snapshot().spawned
    expect(buses).toBe(5) // t = 10, 130, 250, 370, 490
  })
})

describe('emergency pre-emption (Mode B)', () => {
  const run = (mode: 'fixed' | 'maxPressure', preempt = true) => {
    let delay = 0
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const sim = createSim({ seed, network: net, entries: heavyEW, mode, maxPressure: { emergencyPreemption: preempt } })
      sim.run(300)
      sim.dispatch(straight(ns), 'emergency', 'ev')
      sim.run(400)
      const trip = sim.metrics.trips.find((t) => t.tag === 'ev')!
      expect(trip.kind).toBe('emergency')
      delay += trip.delay / 6
    }
    return delay
  }

  it('cuts emergency-vehicle delay vs the fixed loop and vs smart control without pre-emption', () => {
    const fixed = run('fixed')
    const noPre = run('maxPressure', false)
    const pre = run('maxPressure', true)
    expect(pre).toBeLessThan(fixed * 0.8)
    expect(pre).toBeLessThan(noPre)
  })

  it('dispatch draws no randomness: A and B still see identical car arrivals', () => {
    const a = createSim({ seed: 4, network: net, entries: heavyEW, mode: 'fixed' })
    const b = createSim({ seed: 4, network: net, entries: heavyEW, mode: 'maxPressure' })
    for (const s of [a, b]) {
      s.run(200)
      s.dispatch(straight(ns), 'emergency', 'ev')
      s.run(400)
    }
    const sa = a.snapshot()
    const sb = b.snapshot()
    expect(sa.spawned + sa.backlog).toBe(sb.spawned + sb.backlog)
  })
})

describe('transit priority (Mode B)', () => {
  it('weights buses so they lose less time than without priority', () => {
    const run = (busWeight: number) => {
      let d = 0
      for (const seed of [1, 2, 3, 4]) {
        const flows: EntryFlow[] = [...heavyEW, { edge: ns, rate: 0, route: straight(ns), kind: 'bus', headway: 90, offset: 5 }]
        const sim = createSim({ seed, network: net, entries: flows, mode: 'maxPressure', maxPressure: { busWeight } })
        sim.run(1800)
        d += sim.snapshot().busDelay / 4
      }
      return d
    }
    expect(run(15)).toBeLessThan(run(0))
  })
})

describe('platoon hold (smoothness)', () => {
  it('reduces stops per vehicle', () => {
    const run = (platoonEtaS: number) => {
      let s = 0
      for (const seed of [1, 2, 3]) {
        const sim = createSim({ seed, network: net, inflow: 0.09, mode: 'maxPressure', maxPressure: { platoonEtaS } })
        sim.run(1800)
        s += sim.snapshot().stopsPerVehicle / 3
      }
      return s
    }
    expect(run(3)).toBeLessThan(run(0))
  })
})
