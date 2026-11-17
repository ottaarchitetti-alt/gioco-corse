/**
 * Aerodinamica semplice.
 *   resistenza  F = ½ · ρ · Cd·A · v²   (frena l'auto, cresce col quadrato della velocità)
 *   deportanza  F = ½ · ρ · Cl·A · v²   (schiaccia l'auto a terra → più aderenza in curva veloce)
 */
import type { CarParams } from './CarParams';

export const AIR_DENSITY = 1.225; // kg/m³ al livello del mare, 15 °C

export function dragForce(car: CarParams, speed: number): number {
  return 0.5 * AIR_DENSITY * car.dragArea * speed * speed;
}

/** Deportanza totale (N) e divisione tra assale anteriore e posteriore. */
export function downforce(car: CarParams, speed: number): { front: number; rear: number } {
  const total = 0.5 * AIR_DENSITY * car.liftArea * speed * speed;
  return { front: total * car.aeroBalanceFront, rear: total * (1 - car.aeroBalanceFront) };
}
