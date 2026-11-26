/**
 * Pure temporal state samplers. All lookups use O(log N) binary search over
 * time-sorted arrays.
 */
import type {
  ActivePulse,
  ChairSample,
  CipherSample,
  GateState,
  PalletState,
  PlayerSample,
  PulseKind,
  ReplayTimelineEvent,
  StaticChairEntity,
  StaticCipherEntity,
  StaticGateEntity,
  StaticPalletEntity,
  TrailPoint,
  TrajectorySampleTuple,
  Vec3,
} from './types.js';

/** Consecutive samples farther apart than this (world units) are treated as a teleport. */
export const TELEPORT_THRESHOLD_U = 60;
export const DEFAULT_TRAIL_SECONDS = 5.0;
export const DEFAULT_PULSE_WINDOW_S = 1.2;
export const WINDOW_BLOCK_SEAL_S = 20;
/** Fallback full elimination timer when a hang interval carries no progress curve. */
export const CHAIR_FALLBACK_FULL_S = 60;

export const FEAR_STATE_LABELS: Readonly<Record<number, string>> = Object.freeze({
  0: 'healthy',
  1: 'injured',
  2: 'downed',
  3: 'chaired',
  4: 'eliminated',
  5: 'escaped',
});

/**
 * Largest index i with getT(arr[i]) <= t, or -1 when t precedes every element.
 * Array must be sorted ascending by time.
 */
