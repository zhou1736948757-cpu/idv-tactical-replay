/**
 * Multi-segment polyline movement simulator & buff applicability engine (zero DOM).
 */
import { TAC_ROLES } from './roles';
import { TAC_MOVEMENT_BUFFS } from './tactic-data';
import type {
  MeasureBase,
  MeasureBoardLike,
  MeasureBuff,
  MeasureLineConfig,
  MeasureSimResult,
  MeasureSimSegment,
  Point2D,
} from './types';

export interface MeasureSegmentLike {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  path?: readonly Point2D[];
}

/**
 * Compute segment distance in meters using obstacle-routed polyline `seg.path`
 * when present (`length >= 2`), falling back to straight-line chord distance.
 */
export function measureSegmentDistanceM(
  seg: MeasureSegmentLike,
  mapSize: readonly [number, number],
  widthM: number,
): number {
  const [dw, dh] = mapSize;
  if (!(dw > 0) || !(widthM > 0)) return 0;
  const mPerPx = widthM / dw;
  if (seg.path && seg.path.length >= 2) {
    let totalPx = 0;
    for (let i = 1; i < seg.path.length; i++) {
      const a = seg.path[i - 1]!;
      const b = seg.path[i]!;
      totalPx += Math.hypot((b.x - a.x) * dw, (b.y - a.y) * dh);
    }
    return totalPx * mPerPx;
  }
  return Math.hypot((seg.x2 - seg.x1) * dw, (seg.y2 - seg.y1) * dh) * mPerPx;
}

export function restoreMeasureReferences(boards: Record<string, MeasureBoardLike>): void {
  for (const board of Object.values(boards)) {
    const routes = new Map<number, MeasureLineConfig>();
    for (const measure of board.measures ?? []) {
      if (measure.chain == null || !measure.lc) continue;
      if (!routes.has(measure.chain)) routes.set(measure.chain, measure.lc);
      measure.lc = routes.get(measure.chain) ?? measure.lc;
    }
  }
}

export function measureIdCounters(
  boards: Record<string, MeasureBoardLike>,
): { route: number; config: number; buff: number } {
  const counters = { route: 0, config: 0, buff: 0 };
  const include = (key: 'route' | 'config' | 'buff', id: number | null | undefined): void => {
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > counters[key]) {
      counters[key] = id;
    }
  };
  for (const board of Object.values(boards)) {
    for (const measure of board.measures ?? []) {
      include('route', measure.chain);
      include('config', measure.lc?.lid);
      for (const buff of measure.lc?.buffs ?? []) {
        include('buff', buff.id);
        include('buff', buff.linkId);
      }
    }
  }
  return counters;
}

export function measureBaseAt(config: Pick<MeasureLineConfig, 'bases'>, index: number): MeasureBase {
  return (
    config.bases.find((base) => base.from <= index && base.to > index) ??
    config.bases[0]!
  );
}

export function tacStateOf(base: MeasureBase | null | undefined): string {
  if (!base) return 'run';
  if (base.fixed) return 'fixed';
  if (base.stKey) return base.stKey;
  return base.camp === 'hunter' ? 'hunter' : 'run';
}

export function tacStateMatches(buffStates: readonly string[] | undefined, state: string): boolean {
  if (!buffStates) {
    return (
      state === 'run' ||
      state === 'walk' ||
      state === 'crouch' ||
      state === 'role' ||
      state === 'hunter' ||
      state === 'custom'
    );
  }
  return buffStates.includes(state);
}

