import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useSimStore } from '../state/simStore'
import type { CityGeometry } from '../data'
import type { ControllerMode } from '../engine/controllers'
import type { Network } from '../engine/network/types'
import { CAR_COLORS, type CarPose } from './demoCars'
import {
  buildBrakeLightGeometry,
  buildBrakeLightGeometryFor,
  buildBuildingGeometry,
  buildBusGeometry,
  buildCarGeometry,
  buildEmergencyGeometry,
  buildLightBarGeometry,
  buildRoadGeometries,
  LAYER_Y,
} from './geometry'
import type { RoadLayout } from './layout'
import type { SignalHead, SignalState } from './signals'
import { MAX_CARS, PALETTE } from './theme'
import { interpolate } from './vehicleFrame'

export function Ground({ city }: { city: CityGeometry }) {
  const { bbox, origin } = city.network
  const size = Math.max(bbox.north - bbox.south, (bbox.east - bbox.west) * Math.cos((origin.lat * Math.PI) / 180)) * 111_320 * 2.5
  return (
    <mesh rotation-x={-Math.PI / 2} receiveShadow>
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial color={PALETTE.ground} roughness={1} />
    </mesh>
  )
}

export function Roads({ network, layout }: { network: Network; layout: RoadLayout }) {
  const g = useMemo(() => buildRoadGeometries(network, layout), [network, layout])
  useLayoutEffect(() => () => Object.values(g).forEach((x) => x.dispose()), [g])
  return (
    <group>
      <mesh geometry={g.sidewalks} receiveShadow>
        <meshStandardMaterial color={PALETTE.sidewalk} roughness={1} />
      </mesh>
      <mesh geometry={g.roads} receiveShadow>
        <meshStandardMaterial color={PALETTE.road} roughness={0.95} />
      </mesh>
      <mesh geometry={g.markings} receiveShadow>
        <meshStandardMaterial color={PALETTE.marking} roughness={0.8} />
      </mesh>
    </group>
  )
}

export function Buildings({ city }: { city: CityGeometry }) {
  const g = useMemo(() => buildBuildingGeometry(city.buildings), [city])
  useLayoutEffect(() => () => g?.dispose(), [g])
  if (!g) return null
  return (
    <mesh geometry={g} castShadow receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.9} flatShading />
    </mesh>
  )
}

const LAMP_COLORS: Record<SignalState, string> = { red: '#ff3b30', yellow: '#ffb300', green: '#2ee86b' }
const LAMP_OFF = '#2a2d31'

function TrafficLight({ x, z, rotY, state, bar }: Omit<SignalHead, 'key'> & { state: SignalState }) {
  return (
    <>
    {/* Glowing stop bar on the road: readable from overview distance. */}
    <mesh position={[bar.x, LAYER_Y.marking + 0.03, bar.z]} rotation-y={rotY}>
      <boxGeometry args={[bar.width, 0.04, 0.5]} />
      <meshStandardMaterial color={LAMP_COLORS[state]} emissive={LAMP_COLORS[state]} emissiveIntensity={1.6} toneMapped={false} />
    </mesh>
    <group position={[x, 0, z]} rotation-y={rotY}>
      <mesh position={[0, 2.1, 0]} castShadow>
        <cylinderGeometry args={[0.09, 0.11, 4.2, 8]} />
        <meshStandardMaterial color={PALETTE.pole} />
      </mesh>
      <mesh position={[0, 4.0, 0.05]} castShadow>
        <boxGeometry args={[0.42, 1.15, 0.32]} />
        <meshStandardMaterial color="#25282c" />
      </mesh>
      {(['red', 'yellow', 'green'] as const).map((s, i) => (
        <mesh key={s} position={[0, 4.36 - i * 0.36, 0.22]}>
          <sphereGeometry args={[0.12, 12, 8]} />
          {s === state ? (
            <meshStandardMaterial color={LAMP_COLORS[s]} emissive={LAMP_COLORS[s]} emissiveIntensity={4} toneMapped={false} />
          ) : (
            <meshStandardMaterial color={LAMP_OFF} />
          )}
        </mesh>
      ))}
    </group>
    </>
  )
}

/** Lights driven by one sim's published signal aspects (re-renders only when an aspect changes). */
export function LiveTrafficLights({ heads, mode }: { heads: SignalHead[]; mode: ControllerMode }) {
  const signals = useSimStore((s) => s.signals[mode])
  return <TrafficLights heads={heads} stateOf={(h) => signals[h.key] ?? 'red'} />
}

export function TrafficLights({ heads, stateOf }: { heads: SignalHead[]; stateOf: (h: SignalHead, i: number) => SignalState }) {
  return (
    <group>
      {heads.map((h, i) => (
        <TrafficLight key={h.key} x={h.x} z={h.z} rotY={h.rotY} bar={h.bar} nodeId={h.nodeId} edgeIndex={h.edgeIndex} state={stateOf(h, i)} />
      ))}
    </group>
  )
}

const FLEETS = ['car', 'bus', 'emergency'] as const
type Fleet = (typeof FLEETS)[number]
const MAX_PER_FLEET: Record<Fleet, number> = { car: MAX_CARS, bus: 200, emergency: 50 }

/**
 * Engine vehicles: one InstancedMesh per vehicle kind + brake lights (stopped vehicles only)
 * + emergency light bars, interpolated between the last two 10 Hz ticks every frame.
 * Seven draw calls total regardless of fleet size.
 */
