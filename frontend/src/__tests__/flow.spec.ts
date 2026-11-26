import { readFileSync } from 'node:fs';
import { flushPromises, mount, shallowMount } from '@vue/test-utils';
import App from '../App.vue';
import RegionView from '../components/RegionView.vue';
import PracticeHistoryDrawer from '../components/flow/PracticeHistoryDrawer.vue';
import type { Replay2DPayload } from '@idv/replay-renderer';
import * as api from '../api/client';
import { makeAnalytics, MATCHES } from './fixtures';
import { installCanvasStub, installImageStub } from './canvas-stub';
import { afterEach, expect, it, vi } from 'vitest';
import {
  autoEnabled,
  currentLink,
  flow,
  openEntry,
  readHashRegionSubmode,
  revealPractice,
  sanitizeFlowPrefs,
  setRegionSubmode,
  watchOpening,
} from '../store/flow';
import { canEnterStep, ensureAnalytics, loadAllAnalytics, openMatch, resetStore, selectMatch, store } from '../store/app';
import { readTacticalLink, writeTacticalLink } from '../tactical/link-state';

it('validates persisted preferences and lets this link select manual playback', () => {
  expect(sanitizeFlowPrefs({ autoFlow: false, cue: 'invalid', visualPreset: 'original' }))
    .toMatchObject({ autoFlow: false, cue: 'opening-fast', visualPreset: 'original' });
  flow.manualOverride = true;
  expect(autoEnabled()).toBe(false);
  flow.manualOverride = false;
});

it('blocks replay and analysis navigation during a sealed practice session', () => {
  flow.mode = 'blind';
  expect([1, 2, 3, 4, 5].map((n) => canEnterStep(n as 1 | 2 | 3 | 4 | 5))).toEqual([true, false, false, true, true]);
  flow.mode = 'idle';
});

it('protects manual context until explicit application', () => {
  let value: string | null = null;
  const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
  expect(writeTacticalLink(storage, 0, { source: 'manual', groupIndex: 1, survivorZones: [2, 2, 99] })).toBe(true);
  expect(writeTacticalLink(storage, 0, { source: 'replay', groupIndex: 2 })).toBe(false);
  expect(readTacticalLink(storage, 0)).toEqual({ source: 'manual', groupIndex: 1, survivorZones: [2] });
  expect(writeTacticalLink(storage, 0, { source: 'replay', groupIndex: 2 }, true)).toBe(true);
  expect(readTacticalLink(storage, 0)?.groupIndex).toBe(2);
});

const id = MATCHES[0]!.match_id;
const otherId = MATCHES[1]!.match_id;
const attempt = { survivorZones: [0, 1, 2, 3], hunterZone: 4, groupIndex: 0, lockCipherId: null };

function loadPracticeFixture() {
  const replay: Replay2DPayload = JSON.parse(readFileSync(`../backend/data/cache/${id}/replay_2d.json`, 'utf8'));
  vi.spyOn(api, 'fetchReplay').mockResolvedValue(replay);
  vi.spyOn(api, 'fetchAnalytics').mockResolvedValue(makeAnalytics());
  return replay;
}

