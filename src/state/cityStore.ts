import { create } from 'zustand'
import { loadCityFromGeojson, type CityGeometry, type FeatureCollection } from '../data'

interface CityStore {
  city?: CityGeometry
  error?: string
  load(url?: string): Promise<void>
}

export const useCityStore = create<CityStore>((set, get) => ({
  async load(url = `${import.meta.env.BASE_URL}data/heilbronn.geojson`) {
    if (get().city) return
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
      const fc = (await res.json()) as FeatureCollection
      set({ city: loadCityFromGeojson(fc), error: undefined })
    } catch (err) {
      set({ error: String(err) })
    }
  },
}))
