// Headless A/B: fixed-cycle (Mode A) vs max-pressure (Mode B) on the calibrated scenario.
// Same seed + same demand stream in both runs.
//   npm run compare [-- --hour 7 --minutes 60 --through 0 --bg 0.004 --seed 1]
import { readFileSync } from 'node:fs'
import { loadCityFromGeojson, type FeatureCollection } from '../src/data'
import { buildScenario } from '../src/data/scenario'
import type { ControllerMode } from '../src/engine/controllers'
import { createSim } from '../src/engine/engine'

const args = process.argv.slice(2)
const arg = (k: string, d: number) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? Number(args[i + 1]) : d
}
const hour = arg('hour', 7)
const minutes = arg('minutes', 60)
const through = arg('through', 0)
const bg = arg('bg', 0.004)
const seed = arg('seed', 1)

const fc = JSON.parse(readFileSync('public/data/heilbronn.geojson', 'utf8')) as FeatureCollection
const { network } = loadCityFromGeojson(fc)

console.log(`weekday ${hour}:00, ${minutes} min, seed ${seed}, background ${bg} veh/s/entry, assumed KA through ${through} veh/h/dir`)
console.log('scale mode         spawned exited  thr/h  meanWait  meanQ  maxQ   idle(veh·h)  backlog')
for (const scale of [1, 2, 3]) {
  const sc = buildScenario(network, { hour, scale, backgroundRate: bg, assumedThroughVph: through })
  for (const mode of ['fixed', 'maxPressure'] as ControllerMode[]) {
    const sim = createSim({ seed, network, entries: sc.entries, mode })
    sim.run(minutes * 60)
    const m = sim.snapshot()
    console.log(
      `${String(scale).padStart(4)}× ${mode.padEnd(12)} ${String(m.spawned).padStart(7)} ${String(m.exited).padStart(6)} ${m.throughputPerHour.toFixed(0).padStart(6)}` +
        `  ${m.meanWait.toFixed(1).padStart(7)}s ${m.meanQueue.toFixed(1).padStart(6)} ${String(m.maxQueue).padStart(5)} ${(m.totalIdle / 3600).toFixed(1).padStart(12)} ${String(m.backlog).padStart(8)}`,
    )
  }
}
