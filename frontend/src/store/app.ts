/**
 * Global reactive app store (single page, five rail steps).
 * Keeps match list, the active replay/analytics payloads and playback clock.
 */
import { reactive } from 'vue';
import type { MatchAnalyticsPayload, MatchSummary, Replay2DPayload, ReplayTimelineEvent, Vec3 } from '@idv/replay-renderer';
import {
  fetchAnalytics,
  fetchMatches,
  fetchReplay,
  uploadReplay,
  type UploadProgressCallback,
  type UploadResult,
} from '@/api/client';
import { syncActiveMapByName } from '@/tactical';

export type StepId = 1 | 2 | 3 | 4 | 5;
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;

export interface FocusRequest {
  key: number;
  t: number;
  pos: Vec3 | null;
  uid: number | null;
}

export interface AppState {
  step: StepId;
  matches: MatchSummary[];
  matchesLoading: boolean;
  matchesError: string;
  selectedId: string | null;
  replay: Replay2DPayload | null;
  replayLoading: boolean;
  replayError: string;
  analytics: MatchAnalyticsPayload | null;
  analyticsLoading: boolean;
  analyticsError: string;
  analyticsById: Record<string, MatchAnalyticsPayload>;
  recentUploads: string[];
  t: number;
  playing: boolean;
  speed: number;
  focus: FocusRequest | null;
  selectedUid: number | null;
  noticeOpen: boolean;
}

function initialState(): AppState {
  return {
    step: 1,
    matches: [],
    matchesLoading: false,
    matchesError: '',
    selectedId: null,
    replay: null,
    replayLoading: false,
    replayError: '',
    analytics: null,
    analyticsLoading: false,
    analyticsError: '',
    analyticsById: {},
    recentUploads: [],
    t: 0,
    playing: false,
    speed: 1,
    focus: null,
    selectedUid: null,
    noticeOpen: false,
  };
}

export const store = reactive<AppState>(initialState());

let openToken = 0;
let privateMatch = false;
let listToken = 0;
export const matchGeneration = () => openToken;
let focusKey = 0;
let rafId: number | null = null;
let lastTick: number | null = null;

const raf: (cb: (t: number) => void) => number =
  typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? (cb) => window.requestAnimationFrame(cb)
    : (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
const caf: (id: number) => void =
  typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
    ? (id) => window.cancelAnimationFrame(id)
    : (id) => clearTimeout(id);

export function resetStore(): void {
  pause();
  openToken++;
  listToken++;
  privateMatch = false;
  Object.assign(store, initialState());
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function selectedSummary(): MatchSummary | null {
  if (!store.selectedId) return null;
  return store.matches.find((m) => m.match_id === store.selectedId) ?? store.replay?.match ?? null;
}

export function duration(): number {
  return store.replay?.time.duration_s ?? store.replay?.match.duration_s ?? 0;
}

// ------------------------------------------------------------------ data

export async function loadMatches(): Promise<void> {
  const token = ++listToken;
  store.matchesLoading = true;
  store.matchesError = '';
  try {
    const matches = await fetchMatches();
    if (token === listToken) store.matches = matches;
  } catch (err) {
    if (token === listToken) store.matchesError = errMsg(err);
  } finally {
    if (token === listToken) store.matchesLoading = false;
  }
}

export async function ensureAnalytics(matchId: string): Promise<MatchAnalyticsPayload | null> {
  if (privateMatch) return null;
  const token = openToken;
  const cached = store.analyticsById[matchId];
  if (cached) return cached;
  const a = await fetchAnalytics(matchId);
  if (token !== openToken) return null;
  store.analyticsById[matchId] = a;
  return a;
}

const BULK_ANALYTICS_CAP = 50;
const BULK_ANALYTICS_CONCURRENCY = 4;

/** Loads analytics for listed matches with bounded concurrency and cap (prevents self-DDoS at scale). */
export async function loadAllAnalytics(): Promise<void> {
  const targets = store.matches
    .slice(0, BULK_ANALYTICS_CAP)
    .map((m) => m.match_id)
    .filter((id) => !store.analyticsById[id]);
  if (targets.length === 0) return;

  let cursor = 0;
  const workerCount = Math.min(BULK_ANALYTICS_CONCURRENCY, targets.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < targets.length) {
      const idx = cursor++;
      const id = targets[idx];
      if (!id) continue;
      try {
        await ensureAnalytics(id);
      } catch {
        // Individual analytics fetch failure does not block sibling matches
      }
    }
  });
  await Promise.allSettled(workers);
}

export function selectMatch(matchId: string, sealed: boolean): number {
  const token = ++openToken;
  privateMatch = sealed;
  pause();
  store.selectedId = matchId;
  store.replay = null;
  store.analytics = null;
  store.replayError = '';
  store.analyticsError = '';
  store.replayLoading = !sealed;
  store.analyticsLoading = !sealed;
  if (sealed) delete store.analyticsById[matchId];
  store.selectedUid = null;
  store.focus = null;
  store.t = 0;
  resetMatchFlow(sealed);
  return token;
}

