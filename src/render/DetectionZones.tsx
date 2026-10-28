import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Network } from '../engine/network/types'
import { DETECTION_M, useSimStore } from '../state/simStore'
import { buildZoneMesh } from './zoneGeometry'
import { LAYER_Y } from './geometry'
import type { RoadLayout } from './layout'

const IDLE = new THREE.Color('#22d3ee')
const BUS = new THREE.Color('#ffb020')
const EMERGENCY_A = new THREE.Color('#ff2d2d')
const EMERGENCY_B = new THREE.Color('#2f6bff')
/** Vehicles in a zone at which it shows full intensity. */
const FULL_AT = 12

interface Zone {
  key: string
  geometry: THREE.BufferGeometry
}

/**
 * Smart mode only (the scene shows it with sim B): what the controller "sees". Each signalized approach gets a ribbon over its
 * lanes covering the detection range; brightness = detected vehicles, amber = bus, flashing
 * red/blue = emergency vehicle being given priority. The fixed loop has no detectors, so nothing
 * is drawn in Mode A.
 */
export function DetectionZones({ network, layout, keys }: { network: Network; layout: RoadLayout; keys: string[] }) {
  const zones = useMemo<Zone[]>(
    () =>
      keys.map((key) => {
        const edge = Number(key.split(':')[1])
        const z = buildZoneMesh(network, layout, edge, DETECTION_M)
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(z.positions, 3))
        // RGBA vertex colors: white, alpha fades away from the stop line; tint comes from material.color.
        const rgba = new Float32Array((z.fade.length) * 4)
        z.fade.forEach((f, i) => rgba.set([1, 1, 1, f], i * 4))
        g.setAttribute('color', new THREE.BufferAttribute(rgba, 4))
        g.setIndex(z.indices)
        return { key, geometry: g }
      }),
    [network, layout, keys],
  )
  useLayoutEffect(() => () => zones.forEach((z) => z.geometry.dispose()), [zones])
  // Materials are animated every frame, so they live in a ref map rather than React state.
  const mats = useRef(new Map<string, THREE.MeshBasicMaterial>())

  useFrame(({ clock }) => {
    const det = useSimStore.getState().detections
    const flash = Math.sin(clock.elapsedTime * 12) > 0
    for (const [key, mat] of mats.current) {
      const d = det[key]
      const load = Math.min(1, (d?.count ?? 0) / FULL_AT)
      if (d?.request === 'emergency') {
        mat.color.copy(flash ? EMERGENCY_A : EMERGENCY_B)
        mat.opacity = 0.75
      } else if (d?.request === 'bus') {
        mat.color.copy(BUS)
        mat.opacity = 0.55
      } else {
        mat.color.copy(IDLE)
        mat.opacity = 0.12 + 0.5 * load
      }
    }
  })

  return (
    <group position-y={LAYER_Y.marking + 0.02}>
      {zones.map((z) => (
        <mesh key={z.key} geometry={z.geometry} renderOrder={2}>
          <meshBasicMaterial
            ref={(m) => void (m ? mats.current.set(z.key, m) : mats.current.delete(z.key))}
            vertexColors
            transparent
            depthWrite={false}
            opacity={0.2}
            color={IDLE}
            polygonOffset
            polygonOffsetFactor={-2}
          />
        </mesh>
      ))}
    </group>
  )
}
