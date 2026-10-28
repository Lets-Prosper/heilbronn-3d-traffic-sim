import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCityFromGeojson, type FeatureCollection } from '../data'
import { buildIntersections, createFixedCycleController, createMaxPressureController, phaseGroup } from './controllers'
import { createSim, type SimConfig } from './engine'
import { entryEdges, exitEdges, shortestPath } from './network/routing'
import type { Network } from './network/types'
import { crossNetworkForTests } from './testNetworks'

const crossNetwork = crossNetworkForTests

const cityNetwork = (() => {
  let net: Network | undefined
  return () => {
    if (!net) {
      const file = join(import.meta.dirname, '../../public/data/heilbronn.geojson')
      net = loadCityFromGeojson(JSON.parse(readFileSync(file, 'utf8')) as FeatureCollection).network
    }
    return net
  }
})()

/** Digest of everything observable: metrics + every vehicle's kinematic state. */
function runDigest(cfg: SimConfig, seconds: number) {
  const sim = createSim(cfg)
  sim.run(seconds)
  return {
    metrics: sim.snapshot(),
    vehicles: [...sim.state.vehicles.values()].map((v) => [v.id, v.edge, v.lane, v.pos, v.speed]),
    trips: sim.metrics.trips.map((t) => [t.id, t.exit, t.wait, t.travel]),
  }
}

describe('routing', () => {
  it('finds boundary entries/exits and U-turn-free shortest paths', () => {
    const net = crossNetwork()
    const entries = entryEdges(net)
    const exits = exitEdges(net)
    expect(entries).toHaveLength(4)
    expect(exits).toHaveLength(4)
    for (const en of entries) {
      for (const ex of exits) {
        if (net.edges[ex].to === net.edges[en].from) continue
        const p = shortestPath(net, en, ex)!
        expect(p).toEqual([en, ex])
      }
    }
  })
})

describe('fixed-cycle signals', () => {
  it('alternates NS/EW green on a fixed loop with amber + all-red', () => {
    const net = crossNetwork()
    const ctl = createFixedCycleController(net, { greens: [20, 10], amber: 3, allRed: 2 })
    expect(ctl.cycle).toBe(40)
    const ns = net.edges.find((e) => e.to === 1 && phaseGroup(e) === 0)!
    const ew = net.edges.find((e) => e.to === 1 && phaseGroup(e) === 1)!
    const at = (t: number) => (ctl.update(t), [ctl.aspect(1, ns.index), ctl.aspect(1, ew.index)])
    expect(at(0)).toEqual(['green', 'red'])
    expect(at(21)).toEqual(['amber', 'red'])
    expect(at(24)).toEqual(['red', 'red'])
    expect(at(25)).toEqual(['red', 'green'])
    expect(at(36)).toEqual(['red', 'amber'])
    expect(at(40)).toEqual(['green', 'red']) // loops
    expect(ctl.aspect(2, ns.index)).toBe('green') // unsignalized node
  })
})

