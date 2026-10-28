import { useSimStore } from '../state/simStore'

const SPEEDS = [1, 2, 4, 8, 16]
const SCALES = [1, 1.5, 2, 3]
const THROUGH = [0, 300, 600]

/** Top bar: transport, scenario, camera and demo controls. */
export function Hud() {
  const time = useSimStore((s) => s.metrics?.fixed.time ?? 0)
  const running = useSimStore((s) => s.running)
  const speed = useSimStore((s) => s.speed)
  const demand = useSimStore((s) => s.demand)
  const demo = useSimStore((s) => s.demo.phase)
  const { setRunning, setSpeed, setDemand, restart, shot, startDemo, stopDemo } = useSimStore.getState()
  const clock = `${String(Math.floor(time / 60)).padStart(2, '0')}:${String(Math.floor(time % 60)).padStart(2, '0')}`

  return (
    <div className="hud">
      <strong>StadtFluss</strong>
      <span className="clock">{clock}</span>
      <button onClick={() => setRunning(!running)}>{running ? 'Pause' : 'Play'}</button>
      <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Sim speed">
        {SPEEDS.map((s) => (
          <option key={s} value={s}>{s}×</option>
        ))}
      </select>
      <button onClick={restart} title="Re-run both modes from t = 0 with the same seed and demand">↺ Re-run A + B</button>
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
          <option key={v} value={v}>{v ? `+${v} veh/h assumed through` : 'counted movements only'}</option>
        ))}
      </select>
      <span className="sep" />
      <button onClick={() => shot('overview')}>Overview</button>
      <button onClick={() => shot('worst')} title="Most congested intersection under the fixed loop">Worst junction</button>
      <button className="demo" onClick={demo === 'off' ? startDemo : stopDemo}>
        {demo === 'off' ? '▶ Before / after demo' : 'End demo'}
      </button>
    </div>
  )
}
