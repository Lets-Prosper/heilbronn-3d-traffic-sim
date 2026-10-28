// Bridge between the pure engine and the UI. The engine owns the truth.
//
// Two sims run in lockstep — Mode A (fixed loop) and Mode B (max-pressure) —
// from the same seed and demand, so at any instant they've seen identical
// arrivals. The toggle only picks which one the city shows; the metrics panel
// compares both live.
//
// Each frame `advance` runs whole 10 Hz ticks, then publishes the displayed
// sim's last two ticks of vehicle poses (prev/curr) and its signal aspects.
// The renderer reads those every frame via getState() (no React re-render) and
// interpolates by `alpha`, decoupling the 10 Hz sim from the ~60 fps render.
// Signal aspects and metrics are React state: set only on change / at 4 Hz.
import { create } from 'zustand'
import { buildScenario, type Scenario, type ScenarioOptions } from '../data/scenario'
import { DEFAULT_MAX_PRESSURE, type ControllerMode, type Intersection } from '../engine/controllers'
import { approachQueues, createSim, DT, type Sim } from '../engine/engine'
import type { MetricsSnapshot } from '../engine/metrics'
import type { Network } from '../engine/network/types'
import type { RoadLayout } from '../render/layout'
import type { SignalState } from '../render/signals'
import { projectVehicles, toLamp, type VehicleFrame } from '../render/vehicleFrame'

const MAX_TICKS_PER_FRAME = 200
const HUD_INTERVAL_S = 0.25
/** Sim seconds of Mode A used to find the most congested intersection. */
const PROBE_S = 600

export const MODES: ControllerMode[] = ['fixed', 'maxPressure']

export type Vec3 = [number, number, number]
export interface CameraShot {
  position: Vec3
  target: Vec3
  /** Bumped on every request so identical shots re-trigger. */
  nonce: number
  /** Slow orbit around the target after arriving. */
  orbit?: boolean
}


/** What smart-mode detectors see on one approach (for the detection overlay). */
export interface Detection {
  count: number
  request?: 'bus' | 'emergency'
}

/** One ambulance dispatched into both sims at the same moment, and its trip time in each. */
export interface AmbulanceRun {
  tag: string
  from: string
  at: number
  /** Seconds from dispatch to leaving the map, per mode (undefined = still driving). */
  fixed?: number
  maxPressure?: number
}

/** Detection zone length shown/used by smart mode, m (same value the controller counts over). */
export const DETECTION_M = DEFAULT_MAX_PRESSURE.detectionM

/** Pitch preset: AM-peak counts ×2 plus an ASSUMED Karlsruher Str. through flow, so queues are visible. */
export const PITCH_DEMAND: ScenarioOptions = { hour: 7, scale: 2, assumedThroughVph: 300 }

/** Where a dispatched ambulance comes from: a junction arm, or the arm with the longest queue right now. */
export type AmbulanceFrom = 'busiest' | 'north' | 'east' | 'south' | 'west'

interface SimStore {
  sims?: Record<ControllerMode, Sim>
  network?: Network
  layout?: RoadLayout
  scenario?: Scenario
  seed: number
  /** Which sim the city shows. */
  view: ControllerMode
  demand: ScenarioOptions
  running: boolean
  /** Sim seconds per real second. */
  speed: number
  accumulator: number
  prev: VehicleFrame
  curr: VehicleFrame
  alpha: number
  /** Lamp state per approach key (`${node}:${edge}`), displayed sim. */
  signals: Record<string, SignalState>
  metrics?: Record<ControllerMode, MetricsSnapshot>
  hudClock: number
  /** Most congested intersection under Mode A for the current demand. */
  worst?: Intersection
  camera?: CameraShot
  /** Smart-mode detector readings per approach key (published at 4 Hz). */
  detections: Record<string, Detection>
  /** Emergency pre-emption active somewhere in the displayed sim. */
  preempting: boolean
  ambulances: AmbulanceRun[]
  /** Bumped when the view flips (for the flash transition). */
  flipNonce: number