describe('sim: determinism', () => {
  it('same seed -> identical result (synthetic cross)', () => {
    const cfg = { seed: 7, network: crossNetwork(), inflow: 0.08 }
    expect(runDigest(cfg, 600)).toEqual(runDigest(cfg, 600))
  })

  it('same seed -> identical result (Heilbronn network); different seed differs', () => {
    const a = runDigest({ seed: 42, network: cityNetwork() }, 600)
    const b = runDigest({ seed: 42, network: cityNetwork() }, 600)
    const c = runDigest({ seed: 43, network: cityNetwork() }, 600)
    expect(a).toEqual(b)
    expect(c).not.toEqual(a)
    expect(a.metrics.exited).toBeGreaterThan(0)
    for (const [, , , pos, speed] of a.vehicles) {
      expect(Number.isFinite(pos)).toBe(true)
      expect(speed).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('sim: sanity', () => {
  it('higher inflow -> longer queues and waits', () => {
    const run = (inflow: number) => {
      const sim = createSim({ seed: 3, network: crossNetwork(), inflow })
      sim.run(1800)
      return sim.snapshot()
    }
    const low = run(0.02)
    const high = run(0.12)
    expect(high.meanQueue).toBeGreaterThan(low.meanQueue * 2)
    expect(high.totalIdle).toBeGreaterThan(low.totalIdle * 2)
    expect(high.meanWait).toBeGreaterThan(low.meanWait)
    expect(high.exited).toBeGreaterThan(low.exited)
  })

  it('vehicles queue on red and only proceed on green', () => {
    const net = crossNetwork()
    // NS always green, EW never green.
    const sim = createSim({ seed: 5, network: net, inflow: 0.05, signals: { greens: [60, 0], allRed: 0 } })
    sim.run(900)
    const ewEntries = new Set(entryEdges(net).filter((i) => phaseGroup(net.edges[i]) === 1))
    const trips = sim.metrics.trips
    expect(trips.some((t) => !ewEntries.has(t.entry))).toBe(true)
    expect(trips.filter((t) => ewEntries.has(t.entry))).toHaveLength(0)
    const queuedEW = [...sim.state.vehicles.values()].filter((v) => ewEntries.has(v.edge) && v.speed < 0.5)
    expect(queuedEW.length).toBeGreaterThan(5)
    // Queued vehicles stop before the stop line, never past it.
    for (const v of queuedEW) expect(v.pos).toBeLessThan(net.edges[v.edge].length)
  })

  it('accumulates throughput, wait and idle consistently', () => {
    const sim = createSim({ seed: 11, network: crossNetwork(), inflow: 0.06 })
    sim.run(1200)
    const m = sim.snapshot()
    expect(m.spawned).toBe(m.exited + m.active)
    const tripWait = sim.metrics.trips.reduce((s, t) => s + t.wait, 0)
    const activeWait = [...sim.state.vehicles.values()].reduce((s, v) => s + v.wait, 0)
    expect(m.totalIdle).toBeCloseTo(tripWait + activeWait, 6)
    expect(m.meanWait).toBeGreaterThan(0) // 30/70 s red: someone waited
    expect(m.throughputPerHour).toBeCloseTo((m.exited / 1200) * 3600, 6)
  })
})

describe('intersections', () => {
  it('clusters the Karlsruher × Theresienstraße stop lines into one two-phase intersection', () => {
    const net = cityNetwork()
    const xs = buildIntersections(net)
    const j = xs.find((x) => x.nodes.includes(769013083))!
    expect(j.nodes).toHaveLength(5)
    expect(j.groups).toEqual([0, 1])
    // Theresienstraße approaches are N–S, Karlsruher Straße approaches E–W.
    for (const a of j.approaches) {
      expect(a.group).toBe(net.edges[a.edge].name === 'Karlsruher Straße' ? 1 : 0)
    }
  })

  it('does not put stop lines on movements leaving an intersection', () => {
    // Frankfurter Str × Weststraße: 4 two-way signal nodes; each has one inbound and one outbound in-edge.
    const net = cityNetwork()
    const x = buildIntersections(net).find((i) => i.nodes.includes(12985398886))!
    const controlled = x.approaches.map((a) => a.edge).sort((p, q) => p - q)
    expect(controlled).toHaveLength(4)
    for (const outbound of [13, 152, 181, 182]) expect(controlled).not.toContain(outbound)
  })
})

describe('max-pressure (Mode B)', () => {
  /** NS arms carry 4× the EW demand: a fixed 30/30 split wastes green on EW. */
  const asymmetric = (net: Network) => {
    const nsHeavy = entryEdges(net).map((edge) => ({ edge, rate: phaseGroup(net.edges[edge]) === 0 ? 0.12 : 0.03 }))
    return { seed: 9, network: net, entries: nsHeavy }
  }

  it('gives green to the higher-pressure phase, with amber + all-red on switch', () => {
    const net = crossNetwork()
    const ctl = createMaxPressureController(net, { minGreen: 4, decisionInterval: 1, amber: 3, allRed: 2 })
    const ns = net.edges.filter((e) => e.to === 1 && phaseGroup(e) === 0).map((e) => e.index)
    const ew = net.edges.filter((e) => e.to === 1 && phaseGroup(e) === 1).map((e) => e.index)
    const queued = new Set(ew)
    const view = { count: (e: number) => (queued.has(e) ? 5 : 0), lanes: () => 1 }
    const at = (t: number) => (ctl.update(t, view), [ctl.aspect(1, ns[0]), ctl.aspect(1, ew[0])])
    // Starts all-red -> first green goes to group 1 = EW, which has the queue.
    expect(at(0)).toEqual(['red', 'green'])
    expect(at(10)).toEqual(['red', 'green']) // NS empty: no reason to switch
    queued.clear()
    for (const e of ns) queued.add(e)
    expect(at(11)).toEqual(['red', 'amber'])
    expect(at(14)).toEqual(['red', 'red'])
    expect(at(16)).toEqual(['green', 'red'])
  })

  it('same seed + demand: identical arrivals in A and B, B drains queues faster', () => {
    const net = crossNetwork()
    const runMode = (mode: 'fixed' | 'maxPressure') => {
      const sim = createSim({ ...asymmetric(net), mode })
      sim.run(1800)
      return sim.snapshot()
    }
    const a = runMode('fixed')
    const b = runMode('maxPressure')
    expect(b.spawned + b.backlog).toBe(a.spawned + a.backlog)
    expect(b.meanQueue).toBeLessThan(a.meanQueue * 0.8)
    expect(b.meanWait).toBeLessThan(a.meanWait)
    expect(b.exited).toBeGreaterThanOrEqual(a.exited)
  })

  it('is deterministic, and hot-swapping A -> B mid-run cuts the queue', () => {
    const net = crossNetwork()
    const cfg = { ...asymmetric(net), mode: 'maxPressure' as const }
    expect(runDigest(cfg, 600)).toEqual(runDigest(cfg, 600))

    const stay = createSim(asymmetric(net))
    const swap = createSim(asymmetric(net))
    stay.run(900)
    swap.run(900)
    swap.setMode('maxPressure')
    expect(swap.mode).toBe('maxPressure')
    stay.run(900)
    swap.run(900)
    expect(swap.snapshot().queueRecent).toBeLessThan(stay.snapshot().queueRecent)
  })
})
