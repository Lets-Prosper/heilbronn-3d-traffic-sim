// Signal topology shared by all controllers.
//
// OSM tags signals on the approach stop lines, not on the junction node, so a
// real intersection is several signal nodes 10–40 m apart. They are clustered
// into one Intersection whose approaches share a two-phase plan:
// group 0 = north–south movements, group 1 = east–west.
import type { NetEdge, Network } from '../network/types'

export type PhaseGroup = 0 | 1

export interface Approach {
  key: string
  node: number
  edge: number
  group: PhaseGroup
}

export interface Intersection {
  id: number
  nodes: number[]
  /** Centroid of the signal nodes. */
  x: number
  z: number
  approaches: Approach[]
  /** Phase groups that have at least one approach. */
  groups: PhaseGroup[]
}

/** Signal nodes closer than this (single linkage) form one intersection, m. */
export const CLUSTER_RADIUS_M = 60

export const approachKey = (node: number, edge: number) => `${node}:${edge}`

/** Unit heading at the end of an edge (last segment ≥ 0.5 m; OSM has some zero-length tails). */
export function edgeHeading(e: NetEdge): { dx: number; dz: number } {
  const p = e.points
  for (let i = p.length - 1; i > 0; i--) {
    const dx = p[i].x - p[i - 1].x
    const dz = p[i].z - p[i - 1].z
    const l = Math.hypot(dx, dz)
    if (l >= 0.5) return { dx: dx / l, dz: dz / l }
  }
  const a = p[0]
  const b = p[p.length - 1]
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1
  return { dx: (b.x - a.x) / l, dz: (b.z - a.z) / l }
}

/** 0 = north–south, 1 = east–west (by the heading at the stop line). */
export function phaseGroup(e: NetEdge): PhaseGroup {
  const h = edgeHeading(e)
  return Math.abs(h.dz) >= Math.abs(h.dx) ? 0 : 1
}

export function buildIntersections(net: Network, radius = CLUSTER_RADIUS_M): Intersection[] {
  const sig = [...net.nodes.values()].filter((n) => n.signal)
  const parent = sig.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < sig.length; i++) {
    for (let j = i + 1; j < sig.length; j++) {
      if (Math.hypot(sig[i].pos.x - sig[j].pos.x, sig[i].pos.z - sig[j].pos.z) < radius) parent[find(j)] = find(i)
    }
  }
  const clusters = new Map<number, typeof sig>()
  sig.forEach((n, i) => {
    const r = find(i)
    let c = clusters.get(r)
    if (!c) clusters.set(r, (c = []))
    c.push(n)
  })

  const out: Intersection[] = []
  for (const members of clusters.values()) {
    const x = members.reduce((s, n) => s + n.pos.x, 0) / members.length
    const z = members.reduce((s, n) => s + n.pos.z, 0) / members.length
    const candidates = members.flatMap((n) => n.in.map((edge) => ({ node: n, edge })))
    // Only movements heading into the intersection get a stop line; a two-way street's
    // signal node would otherwise also stop traffic leaving the junction.
    const inbound = candidates.filter(({ node, edge }) => {
      const h = edgeHeading(net.edges[edge])
      return h.dx * (x - node.pos.x) + h.dz * (z - node.pos.z) > 0
    })
    const approaches = (inbound.length ? inbound : candidates).map(({ node, edge }) => ({
      key: approachKey(node.id, edge),
      node: node.id,
      edge,
      group: phaseGroup(net.edges[edge]),
    }))
    const groups = ([0, 1] as const).filter((g) => approaches.some((a) => a.group === g))
    out.push({ id: out.length, nodes: members.map((n) => n.id), x, z, approaches, groups })
  }
  return out
}

/** approachKey -> [intersection, approach]. */
export function indexApproaches(xs: Intersection[]): Map<string, [Intersection, Approach]> {
  const m = new Map<string, [Intersection, Approach]>()
  for (const x of xs) for (const a of x.approaches) m.set(a.key, [x, a])
  return m
}