export function upperBoundIndex<T>(arr: readonly T[], t: number, getT: (item: T) => number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (getT(arr[mid] as T) <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Smallest index i with getT(arr[i]) >= t (arr.length when none). */
export function lowerBoundIndex<T>(arr: readonly T[], t: number, getT: (item: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (getT(arr[mid] as T) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const tupleT = (s: TrajectorySampleTuple): number => s[0];

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

function normalize2(dx: number, dz: number, fallback: [number, number] = [0, 1]): [number, number] {
  const len = Math.hypot(dx, dz);
  if (!(len > 1e-9)) return fallback;
  return [dx / len, dz / len];
}

/** Shortest-arc yaw interpolation (degrees), result wrapped to [0, 360). */
export function lerpAngleDeg(a: number, b: number, u: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  if (d === -180 && b > a) d = 180;
  const r = (a + d * u) % 360;
  return r < 0 ? r + 360 : r;
}

function sampleFromTuple(s: TrajectorySampleTuple, t: number, teleported: boolean): PlayerSample {
  return {
    t,
    pos: [s[1], s[2], s[3]],
    dir: normalize2(s[4], s[5]),
    speed: s[6],
    camYawDeg: s[7] === null || s[7] === undefined ? null : s[7],
    fearState: s[8],
    teleported,
  };
}

function isTeleport(a: TrajectorySampleTuple, b: TrajectorySampleTuple): boolean {
  return Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]) > TELEPORT_THRESHOLD_U;
}

/**
 * Samples a player trajectory at time t (binary search + lerp).
 * Position/speed lerp, dir lerp + renormalize, cam yaw shortest arc, fear_state discrete (step).
 * Across teleports (> 60u jump) the earlier sample is held without interpolation.
 */
export function samplePlayerAtTime(samples: readonly TrajectorySampleTuple[] | null | undefined, t: number): PlayerSample | null {
  if (!samples || samples.length === 0) return null;
  const first = samples[0] as TrajectorySampleTuple;
  const last = samples[samples.length - 1] as TrajectorySampleTuple;
  if (t <= first[0]) return sampleFromTuple(first, t, false);
  if (t >= last[0]) return sampleFromTuple(last, t, false);
  const i = upperBoundIndex(samples, t, tupleT);
  const a = samples[i] as TrajectorySampleTuple;
  const b = samples[i + 1] as TrajectorySampleTuple;
  const span = b[0] - a[0];
  if (!(span > 0)) return sampleFromTuple(a, t, false);
  if (isTeleport(a, b)) return sampleFromTuple(a, t, true);
  const u = (t - a[0]) / span;
  const dirA = normalize2(a[4], a[5]);
  const dir = normalize2(lerp(dirA[0], b[4], u), lerp(dirA[1], b[5], u), dirA);
  let camYawDeg: number | null;
  if (a[7] !== null && b[7] !== null) camYawDeg = lerpAngleDeg(a[7], b[7], u);
  else camYawDeg = a[7] ?? b[7] ?? null;
  return {
    t,
    pos: [lerp(a[1], b[1], u), lerp(a[2], b[2], u), lerp(a[3], b[3], u)],
    dir,
    speed: lerp(a[6], b[6], u),
    camYawDeg,
    fearState: a[8],
    teleported: false,
  };
}

/**
 * Returns the trailing polyline (oldest -> newest) covering (t - trailSeconds, t].
 * The last point is the interpolated position at t (age 0); age grows to 1 at the oldest edge.
 * Points flagged `breakBefore` start a new segment after a teleport.
 */
export function extractPlayerTrail(
  samples: readonly TrajectorySampleTuple[] | null | undefined,
  t: number,
  trailSeconds: number = DEFAULT_TRAIL_SECONDS,
): Array<TrailPoint & { breakBefore: boolean }> {
  if (!samples || samples.length === 0 || !(trailSeconds > 0)) return [];
  const first = samples[0] as TrajectorySampleTuple;
  if (t < first[0]) return [];
  const t0 = t - trailSeconds;
  const out: Array<TrailPoint & { breakBefore: boolean }> = [];
  const startIdx = lowerBoundIndex(samples, t0, tupleT);
  const endIdx = upperBoundIndex(samples, t, tupleT);
  // Interpolated start point at the trail edge so the trail length is exactly trailSeconds.
  if (startIdx > 0) {
    const edge = samplePlayerAtTime(samples, t0);
    if (edge && !edge.teleported) out.push({ t: t0, pos: edge.pos, age: 1, breakBefore: false });
  }
  let prev: Vec3 | null = out.length ? (out[0] as TrailPoint).pos : null;
  for (let i = startIdx; i <= endIdx; i++) {
    const s = samples[i] as TrajectorySampleTuple;
    const pos: Vec3 = [s[1], s[2], s[3]];
    const breakBefore = prev !== null && Math.hypot(pos[0] - prev[0], pos[1] - prev[1], pos[2] - prev[2]) > TELEPORT_THRESHOLD_U;
    out.push({ t: s[0], pos, age: Math.min(1, Math.max(0, (t - s[0]) / trailSeconds)), breakBefore });
    prev = pos;
  }
  const cur = samplePlayerAtTime(samples, t);
  const lastPt = out[out.length - 1];
  if (cur && (!lastPt || lastPt.t < t)) {
    const breakBefore = prev !== null && Math.hypot(cur.pos[0] - prev[0], cur.pos[1] - prev[1], cur.pos[2] - prev[2]) > TELEPORT_THRESHOLD_U;
    out.push({ t, pos: cur.pos, age: 0, breakBefore });
  }
  return out;
}

const curveT = (p: readonly number[]): number => p[0] as number;

export function sampleCipherAtTime(cipher: StaticCipherEntity, t: number): CipherSample {
  const completedAt = cipher.completed_at;
  if (completedAt !== null && completedAt !== undefined && t >= completedAt) {
    return { progressPct: 100, activeFixerCount: 0, isCompleted: true };
  }
  const curve = cipher.progress_curve ?? [];
  const i = upperBoundIndex(curve, t, curveT);
  if (i < 0) return { progressPct: 0, activeFixerCount: 0, isCompleted: false };
  const a = curve[i] as [number, number, number];
  let progress = a[1];
  const b = curve[i + 1];
  if (b && b[0] > a[0] && a[2] > 0) {
    progress = lerp(a[1], b[1], (t - a[0]) / (b[0] - a[0]));
  }
  progress = Math.max(0, Math.min(100, progress));
  const done = completedAt === null || completedAt === undefined ? progress >= 100 : false;
  return { progressPct: done ? 100 : progress, activeFixerCount: done ? 0 : Math.max(0, a[2]), isCompleted: done };
}

export function samplePalletAtTime(pallet: StaticPalletEntity, t: number): PalletState {
  if (pallet.broken_at !== null && pallet.broken_at !== undefined && t >= pallet.broken_at) return 'broken';
  if (pallet.dropped_at !== null && pallet.dropped_at !== undefined && t >= pallet.dropped_at) return 'dropped';
  return 'upright';
}

export function sampleChairAtTime(chair: StaticChairEntity, t: number): ChairSample {
  for (const iv of chair.hang_intervals ?? []) {
    if (t < iv.start_t || t >= iv.end_t) continue;
    const curve = iv.progress_curve ?? [];
    let pct: number;
    if (curve.length === 0) {
      pct = ((t - iv.start_t) / CHAIR_FALLBACK_FULL_S) * 100;
    } else {
      const i = upperBoundIndex(curve, t, curveT);
      if (i < 0) {
        const c0 = curve[0] as [number, number];
        pct = c0[0] > iv.start_t ? lerp(0, c0[1], (t - iv.start_t) / (c0[0] - iv.start_t)) : c0[1];
      } else {
        const a = curve[i] as [number, number];
        const b = curve[i + 1];
        pct = b && b[0] > a[0] ? lerp(a[1], b[1], (t - a[0]) / (b[0] - a[0])) : a[1];
      }
    }
    return { isOccupied: true, victimUid: iv.victim_uid, eliminationPct: Math.max(0, Math.min(100, pct)) };
  }
  return { isOccupied: false, victimUid: null, eliminationPct: 0 };
}

export function sampleGateAtTime(gate: StaticGateEntity, t: number): GateState {
  if (gate.opened_at !== null && gate.opened_at !== undefined && t >= gate.opened_at) return 'opened';
  if (gate.powered_at !== null && gate.powered_at !== undefined && t >= gate.powered_at) return 'powered';
  return 'unpowered';
}

/** True when a `tag_add` event refers to the Flywheel (飞轮) survivor skill. */
export function isFlywheelEvent(ev: ReplayTimelineEvent): boolean {
  if (ev.type !== 'tag_add') return false;
  if (ev.label_zh && ev.label_zh.includes('飞轮')) return true;
  for (const v of Object.values(ev.meta ?? {})) {
    if (typeof v === 'string' && (v.toLowerCase().includes('flywheel') || v.includes('飞轮'))) return true;
  }
  return false;
}

function pulseKindOf(ev: ReplayTimelineEvent): PulseKind | null {
  if (ev.type === 'hit_attack') return 'hit_attack';
  if (ev.type === 'skill_cast') return 'skill_cast';
  if (isFlywheelEvent(ev)) return 'flywheel';
  return null;
}

const eventT = (e: ReplayTimelineEvent): number => e.t;

/**
 * Active pulse rings at time t: events with ev.t in [t - windowS, t].
 * `events` must be sorted ascending by t.
 */
export function getActivePulsesAtTime(
  events: readonly ReplayTimelineEvent[],
  t: number,
  windowS: number = DEFAULT_PULSE_WINDOW_S,
): ActivePulse[] {
  if (!events.length || !(windowS > 0)) return [];
  const out: ActivePulse[] = [];
  for (let i = lowerBoundIndex(events, t - windowS, eventT); i < events.length; i++) {
    const ev = events[i] as ReplayTimelineEvent;
    if (ev.t > t) break;
    const kind = pulseKindOf(ev);
    if (!kind) continue;
    out.push({ event: ev, kind, progress: Math.max(0, Math.min(1, (t - ev.t) / windowS)), pos: ev.pos ? [ev.pos[0], ev.pos[1], ev.pos[2]] : null });
  }
  return out;
}

/** Returns a new array sorted ascending by t (stable). */
export function sortEventsByTime(events: readonly ReplayTimelineEvent[]): ReplayTimelineEvent[] {
  return events
    .map((e, i) => [e, i] as const)
    .sort((x, y) => x[0].t - y[0].t || x[1] - y[1])
    .map(([e]) => e);
}

function metaFlagActive(meta: ReplayTimelineEvent['meta']): boolean {
  for (const key of ['active', 'is_chase', 'in_chase', 'state', 'value', 'on']) {
    if (!(key in meta)) continue;
    const v = meta[key];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v > 0;
    if (typeof v === 'string') return ['start', 'begin', 'on', 'true', 'enter', 'active', '1'].includes(v.toLowerCase());
  }
  return true;
}

/**
 * Chase status for a survivor at t: prefers analytics chase segments when supplied,
 * otherwise the latest `chase_state` event (sorted events) involving the uid.
 */
export function isChaseActiveAtTime(
  events: readonly ReplayTimelineEvent[],
  uid: number,
  t: number,
  chaseSegments?: ReadonlyArray<{ survivor_uid: number; start_t: number; end_t: number }> | null,
): boolean {
  if (chaseSegments && chaseSegments.length) {
    return chaseSegments.some((s) => s.survivor_uid === uid && t >= s.start_t && t < s.end_t);
  }
  const end = upperBoundIndex(events, t, eventT);
  for (let i = end; i >= 0; i--) {
    const ev = events[i] as ReplayTimelineEvent;
    if (ev.type !== 'chase_state') continue;
    if (ev.target_uid !== uid && ev.actor_uid !== uid) continue;
    return metaFlagActive(ev.meta ?? {});
  }
  return false;
}

/** True when a `window_block` event for this window happened within the last 20 s. */
export function isWindowSealedAtTime(events: readonly ReplayTimelineEvent[], windowUid: number, t: number, sealS = WINDOW_BLOCK_SEAL_S): boolean {
  for (let i = lowerBoundIndex(events, t - sealS, eventT); i < events.length; i++) {
    const ev = events[i] as ReplayTimelineEvent;
    if (ev.t > t) break;
    if (ev.type === 'window_block' && ev.object_uid === windowUid) return true;
  }
  return false;
}
