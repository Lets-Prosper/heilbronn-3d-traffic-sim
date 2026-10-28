import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCityFromGeojson, type FeatureCollection } from '.'
import { DETECTORS } from './counts'
import demand from './demand2023.json'
import { buildScenario, departSide } from './scenario'

const net = loadCityFromGeojson(
  JSON.parse(readFileSync(join(import.meta.dirname, '../../public/data/heilbronn.geojson'), 'utf8')) as FeatureCollection,
).network

describe('departSide (right-hand traffic)', () => {
  it('maps approach + turn to the exit arm', () => {
    expect(departSide('north', 'right')).toBe('west')
    expect(departSide('north', 'left')).toBe('east')
    expect(departSide('east', 'right')).toBe('north')
    expect(departSide('west', 'left')).toBe('north')
    expect(departSide('south', 'straight')).toBe('north')
  })
})

describe('calibrated scenario', () => {
  it('maps every detector movement onto a connected network route at the counted rate', () => {
    const sc = buildScenario(net, { hour: 7, backgroundRate: 0, busHeadwayS: 0 })
    expect(sc.unmapped).toEqual([])
    expect(sc.movements.map((m) => m.tag).sort()).toEqual(Object.keys(DETECTORS).sort())
    for (const m of sc.movements) {
      expect(m.vph).toBe(demand.weekday[m.tag as keyof typeof demand.weekday][7])
      for (let i = 1; i < m.route.length; i++) expect(net.edges[m.route[i - 1]].to).toBe(net.edges[m.route[i]].from)
    }
    expect(sc.entries).toHaveLength(6)
    const total = sc.entries.reduce((s, e) => s + e.rate * 3600, 0)
    expect(total).toBeCloseTo(372, -1) // weekday 07:00–08:00 sum of the six detectors
  })

  it('routes each movement through the junction onto the labelled arm', () => {
    const sc = buildScenario(net, { backgroundRate: 0 })
    const via = (tag: string) => sc.movements.find((m) => m.tag === tag)!.route.map((i) => net.edges[i].name)
    // D1 = Theresienstraße N right turn -> leaves west on Karlsruher Straße.
    expect(via('D1')).toContain('Karlsruher Straße')
    // D2 = straight -> continues on Theresienstraße, never touches Karlsruher Straße.
    expect(via('D2')).not.toContain('Karlsruher Straße')
    // D4 = Karlsruher E right turn -> leaves on Theresienstraße.
    const d4 = via('D4')
    expect(d4.indexOf('Theresienstraße')).toBeGreaterThan(d4.indexOf('Karlsruher Straße'))
  })

  it('scales flows, and only adds through traffic when explicitly assumed', () => {
    const base = buildScenario(net, { backgroundRate: 0 })
    const x2 = buildScenario(net, { backgroundRate: 0, scale: 2 })
    expect(x2.movements[0].vph).toBeCloseTo(base.movements[0].vph * 2)
    expect(base.movements.some((m) => m.assumed)).toBe(false)
    const through = buildScenario(net, { backgroundRate: 0, assumedThroughVph: 300 })
    expect(through.movements.filter((m) => m.assumed)).toHaveLength(2)
  })
})

describe('transit + emergency routes', () => {
  it('builds four straight-through routes and timetabled (illustrative) bus flows on them', () => {
    const sc = buildScenario(net, { backgroundRate: 0, busHeadwayS: 600 })
    expect(sc.through.map((t) => t.approach).sort()).toEqual(['east', 'north', 'south', 'west'])
    const buses = sc.entries.filter((e) => e.kind === 'bus')
    expect(buses).toHaveLength(4)
    for (const b of buses) expect(b.headway).toBe(600)
    expect(new Set(buses.map((b) => b.offset)).size).toBe(4) // staggered departures
  })
})
