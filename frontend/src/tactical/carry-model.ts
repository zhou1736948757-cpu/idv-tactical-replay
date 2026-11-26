/**
 * Carry / balloon struggle & chair reachability model (zero DOM).
 * Ported from pil-tactical-friend/js/core/carry-model.js + radial/chair evaluators.
 */
import { tZh } from './locales-zh';
import { TAC_SURVIVOR_ROLES } from './roles-roster';
import { TAC_TALENT_TYPES } from './talents';
import type {
  CarryChairEval,
  CarryDropBudget,
  CarryProfile,
  CarryRadialBandM,
  CarryRangeBand,
  CarrySelection,
  CarrySelectionInput,
  CarrySurvivorId,
  CarryTalentDef,
  RelPointInput,
} from './types';

export const CARRY_RULES_VERSION = 'balloon-planning-2026-11-17-ui-v4';

export const CARRY_SURVIVORS: Readonly<
  Record<CarrySurvivorId, { key: CarrySurvivorId; struggleBonus: number }>
> = Object.freeze({
  ordinary: { key: 'ordinary', struggleBonus: 0 },
  forward: {
    key: 'forward',
    struggleBonus: TAC_SURVIVOR_ROLES.forward?.traits?.struggle?.struggleBuff?.levels[0] ?? 0.1,
  },
});

export const CARRY_DROP_PROGRESS_DEFAULT = 25;

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

function buildCarryTalents(): Readonly<Record<string, CarryTalentDef>> {
  const out: Record<string, CarryTalentDef> = {};
  for (const [key, t] of Object.entries(TAC_TALENT_TYPES)) {
    const b = t.buff ?? {};
    if (t.camp === 'survivor' && b.struggleBuff) {
      out[key] = {
        group: 'survivor',
        kind: 'struggle',
        levels: [...b.struggleBuff.levels],
      };
      continue;
    }
    if (t.camp === 'hunter' && (b.struggleBuff || b.pickupBuff)) {
      const def: CarryTalentDef = b.struggleBuff
        ? { group: 'hunterStruggle', kind: 'struggle', levels: [...b.struggleBuff.levels] }
        : { group: 'hunterStruggle', kind: 'pickup', levels: [...b.pickupBuff!.levels] };
      if (b.dropBuff) def.dropProgress = [...b.dropBuff.levels];
      out[key] = def;
      continue;
    }
    if (t.camp === 'hunter' && b.speedBuff && b.speedBuff.carry) {
      const src = b.speedBuff;
      const rawLevels = src.levels ?? (src.mult !== undefined ? [src.mult] : [1]);
      const def: CarryTalentDef = {
        group: 'hunterSpeed',
        kind: 'speed',
        levels: rawLevels.map((v) => round4(v - 1)),
      };
      if (src.duration) def.duration = src.duration;
      out[key] = def;
    }
  }
  return Object.freeze(out);
}

export const CARRY_TALENTS: Readonly<Record<string, CarryTalentDef>> = buildCarryTalents();

export const CARRY_DEFAULTS = Object.freeze({
  survivorId: 'ordinary' as CarrySurvivorId,
  baseSpeed: 4.64,
  baseStruggleSeconds: 16,
  initialProgress: 0,
  pickupSeconds: 2,
});

export const CARRY_BAND_COLORS: readonly string[] = Object.freeze([
  '#328bff',
  '#20d6a0',
  '#ffc247',
  '#f16ba8',
  '#fff0b3',
]);

export const CARRY_BAND_OPACITY: readonly number[] = Object.freeze([0.45, 0.45, 0.45, 0.45, 0.22]);

export const CARRY_BAND_LABELS_ZH: readonly string[] = Object.freeze([
  tZh('ui.tac.rocketChair.balloon.band0'),
  tZh('ui.tac.rocketChair.balloon.band1'),
  tZh('ui.tac.rocketChair.balloon.band2'),
  tZh('ui.tac.rocketChair.balloon.band3'),
  tZh('ui.tac.rocketChair.balloon.band4'),
]);

const clampNum = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
};

