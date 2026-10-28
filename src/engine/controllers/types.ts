export type SignalAspect = 'green' | 'amber' | 'red'

/** Mode A = fixed cycle (baseline), Mode B = max-pressure (adaptive). */
export type ControllerMode = 'fixed' | 'maxPressure'

/** What a controller may observe each tick. */
export interface TrafficView {
  /** Vehicles currently on an edge (all lanes). */
  count(edge: number): number
  /** Lanes on an edge (≥ 1). */
  lanes(edge: number): number
}

export interface SignalController {
  readonly mode: ControllerMode
  update(time: number, view: TrafficView): void
  /** Aspect shown to traffic arriving at `node` via `inEdge`. Uncontrolled movements are always green. */
  aspect(node: number, inEdge: number): SignalAspect
}
