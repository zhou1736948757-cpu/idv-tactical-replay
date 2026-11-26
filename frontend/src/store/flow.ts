import type { Replay2DPayload, MatchAnalyticsPayload } from '@idv/replay-renderer';
import { fetchReplay, fetchAnalytics } from '@/api/client';
import { readTacticalLink } from '@/tactical/link-state';
import { reactive } from 'vue';
import { buildDirectorScript, firstChaseCue, opening60, type DirectorSegment } from '@/tactical/director';
import type { TacticalLink } from '@/tactical/link-state';
import { appendPracticeHistory, evaluatePractice, readPracticeHistory, type PracticeAttempt, type PracticeScoreResult } from '@/tactical/practice';
import { computeReplayLink, LINK_CONFIDENCE, type ReplayLinkResult } from '@/tactical/replay-link';
import { createEmptyBoardState, getActiveMapId, loadDeduceMarks, loadRegionState, saveTacticalLink, setActiveMapId } from '@/tactical/persist';
import { findPilMapByName } from '@/tactical/maps';
import type { DeduceMarksState, PilMapId, RegionSelectionState, StorageLike, TacticalBoardState } from '@/tactical/types';
import { matchGeneration, publishOpening, selectMatch, openMatch, pause, play, setFlowClock, setStep, store, uploadAndRefresh, type StepId } from './app';

export const FLOW_STORAGE_KEY = 'idv.flow.v1';
export type RegionSubmode = 'lock' | 'predict';

