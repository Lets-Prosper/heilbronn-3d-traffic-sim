// Mode B: max-pressure control (Varaiya 2013) + priority, the adaptive "model".
//
// Every `decisionInterval` s, each intersection compares its two phases using
// what its detectors see:
//
//   pressure(approach) = vehicles in the upstream detection zone
//                        − vehicles in the downstream zone it discharges into
//   pressure(phase)    = Σ approaches  (+ busWeight per detected bus)
//
// Little downstream space => low pressure, so a phase can't push traffic into
// a blocked exit. The higher-pressure phase gets green, with min green and an
// amber + all-red clearance on every switch. On top of that:
//
//  * Platoon hold — if a switch is warranted but moving vehicles will reach the
//    stop line on the current green within `platoonEtaS`, hold green (up to
//    `maxExtension`) so the platoon isn't stopped. This is what makes Mode B
//    traffic visibly smoother: fewer stop-and-go cycles.
//  * Transit priority — buses are weighted by occupancy (person-based pressure),
//    so a bus approach wins sooner and keeps its green.
//  * Emergency pre-emption — an emergency vehicle detected within range forces
//    its phase green (clearance intervals still run; min green is waived) and
//    holds it until the vehicle has passed, so the queue ahead of it discharges.
//
// Intersections with only one phase group are mid-block pedestrian crossings.
// Mode A cycles them like any fixed signal. Mode B runs them on demand
// (push-button): vehicles keep green; a pedestrian call is served at the next
// gap in traffic (no vehicle arriving within platoon horizon) or after
// `pedMaxWait`, with a `pedRed` s red. Calls are identical in both modes.
import type { Network } from '../network/types'
import { fixedCycleTimeline, type FixedCycleConfig } from './fixedCycle'
import { approachKey, buildIntersections, indexApproaches, type Intersection, type PhaseGroup } from './intersections'
import type { PriorityRequest, SignalAspect, SignalController, TrafficView } from './types'

export interface MaxPressureConfig {
  minGreen: number
  /** Force a switch after this long if the other phase has any demand. */
  maxGreen: number
  amber: number
  allRed: number
  /** Seconds between pressure evaluations. */
  decisionInterval: number
  /** Upstream detection zone length (≈ camera range along the approach), m. */
  detectionM: number
  /** Downstream zone length for the "space" term, m. */
  downstreamM: number
  /** Hold green for vehicles arriving within this many seconds. 0 disables platoon hold. */
  platoonEtaS: number
  /** Longest a warranted switch may be postponed for an arriving platoon, s. */
  maxExtension: number
  /**
   * Extra pressure per detected bus, in car-equivalents. ASSUMPTION: ~20 passengers
   * per bus vs ~1.3 per car (German urban car occupancy) ≈ 15.
   */
  busWeight: number
  /** Enable emergency pre-emption. */
  emergencyPreemption: boolean
  /** Pedestrian crossing (on demand): red time for vehicles once a call is served, s. */
  pedRed: number
  /** Longest a pedestrian waits for a gap before the crossing goes red anyway, s. */
  pedMaxWait: number
}

export const DEFAULT_MAX_PRESSURE: MaxPressureConfig = {
  minGreen: 8,
  maxGreen: 45,
  amber: 3,
  allRed: 2,
  decisionInterval: 2,
  detectionM: 100,
  downstreamM: 60,
  platoonEtaS: 3,
  maxExtension: 10,
  busWeight: 15,
  emergencyPreemption: true,
  pedRed: 10,
  pedMaxWait: 30,
}

type Stage = 'green' | 'amber' | 'allRed'

interface XState {
  phase: PhaseGroup
  stage: Stage
  since: number
  lastDecision: number
  /** When a switch first became warranted but was postponed for a platoon. */
  wantSince: number | null
  /** Emergency pre-emption active (for HUD). */
  preempt: boolean
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
  const st: XState[] = intersections.map((x) => {
    const p = init?.phaseOf(x)
    const base = { since: -Infinity, lastDecision: -Infinity, wantSince: null, preempt: false }
    return p == null ? { ...base, phase: 0, stage: 'allRed' } : { ...base, phase: p, stage: 'green' }
  })
  // Pedestrian crossings: 'green' for vehicles until a call is served, then amber -> red -> green.
  const ped = intersections.map(() => ({ stage: 'green' as Stage | 'red', since: -Infinity }))
  const pressure = new Float64Array(intersections.length * 2)
  let t = 0

