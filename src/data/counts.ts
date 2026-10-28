// Hourly KFZ detector counts (Stadt Heilbronn Zählstelle CSV) -> demand profiles.
//
// File format: `Timestamp;Object_Id;count`, semicolon-delimited, Windows-1252,
// CRLF. Timestamp `DD.MM.YYYY HH:MM` labels the END of a 1 h interval
// (first row of the year is 01:00, last is 23:59 = the 23:00–24:00 bucket).
// Labels are local wall-clock time; hour-of-day is taken as-is (no DST shift).

export type Approach = 'north' | 'south' | 'east' | 'west'
export type Movement = 'left' | 'straight' | 'right'

export interface Detector {
  id: string // e.g. "D4"
  approach: Approach
  street: string
  movement: Movement
}

/** Detector id -> approach + turning movement (from the Zählstelle labels). */
export const DETECTORS: Record<string, Detector> = {
  D1: { id: 'D1', approach: 'north', street: 'Theresienstraße', movement: 'right' },
  D2: { id: 'D2', approach: 'north', street: 'Theresienstraße', movement: 'straight' },
  D3: { id: 'D3', approach: 'north', street: 'Theresienstraße', movement: 'left' },
  D4: { id: 'D4', approach: 'east', street: 'Karlsruher Straße', movement: 'right' },
  D12: { id: 'D12', approach: 'south', street: 'Theresienstraße', movement: 'straight' },
  D16: { id: 'D16', approach: 'west', street: 'Karlsruher Straße', movement: 'left' },
}

export interface CountRecord {
  detector: string
  /** Day index as YYYY-MM-DD. */
  date: string
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number
  /** Interval start hour, 0–23 (07 = 07:00–08:00). */
  hour: number
  count: number
}

/** `ig11FD837_D4_Z4` -> `D4`. */
export function detectorId(objectId: string): string | undefined {
  return /_(D\d+)_/.exec(objectId)?.[1]
}

/** Parse decoded CSV text. Throws on unknown detectors so new IDs are never silently dropped. */
export function parseCounts(text: string): CountRecord[] {
  const out: CountRecord[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const [ts, objectId, raw] = line.split(';')
    const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(ts)
    if (!m) throw new Error(`line ${i + 1}: bad timestamp "${ts}"`)
    const det = detectorId(objectId)
    if (!det || !DETECTORS[det]) throw new Error(`line ${i + 1}: unmapped detector "${objectId}"`)
    // ~2% of rows are plausibility-corrected fractional values with a decimal comma ("10,1").
    const count = Number(raw?.trim().replace(',', '.'))
    if (!Number.isFinite(count)) throw new Error(`line ${i + 1}: bad count "${raw}"`)
    const [, dd, mm, yyyy, HH, MM] = m
    // End-of-interval label: 01:00 -> hour 0, 23:59 -> hour 23, 00:00 -> hour 23 of the previous day.
    let end = new Date(Date.UTC(+yyyy, +mm - 1, +dd, +HH, +MM))
    if (MM === '59') end = new Date(end.getTime() + 60_000)
    const start = new Date(end.getTime() - 3_600_000)
    out.push({
      detector: det,
      date: start.toISOString().slice(0, 10),
      weekday: start.getUTCDay(),
      hour: start.getUTCHours(),
      count,
    })
  }
  return out
}

export type DayFilter = 'all' | 'weekday' | 'weekend'

const dayMatches = (wd: number, f: DayFilter) =>
  f === 'all' || (f === 'weekday' ? wd >= 1 && wd <= 5 : wd === 0 || wd === 6)

/** Mean veh/h per detector per hour-of-day (24 values). */
export function hourlyProfiles(records: CountRecord[], filter: DayFilter = 'all'): Record<string, number[]> {
  const sum: Record<string, number[]> = {}
  const n: Record<string, number[]> = {}
  for (const r of records) {
    if (!dayMatches(r.weekday, filter)) continue
    ;(sum[r.detector] ??= new Array(24).fill(0))[r.hour] += r.count
    ;(n[r.detector] ??= new Array(24).fill(0))[r.hour] += 1
  }
  const out: Record<string, number[]> = {}
  for (const d of Object.keys(sum)) out[d] = sum[d].map((s, h) => (n[d][h] ? s / n[d][h] : 0))
  return out
}

export interface ApproachDemand {
  approach: Approach
  street: string
  /** Sum of the counted movements on this approach, veh/h. */
  inflow: number
  /** Share of `inflow` per counted movement (sums to 1). */
  turns: Partial<Record<Movement, number>>
  /** Movements on this approach that have no detector (inflow is a lower bound if non-empty). */
  uncounted: Movement[]
}

/** Per-approach inflow + turn ratios for one hour-of-day from detector profiles. */
export function approachDemand(profiles: Record<string, number[]>, hour: number): ApproachDemand[] {
  const by = new Map<Approach, ApproachDemand>()
  for (const det of Object.values(DETECTORS)) {
    const v = profiles[det.id]?.[hour] ?? 0
    let a = by.get(det.approach)
    if (!a) {
      a = { approach: det.approach, street: det.street, inflow: 0, turns: {}, uncounted: [] }
      by.set(det.approach, a)
    }
    a.inflow += v
    a.turns[det.movement] = (a.turns[det.movement] ?? 0) + v
  }
  const all: Movement[] = ['left', 'straight', 'right']
  for (const a of by.values()) {
    for (const k of Object.keys(a.turns) as Movement[]) a.turns[k] = a.inflow ? a.turns[k]! / a.inflow : 0
    a.uncounted = all.filter((m) => !(m in a.turns))
  }
  return [...by.values()]
}
