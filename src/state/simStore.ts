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
import type { ControllerMode, Intersection } from '../engine/controllers'
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

export type DemoPhase = 'off' | 'before' | 'after'

/** Demo preset: AM-peak counts ×2 plus an ASSUMED Karlsruher Str. through flow, so queues are visible. */
export const DEMO_DEMAND: ScenarioOptions = { hour: 7, scale: 2, assumedThroughVph: 300 }
/** Sim second at which the demo flips the city from Mode A to Mode B. */
export const DEMO_FLIP_S = 180

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
  demo: { phase: DemoPhase }
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
  startDemo(): void
  stopDemo(): void
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

export const useSimStore = create<SimStore>((set, get) => ({
  seed: num('seed') ?? 1,
  view: params.get('mode') === 'B' ? 'maxPressure' : 'fixed',
  demand: {
    hour: num('hour') ?? 7,
    scale: num('scale') ?? 1,
    backgroundRate: num('bg') ?? 0.004,
    assumedThroughVph: num('through') ?? 0,
  },
  running: true,
  speed: num('speed') ?? 1,
  accumulator: 0,
  prev: new Map(),
  curr: new Map(),
  alpha: 0,
  signals: {},
  hudClock: 0,
  demo: { phase: 'off' },
  flipNonce: 0,

  init(network, layout) {
    set({ network, layout })
    get().restart()
    if (params.has('demo')) get().startDemo()
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
  startDemo() {
    set({ demand: { ...get().demand, ...DEMO_DEMAND }, demo: { phase: 'before' }, speed: 8, running: true })
    get().setView('fixed')
    get().restart()
    get().shot('worst')
  },
  stopDemo() {
    set({ demo: { phase: 'off' } })
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
    } else patch.hudClock = hudClock
    set(patch)

    // Demo: before -> after flip at a fixed sim time, then slow down and orbit.
    if (get().demo.phase === 'before' && shown.state.time >= DEMO_FLIP_S) {
      set({ demo: { phase: 'after' }, speed: 2 })
      get().setView('maxPressure')
      get().shot('worst', true)
    }
  },
}))
