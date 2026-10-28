import { useEffect, type CSSProperties } from 'react'
import { Scene } from './render/Scene'
import { useCityStore } from './state/cityStore'
import { DemoOverlay } from './ui/DemoOverlay'
import { Hud } from './ui/Hud'
import { MetricsPanel } from './ui/MetricsPanel'
import { ModeToggle } from './ui/ModeToggle'
import { PriorityOverlay } from './ui/PriorityOverlay'
import { DOCK_PX } from './ui/dock'
import { SplitDock } from './ui/SplitDock'
import { SplitLabels } from './ui/SplitLabels'
import { useSimStore } from './state/simStore'
import { usePresenterKeys } from './ui/usePresenterKeys'

export default function App() {
  const load = useCityStore((s) => s.load)
  const error = useCityStore((s) => s.error)
  const split = useSimStore((s) => s.split)
  usePresenterKeys()
  useEffect(() => {
    void load()
  }, [load])
  return (
    <div className={split ? 'app split' : 'app'} style={{ '--dock': `${DOCK_PX}px` } as CSSProperties}>
      <Scene />
      {split && <SplitLabels />}
      <Hud />
      {split ? <SplitDock /> : <MetricsPanel />}
      <ModeToggle />
      <DemoOverlay />
      <PriorityOverlay />
      {error && <div className="error">Failed to load city: {error}</div>}
    </div>
  )
}
