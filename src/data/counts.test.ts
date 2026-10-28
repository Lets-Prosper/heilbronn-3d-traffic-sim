import { describe, expect, it } from 'vitest'
import { approachDemand, detectorId, hourlyProfiles, parseCounts } from './counts'

const CSV = [
  'Timestamp;Object_Id;Plausibilisiert.Zählung Kfz[Fzg/Intervall]',
  '02.01.2023 08:00;ig11FD837_D1_ZD1;30', // Monday 07:00–08:00
  '02.01.2023 08:00;ig11FD837_D2_ZD2;60',
  '02.01.2023 08:00;ig11FD837_D3_ZD3;10',
  '02.01.2023 08:00;ig11FD837_D4_Z4;40,5',
  '02.01.2023 08:00;ig11FD837_D12_ZD12;20',
  '02.01.2023 08:00;ig11FD837_D16_ZD16;25',
  '09.01.2023 08:00;ig11FD837_D1_ZD1;50', // next Monday
  '31.12.2023 23:59;ig11FD837_D1_ZD1;7', // Sunday 23:00–24:00
  '',
].join('\r\n')

describe('counts CSV', () => {
  it('extracts detector ids', () => {
    expect(detectorId('ig11FD837_D4_Z4')).toBe('D4')
    expect(detectorId('ig11FD837_D12_ZD12')).toBe('D12')
  })

  it('parses end-of-interval timestamps and decimal commas', () => {
    const r = parseCounts(CSV)
    expect(r).toHaveLength(8)
    expect(r[0]).toMatchObject({ detector: 'D1', date: '2023-01-02', weekday: 1, hour: 7, count: 30 })
    expect(r[3].count).toBe(40.5)
    expect(r[7]).toMatchObject({ date: '2023-12-31', weekday: 0, hour: 23 })
  })

  it('rejects unmapped detectors', () => {
    expect(() => parseCounts('h\r\n02.01.2023 08:00;ig11FD837_D99_ZD99;1')).toThrow(/unmapped/)
  })

  it('builds hourly means and per-approach inflow + turn ratios', () => {
    const p = hourlyProfiles(parseCounts(CSV), 'weekday')
    expect(p.D1[7]).toBe(40) // mean of 30, 50
    const north = approachDemand(p, 7).find((a) => a.approach === 'north')!
    expect(north.inflow).toBe(110)
    expect(north.turns.right).toBeCloseTo(40 / 110)
    expect(north.turns.straight).toBeCloseTo(60 / 110)
    expect(north.uncounted).toEqual([])
    const east = approachDemand(p, 7).find((a) => a.approach === 'east')!
    expect(east).toMatchObject({ inflow: 40.5, turns: { right: 1 }, uncounted: ['left', 'straight'] })
  })
})
