import { useSimStore } from '../state/simStore'

/** Brief full-screen flash when the presenter flips the toggle. No captions, nothing automatic. */
export function DemoOverlay() {
  const flipNonce = useSimStore((s) => s.flipNonce)
  const shown = useSimStore((s) => (s.split ? 'split' : s.view))
  if (flipNonce === 0) return null
  const label = shown === 'split' ? 'Side by side' : shown === 'maxPressure' ? 'Smart control' : 'Fixed loop'
  // key remounts the element so the CSS animation replays on every flip
  return (
    <div key={flipNonce} className={`flip-flash ${shown}`}>
      <span>{label}</span>
    </div>
  )
}