  init(network: Network, layout: RoadLayout): void
  /** Restart both modes from the same seed + demand. */
  restart(): void
  setDemand(d: Partial<ScenarioOptions>): void
  setView(mode: ControllerMode): void
  setRunning(running: boolean): void
  setSpeed(speed: number): void
  shot(name: 'overview' | 'worst', orbit?: boolean): void
  /**
   * Send an ambulance straight through the main junction, into both modes at the same sim
   * instant. Nothing is ever dispatched automatically: the presenter decides when and from where.
   */
  dispatchAmbulance(from?: AmbulanceFrom): void
  /** Load the pitch scenario, restart both modes, frame the worst junction. Starts nothing else. */
  pitchSetup(): void
  advance(realDelta: number): void
}

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search)
const num = (k: string) => (params.has(k) ? Number(params.get(k)) : undefined)

function publishSignals(sim: Sim, prev: Record<string, SignalState>): Record<string, SignalState> | null {
  let changed = false
  const next: Record<string, SignalState> = {}
  for (const x of sim.intersections) {
    for (const a of x.approaches) {
      const s = toLamp(sim.signals.aspect(a.node, a.edge))
      next[a.key] = s
      if (prev[a.key] !== s) changed = true
    }
  }
  return changed ? next : null
}

/** Run Mode A headless and return the intersection with the largest mean approach queue. */
function findWorst(network: Network, seed: number, scenario: Scenario): Intersection | undefined {
  const sim = createSim({ seed, network, entries: scenario.entries, mode: 'fixed' })
  if (!sim.intersections.length) return undefined
  const sum = sim.intersections.map(() => 0)
  for (let t = 0; t < PROBE_S; t++) {
    sim.run(1)
    approachQueues(sim).forEach((q, i) => (sum[i] += q))
  }
  return sim.intersections[sum.indexOf(Math.max(...sum))]
}

const snapshots = (sims: Record<ControllerMode, Sim>) =>
  ({ fixed: sims.fixed.snapshot(), maxPressure: sims.maxPressure.snapshot() }) as Record<ControllerMode, MetricsSnapshot>

let worstKey = ''


/** Smart-mode detector readings + ambulance results, published at HUD rate. */
function observe(smart: Sim, runs: AmbulanceRun[], sims: Record<ControllerMode, Sim>) {
  const detections: Record<string, Detection> = {}
  const reqs = smart.view.requests()
  let preempting = false
  for (const x of smart.intersections) {
    for (const a of x.approaches) {
      const r = reqs.find((q) => q.node === a.node && q.edge === a.edge && (q.kind === 'emergency' || !detections[a.key]?.request))
      if (r?.kind === 'emergency') preempting = true
      detections[a.key] = { count: smart.view.upstream(a.edge, DETECTION_M, 0).count, request: r?.kind }
    }
  }
  let changed = false
  const ambulances = runs.map((run) => {
    const next = { ...run }
    for (const mode of MODES) {
      if (next[mode] !== undefined) continue
      const trip = sims[mode].metrics.trips.find((tr) => tr.tag === run.tag)
      if (trip) {
        next[mode] = trip.travel
        changed = true
      }
    }
    return next
  })
  return changed ? { detections, preempting, ambulances } : { detections, preempting }
}

