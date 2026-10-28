// Rough CO2 / NOx estimate from idle time + number of stops. Deliberately simple:
// it ranks controllers against each other; it is not an inventory.
import type { MetricsSnapshot } from '.'

/**
 * Idle emission rates for a small/family passenger car, from TRL's idling study:
 * "approximately 17 g of CO2 per minute" (small and family cars); "a large diesel
 * family sized car may emit up to 0.07 g of NOx per minute whilst idling".
 * Source: TRL, "Idling Analysis Summary", PPR987,
 * https://www.trl.co.uk/uploads/trl/documents/PPR987-TRL-Idling-Analysis-Summary.pdf
 * Cross-check: DOE/Argonne give ~0.16 gal/h at idle for a 2.0 L compact sedan;
 * × EPA 8,887 g CO2/gal ≈ 24 g/min — same order. The NOx figure is the upper
 * (large-diesel) end, so NOx here is an upper-bound estimate.
 */
export const IDLE_CO2_G_PER_S = 17 / 60
export const IDLE_NOX_G_PER_S = 0.07 / 60

/**
 * Stop penalty: DERIVED, not a published factor. Each stop throws away the kinetic
 * energy ½·m·v² the car had built up, which the engine must re-supply:
 *   fuel L = ½·m·v² / (η · LHV),  CO2 g = fuel L × 2,348 g/L
 * m = 1,400 kg (typical car + driver); η = 0.20 (spark-ignition efficiency under
 * urban acceleration); LHV petrol ≈ 32 MJ/L; 2,348 g CO2/L = EPA 8,887 g/gal
 * (EPA-420-F-18-008) / 3.785 L/gal. ≈ 50 g CO2 per stop from 50 km/h.
 * No NOx term for stops: no simple citable per-stop factor.
 */
export const CAR_MASS_KG = 1400
export const ENGINE_EFFICIENCY = 0.2
export const PETROL_LHV_J_PER_L = 32e6
export const CO2_G_PER_L_PETROL = 8887 / 3.785

export interface EmissionEstimate {
  co2Kg: number
  noxG: number
  /** Breakdown, kg CO2. */
  idleCo2Kg: number
  stopCo2Kg: number
}

export function estimateEmissions(m: Pick<MetricsSnapshot, 'totalIdle' | 'stopV2Sum'>): EmissionEstimate {
  const idleCo2 = m.totalIdle * IDLE_CO2_G_PER_S
  const stopFuelL = (0.5 * CAR_MASS_KG * m.stopV2Sum) / (ENGINE_EFFICIENCY * PETROL_LHV_J_PER_L)
  const stopCo2 = stopFuelL * CO2_G_PER_L_PETROL
  return {
    co2Kg: (idleCo2 + stopCo2) / 1000,
    noxG: m.totalIdle * IDLE_NOX_G_PER_S,
    idleCo2Kg: idleCo2 / 1000,
    stopCo2Kg: stopCo2 / 1000,
  }
}
