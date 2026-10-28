import { useEffect } from 'react'
import { Scene } from './render/Scene'
import { useCityStore } from './state/cityStore'
import { DemoOverlay } from './ui/DemoOverlay'
import { Hud } from './ui/Hud'
import { MetricsPanel } from './ui/MetricsPanel'
import { ModeToggle } from './ui/ModeToggle'

export default function App() {
  const load = useCityStore((s) => s.load)
  const error = useCityStore((s) => s.error)
  useEffect(() => {
    void load()
  }, [load])
  return (
    <>
      <Scene />
      <Hud />
      <MetricsPanel />
      <ModeToggle />
      <DemoOverlay />
      {error && <div className="error">Failed to load city: {error}</div>}
    </>
  )
}