export function publishOpening(token: number, replay: Replay2DPayload, analytics: MatchAnalyticsPayload): void {
  if (token !== openToken) return;
  privateMatch = false;
  store.replay = replay;
  store.analytics = analytics;
  store.analyticsById[replay.match.match_id] = analytics;
}

export async function openMatch(matchId: string, opts: { step?: StepId; t?: number } = {}): Promise<void> {
  const token = selectMatch(matchId, false);
  if (opts.step) store.step = opts.step;
  const replayP = fetchReplay(matchId)
    .then((r) => {
      if (token !== openToken) return;
      store.replay = r;
      store.t = Math.max(0, Math.min(opts.t ?? 0, r.time.duration_s));
      syncActiveMapByName(r.match.map_name);
    })
    .catch((err) => {
      if (token === openToken) store.replayError = errMsg(err);
    })
    .finally(() => {
      if (token === openToken) store.replayLoading = false;
    });
  const analyticsP = ensureAnalytics(matchId)
    .then((a) => {
      if (token === openToken) store.analytics = a;
    })
    .catch((err) => {
      if (token === openToken) store.analyticsError = errMsg(err);
    })
    .finally(() => {
      if (token === openToken) store.analyticsLoading = false;
    });
  await Promise.all([replayP, analyticsP]);
}

export async function uploadAndRefresh(file: File): Promise<UploadResult> {
  const token = openToken;
  const result = await uploadReplay(file);
  if (token !== openToken) return result;
  store.recentUploads = [...new Set([...result.match_ids, ...store.recentUploads])];
  await loadMatches();
  if (token !== openToken) return result;
  // Make sure uploaded matches are visible even if the list endpoint lags.
  for (const m of result.matches) {
    if (!store.matches.some((x) => x.match_id === m.match_id)) store.matches = [m, ...store.matches];
  }
  return result;
}

// ------------------------------------------------------------------ steps

let flowTick = (_previous: number, next: number) => next;
let manualPlayback = () => {};
let flowAllowsStep = (_step: StepId) => true;
let leavePlayback = () => {};
let resetMatchFlow = (_sealed: boolean) => {};

export function setFlowClock(
  advance: typeof flowTick, suspend: typeof manualPlayback, canEnter: typeof flowAllowsStep, leave: typeof leavePlayback,
  resetMatch: typeof resetMatchFlow,
): void {
  flowTick = advance;
  manualPlayback = suspend;
  flowAllowsStep = canEnter;
  leavePlayback = leave;
  resetMatchFlow = resetMatch;
}

export function canEnterStep(step: StepId): boolean {
  if (!flowAllowsStep(step)) return false;
  if (step !== 3) return true;
  return store.selectedId !== null && store.replay?.match.match_id === store.selectedId &&
    store.analytics?.match_id === store.selectedId;
}

export function setStep(step: StepId): void {
  if (!canEnterStep(step)) return;
  if (store.step === 2 && step !== 2) leavePlayback();
  store.step = step;
}

export function goBack(): void {
  for (let prev = store.step - 1; prev >= 1; prev--) {
    if (canEnterStep(prev as StepId)) {
      setStep(prev as StepId);
      break;
    }
  }
}

// ------------------------------------------------------------------ playback

export function seek(t: number): void {
  manualPlayback();
  const d = duration();
  store.t = Math.max(0, Math.min(Number.isFinite(t) ? t : 0, d));
}

export function stepBy(dt: number): void {
  seek(store.t + dt);
}

export function setSpeed(speed: number): void {
  manualPlayback();
  store.speed = (PLAYBACK_SPEEDS as readonly number[]).includes(speed) ? speed : 1;
}

function tick(now: number): void {
  if (!store.playing) return;
  if (lastTick === null) lastTick = now;
  const dt = Math.max(0, Math.min(0.25, (now - lastTick) / 1000));
  lastTick = now;
  const d = duration();
  const next = flowTick(store.t, store.t + dt * store.speed);
  if (next >= d) {
    store.t = d;
    pause(true);
    return;
  }
  store.t = next;
  if (store.playing) rafId = raf(tick);
}

export function play(): void {
  if (!store.replay || store.playing) return;
  if (store.t >= duration()) store.t = 0;
  store.playing = true;
  lastTick = null;
  rafId = raf(tick);
}

export function pause(internal = false): void {
  if (!internal) manualPlayback();
  store.playing = false;
  lastTick = null;
  if (rafId !== null) caf(rafId);
  rafId = null;
}

export function togglePlay(): void {
  manualPlayback();
  if (store.playing) pause();
  else play();
}

/** Seek to an event and ask the board to center + pulse its location. */
export function focusEvent(ev: Pick<ReplayTimelineEvent, 't' | 'pos' | 'actor_uid'>): void {
  pause();
  seek(ev.t);
  store.focus = { key: ++focusKey, t: ev.t, pos: ev.pos ? ([...ev.pos] as Vec3) : null, uid: ev.actor_uid ?? null };
}

export function focusTime(t: number, uid: number | null = null): void {
  pause();
  seek(t);
  store.focus = { key: ++focusKey, t, pos: null, uid };
}
