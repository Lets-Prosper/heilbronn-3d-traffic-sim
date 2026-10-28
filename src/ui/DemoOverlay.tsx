import { useSimStore } from '../state/simStore'

/** Brief full-screen flash when the presenter flips the toggle. No captions, nothing automatic. */
export function DemoOverlay() {
  const flipNonce = useSimStore((s) => s.flipNonce)
  const smart = useSimStore((s) => s.view === 'maxPressure')
  if (flipNonce === 0) return null
  // key remounts the element so the CSS animation replays on every flip
  return (
    <div key={flipNonce} className={`flip-flash ${smart ? 'smart' : 'fixed'}`}>
      <span>{smart ? 'Smart control' : 'Fixed loop'}</span>
    </div>
  )
}
