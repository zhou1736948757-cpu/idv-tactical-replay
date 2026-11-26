/**
 * Waypoint animation math, arc-length interpolation, global timeline sampling,
 * and time <-> speed mode conversion (zero DOM).
 */
import { tZh } from './locales-zh';
import type {
  AnimData,
  AnimDurationInfo,
  AnimEntry,
  AnimGeom,
  AnimMode,
  AnimPositionResult,
  AnimSegDurFn,
  AnimSegmentInfo,
  Point2D,
} from './types';

export function animSegmentLenM(a: Point2D, b: Point2D, geom: AnimGeom): number {
  const units = Math.hypot((b.x - a.x) * geom.dw, (b.y - a.y) * geom.dh);
  return geom.widthM ? (units / geom.dw) * geom.widthM : units;
}

export function animSegPath(anim: Pick<AnimData, 'points' | 'paths'>, i: number): Point2D[] {
  const pts = anim.points ?? [];
  const p = anim.paths?.[i];
  if (p && p.length >= 2) return p;
  return [pts[i]!, pts[i + 1]!];
}

export function animPathLenM(path: readonly Point2D[], geom: AnimGeom): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    d += animSegmentLenM(path[i - 1]!, path[i]!, geom);
  }
  return d;
}

export function animPointAlongPath(path: readonly Point2D[], r: number, geom: AnimGeom): Point2D {
  const first = path[0]!;
  const last = path[path.length - 1]!;
  if (r <= 0) return { x: first.x, y: first.y };
  const total = animPathLenM(path, geom);
  if (!(total > 0) || r >= 1) return { x: last.x, y: last.y };
  const target = r * total;
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const p0 = path[i - 1]!;
    const p1 = path[i]!;
    const seg = animSegmentLenM(p0, p1, geom);
    if (seg > 0 && acc + seg >= target) {
      const t2 = (target - acc) / seg;
      return {
        x: p0.x + (p1.x - p0.x) * t2,
        y: p0.y + (p1.y - p0.y) * t2,
      };
    }
    acc += seg;
  }
  return { x: last.x, y: last.y };
}

export function animSegments(
  anim: AnimData,
  geom: AnimGeom,
  segDurFn?: AnimSegDurFn | null,
): AnimSegmentInfo[] {
  const pts = anim.points ?? [];
  const out: AnimSegmentInfo[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const lenM = animPathLenM(animSegPath(anim, i), geom);
    let t0: number;
    let t1: number;
    if (anim.mode === 'speed') {
      const prev = out[i - 1];
      t0 = prev ? prev.t1 : 0;
      const v = anim.speeds?.[i]?.speed;
      const dur = segDurFn
        ? segDurFn(i, lenM, v)
        : typeof v === 'number' && v > 0
          ? lenM / v
          : 0;
      t1 = t0 + Math.max(0, dur || 0);
    } else {
      const times = anim.times ?? [];
      t0 = times[i] ?? (out[i - 1] ? out[i - 1]!.t1 : 0);
      t1 = Math.max(t0, times[i + 1] ?? t0);
    }
    const dur = t1 - t0;
    out.push({ t0, t1, dur, lenM, avgSpeed: dur > 0 ? lenM / dur : null });
  }
  return out;
}

export function animDuration(
  anim: AnimData,
  geom: AnimGeom,
  segDurFn?: AnimSegDurFn | null,
): AnimDurationInfo {
  const segs = animSegments(anim, geom, segDurFn);
  if (segs.length === 0) return { start: 0, end: 0, total: 0 };
  const start = segs[0]!.t0;
  const end = segs[segs.length - 1]!.t1;
  return { start, end, total: end - start };
}

export function animPositionAt(
  anim: AnimData,
  geom: AnimGeom,
  t: number,
  segDurFn?: AnimSegDurFn | null,
): AnimPositionResult | null {
  const pts = anim.points ?? [];
  if (pts.length === 0) return null;
  if (pts.length === 1) return { x: pts[0]!.x, y: pts[0]!.y, done: true };
  const segs = animSegments(anim, geom, segDurFn);
  const { start, end } = animDuration(anim, geom, segDurFn);
  if (t <= start) return { x: pts[0]!.x, y: pts[0]!.y, done: end <= start };
  if (t >= end) {
    const last = pts[pts.length - 1]!;
    return { x: last.x, y: last.y, done: true };
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s.dur <= 0) continue;
    if (t >= s.t0 && t <= s.t1) {
      const r = (t - s.t0) / s.dur;
      const p = animPointAlongPath(animSegPath(anim, i), r, geom);
      return { x: p.x, y: p.y, done: false };
    }
  }
  for (let i = 0; i < segs.length; i++) {
    if (t <= segs[i]!.t1) {
      const pt = pts[i + 1]!;
      return { x: pt.x, y: pt.y, done: false };
    }
  }
  const last = pts[pts.length - 1]!;
  return { x: last.x, y: last.y, done: true };
}

export function animAvgSpeed(
  anim: AnimData,
  geom: AnimGeom,
  segIdx: number,
  segDurFn?: AnimSegDurFn | null,
): number | null {
  const s = animSegments(anim, geom, segDurFn)[segIdx];
  return s ? s.avgSpeed : null;
}

export function animAllPositions(
  entries: ReadonlyArray<AnimEntry | null | undefined>,
  geom: AnimGeom,
  t: number,
): Array<AnimPositionResult | null> {
  return entries.map((e) => (e && e.anim ? animPositionAt(e.anim, geom, t, e.segDurFn) : null));
}

export function convertAnimMode(
  anim: AnimData,
  targetMode: AnimMode,
  geom: AnimGeom,
  defaultSpeed = 3.8,
  segDurFn?: AnimSegDurFn | null,
): AnimData {
  const points = (anim.points ?? []).map((p) => ({ x: p.x, y: p.y }));
  const paths = anim.paths ? anim.paths.map((p) => (p ? p.map((pt) => ({ x: pt.x, y: pt.y })) : undefined)) : undefined;

  if (anim.mode === targetMode) {
    return {
      mode: targetMode,
      points,
      ...(anim.times ? { times: [...anim.times] } : {}),
      ...(anim.speeds ? { speeds: anim.speeds.map((s) => ({ ...s })) } : {}),
      ...(paths ? { paths } : {}),
    };
  }

  const segs = animSegments(anim, geom, segDurFn);
  if (targetMode === 'speed') {
    const customLabel = tZh('common.custom');
    const speeds = segs.map((s, i) => ({
      name: anim.speeds?.[i]?.name ?? customLabel,
      speed: s.avgSpeed && s.avgSpeed > 0 ? s.avgSpeed : defaultSpeed,
      ...(anim.speeds?.[i]?.buffs ? { buffs: anim.speeds[i]!.buffs!.map((b) => ({ ...b })) } : {}),
    }));
    return {
      mode: 'speed',
      points,
      speeds,
      ...(anim.times ? { times: [...anim.times] } : {}),
      ...(paths ? { paths } : {}),
    };
  }

  const times = segs.length > 0 ? [segs[0]!.t0, ...segs.map((s) => s.t1)] : points.length === 1 ? [0] : [];
  while (times.length < points.length) {
    times.push((times[times.length - 1] ?? 0) + 3);
  }
  return {
    mode: 'time',
    points,
    times,
    ...(anim.speeds ? { speeds: anim.speeds.map((s) => ({ ...s })) } : {}),
    ...(paths ? { paths } : {}),
  };
}
