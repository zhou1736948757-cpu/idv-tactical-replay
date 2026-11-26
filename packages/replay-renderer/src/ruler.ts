/**
 * Floor classification + floor-aware distance / 45 u/s survivor sprint ETA ruler
 * (Workflow/PLAN.md D2).
 */
import type { FloorId, RulerMeasurement, TacticalDistanceOptions, Vec3 } from './types.js';

export const B1_MAX_Y = -20.0;
export const F2_MIN_Y = 25.0;
export const SURVIVOR_SPRINT_SPEED_U_PER_S = 45.0;
export const DEFAULT_STAIR_PENALTY_U = 90;

/** Default horizontal reference planes per floor. */
export const DEFAULT_FLOOR_PLANES: Readonly<Record<FloorId, number>> = Object.freeze({
  B1: -85.0,
  '1F': 0.0,
  '2F': 60.0,
});

export const FLOOR_IDS: readonly FloorId[] = Object.freeze(['B1', '1F', '2F'] as FloorId[]);

/** B1: y < -20; 1F: -20 <= y < 25; 2F: y >= 25. */
export function classifyFloor(y: number): FloorId {
  if (y < B1_MAX_Y) return 'B1';
  if (y >= F2_MIN_Y) return '2F';
  return '1F';
}

export function measureTacticalDistance(
  pA: Vec3 | readonly number[],
  pB: Vec3 | readonly number[],
  opts: TacticalDistanceOptions = {},
): RulerMeasurement {
  const stairPenaltyU = opts.stairPenaltyU ?? DEFAULT_STAIR_PENALTY_U;
  const speed = opts.sprintSpeedUPerS && opts.sprintSpeedUPerS > 0 ? opts.sprintSpeedUPerS : SURVIVOR_SPRINT_SPEED_U_PER_S;
  const ax = pA[0] ?? 0;
  const ay = pA[1] ?? 0;
  const az = pA[2] ?? 0;
  const bx = pB[0] ?? 0;
  const by = pB[1] ?? 0;
  const bz = pB[2] ?? 0;
  const planarDistanceU = Math.hypot(bx - ax, bz - az);
  const verticalDeltaU = Math.abs(by - ay);
  const euclidean3dU = Math.hypot(planarDistanceU, verticalDeltaU);
  const floorA = classifyFloor(ay);
  const floorB = classifyFloor(by);
  const crossFloor = floorA !== floorB;
  const effectiveDistanceU = euclidean3dU + (crossFloor ? stairPenaltyU : 0);
  return {
    planarDistanceU,
    verticalDeltaU,
    euclidean3dU,
    floorA,
    floorB,
    crossFloor,
    stairPenaltyU: crossFloor ? stairPenaltyU : 0,
    effectiveDistanceU,
    survivorSprintEtaS: effectiveDistanceU / speed,
  };
}

/** "135.0u · 3.0s" */
export function formatRulerLabel(m: RulerMeasurement): string {
  return `${m.effectiveDistanceU.toFixed(1)}u · ${m.survivorSprintEtaS.toFixed(1)}s`;
}

/** "B1→1F +90u" for cross-floor measurements, otherwise null. */
export function formatCrossFloorBadge(m: RulerMeasurement): string | null {
  if (!m.crossFloor) return null;
  return `${m.floorA}→${m.floorB} +${m.stairPenaltyU.toFixed(0)}u`;
}
