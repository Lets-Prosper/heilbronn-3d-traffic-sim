import { turnAngle } from './conflicts'
import type { Network } from './types'

/** Nodes at the edge of the study area (or dead ends): at most one distinct neighbour. */
export function boundaryNodes(net: Network): Set<number> {
  const out = new Set<number>()
  for (const n of net.nodes.values()) {
    const nbrs = new Set([...n.out.map((i) => net.edges[i].to), ...n.in.map((i) => net.edges[i].from)])
    if (nbrs.size <= 1) out.add(n.id)
  }
  return out
}

/** Edges leaving a boundary node — where vehicles spawn. Sorted by index. */
export function entryEdges(net: Network): number[] {
  const b = boundaryNodes(net)
  return net.edges.filter((e) => b.has(e.from)).map((e) => e.index)
}

/** Edges entering a boundary node — where vehicles despawn. Sorted by index. */
export function exitEdges(net: Network): number[] {
  const b = boundaryNodes(net)
  return net.edges.filter((e) => b.has(e.to)).map((e) => e.index)
}

/** Free-flow traversal time, s. */
export const edgeCost = (net: Network, i: number) => net.edges[i].length / net.edges[i].speedLimit

/** Turns sharper than this are U-turns (incl. across a dual-carriageway median), radians. */
const UTURN_RAD = (125 * Math.PI) / 180

/**
 * Successor edges, excluding U-turns unless it's the only option: back along the same way, or
 * any turn sharper than 125° (e.g. from one carriageway of a dual road into the other).
 */
export function successors(net: Network, edge: number): number[] {
  const e = net.edges[edge]
  const outs = net.nodes.get(e.to)!.out
  const ok = outs.filter((j) => {
    const o = net.edges[j]
    if (o.to === e.from && o.wayId === e.wayId) return false
    return Math.abs(turnAngle(e, o)) < UTURN_RAD
  })
  return ok.length ? ok : outs
}

export interface PathTree {
  source: number
  /** Travel time from the start of `source` to the end of each edge (Infinity = unreachable). */
  cost: Float64Array
  /** Predecessor edge on the shortest path (-1 = none). */
  prev: Int32Array
}

/** Edge-based Dijkstra (so turn restrictions like no-U-turn are exact). */
export function shortestPathTree(net: Network, source: number): PathTree {
  const n = net.edges.length
  const cost = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  cost[source] = edgeCost(net, source)
  const heap = new MinHeap()
  heap.push(cost[source], source)
  while (heap.size) {
    const [c, u] = heap.pop()
    if (done[u]) continue
    done[u] = 1
    for (const v of successors(net, u)) {
      const nc = c + edgeCost(net, v)
      if (nc < cost[v]) {
        cost[v] = nc
        prev[v] = u
        heap.push(nc, v)
      }
    }
  }
  return { source, cost, prev }
}

/** Edge sequence from tree.source to `target` inclusive, or null if unreachable. */
export function pathTo(tree: PathTree, target: number): number[] | null {
  if (tree.cost[target] === Infinity) return null
  const path: number[] = []
  for (let e = target; e !== -1; e = tree.prev[e]) path.push(e)
  return path.reverse()
}

export function shortestPath(net: Network, from: number, to: number): number[] | null {
  return pathTo(shortestPathTree(net, from), to)
}

/** Binary min-heap keyed by number; ties broken by insertion-independent value order. */
class MinHeap {
  private k: number[] = []
  private v: number[] = []
  get size() {
    return this.k.length
  }
  private less(i: number, j: number) {
    return this.k[i] < this.k[j] || (this.k[i] === this.k[j] && this.v[i] < this.v[j])
  }
  private swap(i: number, j: number) {
    ;[this.k[i], this.k[j]] = [this.k[j], this.k[i]]
    ;[this.v[i], this.v[j]] = [this.v[j], this.v[i]]
  }
  push(key: number, val: number) {
    this.k.push(key)
    this.v.push(val)
    for (let i = this.k.length - 1; i > 0; ) {
      const p = (i - 1) >> 1
      if (!this.less(i, p)) break
      this.swap(i, p)
      i = p
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.k[0], this.v[0]]
    const last = this.k.length - 1
    this.swap(0, last)
    this.k.pop()
    this.v.pop()
    for (let i = 0; ; ) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < last && this.less(l, m)) m = l
      if (r < last && this.less(r, m)) m = r
      if (m === i) break
      this.swap(i, m)
      i = m
    }
    return top
  }
}