export function normalizeCarryBuffs(
  buffs: unknown,
): Array<{ key: string; level: number }> {
  if (!Array.isArray(buffs)) return [];
  const out: Array<{ key: string; level: number }> = [];
  for (const b of buffs) {
    if (!b || typeof b !== 'object') continue;
    const rec = b as { key?: unknown; level?: unknown };
    if (typeof rec.key !== 'string') continue;
    const def = CARRY_TALENTS[rec.key];
    if (!def) continue;
    const rawLevel =
      typeof rec.level === 'number' && Number.isFinite(rec.level)
        ? Math.round(rec.level)
        : def.levels.length;
    const level = clampNum(rawLevel, 1, def.levels.length, def.levels.length);
    out.push({ key: rec.key, level });
  }
  return out;
}

export function normalizeCarrySelection(input: CarrySelectionInput = {}): CarrySelection {
  const survivorId: CarrySurvivorId =
    input.survivorId && Object.prototype.hasOwnProperty.call(CARRY_SURVIVORS, input.survivorId)
      ? (input.survivorId as CarrySurvivorId)
      : CARRY_DEFAULTS.survivorId;
  return {
    survivorId,
    baseSpeed: clampNum(input.baseSpeed, 0.1, 40, CARRY_DEFAULTS.baseSpeed),
    baseStruggleSeconds: clampNum(
      input.baseStruggleSeconds,
      0.1,
      300,
      CARRY_DEFAULTS.baseStruggleSeconds,
    ),
    initialProgress: clampNum(input.initialProgress, 0, 100, CARRY_DEFAULTS.initialProgress),
    pickupSeconds: clampNum(input.pickupSeconds, 0, 20, CARRY_DEFAULTS.pickupSeconds),
    buffs: normalizeCarryBuffs(input.buffs),
  };
}

export function createCarryProfile(input: CarrySelectionInput = {}): CarryProfile {
  const selection = normalizeCarrySelection(input);
  let struggleBonus = CARRY_SURVIVORS[selection.survivorId].struggleBonus;
  let speedBonus = 0;
  let pickupSpeedup = 0;
  let dropProgressPercent = CARRY_DROP_PROGRESS_DEFAULT;
  const timedSpeedBuffs: Array<{ value: number; duration: number }> = [];

  for (const { key, level } of selection.buffs) {
    const def = CARRY_TALENTS[key];
    if (!def) continue;
    const value = def.levels[level - 1] ?? 0;
    if (def.kind === 'struggle') struggleBonus += value;
    if (def.dropProgress) dropProgressPercent = def.dropProgress[level - 1] ?? dropProgressPercent;
    if (def.kind === 'pickup') pickupSpeedup += value;
    if (def.kind === 'speed') {
      if (def.duration) timedSpeedBuffs.push({ value, duration: def.duration });
      else speedBonus += value;
    }
  }

  const struggleRate = 1 + struggleBonus;
  const remainingSeconds =
    (selection.baseStruggleSeconds * (1 - selection.initialProgress / 100)) / struggleRate;
  const timedBreakpoints = Array.from(
    new Set(timedSpeedBuffs.map((b) => b.duration).filter((d) => Number.isFinite(d) && d > 0)),
  ).sort((a, b) => a - b);

  return {
    version: CARRY_RULES_VERSION,
    selection,
    struggleRate,
    remainingSeconds,
    dropProgressPercent,
    pickupSeconds: selection.pickupSeconds / (1 + pickupSpeedup),
    timedBreakpoints,
    speedAt(seconds: number): number {
      const timed = timedSpeedBuffs
        .filter((b) => seconds < b.duration)
        .reduce((sum, b) => sum + b.value, 0);
      return selection.baseSpeed * (1 + speedBonus + timed);
    },
  };
}

export function carryDropBudget(profile: CarryProfile, seconds: number): CarryDropBudget {
  const progressPercent =
    profile.selection.initialProgress +
    (seconds * 100 * profile.struggleRate) / profile.selection.baseStruggleSeconds;
  const canHang = progressPercent < 100 - 1e-7;
  const drops = canHang
    ? Math.max(0, Math.ceil((100 - progressPercent - 1e-7) / profile.dropProgressPercent) - 1)
    : null;
  return {
    progressPercent,
    drops,
    canHang,
    risk: canHang && progressPercent >= 90 - 1e-7,
  };
}

