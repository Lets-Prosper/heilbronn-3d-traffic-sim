export type SignalAspect = 'green' | 'amber' | 'red'

/** Mode A = fixed cycle (baseline), Mode B = max-pressure (adaptive). */
export type ControllerMode = 'fixed' | 'maxPressure'

/** What a detector zone on one approach sees. */
export interface ZoneReading {
  /** Vehicles within the zone (stopped or moving). */
  count: number
  /** Moving vehicles that will reach the stop line within the platoon horizon. */
  arriving: number
}

/** A priority vehicle detected approaching a signalized approach. */
export interface PriorityRequest {
  node: number
  edge: number
  kind: 'bus' | 'emergency'
  /** Distance from the vehicle's front bumper to the stop line, m. */
  distance: number
  vehicle: number
}

/**
 * What a controller may observe each tick — modelled on what junction detectors
 * (camera / radar / transponder) report, not on the engine's internals.
 */
export interface TrafficView {
  /** Vehicles currently on an edge (all lanes). */
  count(edge: number): number
  /** Lanes on an edge (≥ 1). */
  lanes(edge: number): number
  /** Vehicles within `metres` upstream of the end of `edge` (follows upstream roads). */
  upstream(edge: number, metres: number, etaS: number): ZoneReading
  /** Vehicles within `metres` downstream of the end of `edge` (on the roads it feeds). */
  downstream(edge: number, metres: number): number
  /** Buses / emergency vehicles currently approaching a signalized approach. */
  requests(): readonly PriorityRequest[]
  /**
   * Pedestrian push-button at intersection `x` (by id): sim time of the oldest unserved press,
   * or null. Presses come from their own RNG stream, identical in every mode.
   */
  pedCall(x: number): number | null
  /** Controller has started the pedestrian phase at intersection `x`: clears its call. */
  pedServed(x: number): void
}

export interface SignalController {
  readonly mode: ControllerMode
  update(time: number, view: TrafficView): void
  /** Aspect shown to traffic arriving at `node` via `inEdge`. Uncontrolled movements are always green. */
  aspect(node: number, inEdge: number): SignalAspect
}
