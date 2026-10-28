import { useState } from 'react'
import type { ControllerMode } from '../engine/controllers'
import type { MetricsSnapshot } from '../engine/metrics'
import { estimateEmissions } from '../engine/metrics/emissions'
import { useSimStore, type AmbulanceRun } from '../state/simStore'
import { DOCK_PX } from './dock'
import { delta, fmt } from './format'
import { LiveChart, type ChartMetric } from './LiveChart'

interface Tile {
  label: string
  unit: string
  value: (m: MetricsSnapshot) => number
  digits: number
  hint: string
}

const TILES: Tile[] = [
  { label: 'Stopped now', unit: 'veh', value: (m) => m.queueNow, digits: 0, hint: 'Vehicles standing still on the whole map right now' },
  { label: 'Avg wait', unit: 's', value: (m) => m.meanWait, digits: 1, hint: 'Stopped time per completed trip' },
  { label: 'Stops / veh', unit: '', value: (m) => m.stopsPerVehicle, digits: 2, hint: 'How often the average vehicle had to halt' },
  { label: 'CO₂', unit: 'kg', value: (m) => estimateEmissions(m).co2Kg, digits: 1, hint: 'Idling + stop/restart estimate' },
]

const SIDES: Record<ControllerMode, { tag: string; name: string; sub: string }> = {
  fixed: { tag: 'A', name: 'Fixed loop', sub: '30 s / 30 s timer' },
  maxPressure: { tag: 'B', name: 'Smart control', sub: 'Detectors on every approach' },
}

function Side({ mode, m, other, run }: { mode: ControllerMode; m: MetricsSnapshot; other: MetricsSnapshot; run?: AmbulanceRun }) {
  const s = SIDES[mode]
  const smart = mode === 'maxPressure'
  const mine = run?.[mode]
  const theirs = run?.fixed
  const gain = smart && mine !== undefined && theirs !== undefined ? mine - theirs : undefined
  return (
    <section className={`side ${mode}`} aria-label={`${s.tag} ${s.name}`}>
      <header>
        <span className="chip">{s.tag}</span>
        <b>{s.name}</b>
        <small>{s.sub}</small>
      </header>
      <div className="tiles">
        {TILES.map((t) => {
          const d = delta(t.value(other), t.value(m), true)
          return (
            <div className="tile" key={t.label} title={t.hint}>
              <small>{t.label}</small>
              <span className="num">
                {fmt(t.value(m), t.digits)}
                {t.unit && <em>{t.unit}</em>}
              </span>
              {/* A keeps an empty row so both sides' tiles line up. */}
              <span className={`delta ${smart ? d.verdict : 'flat'}`} aria-hidden={!smart}>
                {smart ? `${d.verdict === 'good' ? '▼' : d.verdict === 'bad' ? '▲' : ''} ${d.label}` : '\u00a0'}
              </span>
            </div>
          )
        })}
      </div>
      <p className="amb">
        {!run ? (
          smart ? '' : <span className="soft">Press E to send an ambulance into both</span>
        ) : (
          <>
            🚑 #{run.tag.replace('ambulance-', '')} <span className="soft">{run.from.replace(/ from the /, ' · ')}</span>{' '}
            <b>{mine !== undefined ? `${mine.toFixed(0)} s` : 'en route…'}</b>
            {gain !== undefined && (
              <span className={`delta ${Math.abs(gain) < 3 ? 'flat' : gain < 0 ? 'good' : 'bad'}`}>
                {Math.abs(gain) < 3 ? '≈ same' : `${gain < 0 ? '▼ ' : '▲ +'}${Math.abs(gain).toFixed(0)} s`}
              </span>
            )}
          </>
        )}
      </p>
    </section>
  )
}

/** Split view scoreboard: A under the left view, B (with deltas) under the right, live chart between. */
export function SplitDock() {
  const metrics = useSimStore((s) => s.metrics)
  const runs = useSimStore((s) => s.ambulances)
  const [metric, setMetric] = useState<ChartMetric>('queue')
  if (!metrics) return null
  const run = runs[runs.length - 1]
  return (
    <div className="dock" style={{ height: DOCK_PX }}>
      <Side mode="fixed" m={metrics.fixed} other={metrics.fixed} run={run} />
      <section className="live" aria-label="Live comparison chart">
        <header>
          <div className="seg" role="tablist" aria-label="Chart metric">
            <button role="tab" aria-selected={metric === 'queue'} onClick={() => setMetric('queue')}>
              Stopped now
            </button>
            <button role="tab" aria-selected={metric === 'idle'} onClick={() => setMetric('idle')}>
              Time lost <small>veh·h</small>
            </button>
          </div>
          <span className="chart-legend">
            <i className="fixed" /> A Fixed <i className="maxPressure" /> B Smart
          </span>
        </header>
        <LiveChart metric={metric} />
      </section>
      <Side mode="maxPressure" m={metrics.maxPressure} other={metrics.fixed} run={run} />
    </div>
  )
}
