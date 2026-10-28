/** Seedable PRNG (mulberry32). Deterministic across platforms. */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number
  /** Current internal state, for snapshot/restore. */
  state(): number
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0
  return {
    next() {
      s = (s + 0x6d2b79f5) >>> 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    state: () => s,
  }
}
