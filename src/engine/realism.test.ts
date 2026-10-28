import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCityFromGeojson, type FeatureCollection } from '../data'
import { buildIntersections, phaseGroup } from './controllers'
import { createSim } from './engine'
import { createConflictTable } from './network/conflicts'
import { crossNetworkForTests } from './testNetworks'

const cross = crossNetworkForTests()
const into = (g: 0 | 1) => cross.edges.filter((e) => e.to === 1 && phaseGroup(e) === g).map((e) => e.index)
const outOf = (g: 0 | 1) => cross.edges.filter((e) => e.from === 1 && phaseGroup(e) === g).map((e) => e.index)
const opposite = (i: number) => cross.edges.find((e) => e.from === 1 && e.to !== cross.edges[i].from && phaseGroup(e) === phaseGroup(cross.edges[i]))!.index

describe('movement conflicts', () => {
  const c = createConflictTable(cross)
  it('crossing through-movements conflict, opposite through-movements do not', () => {
    const [n] = into(0)
    const [e] = into(1)
    expect(c(n, opposite(n), e, opposite(e))).toBe(true)
    const [n1, n2] = into(0)
    expect(c(n1, opposite(n1), n2, opposite(n2))).toBe(false)
  })
  it('merges into the same exit conflict', () => {
    const [n] = into(0)
    const [e] = into(1)
    const [x] = outOf(0).filter((o) => cross.edges[o].to !== cross.edges[n].from)
    expect(c(n, x, e, x)).toBe(true)
  })
})

describe('no vehicles inside each other', () => {
  it('keeps every same-lane gap non-negative (bumper to bumper) on a busy junction, both modes', () => {
    for (const mode of ['fixed', 'maxPressure'] as const) {
      const sim = createSim({ seed: 8, network: cross, inflow: 0.1, mode })
      let worst = Infinity
      for (let t = 0; t < 6000; t++) {
        sim.step()
        if (t % 10) continue
        const byLane = new Map<string, { pos: number; length: number }[]>()
        for (const v of sim.state.vehicles.values()) {
          const k = `${v.edge}:${v.lane}`
          if (!byLane.has(k)) byLane.set(k, [])
          byLane.get(k)!.push(v)
        }
        for (const l of byLane.values()) {
          l.sort((a, b) => b.pos - a.pos)
          for (let i = 1; i < l.length; i++) worst = Math.min(worst, l[i - 1].pos - l[i - 1].length - l[i].pos)
        }
      }
      expect(worst, mode).toBeGreaterThan(-0.05)
    }
  })
})

describe('pedestrian crossings (on demand in smart mode)', () => {
  const net = loadCityFromGeojson(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../public/data/heilbronn.geojson'), 'utf8')) as FeatureCollection,
  ).network
  const crossing = buildIntersections(net).find((x) => x.groups.length < 2 && x.nodes.length === 2)!

  it('stays green for vehicles more of the time than the fixed loop', () => {
    const greenShare = (mode: 'fixed' | 'maxPressure') => {
      const sim = createSim({ seed: 3, network: net, inflow: 0.01, mode })
      const a = crossing.approaches[0]
      let green = 0
      for (let t = 0; t < 6000; t++) {
        sim.step()
        if (sim.signals.aspect(a.node, a.edge) === 'green') green++
      }
      return green / 6000
    }
    const fixed = greenShare('fixed')
    const smart = greenShare('maxPressure')
    expect(smart).toBeGreaterThan(fixed + 0.2)
    expect(smart).toBeLessThan(1) // pedestrians still get served
  })
})

describe('no gridlock in the main junction', () => {
  const net = loadCityFromGeojson(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../public/data/heilbronn.geojson'), 'utf8')) as FeatureCollection,
  ).network

  it('never routes a U-turn across a dual-carriageway median', async () => {
    const { successors } = await import('./network/routing')
    const { turnAngle } = await import('./network/conflicts')
    for (const e of net.edges) {
      const outs = successors(net, e.index)
      if (net.nodes.get(e.to)!.out.length > outs.length || outs.length > 1) {
        for (const o of outs) expect(Math.abs(turnAngle(e, net.edges[o])), `e${e.index}->e${o}`).toBeLessThan((125 * Math.PI) / 180 + 1e-9)
      }
    }
  })

  it('keeps traffic moving through the junction under extreme demand + ambulances (regression: seed 13 locked at 474 s)', async () => {
    const { buildScenario, junctionNodes } = await import('../data/scenario')
    const J = junctionNodes(net)
    const near = new Set(net.edges.filter((e) => J.has(e.from) || J.has(e.to)).map((e) => e.index))
    const sc = buildScenario(net, { scale: 3, assumedThroughVph: 600, busHeadwayS: 300 })
    const sim = createSim({ seed: 13, network: net, entries: sc.entries, mode: 'maxPressure' })
    const last = new Map<number, number>()
    let lastMove = 0
    for (let t = 1; t <= 900; t++) {
      sim.run(1)
      if (t % 97 === 0) sim.dispatch(sc.through[(t / 97) % 4].route, 'emergency', `ev${t}`)
      let moved = false
      let present = 0
      for (const v of sim.state.vehicles.values()) {
        if (!near.has(v.edge)) continue
        present++
        const p = v.ri * 1000 + v.pos
        if (last.get(v.id) === undefined || p - last.get(v.id)! > 0.5) moved = true
        last.set(v.id, p)
      }
      if (moved || present === 0) lastMove = t
      expect(t - lastMove, `frozen since ${lastMove}`).toBeLessThan(120)
    }
  }, 60_000)
})
