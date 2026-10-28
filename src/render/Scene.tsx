import { CameraControls, Stats } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import type CameraControlsImpl from 'camera-controls'
import { useEffect, useMemo, useRef } from 'react'
import type { CityGeometry } from '../data'
import { useCityStore } from '../state/cityStore'
import { useSimStore } from '../state/simStore'
import { buildIntersections } from '../engine/controllers'
import { Buildings, Cars, Ground, LiveTrafficLights, Roads, SimCars } from './City'
import { demoCars } from './demoCars'
import { buildRoadLayout } from './layout'
import { signalHeads } from './signals'
import { MAX_CARS, PALETTE } from './theme'

/** Drives the fixed-step engine from the render loop. Draws nothing. */
function SimDriver() {
  const advance = useSimStore((s) => s.advance)
  useFrame((_, delta) => advance(delta))
  return null
}

/** Karlsruher Straße × Theresienstraße, in local meters. */
const FOCUS: [number, number, number] = [-95, 0, 15]

/** Initial camera, ?view=overview|junction. Later shots come from the store (overview / worst junction / demo). */
const VIEWS: Record<string, [number, number, number]> = {
  overview: [FOCUS[0] + 170, 190, FOCUS[2] + 230],
  junction: [FOCUS[0] + 40, 45, FOCUS[2] + 60],
}
const params = new URLSearchParams(location.search)
const initialView = VIEWS[params.get('view') ?? ''] ?? VIEWS.overview

/** Flies to store camera shots (smoothed by camera-controls), then optionally orbits slowly. */
function CameraRig() {
  const controls = useThree((s) => s.controls) as CameraControlsImpl | null
  const shot = useSimStore((s) => s.camera)
  const orbiting = useRef(false)
  useEffect(() => {
    if (!controls) return
    void controls.setLookAt(...initialView, ...FOCUS, false)
    // Any user drag cancels the auto-orbit.
    const stop = () => (orbiting.current = false)
    controls.addEventListener('controlstart', stop)
    return () => controls.removeEventListener('controlstart', stop)
  }, [controls])
  useEffect(() => {
    if (!controls || !shot) return
    orbiting.current = !!shot.orbit
    void controls.setLookAt(...shot.position, ...shot.target, true)
  }, [controls, shot])
  useFrame((_, dt) => {
    if (orbiting.current && controls) void controls.rotate(dt * 0.06, 0, true)
  })
  return null
}
/** Dev aids: ?cars=3000 adds static demo cars (instancing stress test), ?stats shows an FPS meter. */
const stressCars = Math.min(Number(params.get('cars')) || 0, MAX_CARS)
const showStats = params.has('stats')

function CityView({ city }: { city: CityGeometry }) {
  const init = useSimStore((s) => s.init)
  const layout = useMemo(() => buildRoadLayout(city.network), [city])
  // Heads only where the engine actually controls an approach.
  const heads = useMemo(() => {
    const keys = new Set(buildIntersections(city.network).flatMap((x) => x.approaches.map((a) => a.key)))
    return signalHeads(city.network, layout, keys)
  }, [city, layout])
  const stress = useMemo(() => (stressCars ? demoCars(city.network, layout, 7, stressCars) : null), [city, layout])
  useEffect(() => init(city.network, layout), [init, city, layout])
  return (
    <>
      <Ground city={city} />
      <Roads network={city.network} layout={layout} />
      <Buildings city={city} />
      <LiveTrafficLights heads={heads} />
      <SimCars />
      {stress && <Cars cars={stress} />}
    </>
  )
}

export function Scene() {
  const city = useCityStore((s) => s.city)
  return (
    <Canvas
      shadows="percentage"
      dpr={[1, 1.5]}
      camera={{ position: initialView, fov: 35, near: 1, far: 4000 }}
      gl={{ antialias: true }}
    >
      <color attach="background" args={[PALETTE.sky]} />
      <fog attach="fog" args={[PALETTE.sky, 520, 1500]} />
      {/* 07:00 morning: warm low sun from the east-southeast, cool sky fill — long soft shadows. */}
      <hemisphereLight args={['#dcefff', '#a3b886', 0.95]} />
      <directionalLight
        position={[FOCUS[0] + 420, 230, FOCUS[2] + 90]}
        color="#ffd8a6"
        intensity={2.3}
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.4}
        shadow-camera-left={-500}
        shadow-camera-right={500}
        shadow-camera-top={500}
        shadow-camera-bottom={-500}
        shadow-camera-near={10}
        shadow-camera-far={1200}
      >
        <object3D attach="target" position={FOCUS} />
      </directionalLight>
      <SimDriver />
      {city && <CityView city={city} />}
      {/* smoothTime: cinematic flights between shots; dragging keeps its own snappier smoothing. */}
      <CameraControls makeDefault smoothTime={0.9} maxPolarAngle={Math.PI / 2.4} minDistance={20} maxDistance={1100} />
      <CameraRig />
      {showStats && <Stats />}
    </Canvas>
  )
}
