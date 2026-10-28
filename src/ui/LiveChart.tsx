import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import type { ControllerMode } from '../engine/controllers'
import { useSimStore } from '../state/simStore'

export type ChartMetric = 'queue' | 'idle'

const SERIES: { mode: ControllerMode; tag: string; name: string }[] = [
  { mode: 'fixed', tag: 'A', name: 'Fixed' },
  { mode: 'maxPressure', tag: 'B', name: 'Smart' },
]
const PAD = { l: 34, r: 44, t: 8, b: 18 }

/** Largest "nice" number (1, 2, 2.5, 5 × 10^k) step giving at most `n` intervals up to `max`. */
function niceStep(max: number, n: number) {
  const raw = max / n
  const p = 10 ** Math.floor(Math.log10(raw))
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p
}

const fmtY = (v: number, metric: ChartMetric) => (metric === 'idle' ? v.toFixed(v < 10 ? 1 : 0) : v.toFixed(0))
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

/**
 * A vs B over sim time, same axis: vehicles stopped right now, or total time lost (stopped
 * vehicle-hours). The band between the lines is what smart control saves.
 */
export function LiveChart({ metric }: { metric: ChartMetric }) {
  const history = useSimStore((s) => s.history)
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 400, h: 120 })
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { t } = history
  const ys = history[metric]
  const n = t.length
  const tMax = Math.max(60, n ? t[n - 1] : 0)
  const peak = Math.max(1e-6, ...ys.fixed, ...ys.maxPressure)
  const step = niceStep(peak * 1.08, 3)
  const yMax = Math.ceil((peak * 1.08) / step) * step
  const iw = Math.max(1, size.w - PAD.l - PAD.r)
  const ih = Math.max(1, size.h - PAD.t - PAD.b)
  const x = (v: number) => PAD.l + (v / tMax) * iw
  const y = (v: number) => PAD.t + ih - (v / yMax) * ih
  const line = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const band =
    n > 1
      ? `${line(ys.fixed)}${ys.maxPressure
          .map((v, i) => [i, v] as const)
          .reverse()
          .map(([i, v]) => `L${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`)
          .join('')}Z`
      : ''

  const xStep = niceStep(tMax / 60, 4) * 60
  const xTicks = Array.from({ length: Math.floor(tMax / xStep) + 1 }, (_, i) => i * xStep)
  const yTicks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step)

  // End labels: nudge apart so they never overlap.
  const ends = SERIES.map((s) => ({ ...s, v: n ? ys[s.mode][n - 1] : 0 }))
  const ly = ends.map((e) => (n ? y(e.v) : PAD.t + ih))
  if (Math.abs(ly[0] - ly[1]) < 13) {
    const mid = (ly[0] + ly[1]) / 2
    const up = ends[0].v >= ends[1].v ? 0 : 1
    ly[up] = mid - 6.5
    ly[1 - up] = mid + 6.5
  }

  const onMove = (ev: PointerEvent<SVGSVGElement>) => {
    if (n < 2) return
    const r = ev.currentTarget.getBoundingClientRect()
    const tv = ((ev.clientX - r.left - PAD.l) / iw) * tMax
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (t[mid] < tv) lo = mid
      else hi = mid
    }
    setHover(Math.abs(t[lo] - tv) < Math.abs(t[hi] - tv) ? lo : hi)
  }
  const h = hover !== null && hover < n ? hover : null

  return (
    <div className="chart" ref={box}>
      <svg
        width={size.w}
        height={size.h}
        role="img"
        aria-label={`${metric === 'queue' ? 'Vehicles stopped now' : 'Total time lost'}: A ${fmtY(ends[0].v, metric)}, B ${fmtY(ends[1].v, metric)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <g className="grid">
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={PAD.l + iw} y1={y(v)} y2={y(v)} />
              <text x={PAD.l - 6} y={y(v)} dy="0.32em" textAnchor="end">
                {fmtY(v, metric)}
              </text>
            </g>
          ))}
          {xTicks.map((v) => (
            <text key={v} x={x(v)} y={size.h - 4} textAnchor={v === 0 ? 'start' : 'middle'}>
              {v === 0 ? '0' : `${v / 60} min`}
            </text>
          ))}
        </g>
        {band && <path className="band" d={band} />}
        {SERIES.map((s) => (
          <path key={s.mode} className={`series ${s.mode}`} d={n ? line(ys[s.mode]) : ''} />
        ))}
        {n > 0 &&
          ends.map((e, i) => (
            <g key={e.mode}>
              <circle className={`dot ${e.mode}`} cx={x(t[n - 1])} cy={y(e.v)} r={4} />
              <text className="end" x={x(t[n - 1]) + 8} y={ly[i]} dy="0.32em">
                {e.tag} {fmtY(e.v, metric)}
              </text>
            </g>
          ))}
        {h !== null && (
          <g className="cross">
            <line x1={x(t[h])} x2={x(t[h])} y1={PAD.t} y2={PAD.t + ih} />
            {SERIES.map((s) => (
              <circle key={s.mode} className={`dot ${s.mode}`} cx={x(t[h])} cy={y(ys[s.mode][h])} r={4} />
            ))}
          </g>
        )}
      </svg>
      {h !== null && (
        <div className="tip" style={{ left: Math.min(x(t[h]) + 10, size.w - 120) }}>
          <b>{clock(t[h])}</b>
          {SERIES.map((s) => (
            <span key={s.mode}>
              <i className={s.mode} /> {s.tag} {s.name} <b>{fmtY(ys[s.mode][h], metric)}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
