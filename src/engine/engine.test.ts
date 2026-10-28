import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRng } from './rng'
import { createSim, DT } from './engine'

describe('rng', () => {
  it('is deterministic for a given seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    const seqA = Array.from({ length: 100 }, () => a.next())
    const seqB = Array.from({ length: 100 }, () => b.next())
    expect(seqA).toEqual(seqB)
  })

  it('differs across seeds and stays in [0, 1)', () => {
    const a = createRng(1)
    const b = createRng(2)
    expect(a.next()).not.toBe(b.next())
    const r = createRng(7)
    for (let i = 0; i < 10_000; i++) {
      const v = r.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('engine', () => {
  it('advances at a fixed 10 Hz timestep', () => {
    const sim = createSim({ seed: 1 })
    for (let i = 0; i < 600; i++) sim.step()
    expect(sim.state.tick).toBe(600)
    expect(sim.state.time).toBeCloseTo(600 * DT)
    expect(sim.state.time).toBeCloseTo(60)
  })
})

describe('architecture', () => {
  it('engine/ has no React, Three.js, or DOM imports', () => {
    const dir = import.meta.dirname
    const forbidden = /from\s+['"](react|react-dom|three|@react-three\/[^'"]+|zustand)['"]/
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8')
      expect(src, `${f} imports a forbidden module`).not.toMatch(forbidden)
      expect(src, `${f} touches the DOM`).not.toMatch(/\b(window|document)\./)
    }
  })
})