export function SimCars({ mode }: { mode: ControllerMode }) {
  const bodies = useRef<Record<Fleet, THREE.InstancedMesh | null>>({ car: null, bus: null, emergency: null })
  const brakes = useRef<Record<Fleet, THREE.InstancedMesh | null>>({ car: null, bus: null, emergency: null })
  const bars = useRef<THREE.InstancedMesh>(null)
  const barMat = useRef<THREE.MeshStandardMaterial>(null)
  const geo = useMemo(
    () => ({
      body: { car: buildCarGeometry(), bus: buildBusGeometry(), emergency: buildEmergencyGeometry() },
      brake: {
        car: buildBrakeLightGeometry(),
        bus: buildBrakeLightGeometryFor(5.9, 0.9, 1.0),
        emergency: buildBrakeLightGeometryFor(3.0, 1.0, 0.8),
      },
      bar: buildLightBarGeometry(),
    }),
    [],
  )
  useLayoutEffect(
    () => () => {
      for (const f of FLEETS) {
        geo.body[f].dispose()
        geo.brake[f].dispose()
      }
      geo.bar.dispose()
    },
    [geo],
  )
  const tmp = useMemo(
    () => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0), pos: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1) }),
    [],
  )
  const palette = useMemo(() => CAR_COLORS.map((c) => new THREE.Color(c)), [])

  useFrame(({ clock }) => {
    const car = bodies.current.car
    const bar = bars.current
    if (!car || !bar) return
    const { frames, alpha } = useSimStore.getState()
    const { prev, curr } = frames[mode]
    const { m, q, up, pos, one } = tmp
    const n: Record<Fleet, number> = { car: 0, bus: 0, emergency: 0 }
    const nb: Record<Fleet, number> = { car: 0, bus: 0, emergency: 0 }
    for (const [id, pose] of curr) {
      const f = pose.kind
      const mesh = bodies.current[f]
      if (!mesh || n[f] >= MAX_PER_FLEET[f]) continue
      const p = interpolate(prev, pose, id, alpha)
      q.setFromAxisAngle(up, p.yaw)
      m.compose(pos.set(p.x, 0, p.z), q, one)
      mesh.setMatrixAt(n[f], m)
      if (f === 'car') mesh.setColorAt(n[f], palette[(id * 7919) % palette.length])
      if (f === 'emergency') bar.setMatrixAt(n.emergency, m)
      n[f]++
      if (p.stopped) brakes.current[f]?.setMatrixAt(nb[f]++, m)
    }
    for (const f of FLEETS) {
      const mesh = bodies.current[f]!
      const b = brakes.current[f]!
      mesh.count = n[f]
      b.count = nb[f]
      mesh.instanceMatrix.needsUpdate = true
      b.instanceMatrix.needsUpdate = true
    }
    if (car.instanceColor) car.instanceColor.needsUpdate = true
    bar.count = n.emergency
    bar.instanceMatrix.needsUpdate = true
    // Blue lights: alternate flash ~3 Hz.
    if (barMat.current) barMat.current.emissiveIntensity = Math.sin(clock.elapsedTime * 19) > 0 ? 6 : 0.3
  })

  return (
    <>
      {FLEETS.map((f) => (
        <instancedMesh
          key={f}
          ref={(r) => void (bodies.current[f] = r)}
          args={[geo.body[f], undefined, MAX_PER_FLEET[f]]}
          castShadow
          receiveShadow
          frustumCulled={false}
        >
          <meshStandardMaterial vertexColors roughness={0.45} metalness={0.15} />
        </instancedMesh>
      ))}
      {FLEETS.map((f) => (
        <instancedMesh key={`b-${f}`} ref={(r) => void (brakes.current[f] = r)} args={[geo.brake[f], undefined, MAX_PER_FLEET[f]]} frustumCulled={false}>
          <meshStandardMaterial color="#ff2a1a" emissive="#ff2a1a" emissiveIntensity={3} toneMapped={false} />
        </instancedMesh>
      ))}
      <instancedMesh ref={bars} args={[geo.bar, undefined, MAX_PER_FLEET.emergency]} frustumCulled={false}>
        <meshStandardMaterial ref={barMat} color="#2f6bff" emissive="#2f6bff" emissiveIntensity={6} toneMapped={false} />
      </instancedMesh>
    </>
  )
}

/** Static cars in a single InstancedMesh (?cars=N instancing stress test). */
export function Cars({ cars }: { cars: CarPose[] }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const geometry = useMemo(() => buildCarGeometry(), [])
  useLayoutEffect(() => () => geometry.dispose(), [geometry])

  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const pos = new THREE.Vector3()
    const one = new THREE.Vector3(1, 1, 1)
    const c = new THREE.Color()
    const n = Math.min(cars.length, MAX_CARS)
    for (let i = 0; i < n; i++) {
      const car = cars[i]
      q.setFromAxisAngle(up, Math.atan2(-car.dz, car.dx))
      m.compose(pos.set(car.x, 0, car.z), q, one)
      mesh.setMatrixAt(i, m)
      mesh.setColorAt(i, c.set(car.color))
    }
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [cars])

  return (
    <instancedMesh ref={ref} args={[geometry, undefined, MAX_CARS]} castShadow receiveShadow frustumCulled={false}>
      <meshStandardMaterial vertexColors roughness={0.55} metalness={0.1} />
    </instancedMesh>
  )
}
