// Mode B: max-pressure control (Varaiya 2013), the adaptive "model".
//
// Every `decisionInterval` s, each intersection compares its two phases.
// Pressure of an approach = vehicles queued upstream − mean vehicles on the
// edges it discharges into (little downstream space => low pressure, so a
// phase can't push traffic into a blocked exit). Phase pressure = sum over
// its approaches. The higher-pressure phase gets green, subject to min green
// and an amber + all-red clearance on every switch.
//
// Intersections with only one phase group (mid-block pedestrian signals) keep
// the fixed-cycle timeline in both modes, so A/B differ only where an actual
// conflict between movements is being arbitrated.
import { successors } from '../network/routing'
import type { Network } from '../network/types'
import { fixedCycleTimeline, type FixedCycleConfig } from './fixedCycle'
import { approachKey, buildIntersections, indexApproaches, type Intersection, type PhaseGroup } from './intersections'
import type { SignalAspect, SignalController, TrafficView } from './types'

export interface MaxPressureConfig {
  minGreen: number
  /** Force a switch after this long if the other phase has any demand. */
  maxGreen: number
  amber: number
  allRed: number
  /** Seconds between pressure evaluations. */
  decisionInterval: number
}

export const DEFAULT_MAX_PRESSURE: MaxPressureConfig = { minGreen: 6, maxGreen: 60, amber: 3, allRed: 2, decisionInterval: 2 }

type Stage = 'green' | 'amber' | 'allRed'

interface XState {
  phase: PhaseGroup
  stage: Stage
  since: number
  lastDecision: number
}

export interface MaxPressureInit {
  /** Phase currently showing green/amber at an intersection, or null if all-red. */
  phaseOf(x: Intersection): PhaseGroup | null
}

export function createMaxPressureController(
  net: Network,
  cfg: Partial<MaxPressureConfig> = {},
  intersections: Intersection[] = buildIntersections(net),
  fallback: Partial<FixedCycleConfig> = {},
  init?: MaxPressureInit,
) {
  const c = { ...DEFAULT_MAX_PRESSURE, ...cfg }
  const timeline = fixedCycleTimeline(fallback)
  const byKey = indexApproaches(intersections)
  const succ = new Map<number, number[]>()
  for (const x of intersections) for (const a of x.approaches) succ.set(a.edge, successors(net, a.edge))
  const st: XState[] = intersections.map((x) => {
    const p = init?.phaseOf(x)
    return p == null
      ? { phase: 0, stage: 'allRed', since: -Infinity, lastDecision: -Infinity }
      : { phase: p, stage: 'green', since: -Infinity, lastDecision: -Infinity }
  })
  const pressure = new Float64Array(intersections.length * 2)
  let t = 0

  const approachPressure = (edge: number, view: TrafficView) => {
    const outs = succ.get(edge)!
    let down = 0
    for (const j of outs) down += view.count(j)
    return view.count(edge) - (outs.length ? down / outs.length : 0)
  }

  return {
    mode: 'maxPressure' as const,
    config: c,
    intersections,
    /** Last computed pressure for [intersection][group] (for HUD/debug). */
    pressure: (x: number, g: PhaseGroup) => pressure[x * 2 + g],
    update(time: number, view: TrafficView) {
      t = time
      for (let i = 0; i < intersections.length; i++) {
        const x = intersections[i]
        if (x.groups.length < 2) continue
        const s = st[i]
        if (s.stage === 'amber' && t - s.since >= c.amber) {
          s.stage = 'allRed'
          s.since = t
        }
        if (s.stage === 'allRed' && t - s.since >= c.allRed) {
          s.stage = 'green'
          s.phase = (1 - s.phase) as PhaseGroup
          s.since = t
        }
        if (s.stage !== 'green' || t - s.lastDecision < c.decisionInterval) continue
        s.lastDecision = t
        let p0 = 0
        let p1 = 0
        for (const a of x.approaches) {
          const p = approachPressure(a.edge, view)
          if (a.group === 0) p0 += p
          else p1 += p
        }
        pressure[i * 2] = p0
        pressure[i * 2 + 1] = p1
        const cur = s.phase === 0 ? p0 : p1
        const other = s.phase === 0 ? p1 : p0
        const held = t - s.since
        if (held < c.minGreen) continue
        if (other > cur || (held >= c.maxGreen && other > 0)) {
          s.stage = 'amber'
          s.since = t
        }
      }
    },
    aspect(node: number, inEdge: number): SignalAspect {
      const hit = byKey.get(approachKey(node, inEdge))
      if (!hit) return 'green'
      const [x, a] = hit
      if (x.groups.length < 2) return timeline.at(t, a.group)
      const s = st[x.id]
      if (s.stage === 'allRed' || a.group !== s.phase) return 'red'
      return s.stage
    },
  } satisfies SignalController & Record<string, unknown>
}