export function carryRangeBands(profile: CarryProfile): CarryRangeBand[] {
  const rate = (100 * profile.struggleRate) / profile.selection.baseStruggleSeconds;
  const budget = profile.remainingSeconds;
  const initial = profile.selection.initialProgress;
  const drop = profile.dropProgressPercent;
  const at = (progress: number): number => Math.max(0, Math.min(budget, (progress - initial) / rate));
  const riskAt = at(90);
  const safeAt = (progress: number): number => Math.min(riskAt, at(progress));
  const cuts = [
    0,
    safeAt(100 - 3 * drop),
    safeAt(100 - 2 * drop),
    safeAt(100 - drop),
    riskAt,
    budget,
  ];
  return [0, 1, 2, 3, 4].map((i) => ({
    band: i,
    minSeconds: cuts[i]!,
    maxSeconds: cuts[i + 1]!,
    empty: cuts[i + 1]! - cuts[i]! < 1e-9,
  }));
}

export function carryBandAt(bands: readonly CarryRangeBand[], seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return -1;
  if (seconds >= bands[4]!.maxSeconds) return -1;
  for (let i = 0; i < 5; i++) {
    if (!bands[i]!.empty && seconds < bands[i]!.maxSeconds + 1e-9) return i;
  }
  return -1;
}

function integrateDistance(
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
    const v = speedAt((a + b) / 2);
    dist += (b - a) * v;
  }
  return dist;
}

function travelTimeForDistance(
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

export function computeCarryRadialBandsM(profile: CarryProfile): CarryRadialBandM[] {
  const bands = carryRangeBands(profile);
  const bps = profile.timedBreakpoints ?? [];
  const result: CarryRadialBandM[] = [];
  for (const b of bands) {
    if (b.empty) continue;
    const minRadiusM = integrateDistance(profile.speedAt, bps, 0, b.minSeconds);
    const maxRadiusM = integrateDistance(profile.speedAt, bps, 0, b.maxSeconds);
    result.push({
      band: b.band,
      minSeconds: b.minSeconds,
      maxSeconds: b.maxSeconds,
      minRadiusM,
      maxRadiusM,
      color: CARRY_BAND_COLORS[b.band] ?? '#328bff',
      opacity: CARRY_BAND_OPACITY[b.band] ?? 0.45,
      labelZh: CARRY_BAND_LABELS_ZH[b.band] ?? '',
    });
  }
  return result;
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

export function evaluateChairsForCarry(
  profile: CarryProfile,
  startRelPos: [number, number] | { x: number; y: number },
  chairsRelPos: readonly RelPointInput[],
  mapSize: readonly [number, number],
  widthM: number,
): CarryChairEval[] {
  const start = Array.isArray(startRelPos)
    ? { x: startRelPos[0], y: startRelPos[1] }
    : startRelPos;
  const mPerPx = widthM / mapSize[0];
  const bands = carryRangeBands(profile);
  const bps = profile.timedBreakpoints ?? [];

  const evals: CarryChairEval[] = chairsRelPos.map((raw, i) => {
    const ch = extractRelPoint(raw, i);
    const dxPx = (ch.x - start.x) * mapSize[0];
    const dyPx = (ch.y - start.y) * mapSize[1];
    const distanceM = Math.hypot(dxPx, dyPx) * mPerPx;
    const travelSeconds = travelTimeForDistance(profile.speedAt, bps, distanceM);
    const band = carryBandAt(bands, travelSeconds);
    const budget = carryDropBudget(profile, travelSeconds);
    return {
      index: ch.index,
      x: ch.x,
      y: ch.y,
      distanceM,
      travelSeconds,
      band,
      drops: budget.drops,
      canHang: budget.canHang,
      risk: budget.risk,
      progressPercent: budget.progressPercent,
      ...(ch.label !== undefined ? { label: ch.label } : {}),
      ...(ch.kind !== undefined ? { kind: ch.kind } : {}),
    };
  });

  evals.sort((a, b) => a.travelSeconds - b.travelSeconds || a.distanceM - b.distanceM || a.index - b.index);
  return evals;
}
