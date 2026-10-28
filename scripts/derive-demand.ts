// Derive hourly inflow profiles + turn ratios from the 2023 Zählstelle CSV.
//   npm run derive-demand [-- path/to/file.csv] [--hour 7] [--write]
// --write regenerates src/data/demand2023.json (the browser's copy of the profiles).
import { readFileSync, writeFileSync } from 'node:fs'
import { approachDemand, DETECTORS, hourlyProfiles, parseCounts } from '../src/data/counts'

const args = process.argv.slice(2)
const hourIdx = args.indexOf('--hour')
const peakHour = hourIdx >= 0 ? Number(args[hourIdx + 1]) : 7
const write = args.includes('--write')
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--hour') ?? 'Zählstelle Karlsruher Straße_Theresienstraße_2023.csv'

const text = new TextDecoder('windows-1252').decode(readFileSync(file))
const records = parseCounts(text)
const f0 = (n: number) => n.toFixed(0).padStart(5)
const pct = (n: number) => `${(n * 100).toFixed(1)}%`

console.log(`file: ${file}`)
console.log(`records: ${records.length}  days: ${new Set(records.map((r) => r.date)).size}`)

for (const filter of ['weekday', 'all'] as const) {
  const p = hourlyProfiles(records, filter)
  console.log(`\nMEAN VEH/H BY HOUR (${filter}; hour = interval start)`)
  console.log(`  det  ${Array.from({ length: 24 }, (_, h) => String(h).padStart(5)).join('')}`)
  for (const id of Object.keys(DETECTORS)) console.log(`  ${id.padEnd(4)} ${p[id].map(f0).join('')}`)
  const tot = Array.from({ length: 24 }, (_, h) => Object.values(p).reduce((s, v) => s + v[h], 0))
  console.log(`  sum  ${tot.map(f0).join('')}`)
  const am = tot.slice(5, 11)
  const amPeak = 5 + am.indexOf(Math.max(...am))
  const dayPeak = tot.indexOf(Math.max(...tot))
  console.log(`  AM peak hour: ${amPeak}:00–${amPeak + 1}:00 (${tot[amPeak].toFixed(0)} veh/h)   daily peak: ${dayPeak}:00 (${tot[dayPeak].toFixed(0)} veh/h)`)
}

const p = hourlyProfiles(records, 'weekday')
console.log(`\nSCENARIO: weekday ${peakHour}:00–${peakHour + 1}:00`)
for (const a of approachDemand(p, peakHour)) {
  const turns = Object.entries(a.turns).map(([m, r]) => `${m} ${pct(r!)}`).join(', ')
  const gap = a.uncounted.length ? `  [uncounted: ${a.uncounted.join(', ')}]` : ''
  console.log(`  ${a.approach.padEnd(5)} ${a.street.padEnd(18)} ${a.inflow.toFixed(0).padStart(5)} veh/h  (${(a.inflow / 3600).toFixed(4)} veh/s)  ${turns}${gap}`)
}

if (write) {
  const round = (p: Record<string, number[]>) =>
    Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.map((x) => Math.round(x * 10) / 10)]))
  const out = {
    source: 'Stadt Heilbronn, Zählstelle Karlsruher Straße / Theresienstraße, 2023, plausibilisierte Kfz-Zählung',
    units: 'mean veh/h per detector; index = interval start hour',
    weekday: round(hourlyProfiles(records, 'weekday')),
    all: round(hourlyProfiles(records, 'all')),
  }
  writeFileSync('src/data/demand2023.json', JSON.stringify(out, null, 1) + '\n')
  console.log('\nwrote src/data/demand2023.json')
}
