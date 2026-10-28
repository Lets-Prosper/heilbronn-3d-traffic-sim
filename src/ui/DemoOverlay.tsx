import { estimateEmissions } from '../engine/metrics/emissions'
import { DEMO_FLIP_S, useSimStore } from '../state/simStore'

/** Change from a to b as a signed percent string, e.g. "−42%". */
const change = (a: number, b: number) => {
  const p = a > 0 ? Math.round(((b - a) / a) * 100) : 0
  return `${p <= 0 ? '−' : '+'}${Math.abs(p)}%`
}

/** Demo captions + the full-screen flash on every A/B flip. */
export function DemoOverlay() {
  const phase = useSimStore((s) => s.demo.phase)
  const flipNonce = useSimStore((s) => s.flipNonce)
  const view = useSimStore((s) => s.view)
  const m = useSimStore((s) => s.metrics)
  const smart = view === 'maxPressure'

  let caption: React.ReactNode = null
  if (phase === 'before' && m) {
    const left = Math.max(0, DEMO_FLIP_S - m.fixed.time)
    caption = (
      <>
        <b>Fixed loop.</b> 07:00 weekday · real 2023 counts ×2 + assumed through traffic. Lights cycle 30 s / 30 s regardless of
        queues. <span className="soft">Switching in {Math.ceil(left)} s…</span>
      </>
    )
  } else if (phase === 'after' && m) {
    const wait = change(m.fixed.meanWait, m.maxPressure.meanWait)
    const co2 = change(estimateEmissions(m.fixed).co2Kg, estimateEmissions(m.maxPressure).co2Kg)
    caption = (
      <>
        <b>Smart control.</b> Same cars, same moment — each junction now serves whichever approach has the most pressure.{' '}
        <span className="big">{wait} wait</span> <span className="big">{co2} CO₂</span>
      </>
    )
  }

  return (
    <>
      {/* key remounts the element so the CSS animation replays on every flip */}
      {flipNonce > 0 && (
        <div key={flipNonce} className={`flip-flash ${smart ? 'smart' : 'fixed'}`}>
          <span>{smart ? 'Smart control' : 'Fixed loop'}</span>
        </div>
      )}
      {caption && <div className="caption">{caption}</div>}
    </>
  )
}