function expectBlind(matchId = id) {
  expect(store.selectedId).toBe(matchId);
  expect(store.replay).toBeNull();
  expect(store.analytics).toBeNull();
  expect(store.analyticsById[matchId]).toBeUndefined();
  expect(flow).toMatchObject({ mode: 'blind', link: null, reveal: null });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  resetStore();
  flow.mode = 'idle';
  flow.regionSubmode = 'lock';
  flow.history = [];
  location.hash = '';
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([id, otherId])('invalidates pending public replay, matrix and analytics on practice entry from %s', async (previousId) => {
  const replay = loadPracticeFixture();
  const oldReplay = deferred<Replay2DPayload>();
  const oldAnalytics = deferred<ReturnType<typeof makeAnalytics>>();
  vi.mocked(api.fetchReplay).mockReturnValueOnce(oldReplay.promise);
  store.matches = MATCHES.slice(0, 2);
  vi.mocked(api.fetchAnalytics).mockReturnValueOnce(oldAnalytics.promise)
    .mockReturnValueOnce(oldAnalytics.promise).mockReturnValueOnce(oldAnalytics.promise);
  const matrix = loadAllAnalytics();
  const previous = openEntry(previousId, 'sandbox');
  store.analyticsById[id] = makeAnalytics();
  store.selectedUid = 123;
  const entering = openEntry(id, 'practice');
  expectBlind();
  expect(store.selectedUid).toBeNull();
  await entering;
  expect(flow.truthReady).toBe(true);
  expect(await ensureAnalytics(id)).toBeNull();
  oldReplay.resolve(replay);
  oldAnalytics.resolve(makeAnalytics());
  await Promise.all([previous, matrix]);
  expectBlind();
  expect(Object.keys(store.analyticsById)).toEqual([]);
});

it('ignores deferred registration after same-ID re-entry and isolates only the active replay link', async () => {
  vi.useFakeTimers();
  loadPracticeFixture();
  await openEntry(id, 'sandbox', { t: 0 });
  writeTacticalLink(localStorage, 7, { source: 'replay', matchId: id, groupIndex: 1 });
  writeTacticalLink(localStorage, 1, { source: 'deduce', groupIndex: 2 });
  writeTacticalLink(localStorage, 2, { source: 'manual', groupIndex: 0 });
  writeTacticalLink(localStorage, 3, { source: 'replay', matchId: otherId, groupIndex: 1 });
  await openEntry(id, 'practice');
  vi.runOnlyPendingTimers();
  expectBlind();
  expect(currentLink(7)).toBeNull();
  expect([1, 2, 3].map(map => currentLink(map as 1 | 2 | 3)?.source)).toEqual(['deduce', 'manual', 'replay']);
  expect(readTacticalLink(localStorage, 7)?.matchId).toBe(id);
});

it('opens a practice hash before the archive arrives and resolves the map from the sealed replay', async () => {
  loadPracticeFixture();
  const archive = deferred<typeof MATCHES>();
  vi.spyOn(api, 'fetchMatches').mockReturnValue(archive.promise);
  location.hash = `m=${id}&s=2&t=12&mode=practice`;
  const app = shallowMount(App);
  await vi.waitFor(() => expect(flow.truthReady).toBe(true));
  expectBlind();
  expect(store.step).toBe(4);
  expect(flow.practiceMap).toBe(7);
  archive.resolve(MATCHES);
  app.unmount();
  location.hash = '';
});

it.each([12, 120])('reviews history without scoring twice, then plays exactly the opening of a %i s replay', async (duration) => {
  vi.useFakeTimers();
  const replay = loadPracticeFixture();
  replay.time.duration_s = duration;
  await openEntry(id, 'practice');
  revealPractice(attempt);
  revealPractice(attempt);
  expect(flow.history).toHaveLength(1);
  expect(canEnterStep(3)).toBe(false);
  const record = flow.history[0]!;
  const drawer = mount(PracticeHistoryDrawer);
  await drawer.get('li button:first-of-type').trigger('click');
  await Promise.resolve();
  expect(flow.reveal?.attempt).toEqual(record.attempt);
  expect(flow.history).toHaveLength(1);
  expect(store.replay).toBeNull();
  expect(store.analytics).toBeNull();
  expect(canEnterStep(3)).toBe(false);
  watchOpening();
  expect(store).toMatchObject({ step: 2, playing: true, t: 0, speed: 1 });
  expect(store.replay?.match.match_id).toBe(id);
  expect(store.analytics?.match_id).toBe(id);
  expect(canEnterStep(3)).toBe(true);
  vi.advanceTimersByTime((duration + 1) * 1000);
  expect(store.t).toBe(Math.min(60, duration));
  expect(store.playing).toBe(false);
  expect(flow.openingFinished).toBe(true);
  await drawer.get('li button:last-of-type').trigger('click');
  await Promise.resolve();
  drawer.unmount();
  expectBlind();
  expect(flow.draftRegion?.survivorZones).toEqual([]);
  expect(flow.history).toHaveLength(1);
});

it('abandons a revealed comparison immediately when opening a public match and waits for both payloads', async () => {
  const replay = loadPracticeFixture();
  await openEntry(id, 'practice');
  revealPractice(attempt);
  expect(flow.reveal?.truth.matchId).toBe(id);
  expect(canEnterStep(3)).toBe(false);

  const analyticsB = deferred<ReturnType<typeof makeAnalytics>>();
  vi.mocked(api.fetchAnalytics).mockReturnValueOnce(analyticsB.promise);
  vi.mocked(api.fetchReplay).mockResolvedValueOnce({ ...replay, match: MATCHES[1]! });
  const loading = openMatch(otherId);
  expect(store.selectedId).toBe(otherId);
  expect(flow).toMatchObject({
    mode: 'idle', reveal: null, truthReady: false, practiceMap: null, draftRegion: null,
    draftMarks: {}, draftBoard: null, segment: null, openingFinished: false,
  });
  watchOpening();
  expect(store.playing).toBe(false);
  await vi.waitFor(() => expect(store.replay?.match.match_id).toBe(otherId));
  expect(canEnterStep(3)).toBe(false);
  analyticsB.resolve(makeAnalytics({ match_id: otherId }));
  await loading;
  expect(store.analytics?.match_id).toBe(otherId);
  expect(canEnterStep(3)).toBe(true);
  expect(flow.history.map(record => record.matchId)).toEqual([id]);
});

it('discards a pending sealed load when a public selection supersedes it', async () => {
  const replay = loadPracticeFixture();
  const pending = deferred<Replay2DPayload>();
  vi.mocked(api.fetchReplay).mockReturnValueOnce(pending.promise);
  const practice = openEntry(id, 'practice');
  selectMatch(otherId, false);
  pending.resolve(replay);
  await practice;
  revealPractice(attempt);
  expect(flow).toMatchObject({ mode: 'idle', truthReady: false, reveal: null, draftBoard: null, history: [] });
  expect(store.selectedId).toBe(otherId);
  expect(canEnterStep(3)).toBe(false);
});

it('discards late sealed payloads across practice retries and match switches', async () => {
  const replay = loadPracticeFixture();
  const first = deferred<Replay2DPayload>();
  const second = deferred<Replay2DPayload>();
  vi.mocked(api.fetchReplay).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const loadingA = openEntry(otherId, 'practice');
  const loadingB = openEntry(id, 'practice');
  await openEntry(id, 'practice');
  for (const [pending, loading] of [[second, loadingB], [first, loadingA]] as const) {
    pending.resolve({ ...replay, match: MATCHES[1]! });
    await loading;
    expectBlind();
    expect(flow.practiceMap).toBe(7);
  }
  revealPractice(attempt);
  expect(flow.reveal?.truth.matchId).toBe(id);
});

it('forces lock submode on blind practice & reveal and seals truth completely in SpawnPredictorView', async () => {
  installCanvasStub();
  const imgStub = installImageStub('load', { w: 750, h: 644 });
  try {
    expect(readHashRegionSubmode('#s=4&sub=predict')).toBe('predict');
    expect(readHashRegionSubmode('#s=4&sub=lock')).toBe('lock');
    expect(readHashRegionSubmode(`#m=${id}&s=4&mode=practice&sub=predict`)).toBe('lock');
    expect(readHashRegionSubmode('#s=4')).toBeNull();

    const replay = loadPracticeFixture();
    // Pre-set submode to 'predict' before entering blind practice -> MUST be forced to 'lock'
    setRegionSubmode('predict');
    await openEntry(id, 'practice');
    expectBlind();
    expect(flow.regionSubmode).toBe('lock');

    const w = mount(RegionView);
    await flushPromises();
    expect(w.find('[data-test="region-canvas"]').exists()).toBe(true);
    expect(w.find('[data-test="btn-region-mode-lock"]').attributes('aria-selected')).toBe('true');

    // User may consult historical predictor during blind mode without ANY spoiler leakage
    await w.find('[data-test="btn-region-mode-predict"]').trigger('click');
    await flushPromises();
    expect(flow.regionSubmode).toBe('predict');
    expect(w.find('[data-test="spawn-predict-board"]').exists()).toBe(true);
    // Replay prefill button MUST be hidden in blind mode; Sandbox button disabled
    expect(w.find('[data-test="btn-predict-from-replay"]').exists()).toBe(false);
    expect(w.find('[data-test="btn-predict-to-sandbox"]').attributes('disabled')).toBeDefined();

    // Zero leakage of sealed replay player names in DOM text or attributes
    const html = w.html();
    for (const player of replay.players) {
      expect(html).not.toContain(player.player_name);
    }
    expect(store.replay).toBeNull();
    expect(flow.reveal).toBeNull();

    // Revealing practice MUST force regionSubmode back to 'lock' immediately
    revealPractice(attempt);
    await flushPromises();
    expect(flow.mode).toBe('revealed');
    expect(flow.regionSubmode).toBe('lock');
    expect(w.find('[data-test="region-canvas"]').exists()).toBe(true);
    w.unmount();
  } finally {
    imgStub.restore();
  }
});