export function buffAppliesToBase(buff: MeasureBuff, base: MeasureBase): boolean {
  const state = tacStateOf(base);
  if (base.fixed) return false;
  const camp = base.camp === 'hunter' || base.camp === 'survivor'
    ? base.camp
    : state === 'hunter'
      ? 'hunter'
      : undefined;

  if (buff.type === 'trait') {
    const isSurvTrait = TAC_MOVEMENT_BUFFS.trait.survivor.some((t) => t.key === buff.key);
    const isHuntTrait = TAC_MOVEMENT_BUFFS.trait.hunter.some((t) => t.key === buff.key);
    const td = [...TAC_MOVEMENT_BUFFS.trait.survivor, ...TAC_MOVEMENT_BUFFS.trait.hunter].find(
      (t) => t.key === buff.key,
    );
    if (!td) return true;
    if (camp === 'survivor' && !isSurvTrait) return false;
    if (camp === 'hunter' && !isHuntTrait) return false;
    if (td.roles && td.roles.length > 0 && (!base.role || !td.roles.includes(base.role))) return false;
    if (td.forms && td.forms.length > 0 && !td.forms.includes(base.form ?? 0)) return false;
    if (base.role && (camp === 'hunter' || base.stKey === 'role')) {
      const roleName = TAC_ROLES[base.role]?.name;
      if (roleName && td.role !== roleName) return false;
    }
    return tacStateMatches(td.states, state);
  }

  if (buff.type === 'talent') {
    const tb = buff.key ? TAC_MOVEMENT_BUFFS.talent[buff.key] : undefined;
    if (!tb) return true;
    if (camp && tb.camp && tb.camp !== camp) return false;
    return tacStateMatches(tb.states, state);
  }

  if (buff.type === 'other') {
    const survOb = TAC_MOVEMENT_BUFFS.other.survivor.find((t) => t.key === buff.key);
    const huntOb = TAC_MOVEMENT_BUFFS.other.hunter.find((t) => t.key === buff.key);
    const ob = camp === 'hunter' ? huntOb : camp === 'survivor' ? survOb : (survOb ?? huntOb);
    if (!ob) {
      if (camp && (survOb || huntOb)) return false;
      return true;
    }
    return tacStateMatches(ob.states, state);
  }

  return true;
}

/**
 * Distances are in metres. A timed bonus starts on arrival at its first vertex,
 * and its clock keeps running through segments where it does not apply.
 */
export function simulateMovement(
  distances: readonly number[],
  config: MeasureLineConfig,
  applies: (buff: MeasureBuff, base: MeasureBase) => boolean = buffAppliesToBase,
): MeasureSimResult {
  const n = distances.length;
  const buffs = config.buffs
    .map((buff) => ({
      ...buff,
      from: Math.max(0, Math.min(n, buff.from ?? 0)),
      to: Math.max(0, Math.min(n, buff.to ?? n)),
    }))
    .filter((buff) => buff.to > buff.from);

  const arrival = [0];
  const out: MeasureSimSegment[] = [];
  let time = 0;

  for (let i = 0; i < n; i++) {
    const dist = distances[i]!;
    const base = measureBaseAt(config, i);
    const inDomain = buffs.filter(
      (buff) => !base.fixed && buff.from <= i && buff.to >= i + 1 && applies(buff, base),
    );
    const segment: MeasureSimSegment = { dist, t: 0, t0: dist / base.speed, parts: [] };
    let rest = dist;

    while (rest > 1e-9) {
      const active = inDomain.filter(
        (buff) => !buff.duration || time < arrival[buff.from]! + buff.duration - 1e-9,
      );
      const addMult = Math.max(
        0.01,
        1 +
          active
            .filter((buff) => !buff.postMult)
            .reduce((sum, buff) => sum + ((buff.mult ?? 1) - 1), 0),
      );
      const mult = active
        .filter((buff) => buff.postMult)
        .reduce((product, buff) => product * (buff.mult ?? 1), addMult);
      const speed = base.speed * mult;
      let duration = rest / speed;

      for (const buff of active) {
        if (!buff.duration) continue;
        const remaining = arrival[buff.from]! + buff.duration - time;
        if (remaining < duration) duration = Math.max(0, remaining);
      }

      const distance = speed * duration;
      const last = segment.parts[segment.parts.length - 1];
      if (last && Math.abs(last.v - speed) < 1e-9) {
        last.dist += distance;
        last.t += duration;
      } else {
        segment.parts.push({ dist: distance, t: duration, v: speed, pct: (mult - 1) * 100 });
      }
      segment.t += duration;
      time += duration;
      rest -= distance;
    }

    arrival[i + 1] = time;
    out.push(segment);
  }

  return {
    total: time,
    t0: out.reduce((sum, segment) => sum + segment.t0, 0),
    dist: distances.reduce((sum, dist) => sum + dist, 0),
    arrival,
    segs: out,
  };
}
