/**
 * Tide Turner (化险为夷 20s + 20–21s 5% margin) reachability model (zero DOM).
 * Ported from pil-tactical-friend/js/core/tide-model.js + radial/chair evaluators.
 */
import { tZh } from './locales-zh';
import type {
  RelPointInput,
  TideBuffInput,
  TideChairEval,
  TideProfile,
  TideRadialBandM,
  TideRangeBand,
} from './types';

export const TIDE_SECONDS = 20;
export const TIDE_MAX_SECONDS = 21;

export const TIDE_BAND_COLORS: readonly string[] = Object.freeze([
  '#328bff',
  '#20d6a0',
  '#ffc247',
  '#f16ba8',
  '#fff0b3',
]);

export const TIDE_BAND_OPACITY: readonly number[] = Object.freeze([0.45, 0.45, 0.45, 0.45, 0.22]);

export const TIDE_BAND_LABELS_ZH: readonly string[] = Object.freeze([
  tZh('ui.tac.rocketChair.tideTurner.band0'),
  tZh('ui.tac.rocketChair.tideTurner.band1'),
  tZh('ui.tac.rocketChair.tideTurner.band2'),
  tZh('ui.tac.rocketChair.tideTurner.band3'),
  tZh('ui.tac.rocketChair.tideTurner.band4'),
]);

export function tideRangeBands(): TideRangeBand[] {
  const cuts = [0, 5, 10, 15, TIDE_SECONDS, TIDE_MAX_SECONDS];
  return [0, 1, 2, 3, 4].map((i) => ({
    band: i,
    minSeconds: cuts[i]!,
    maxSeconds: cuts[i + 1]!,
    empty: false,
  }));
}

export function tideBandAt(bands: readonly TideRangeBand[], seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return -1;
  if (seconds >= bands[4]!.maxSeconds) return -1;
  for (let i = 0; i < 5; i++) {
    if (seconds < bands[i]!.maxSeconds + 1e-9) return i;
  }
  return -1;
}

export function createTideProfile(
  input: { baseSpeed?: number; buffs?: TideBuffInput[] } = {},
): TideProfile {
  const base =
    typeof input.baseSpeed === 'number' && Number.isFinite(input.baseSpeed) && input.baseSpeed > 0
      ? input.baseSpeed
      : 3.8;
  const list = (input.buffs ?? []).filter(
    (b): b is TideBuffInput => Boolean(b) && Number.isFinite(b.mult),
  );
  const timedBreakpoints = Array.from(
    new Set(
      list
        .map((b) => b.duration)
        .filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d > 0),
    ),
  ).sort((a, b) => a - b);

  return {
    remainingSeconds: TIDE_MAX_SECONDS,
    baseSpeed: base,
    timedBreakpoints,
    speedAt(seconds: number): number {
      const active = list.filter((b) => !b.duration || seconds < b.duration - 1e-9);
      const addMult = Math.max(
        0.01,
        1 +
          active
            .filter((b) => !b.postMult)
            .reduce((sum, b) => sum + (b.mult - 1), 0),
      );
      const mult = active
        .filter((b) => b.postMult)
        .reduce((product, b) => product * b.mult, addMult);
      return base * mult;
    },
  };
}

function integrateTideDistance(
  speedAt: (t: number) => number,
  breakpoints: readonly number[],
  tStart: number,
  tEnd: number,
): number {
  if (tEnd <= tStart) return 0;
  const pts = [tStart, ...breakpoints.filter((bp) => bp > tStart && bp < tEnd), tEnd];
  let dist = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (b - a <= 0) continue;
    dist += (b - a) * speedAt((a + b) / 2);
  }
  return dist;
}

function tideTravelTimeForDistance(
  speedAt: (t: number) => number,
  breakpoints: readonly number[],
  distanceM: number,
): number {
  if (!(distanceM > 0)) return 0;
  let rem = distanceM;
  let prev = 0;
  for (const bp of breakpoints) {
    if (bp <= prev) continue;
    const v = speedAt((prev + bp) / 2);
    if (v > 0) {
      const segDist = (bp - prev) * v;
      if (rem <= segDist + 1e-12) {
        return prev + rem / v;
      }
      rem -= segDist;
    }
    prev = bp;
  }
  const vTail = speedAt(prev + 1);
  return vTail > 0 ? prev + rem / vTail : Infinity;
}

export function computeTideRadialBandsM(profile: TideProfile): TideRadialBandM[] {
  const bands = tideRangeBands();
  const bps = profile.timedBreakpoints ?? [];
  return bands.map((b) => ({
    band: b.band,
    minSeconds: b.minSeconds,
    maxSeconds: b.maxSeconds,
    minRadiusM: integrateTideDistance(profile.speedAt, bps, 0, b.minSeconds),
    maxRadiusM: integrateTideDistance(profile.speedAt, bps, 0, b.maxSeconds),
    color: TIDE_BAND_COLORS[b.band] ?? '#328bff',
    opacity: TIDE_BAND_OPACITY[b.band] ?? 0.45,
    labelZh: TIDE_BAND_LABELS_ZH[b.band] ?? '',
  }));
}

function extractRelPoint(
  input: RelPointInput,
  fallbackIndex: number,
): { x: number; y: number; index: number; label?: string; kind?: string } {
  if (Array.isArray(input)) {
    return { x: input[0], y: input[1], index: fallbackIndex };
  }
  if ('relPos' in input) {
    return {
      x: input.relPos[0],
      y: input.relPos[1],
      index: input.index ?? fallbackIndex,
      label: input.label,
      kind: input.kind,
    };
  }
  return { x: input.x, y: input.y, index: fallbackIndex };
}

export function evaluateChairsForTide(
  profile: TideProfile,
  targetRelPos: [number, number] | { x: number; y: number },
  chairsRelPos: readonly RelPointInput[],
  mapSize: readonly [number, number],
  widthM: number,
): TideChairEval[] {
  const target = Array.isArray(targetRelPos)
    ? { x: targetRelPos[0], y: targetRelPos[1] }
    : targetRelPos;
  const mPerPx = widthM / mapSize[0];
  const bands = tideRangeBands();
  const bps = profile.timedBreakpoints ?? [];

  const evals: TideChairEval[] = chairsRelPos.map((raw, i) => {
    const ch = extractRelPoint(raw, i);
    const dxPx = (ch.x - target.x) * mapSize[0];
    const dyPx = (ch.y - target.y) * mapSize[1];
    const distanceM = Math.hypot(dxPx, dyPx) * mPerPx;
    const travelSeconds = tideTravelTimeForDistance(profile.speedAt, bps, distanceM);
    const band = tideBandAt(bands, travelSeconds);
    return {
      index: ch.index,
      x: ch.x,
      y: ch.y,
      distanceM,
      travelSeconds,
      band,
      reachable20s: band >= 0 && band <= 3,
      inMargin: band === 4,
      reachable: band >= 0,
      ...(ch.label !== undefined ? { label: ch.label } : {}),
      ...(ch.kind !== undefined ? { kind: ch.kind } : {}),
    };
  });

  evals.sort((a, b) => a.travelSeconds - b.travelSeconds || a.distanceM - b.distanceM || a.index - b.index);
  return evals;
}
