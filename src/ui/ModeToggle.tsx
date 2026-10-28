import { useSimStore } from '../state/simStore'

/** The big A/B switch. Both modes are always running; this picks which one the city shows. */
export function ModeToggle() {
  const view = useSimStore((s) => s.view)
  const setView = useSimStore((s) => s.setView)
  const smart = view === 'maxPressure'
  return (
    <div className="mode-toggle" data-smart={smart}>
      <button aria-pressed={!smart} onClick={() => setView('fixed')}>
        <span className="tag">A</span> Fixed loop
      </button>
      <button aria-pressed={smart} onClick={() => setView('maxPressure')}>
        <span className="tag">B</span> Smart control
      </button>
      <span className="knob" aria-hidden />
      <span className="legend">
        {smart
          ? 'Detectors (blue zones) count every approach · priority for buses & ambulances'
          : 'Timer only: 30 s / 30 s, blind to queues, buses and ambulances'}
      </span>
    </div>
  )
}
