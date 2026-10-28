import { useSimStore } from '../state/simStore'
import { DOCK_PX } from './dock'

/** Split view: the seam between the halves and a name tag on each, with what that half sees right now. */
export function SplitLabels() {
  const stopped = [useSimStore((s) => s.metrics?.fixed.queueNow ?? 0), useSimStore((s) => s.metrics?.maxPressure.queueNow ?? 0)]
  const preempting = useSimStore((s) => s.preempting)
  return (
    <div className="split-chrome" style={{ bottom: DOCK_PX }} aria-hidden>
      <div className="seam" />
      <div className="tag fixed">
        <span className="chip">A</span> Fixed loop <span className="live">{stopped[0]} stopped</span>
      </div>
      <div className="tag maxPressure">
        <span className="chip">B</span> Smart control <span className="live">{stopped[1]} stopped</span>
      </div>
      {preempting && <div className="priority-badge in-split">🚨 Ambulance detected · green for its approach</div>}
    </div>
  )
}

