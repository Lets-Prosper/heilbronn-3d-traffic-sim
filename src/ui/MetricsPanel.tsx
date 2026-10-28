import { estimateEmissions } from '../engine/metrics/emissions'
import type { MetricsSnapshot } from '../engine/metrics'
import { useSimStore } from '../state/simStore'

interface Row {
  label: string
  unit: string
  value: (m: MetricsSnapshot) => number
  digits: number
  /** Lower is better (wait, queue, emissions) vs higher is better (throughput). */
  lowerIsBetter: boolean
  hint?: string
}

const ROWS: Row[] = [
  { label: 'Avg wait', unit: 's', value: (m) => m.meanWait, digits: 1, lowerIsBetter: true, hint: 'Stopped time per completed trip' },
  { label: 'Throughput', unit: 'veh/h', value: (m) => m.throughputPerHour, digits: 0, lowerIsBetter: false, hint: 'Exits per sim hour so far. Demand is identical, so early gains mean trips finish sooner; over a full hour both approach the demand rate' },
  { label: 'Mean queue', unit: 'veh', value: (m) => m.meanQueue, digits: 1, lowerIsBetter: true, hint: 'Time-averaged stopped vehicles' },
  { label: 'Stops / vehicle', unit: '', value: (m) => m.stopsPerVehicle, digits: 2, lowerIsBetter: true, hint: 'Smoothness: how often the average vehicle had to come to a halt' },
  { label: 'Bus delay', unit: 's', value: (m) => m.busDelay, digits: 1, lowerIsBetter: true, hint: 'Mean extra travel time per bus vs an empty road (illustrative lines)' },
  { label: 'Emergency delay', unit: 's', value: (m) => m.emergencyDelay, digits: 1, lowerIsBetter: true, hint: 'Mean extra travel time per ambulance vs an empty road' },
  { label: 'CO₂', unit: 'kg', value: (m) => estimateEmissions(m).co2Kg, digits: 2, lowerIsBetter: true, hint: 'Idle time (TRL rate) + stop/restart energy' },
  { label: 'NOₓ', unit: 'g', value: (m) => estimateEmissions(m).noxG, digits: 1, lowerIsBetter: true, hint: 'Idle time × TRL upper-bound rate' },
]

function fmt(v: number, digits: number) {
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** Live A vs B comparison. Both columns come from sims at the same sim time, same seed + demand. */
export function MetricsPanel() {
  const m = useSimStore((s) => s.metrics)
  const view = useSimStore((s) => s.view)
  const runs = useSimStore((s) => s.ambulances)
  if (!m) return null
  const a = m.fixed
  const b = m.maxPressure
  return (
    <div className="metrics">
      <table>
        <thead>
          <tr>
            <th />
            <th className={view === 'fixed' ? 'on' : ''}>A Fixed</th>
            <th className={view === 'maxPressure' ? 'on' : ''}>B Smart</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => {
            const va = r.value(a)
            const vb = r.value(b)
            const d = va > 0 ? ((vb - va) / va) * 100 : 0
            const better = Math.abs(d) < 0.5 ? 'flat' : (d < 0) === r.lowerIsBetter ? 'good' : 'bad'
            return (
              <tr key={r.label} title={r.hint}>
                <th>
                  {r.label} {r.unit && <small>{r.unit}</small>}
                </th>
                <td className={view === 'fixed' ? 'on' : ''}>{fmt(va, r.digits)}</td>
                <td className={view === 'maxPressure' ? 'on' : ''}>{fmt(vb, r.digits)}</td>
                <td className={`delta ${better}`}>{va > 0 ? `${d > 0 ? '+' : ''}${d.toFixed(0)}%` : '–'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {runs.length > 0 && (
        <table className="amb-table">
          <tbody>
            {runs.slice(-3).map((r) => {
              const done = r.fixed !== undefined && r.maxPressure !== undefined
              const d = done ? r.maxPressure! - r.fixed! : 0
              return (
                <tr key={r.tag} title={r.from}>
                  <th>
                    🚑 #{r.tag.replace('ambulance-', '')} <small>{r.from.replace(/ from the /, ' · ')}</small>
                  </th>
                  <td className={view === 'fixed' ? 'on' : ''}>{r.fixed !== undefined ? `${r.fixed.toFixed(0)} s` : '…'}</td>
                  <td className={view === 'maxPressure' ? 'on' : ''}>{r.maxPressure !== undefined ? `${r.maxPressure.toFixed(0)} s` : '…'}</td>
                  <td className={`delta ${!done || Math.abs(d) < 3 ? 'flat' : d < 0 ? 'good' : 'bad'}`} title={done && Math.abs(d) < 3 ? 'No queue in its way in either mode' : undefined}>
                    {!done ? '' : Math.abs(d) < 3 ? '≈' : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(0)} s`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <p className="note">
        Same seed, same arrivals, same sim time · {a.exited.toLocaleString()} / {b.exited.toLocaleString()} trips done · emissions are estimates
      </p>
    </div>
  )
}