export const useSimStore = create<SimStore>((set, get) => ({
  seed: num('seed') ?? 1,
  view: params.get('mode') === 'B' ? 'maxPressure' : 'fixed',
  demand: {
    hour: num('hour') ?? 7,
    scale: num('scale') ?? 1,
    backgroundRate: num('bg') ?? 0.004,
    assumedThroughVph: num('through') ?? 0,
    busHeadwayS: num('bus') ?? 600,
  },
  running: true,
  speed: num('speed') ?? 1,
  accumulator: 0,
  prev: new Map(),
  curr: new Map(),
  alpha: 0,
  signals: {},
  hudClock: 0,
  flipNonce: 0,
  detections: {},
  preempting: false,
  ambulances: [],

  init(network, layout) {
    set({ network, layout })
    get().restart()
    if (params.has('pitch') || params.has('demo')) get().pitchSetup()
  },
  restart() {
    const { network, layout, seed, view, demand } = get()
    if (!network || !layout) return
    const scenario = buildScenario(network, demand)
    const sims = {
      fixed: createSim({ seed, network, entries: scenario.entries, mode: 'fixed' }),
      maxPressure: createSim({ seed, network, entries: scenario.entries, mode: 'maxPressure' }),
    }
    const key = JSON.stringify([seed, scenario.options])
    const worst = key === worstKey ? get().worst : findWorst(network, seed, scenario)
    worstKey = key
    const frame = projectVehicles(sims[view], network, layout)
    set({
      sims, scenario, worst, accumulator: 0, prev: frame, curr: frame, alpha: 0,
      signals: publishSignals(sims[view], {}) ?? {}, metrics: snapshots(sims), hudClock: 0,
      ambulances: [], detections: {}, preempting: false,
    })
  },
  setDemand(d) {
    set({ demand: { ...get().demand, ...d } })
    get().restart()
  },
  setView(view) {
    const { sims, network, layout } = get()
    if (view === get().view) return
    if (!sims || !network || !layout) return set({ view })
    // Same vehicle ids exist in both sims: snap instead of interpolating across sims.
    const frame = projectVehicles(sims[view], network, layout)
    set({
      view, prev: frame, curr: frame, flipNonce: get().flipNonce + 1,
      signals: publishSignals(sims[view], {}) ?? {},
    })
  },
  setRunning: (running) => set({ running }),
  setSpeed: (speed) => set({ speed }),
  shot(name, orbit = false) {
    const nonce = (get().camera?.nonce ?? 0) + 1
    const w = get().worst
    if (name === 'worst' && w) {
      set({ camera: { position: [w.x + 55, 60, w.z + 75], target: [w.x, 0, w.z], nonce, orbit } })
    } else {
      const c = w ?? { x: -95, z: 15 }
      set({ camera: { position: [c.x + 170, 190, c.z + 230], target: [c.x, 0, c.z], nonce, orbit } })
    }
  },
  dispatchAmbulance(from = 'busiest') {
    const { sims, scenario, worst } = get()
    if (!sims || !scenario?.through.length) return
    // A chosen arm, or the straight-through route whose junction approach is most congested under Mode A.
    let best = scenario.through.find((t) => t.approach === from) ?? scenario.through[0]
    let most = from === 'busiest' ? -1 : Infinity
    for (const t of from === 'busiest' ? scenario.through : []) {
      const a = worst?.approaches.find((ap) => t.route.includes(ap.edge))
      const q = a ? sims.fixed.view.upstream(a.edge, 150, 0).count : 0
      if (q > most) {
        most = q
        best = t
      }
    }
    const n = get().ambulances.length + 1
    const tag = `ambulance-${n}`
    sims.fixed.dispatch(best.route, 'emergency', tag)
    sims.maxPressure.dispatch(best.route, 'emergency', tag)
    set({ ambulances: [...get().ambulances, { tag, from: `${best.street} from the ${best.approach}`, at: sims.fixed.state.time }] })
  },
  pitchSetup() {
    set({ demand: { ...get().demand, ...PITCH_DEMAND } })
    get().setView('fixed')
    get().restart()
    get().shot('worst')
  },
  advance(realDelta) {
    const { sims, network, layout, running, speed, view } = get()
    if (!sims || !network || !layout || !running) return
    let acc = get().accumulator + Math.min(realDelta, 0.25) * speed
    const n = Math.min(Math.floor(acc / DT + 1e-9), MAX_TICKS_PER_FRAME)
    if (n === 0) {
      set({ accumulator: acc, alpha: acc / DT })
      return
    }
    const shown = sims[view]
    let prev = get().curr
    for (let i = 0; i < n; i++) {
      if (i === n - 1 && n > 1) prev = projectVehicles(shown, network, layout)
      sims.fixed.step()
      sims.maxPressure.step()
    }
    acc -= n * DT
    if (acc >= DT) acc = 0 // fell behind (MAX_TICKS_PER_FRAME): drop time rather than spiral
    const curr = projectVehicles(shown, network, layout)
    const patch: Partial<SimStore> = { accumulator: acc, alpha: acc / DT, prev, curr }
    const signals = publishSignals(shown, get().signals)
    if (signals) patch.signals = signals
    const hudClock = get().hudClock + realDelta
    if (hudClock >= HUD_INTERVAL_S) {
      patch.metrics = snapshots(sims)
      patch.hudClock = 0
      Object.assign(patch, observe(sims.maxPressure, get().ambulances, sims))
    } else patch.hudClock = hudClock
    set(patch)

  },
}))
