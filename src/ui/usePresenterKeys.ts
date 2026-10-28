import { useEffect } from 'react'
import { useSimStore } from '../state/simStore'

const SPEEDS = [1, 2, 4, 8, 16]

/**
 * Presenter shortcuts (ignored while typing in a control):
 *   Space  play / pause          A / B  fixed loop / smart control   S  side by side
 *   E      ambulance (busiest side)   ↑ / ↓  faster / slower
 *   R      re-run both modes      W / O  worst junction / overview camera
 */
export function usePresenterKeys() {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null
      if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return
      const s = useSimStore.getState()
      const i = SPEEDS.indexOf(s.speed)
      switch (ev.key.toLowerCase()) {
        case ' ':
          s.setRunning(!s.running)
          break
        case 'a':
          s.setView('fixed')
          break
        case 'b':
          s.setView('maxPressure')
          break
        case 's':
          s.setSplit(!s.split)
          break
        case 'e':
          s.dispatchAmbulance()
          break
        case 'r':
          s.restart()
          break
        case 'w':
          s.shot('worst')
          break
        case 'o':
          s.shot('overview')
          break
        case 'arrowup':
          s.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i) + 1)])
          break
        case 'arrowdown':
          s.setSpeed(SPEEDS[Math.max(0, (i < 0 ? 1 : i) - 1)])
          break
        default:
          return
      }
      ev.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
