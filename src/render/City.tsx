import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useSimStore } from '../state/simStore'
import type { CityGeometry } from '../data'
import type { Network } from '../engine/network/types'
import { CAR_COLORS, type CarPose } from './demoCars'
import { buildBrakeLightGeometry, buildBuildingGeometry, buildCarGeometry, buildRoadGeometries, LAYER_Y } from './geometry'
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

/** Lights driven by the sim's published signal aspects (re-renders only when an aspect changes). */
export function LiveTrafficLights({ heads }: { heads: SignalHead[] }) {
  const signals = useSimStore((s) => s.signals)
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

/**
 * Engine vehicles: one InstancedMesh for bodies + one for brake lights (stopped cars only),
 * interpolated between the last two 10 Hz ticks every frame. Two draw calls total.
 */
export function SimCars() {
  const cars = useRef<THREE.InstancedMesh>(null)
  const brakes = useRef<THREE.InstancedMesh>(null)
  const geometry = useMemo(() => buildCarGeometry(), [])
  const brakeGeometry = useMemo(() => buildBrakeLightGeometry(), [])
  useLayoutEffect(() => () => (geometry.dispose(), brakeGeometry.dispose()), [geometry, brakeGeometry])
  const tmp = useMemo(
    () => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0), pos: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1) }),
    [],
  )
  const palette = useMemo(() => CAR_COLORS.map((c) => new THREE.Color(c)), [])

  useFrame(() => {
    const mesh = cars.current
    const lamps = brakes.current
    if (!mesh || !lamps) return
    const { prev, curr, alpha } = useSimStore.getState()
    const { m, q, up, pos, one } = tmp
    let i = 0
    let b = 0
    for (const [id, pose] of curr) {
      if (i >= MAX_CARS) break
      const p = interpolate(prev, pose, id, alpha)
      q.setFromAxisAngle(up, p.yaw)
      m.compose(pos.set(p.x, 0, p.z), q, one)
      mesh.setMatrixAt(i, m)
      mesh.setColorAt(i, palette[(id * 7919) % palette.length])
      i++
      if (p.stopped) lamps.setMatrixAt(b++, m)
    }
    mesh.count = i
    lamps.count = b
    mesh.instanceMatrix.needsUpdate = true
    lamps.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  })

  return (
    <>
      <instancedMesh ref={cars} args={[geometry, undefined, MAX_CARS]} castShadow receiveShadow frustumCulled={false}>
        <meshStandardMaterial vertexColors roughness={0.45} metalness={0.15} />
      </instancedMesh>
      <instancedMesh ref={brakes} args={[brakeGeometry, undefined, MAX_CARS]} frustumCulled={false}>
        <meshStandardMaterial color="#ff2a1a" emissive="#ff2a1a" emissiveIntensity={3} toneMapped={false} />
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
