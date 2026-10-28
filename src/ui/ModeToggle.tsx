import { useSimStore } from '../state/simStore'

const OPTIONS = [
  { key: 'fixed', tag: 'A', label: 'Fixed loop', legend: 'Timer only: 30 s / 30 s, blind to queues, buses and ambulances' },
  { key: 'split', tag: 'A | B', label: 'Side by side', legend: '' },
  { key: 'maxPressure', tag: 'B', label: 'Smart control', legend: 'Detectors (blue zones) count every approach · priority for buses & ambulances' },
] as const

/**
 * The big switch: A full-screen, both side by side, or B full-screen. Both modes are always
 * running; this only picks what the city shows.
 */
export function ModeToggle() {
  const current = useSimStore((s) => (s.split ? 'split' : s.view))
  const { setView, setSplit } = useSimStore.getState()
  const i = OPTIONS.findIndex((o) => o.key === current)
  return (
    <div className="mode-toggle" data-pos={current} role="radiogroup" aria-label="What the city shows">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          role="radio"
          aria-checked={o.key === current}
          title={o.key === 'split' ? 'Key S' : `Key ${o.tag}`}
          onClick={() => (o.key === 'split' ? setSplit(true) : setView(o.key))}
        >
          <span className="tag">{o.tag}</span> {o.label}
        </button>
      ))}
      <span className="knob" aria-hidden style={{ transform: `translateX(${i * 100}%)` }} />
      {OPTIONS[i].legend && <span className="legend">{OPTIONS[i].legend}</span>}
    </div>
  )
}
