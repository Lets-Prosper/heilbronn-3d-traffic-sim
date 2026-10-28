import { useSimStore } from '../state/simStore'

/** Small live badge while smart mode is pre-empting a junction for an ambulance. */
export function PriorityOverlay() {
  const preempting = useSimStore((s) => s.preempting)
  const smart = useSimStore((s) => s.view === 'maxPressure')
  if (!smart || !preempting) return null
  return <div className="priority-badge">🚨 Ambulance detected · green for its approach</div>
}
