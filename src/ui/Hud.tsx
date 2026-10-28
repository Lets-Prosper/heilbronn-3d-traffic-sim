import { useState } from 'react'
import { useSimStore, type AmbulanceFrom } from '../state/simStore'

const SPEEDS = [1, 2, 4, 8, 16]
const SCALES = [1, 1.5, 2, 3]
const THROUGH = [0, 300, 600]
const FROM: [AmbulanceFrom, string][] = [
  ['busiest', 'busiest side'], ['north', 'from north'], ['east', 'from east'], ['south', 'from south'], ['west', 'from west'],
]
const BUS: [number, string][] = [[0, 'no buses'], [600, 'bus /10 min'], [300, 'bus /5 min']]

/** Top bar: transport, scenario, camera and demo controls. */
export function Hud() {
  const time = useSimStore((s) => s.metrics?.fixed.time ?? 0)
  const running = useSimStore((s) => s.running)
  const speed = useSimStore((s) => s.speed)
  const demand = useSimStore((s) => s.demand)
  const [from, setFrom] = useState<AmbulanceFrom>('busiest')
  const { setRunning, setSpeed, setDemand, restart, shot, pitchSetup, dispatchAmbulance } = useSimStore.getState()
  const clock = `${String(Math.floor(time / 60)).padStart(2, '0')}:${String(Math.floor(time % 60)).padStart(2, '0')}`

  return (
    <div className="hud">
      <strong title="Keys: Space play/pause · A / B fixed / smart · E ambulance · ↑↓ speed · R re-run · W / O camera">StadtFluss</strong>
      <span className="clock">{clock}</span>
      <button onClick={() => setRunning(!running)}>{running ? 'Pause' : 'Play'}</button>
      <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Sim speed">
        {SPEEDS.map((s) => (
          <option key={s} value={s}>{s}×</option>
        ))}
      </select>
      <button onClick={restart} title="Re-run both modes from t = 0 with the same seed and demand">↺ Re-run A+B</button>
      <span className="sep" />
      <select value={demand.hour} onChange={(e) => setDemand({ hour: Number(e.target.value) })} title="Weekday hour (2023 counts)">
        {Array.from({ length: 24 }, (_, h) => (
          <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
        ))}
      </select>
      <select value={demand.scale} onChange={(e) => setDemand({ scale: Number(e.target.value) })} title="Demand multiplier">
        {SCALES.map((s) => (
          <option key={s} value={s}>counts {s}×</option>
        ))}
      </select>
      <select
        value={demand.assumedThroughVph}
        onChange={(e) => setDemand({ assumedThroughVph: Number(e.target.value) })}
        title="ASSUMED Karlsruher Str. through flow per direction (not in the counts)"
      >
        {THROUGH.map((v) => (
          <option key={v} value={v}>{v ? `+${v}/h assumed through` : 'counted only'}</option>
        ))}
      </select>
      <select
        value={demand.busHeadwayS}
        onChange={(e) => setDemand({ busHeadwayS: Number(e.target.value) })}
        title="ILLUSTRATIVE bus lines straight through the junction, both streets, both directions"
      >
        {BUS.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>
      <span className="group">
        <button onClick={() => dispatchAmbulance(from)} title="Send an ambulance through the main junction, in both modes at the same moment">
          🚑 Ambulance
        </button>
        <select value={from} onChange={(e) => setFrom(e.target.value as AmbulanceFrom)} title="Which side it comes from">
          {FROM.map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
      </span>
      <span className="sep" />
      <button onClick={() => shot('overview')}>Overview</button>
      <button onClick={() => shot('worst')} title="Most congested intersection under the fixed loop">Worst jct</button>
      <button className="demo" onClick={pitchSetup} title="Load the pitch scenario (07:00, counts ×2 + assumed through traffic), restart both modes on the fixed loop and frame the worst junction. Nothing runs automatically.">
        🎬 Pitch setup
      </button>
    </div>
  )
}