export function readHashRegionSubmode(hashInput?: string): RegionSubmode | null {
  const raw = hashInput ?? (typeof window !== 'undefined' ? window.location.hash : '');
  const params = new URLSearchParams(raw.replace(/^#/, ''));
  if (params.get('mode') === 'practice') return 'lock';
  const sub = params.get('sub');
  if (sub === 'predict') return 'predict';
  if (sub === 'lock') return 'lock';
  return null;
}

export interface FlowPrefs {
  autoFlow: boolean;
  defaultEntryPath: 'sandbox' | 'practice' | 'ask';
  autoOpenAfterUpload: boolean;
  cue: 'opening-fast' | 'first-chase' | 'none';
  director: boolean;
  autoLinkTactics: boolean;
  endAction: 'banner' | 'auto-analytics' | 'off';
  regionAutoSwitchCamp: boolean;
  visualPreset: 'clarity' | 'original' | 'dossier';
  rightDrawerCollapsed: boolean;
}

const defaults: FlowPrefs = {
  autoFlow: true, defaultEntryPath: 'sandbox', autoOpenAfterUpload: true, cue: 'opening-fast',
  director: true, autoLinkTactics: true, endAction: 'banner', regionAutoSwitchCamp: true,
  visualPreset: 'clarity', rightDrawerCollapsed: false,
};

export function sanitizeFlowPrefs(raw: unknown): FlowPrefs {
  const prefs = { ...defaults };
  if (!raw || typeof raw !== 'object') return prefs;
  const value = raw as Partial<FlowPrefs>;
  for (const key of ['autoFlow', 'autoOpenAfterUpload', 'director', 'autoLinkTactics', 'regionAutoSwitchCamp', 'rightDrawerCollapsed'] as const) {
    if (typeof value[key] === 'boolean') prefs[key] = value[key];
  }
  if (value.defaultEntryPath === 'sandbox' || value.defaultEntryPath === 'practice' || value.defaultEntryPath === 'ask') prefs.defaultEntryPath = value.defaultEntryPath;
  if (value.cue === 'opening-fast' || value.cue === 'first-chase' || value.cue === 'none') prefs.cue = value.cue;
  if (value.endAction === 'banner' || value.endAction === 'auto-analytics' || value.endAction === 'off') prefs.endAction = value.endAction;
  if (value.visualPreset === 'clarity' || value.visualPreset === 'original' || value.visualPreset === 'dossier') prefs.visualPreset = value.visualPreset;
  return prefs;
}

function storage(): StorageLike | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function readPrefs(): FlowPrefs {
  try {
    const store = storage();
    const parsed: unknown = JSON.parse(store?.getItem(FLOW_STORAGE_KEY) ?? 'null');
    return sanitizeFlowPrefs({
      visualPreset: store?.getItem('idv.flow.v1.visualPreset'),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
    });
  }
  catch { return sanitizeFlowPrefs(null); }
}

export const flow = reactive({
  prefs: readPrefs(),
  manualOverride: false,
  mode: 'idle' as 'idle' | 'blind' | 'revealed' | 'pro-opening',
  regionSubmode: (readHashRegionSubmode() ?? 'lock') as RegionSubmode,
  uploading: false,
  toast: '',
  history: readPracticeHistory(storage()),
  link: null as ReplayLinkResult | null,
  linkRevision: 0,
  dismissedLink: false,
  practiceMap: null as PilMapId | null,
  draftRegion: null as RegionSelectionState | null,
  draftMarks: {} as DeduceMarksState,
  draftBoard: null as TacticalBoardState | null,
  reveal: null as { truth: ReplayLinkResult; score: PracticeScoreResult; attempt: PracticeAttempt } | null,
  truthReady: false,
  director: 'off' as 'off' | 'running' | 'suspended',
  segment: null as DirectorSegment | null,
  summary: false,
  openingFinished: false,
});

let sealedSession: {
  token: number;
  replay: Replay2DPayload;
  analytics: MatchAnalyticsPayload;
  truth: ReplayLinkResult;
} | null = null;
let script: DirectorSegment[] = [];
let cueEnd: number | null = null;
let playedBeats = new Set<number>();
let beatTimer: ReturnType<typeof setTimeout> | undefined;

export const autoEnabled = () => flow.prefs.autoFlow && !flow.manualOverride;
export const practicing = () => flow.mode === 'blind' || flow.mode === 'revealed';

export function setRegionSubmode(next: RegionSubmode): void {
  flow.regionSubmode = next === 'predict' ? 'predict' : 'lock';
}

export function saveFlowPrefs(): void {
  try { storage()?.setItem(FLOW_STORAGE_KEY, JSON.stringify(sanitizeFlowPrefs(flow.prefs))); } catch { /* optional */ }
}

export function currentLink(mapId: PilMapId): TacticalLink | null {
  return readTacticalLink(storage(), mapId, flow.mode === 'blind' ? store.selectedId : null);
}

export function rememberManual(mapId: PilMapId, fields: Partial<TacticalLink>, source: 'manual' | 'deduce' = 'manual'): void {
  const previous = currentLink(mapId);
  const retained = previous?.source === 'manual' || previous?.source === 'deduce' ? previous : null;
  if (saveTacticalLink(mapId, { groupIndex: null, ...retained, ...fields, source }, true, storage())) flow.linkRevision++;
}

export function applyReplayLink(explicit = false): void {
  const link = flow.link;
  if (!link || flow.mode !== 'idle' || !autoEnabled()) return;
  const prior = currentLink(link.mapId);
  const region = loadRegionState(link.mapId);
  const oldMarks = loadDeduceMarks(link.mapId);
  if (!explicit && (prior?.source === 'manual' || prior?.source === 'deduce' ||
    (!prior && (region.survivorZones.length || region.hunterZones.length || region.cipherGroupIndex || Object.keys(oldMarks).length)))) return;
  if (saveTacticalLink(link.mapId, {
    source: 'replay', matchId: link.matchId, groupIndex: link.groupIndex,
    survivorZones: link.spawn.survivorZones, hunterZone: link.spawn.hunterZone, marks: link.truthMarks,
  }, explicit, storage())) flow.linkRevision++;
}

export function tacticalLink(mapId: PilMapId): TacticalLink | null {
  if (!autoEnabled() || practicing() || flow.dismissedLink || flow.link?.matchId !== store.selectedId ||
    flow.link?.mapId !== mapId) return null;
  const value = currentLink(mapId);
  return value?.source === 'replay' && value.matchId === flow.link.matchId ? value : null;
}

export function sharedCipherGroup(mapId: PilMapId): number | null {
  void flow.linkRevision;
  if (!autoEnabled() || practicing()) return null;
  const context = currentLink(mapId);
  if (context?.source === 'replay') return tacticalLink(mapId)?.groupIndex ?? null;
  return context?.groupIndex ?? null;
}

export function suspendDirector(): void {
  clearTimeout(beatTimer);
  if (flow.director === 'running') flow.director = 'suspended';
}

export function resumeDirector(): void {
  if (!autoEnabled() || !store.replay || practicing()) return;
  flow.director = 'running';
  updateClock(store.t, store.t);
  if (flow.segment?.mode !== 'beat') play();
}

function updateClock(previous: number, proposed: number): number {
  if (flow.mode === 'pro-opening' && flow.segment && proposed >= flow.segment.end) {
    pause(true);
    flow.openingFinished = true;
    flow.mode = 'revealed';
    return flow.segment.end;
  }
  if (flow.director !== 'running' || store.step !== 2) return proposed;
  if (proposed >= (store.replay?.time.duration_s ?? Infinity)) {
    flow.director = 'off';
    flow.summary = flow.prefs.endAction === 'banner';
    if (flow.prefs.endAction === 'auto-analytics') setStep(3);
    return proposed;
  }
  if (cueEnd !== null && proposed < cueEnd) return proposed;
  if (cueEnd !== null) {
    cueEnd = null;
    store.speed = 1;
    if (!flow.prefs.director) {
      flow.director = 'off';
      flow.segment = null;
    }
    return proposed;
  }
  const beat = script.find((segment) => segment.mode === 'beat' && segment.start >= previous &&
    segment.start <= proposed && !playedBeats.has(segment.start));
  if (beat) {
    playedBeats.add(beat.start);
    flow.segment = beat;
    pause(true);
    beatTimer = setTimeout(() => {
      if (flow.director === 'running' && store.step === 2) play();
    }, beat.pauseMs);
    return beat.start;
  }
  const active = script.find((segment) => segment.start <= proposed && proposed < segment.end);
  flow.segment = active ?? null;
  if (active) store.speed = active.speed;
  return proposed;
}

setFlowClock(updateClock, suspendDirector,
  (step) => flow.mode !== 'blind' || step === 1 || step === 4 || step === 5,
  () => {
    if (flow.mode === 'pro-opening') {
      pause(true);
      flow.mode = 'revealed';
      flow.segment = null;
    } else if (flow.director === 'running') {
      pause();
    }
  },
  resetMatchFlow,
);

function resetMatchFlow(sealed: boolean): void {
  sealedSession = null;
  flow.link = null;
  flow.dismissedLink = false;
  flow.reveal = null;
  flow.truthReady = false;
  flow.practiceMap = null;
  flow.draftRegion = null;
  flow.draftMarks = {};
  flow.draftBoard = sealed ? createEmptyBoardState() : null;
  flow.summary = false;
  flow.openingFinished = false;
  flow.segment = null;
  flow.director = 'off';
  script = [];
  cueEnd = null;
  playedBeats = new Set();
  store.speed = 1;
  flow.mode = sealed ? 'blind' : 'idle';
  if (sealed) flow.regionSubmode = 'lock';
}

export async function openEntry(matchId: string, entry: 'sandbox' | 'practice', opts: {
  step?: StepId; t?: number; manual?: boolean; reviewedAttempt?: PracticeAttempt;
} = {}): Promise<void> {
  flow.manualOverride = opts.manual ?? false;
  if (entry === 'practice') {
    const token = selectMatch(matchId, true);
    flow.regionSubmode = 'lock';
    store.step = 4;
    const summary = store.matches.find((match) => match.match_id === matchId);
    initializeDraft(findPilMapByName(summary?.map_name)?.mapId ?? getActiveMapId());
    try {
      const [replay, analytics] = await Promise.all([fetchReplay(matchId), fetchAnalytics(matchId)]);
      if (token !== matchGeneration()) return;
      const map = findPilMapByName(replay.match.map_name);
      if (map && flow.practiceMap !== map.mapId) initializeDraft(map.mapId);
      const truth = computeReplayLink(replay);
      if (!truth || truth.confidence < LINK_CONFIDENCE || truth.groupIndex === null || truth.spawn.hunterZone === null) {
        flow.toast = '录像配准置信度不足，可手动选择战术点位。';
        return;
      }
      sealedSession = { token, replay, analytics, truth };
      flow.truthReady = true;
      if (opts.reviewedAttempt) reviewSavedAttempt(opts.reviewedAttempt);
    } catch (error) {
      if (token === matchGeneration()) flow.toast = error instanceof Error ? error.message : '录像加载失败';
    }
    return;
  }

  const loading = openMatch(matchId, { step: opts.step ?? 2, t: opts.t });
  const token = matchGeneration();
  await loading;
  if (token !== matchGeneration()) return;
  const replay = store.replay;
  if (!replay) {
    flow.toast = store.replayError || '录像加载失败';
    return;
  }
  if (autoEnabled() && opts.t === undefined && store.step === 2 && flow.prefs.cue !== 'none') {
    script = flow.prefs.director ? buildDirectorScript(replay, store.analytics) : [];
    const cue = firstChaseCue(replay, store.analytics);
    if (flow.prefs.cue === 'first-chase') store.t = cue;
    else if (cue > 0) {
      cueEnd = cue;
      // Keep the lead-in between the pre-chase cue and the first focus at 1×.
      const leadIn = script.find((segment) => segment.mode === 'fast' && segment.start <= cue && segment.end > cue);
      if (leadIn) {
        leadIn.speed = 1;
        leadIn.followUid = store.analytics?.hunter_metrics.uid ?? null;
        leadIn.caption = '首追前 · 跟随监管者';
      }
      store.speed = 4;
      flow.segment = { start: 0, end: cue, mode: 'fast', speed: 4, followUid: store.analytics?.hunter_metrics.uid ?? null, caption: '开局快进 · 定位首追' };
    }
    flow.director = flow.prefs.director || cueEnd !== null ? 'running' : 'off';
    play();
  }
  if (autoEnabled() && flow.prefs.autoLinkTactics) {
    setTimeout(() => {
      if (token !== matchGeneration()) return;
      const link = computeReplayLink(replay);
      if (!link || link.confidence < LINK_CONFIDENCE || link.groupIndex === null) {
        flow.toast = '录像配准置信度不足，可手动选择战术点位。';
        return;
      }
      flow.link = link;
      applyReplayLink();
    }, 0);
  }
}

function initializeDraft(mapId: PilMapId): void {
  flow.practiceMap = mapId;
  flow.draftRegion = { side: 1, cipherGroupIndex: 0, survivorZones: [], hunterZones: [],
    selectedCipherIndex: -1, showDoors: false, roleSize: 50, cipherSize: 5.2, doorSize: 6 };
  setActiveMapId(mapId);
}

function reviewSavedAttempt(attempt: PracticeAttempt): void {
  if (!flow.draftRegion) return;
  flow.draftRegion = { ...flow.draftRegion, survivorZones: [...attempt.survivorZones],
    hunterZones: [attempt.hunterZone], cipherGroupIndex: attempt.groupIndex };
  revealPractice(attempt, false);
}

export function revealPractice(attempt: PracticeAttempt, save = true): void {
  if (flow.mode !== 'blind' || !sealedSession || sealedSession.token !== matchGeneration() || attempt.survivorZones.length < 1 || attempt.hunterZone < 0) return;
  const { truth } = sealedSession;
  const score = evaluatePractice(attempt, truth);
  flow.reveal = { truth, score, attempt };
  flow.mode = 'revealed';
  flow.regionSubmode = 'lock';
  if (save) flow.history = appendPracticeHistory(storage(), { matchId: truth.matchId, mapId: truth.mapId, at: Date.now(), ...score, attempt });
}

export function openPracticeDraft(): void {
  if (flow.mode !== 'blind' || !flow.draftBoard) return;
  store.step = 2;
}

export function watchOpening(): void {
  if (flow.mode !== 'revealed' || !sealedSession || sealedSession.token !== matchGeneration() || !flow.reveal) return;
  publishOpening(sealedSession.token, sealedSession.replay, sealedSession.analytics);
  flow.toast = '';
  flow.mode = 'pro-opening';
  flow.openingFinished = false;
  flow.segment = opening60(sealedSession.replay);
  store.t = 0;
  store.speed = 1;
  setStep(2);
  play();
}

export async function importFiles(files: Iterable<File>, options: { entryPath?: 'sandbox' | 'practice'; legacyTopbar?: boolean } = {}) {
  if (flow.uploading) return [];
  const zips = [...files].filter((file) => /\.zip$/i.test(file.name));
  if (!zips.length) throw new Error('仅支持 .zip 录像压缩包');
  const token = matchGeneration();
  flow.uploading = true;
  try {
    const results = [];
    for (const file of zips) results.push(...(await uploadAndRefresh(file)).matches);
    const matches = [...new Map(results.map((match) => [match.match_id, match])).values()]
      .sort((a, b) => b.save_time_float - a.save_time_float);
    if (token !== matchGeneration()) return matches;
    const entry = options.entryPath ?? flow.prefs.defaultEntryPath;
    flow.toast = matches.length ? `已导入 ${matches.length} 场对局` : '压缩包中未发现可解析的对局录像';
    if (matches[0] && autoEnabled() && flow.prefs.autoOpenAfterUpload && entry !== 'ask') {
      await openEntry(matches[0].match_id, entry);
    } else {
      setStep(1);
      if (options.legacyTopbar && !autoEnabled() && matches.length === 1) {
        await openEntry(matches[0]!.match_id, 'sandbox', { manual: true });
      }
    }
    return matches;
  } finally { flow.uploading = false; }
}
