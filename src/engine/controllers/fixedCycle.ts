import { approachKey, buildIntersections, indexApproaches, type Intersection, type PhaseGroup } from './intersections'
import type { SignalAspect, SignalController } from './types'
import type { Network } from '../network/types'

export interface FixedCycleConfig {
  /** Green seconds for [north–south, east–west]. 0 = that group never gets green. */
  greens: [number, number]
  amber: number
  allRed: number
  /** Cycle offset, s. */
  offset: number
}

export const DEFAULT_FIXED_CYCLE: FixedCycleConfig = { greens: [30, 30], amber: 3, allRed: 2, offset: 0 }

/** Pure timeline: [NS green][NS amber][all-red][EW green][EW amber][all-red] -> repeat. */
export function fixedCycleTimeline(cfg: Partial<FixedCycleConfig> = {}) {
  const c = { ...DEFAULT_FIXED_CYCLE, ...cfg }
  const amberOf = (g: number) => (g > 0 ? c.amber : 0)
  const span0 = c.greens[0] + amberOf(c.greens[0]) + c.allRed
  const span1 = c.greens[1] + amberOf(c.greens[1]) + c.allRed
  const cycle = span0 + span1
  const start = [0, span0]
  return {
    config: c,
    cycle,
    at(t: number, g: PhaseGroup): SignalAspect {
      if (cycle <= 0) return 'red'
      const tc = (((t + c.offset - start[g]) % cycle) + cycle) % cycle
      if (tc < c.greens[g]) return 'green'
      if (tc < c.greens[g] + amberOf(c.greens[g])) return 'amber'
      return 'red'
    },
  }
}

/**
 * Signals v1 / Mode A: fixed-cycle, two-phase controller ("lights stationary on a loop").
 * Every intersection runs the same timeline, independent of traffic.
 */
export function createFixedCycleController(
  net: Network,
  cfg: Partial<FixedCycleConfig> = {},
  intersections: Intersection[] = buildIntersections(net),
) {
  const timeline = fixedCycleTimeline(cfg)
  const byKey = indexApproaches(intersections)
  let t = 0
  return {
    mode: 'fixed' as const,
    config: timeline.config,
    cycle: timeline.cycle,
    intersections,
    update(time: number) {
      t = time
    },
    aspect(node: number, inEdge: number): SignalAspect {
      const hit = byKey.get(approachKey(node, inEdge))
      return hit ? timeline.at(t, hit[1].group) : 'green'
    },
  } satisfies SignalController & Record<string, unknown>
}
