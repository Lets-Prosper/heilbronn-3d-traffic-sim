export function fmt(v: number, digits: number) {
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export type Verdict = 'good' | 'bad' | 'flat'

/** B relative to A, % — and whether that's better, given which direction is good. */
export function delta(a: number, b: number, lowerIsBetter: boolean): { pct: number; verdict: Verdict; label: string } {
  if (!(a > 0)) return { pct: 0, verdict: 'flat', label: '–' }
  const pct = ((b - a) / a) * 100
  const verdict: Verdict = Math.abs(pct) < 0.5 ? 'flat' : pct < 0 === lowerIsBetter ? 'good' : 'bad'
  return { pct, verdict, label: `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(0)}%` }
}