  const approachPressure = (edge: number, view: TrafficView) => {
    const up = view.upstream(edge, c.detectionM, c.platoonEtaS)
    return { p: up.count - view.downstream(edge, c.downstreamM), arriving: up.arriving }
  }

  const startSwitch = (s: XState) => {
    s.stage = 'amber'
    s.since = t
    s.wantSince = null
  }

  return {
    mode: 'maxPressure' as const,
    config: c,
    intersections,
    /** Last computed pressure for [intersection][group] (for HUD/debug). */
    pressure: (x: number, g: PhaseGroup) => pressure[x * 2 + g],
    timeline,
    /** Is emergency pre-emption currently active at intersection x? */
    preempting: (x: number) => st[x].preempt,
    update(time: number, view: TrafficView) {
      t = time
      // Priority requests grouped by intersection.
      const reqs = new Map<number, { req: PriorityRequest; group: PhaseGroup }[]>()
      for (const r of view.requests()) {
        const hit = byKey.get(approachKey(r.node, r.edge))
        if (!hit) continue
        let l = reqs.get(hit[0].id)
        if (!l) reqs.set(hit[0].id, (l = []))
        l.push({ req: r, group: hit[1].group })
      }

      for (let i = 0; i < intersections.length; i++) {
        const x = intersections[i]
        if (x.groups.length < 2) {
          const p = ped[i]
          if (p.stage === 'amber' && t - p.since >= c.amber) {
            p.stage = 'red'
            p.since = t
          } else if (p.stage === 'red' && t - p.since >= c.pedRed + c.allRed) {
            p.stage = 'green'
            p.since = t
          } else if (p.stage === 'green' && t - p.since >= c.minGreen) {
            const call = view.pedCall(x.id)
            if (call !== null) {
              const evNear = (reqs.get(i) ?? []).some((r) => r.req.kind === 'emergency')
              const arriving = x.approaches.reduce((n, a) => n + view.upstream(a.edge, c.detectionM, c.platoonEtaS).arriving, 0)
              if (!evNear && (arriving === 0 || t - call >= c.pedMaxWait)) {
                p.stage = 'amber'
                p.since = t
                view.pedServed(x.id)
              }
            }
          }
          continue
        }
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

        const mine = reqs.get(i) ?? []
        // Emergency pre-emption: nearest emergency vehicle decides; checked every tick.
        const ev = c.emergencyPreemption
          ? mine.filter((r) => r.req.kind === 'emergency').sort((a, b) => a.req.distance - b.req.distance)[0]
          : undefined
        s.preempt = !!ev
        if (ev) {
          if (s.stage === 'green' && s.phase !== ev.group) startSwitch(s) // min green waived
          continue // hold everything else until it has passed
        }

        if (s.stage !== 'green' || t - s.lastDecision < c.decisionInterval) continue
        s.lastDecision = t
        let p0 = 0
        let p1 = 0
        let arrivingOnGreen = 0
        for (const a of x.approaches) {
          const { p, arriving } = approachPressure(a.edge, view)
          if (a.group === 0) p0 += p
          else p1 += p
          if (a.group === s.phase) arrivingOnGreen += arriving
        }
        for (const r of mine) {
          if (r.req.kind !== 'bus') continue
          if (r.group === 0) p0 += c.busWeight
          else p1 += c.busWeight
        }
        pressure[i * 2] = p0
        pressure[i * 2 + 1] = p1
        const cur = s.phase === 0 ? p0 : p1
        const other = s.phase === 0 ? p1 : p0
        const held = t - s.since
        if (held < c.minGreen) continue
        const warranted = other > cur || (held >= c.maxGreen && other > 0)
        if (!warranted) {
          s.wantSince = null
          continue
        }
        s.wantSince ??= t
        const platoon = arrivingOnGreen > 0 && t - s.wantSince < c.maxExtension && held < c.maxGreen
        if (!platoon) startSwitch(s)
      }
    },
    aspect(node: number, inEdge: number): SignalAspect {
      const hit = byKey.get(approachKey(node, inEdge))
      if (!hit) return 'green'
      const [x, a] = hit
      if (x.groups.length < 2) {
        const p = ped[x.id]
        return p.stage === 'green' ? 'green' : p.stage === 'amber' ? 'amber' : 'red'
      }
      const s = st[x.id]
      if (s.stage === 'allRed' || a.group !== s.phase) return 'red'
      return s.stage
    },
  } satisfies SignalController & Record<string, unknown>
}
