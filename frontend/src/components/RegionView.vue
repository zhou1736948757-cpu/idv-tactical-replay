<script setup lang="ts">
import {
  autoEnabled,
  applyReplayLink,
  flow,
  openPracticeDraft,
  rememberManual,
  practicing,
  readHashRegionSubmode,
  revealPractice,
  setRegionSubmode,
  sharedCipherGroup,
  tacticalLink,
  watchOpening,
  type RegionSubmode,
} from '@/store/flow';
import { cipherOf } from '@/tactical/geo';
import { deduce } from '@/tactical/deduce';
import { focusTime, setStep, store } from '@/store/app';
import { formatClock } from '@/lib/format';
import PracticeHud from './flow/PracticeHud.vue';
import PracticeRevealCard from './flow/PracticeRevealCard.vue';
import NextStepCta from './flow/NextStepCta.vue';
import { getEnhancedMap, resolveMapToneMaterial, useMapPreset } from '@/lib/mapTone';
import { VISUAL_PRESETS } from '@idv/replay-renderer';
import { CANVAS_FONT_CJK, whenFontsReady } from '@/lib/typography';
import MapPresetSwitch from './tactical/MapPresetSwitch.vue';
import { useFolio } from './tactical/useFolio';
import ManorMapFrame from './tactical/ManorMapFrame.vue';
import ManorOrnaments from './tactical/ManorOrnaments.vue';
import SpawnPredictorView from './region/SpawnPredictorView.vue';

const { visualPreset } = useMapPreset();
const { folioOpen, toggleFolio } = useFolio();
folioOpen.value = !flow.prefs.rightDrawerCollapsed;

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import '@/styles/pil-views.css';
import '@/styles/spawn-predictor.css';
import {
  MAPS_DATA,
  analyzeRegionCiphers,
  calculateZoneCenters,
  getActiveMapId,
  loadRegionState,
  mapsZonesRelative,
  onActiveMapChange,
  resolvePilMapId,
  saveRegionState,
  setActiveMapId,
  type PilMapId,
  type RegionSelectionState,
} from '@/tactical';

const ROLE_SIZE_DEFAULT = 50;
const CIPHER_SIZE_DEFAULT = 5.2;
const DOOR_SIZE_DEFAULT = 6;

const mapId = ref<PilMapId>(getActiveMapId());
const state = reactive<RegionSelectionState>(readRegion(mapId.value));
const feedbackMsg = ref('');
const displayOpen = ref(false);
const showDungeons = ref(true);

const submode = computed<RegionSubmode>(() => flow.regionSubmode);

function switchSubmode(next: RegionSubmode): void {
  if (flow.regionSubmode === next) return;
  setRegionSubmode(next);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('idv-map-fit-reset'));
  }
}

function syncSubmodeFromHash(): void {
  if (practicing()) return;
  const hashSub = readHashRegionSubmode();
  if (hashSub) setRegionSubmode(hashSub);
}

function onPredictTransferToLock(payload: {
  mapId: PilMapId;
  survivorZones: number[];
  hunterZone: number;
}): void {
  if (!practicing()) {
    setActiveMapId(payload.mapId);
  }
  mapId.value = payload.mapId;
  if (flow.mode === 'blind' && flow.draftRegion) {
    flow.draftRegion = {
      ...flow.draftRegion,
      survivorZones: [...payload.survivorZones],
      hunterZones: payload.hunterZone >= 0 ? [payload.hunterZone] : [],
      side: -1,
    };
  } else {
    const existing = loadRegionState(payload.mapId);
    rememberManual(payload.mapId, {
      groupIndex: existing.cipherGroupIndex,
      survivorZones: [...payload.survivorZones],
      hunterZone: payload.hunterZone >= 0 ? payload.hunterZone : null,
    });
    saveRegionState(payload.mapId, {
      ...existing,
      side: -1,
      survivorZones: [...payload.survivorZones],
      hunterZones: payload.hunterZone >= 0 ? [payload.hunterZone] : [],
    });
  }
  applyLoadedState(payload.mapId);
  switchSubmode('lock');
}

const wrapEl = ref<HTMLDivElement | null>(null);
const clipEl = ref<HTMLDivElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const cameraScale = ref<number>(1);
const modelOriginX = ref<number>(0);
const modelOriginY = ref<number>(0);
const clipWidth = ref<number>(MAPS_DATA[mapId.value]!.mapSize[0]);
const clipHeight = ref<number>(MAPS_DATA[mapId.value]!.mapSize[1]);
const boxWidth = ref<number>(MAPS_DATA[mapId.value]!.mapSize[0]);
const boxHeight = ref<number>(MAPS_DATA[mapId.value]!.mapSize[1]);
const imgReady = ref(false);
const imgMissing = ref(false);

let loadedImg: HTMLImageElement | HTMLCanvasElement | null = null;
let imgToken = 0;
let resizeObs: ResizeObserver | null = null;
let unsubMap: (() => void) | null = null;

const frameSupported = typeof ResizeObserver !== 'undefined';
const currentMap = computed(() => MAPS_DATA[mapId.value]!);
const zones = computed(() => mapsZonesRelative[mapId.value]!);
const centers = computed(() => calculateZoneCenters(zones.value));
const hunterZoneIdx = computed(() => state.hunterZones[0] ?? -1);
const analysis = computed(() =>
  analyzeRegionCiphers(mapId.value, state.cipherGroupIndex, hunterZoneIdx.value >= 0 ? hunterZoneIdx.value : null),
);
const dynamicHint = computed(() => {
  const h = currentMap.value.hints[state.cipherGroupIndex];
  return h ? h.trim() : '';
});

function readRegion(id: PilMapId): RegionSelectionState {
  if (practicing() && flow.draftRegion) return flow.draftRegion;
  const saved = loadRegionState(id);
  const link = tacticalLink(id);
  saved.cipherGroupIndex = sharedCipherGroup(id) ?? saved.cipherGroupIndex;
  if (link) {
    saved.survivorZones = link.survivorZones ?? [];
    saved.hunterZones = link.hunterZone == null ? [] : [link.hunterZone];
  }
  return saved;
}

const revealed = computed(() => flow.mode === 'revealed' ? flow.reveal : null);
const compareLayer = ref<'both' | 'mine' | 'pro'>('both');
const showPrediction = computed(() => !revealed.value || compareLayer.value !== 'pro');
const showPro = computed(() => revealed.value && compareLayer.value !== 'mine');
const actualLock = computed(() => {
  const id = revealed.value?.truth.lockCipherId;
  return id ? cipherOf(mapId.value, id) : undefined;
});
const hunterDiff = computed(() => {
  if (!revealed.value || revealed.value.score.hunterHit) return null;
  const point = revealed.value.truth.spawn.perPlayer.find((player) => player.camp === 1);
  const center = centers.value[revealed.value.attempt.hunterZone];
  if (!point || !center) return null;
  const [w, h] = currentMap.value.mapSize;
  return { point, x: center.x * w, y: center.y * h };
});

function estimatePlaqueWidth(text: string, fontSize = 13): number {
  let width = 14;
  for (const ch of Array.from(text)) {
    const code = ch.codePointAt(0) ?? 0;
    width += code > 0x7f ? fontSize * 1.04 : ch === ' ' ? fontSize * 0.34 : fontSize * 0.62;
  }
  return Math.ceil(width);
}

function clampBoxInMap(
  x: number,
  y: number,
  w: number,
  h: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): [number, number] {
  const cx = Math.max(left + 2, Math.min(right - w - 2, x));
  const cy = Math.max(top + 2, Math.min(bottom - h - 2, y));
  return [cx, cy];
}

const svgOverlay = computed(() => {
  const s = cameraScale.value;
  const gp = currentMap.value.gridPlacement;
  const [mw, mh] = currentMap.value.mapSize;
  const left = gp.minX * s;
  const top = gp.minY * s;
  const right = gp.maxX * s;
  const bottom = gp.maxY * s;

  let offset: {
    x1: number; y1: number; x2: number; y2: number;
    px: number; py: number; pw: number; ph: number; label: string;
  } | null = null;
  if (revealed.value && hunterDiff.value && compareLayer.value === 'both') {
    const x1 = hunterDiff.value.x * s;
    const y1 = hunterDiff.value.y * s;
    const x2 = hunterDiff.value.point.px * s;
    const y2 = hunterDiff.value.point.py * s;
    const label = `偏差 ${revealed.value.score.hunterOffsetMeters} 米`;
    const pw = Math.max(96, estimatePlaqueWidth(label, 13));
    const ph = 24;
    const [px, py] = clampBoxInMap((x1 + x2) / 2 - pw / 2, (y1 + y2) / 2 + 12, pw, ph, left, top, right, bottom);
    offset = { x1, y1, x2, y2, px, py, pw, ph, label };
  }

  let lock: {
    cx: number; cy: number; px: number; py: number; pw: number; ph: number; label: string;
  } | null = null;
  if (revealed.value && actualLock.value) {
    const cx = actualLock.value.location[0] * s;
    const cy = actualLock.value.location[1] * s;
    const label = compareLayer.value === 'both' && revealed.value.score.lockCipherMatch
      ? '✓ 封禁一致'
      : `实际封禁 · ${actualLock.value.name}`;
    const pw = Math.max(108, estimatePlaqueWidth(label, 13));
    const ph = 23;
    const [px, py] = clampBoxInMap(cx + 18, cy - 30, pw, ph, left, top, right, bottom);
    lock = { cx, cy, px, py, pw, ph, label };
  }

  const spawns = (revealed.value?.truth.spawn.perPlayer ?? []).map((point) => {
    const cx = point.px * s;
    const cy = point.py * s;
    const label = `${point.name}${point.nearEdge ? ' · 贴边' : ''}`;
    const pw = Math.max(40, estimatePlaqueWidth(label, 13));
    const ph = 23;
    const [px, py] = clampBoxInMap(cx + 18, cy - 30, pw, ph, left, top, right, bottom);
    const z = zones.value[point.zone];
    const zoneRect = z
      ? { x: z.x * mw * s, y: z.y * mh * s, w: z.width * mw * s, h: z.height * mh * s }
      : null;
    return { uid: point.uid, camp: point.camp, cx, cy, px, py, pw, ph, label, zoneRect };
  });

  return { offset, lock, spawns };
});

const frameMetrics = computed(() => {
  const s = cameraScale.value;
  const gp = currentMap.value.gridPlacement;
  const mapLeft = 3 + modelOriginX.value + gp.minX * s;
  const mapTop = 3 + modelOriginY.value + gp.minY * s;
  const mapRight = 3 + modelOriginX.value + gp.maxX * s;
  const boardW = clipWidth.value + 6;
  return {
    scaleLeft: Math.max(12, Math.round(mapLeft)),
    scaleBottom: 42,
    compassRight: Math.max(12, Math.round(boardW - mapRight + 10)),
    compassTop: Math.max(12, Math.round(mapTop + 8)),
  };
});
const linked = computed(() => {
  void flow.linkRevision;
  return tacticalLink(mapId.value) !== null;
});
const linkAvailable = computed(() => autoEnabled() && !practicing() && !flow.dismissedLink && flow.link?.mapId === mapId.value);

function keepManual(): void {
  flow.dismissedLink = true;
  rememberManual(mapId.value, {});
  applyLoadedState(mapId.value);
  updateCanvasMetrics();
}

function lockPractice(): void {
  const hunterZone = state.hunterZones[0];
  if (hunterZone === undefined) return;
  const group = currentMap.value.cipherCombinations[state.cipherGroupIndex] ?? [];
  const result = deduce(currentMap.value.deduction, flow.draftMarks);
  const cipherIds = Object.keys(flow.draftMarks).length
    ? currentMap.value.deduction.ciphers.filter((_, index) => result.state[index] === 'yes').map((cipher) => cipher.id)
    : undefined;
  revealPractice({ survivorZones: [...state.survivorZones], hunterZone, groupIndex: state.cipherGroupIndex,
    lockCipherId: group[analysis.value.lockIndex] ?? null, cipherIds });
}

function persistState(manual = false): void {
  if (practicing()) {
    if (flow.mode === 'blind') flow.draftRegion = { ...state, survivorZones: [...state.survivorZones], hunterZones: [...state.hunterZones] };
    return;
  }
  if (manual) rememberManual(mapId.value, { groupIndex: state.cipherGroupIndex,
    survivorZones: [...state.survivorZones], hunterZone: state.hunterZones[0] ?? null });
  if (!manual && linked.value) return;
  saveRegionState(mapId.value, {
    side: state.side,
    cipherGroupIndex: state.cipherGroupIndex,
    survivorZones: [...state.survivorZones],
    hunterZones: [...state.hunterZones],
    selectedCipherIndex: state.selectedCipherIndex,
    showDoors: state.showDoors,
    roleSize: state.roleSize,
    cipherSize: state.cipherSize,
    doorSize: state.doorSize,
  });
}

function applyLoadedState(id: PilMapId): void {
  mapId.value = id;
  const loaded = readRegion(id);
  state.side = loaded.side;
  state.cipherGroupIndex = loaded.cipherGroupIndex;
  state.survivorZones = [...loaded.survivorZones];
  state.hunterZones = [...loaded.hunterZones];
  state.selectedCipherIndex = loaded.selectedCipherIndex;
  state.showDoors = loaded.showDoors;
  state.roleSize = loaded.roleSize;
  state.cipherSize = loaded.cipherSize;
  state.doorSize = loaded.doorSize;
  feedbackMsg.value = '';
}

function onSelectMap(idInput: number | string): void {
  if (practicing()) return;
  const next = setActiveMapId(resolvePilMapId(idInput));
  if (next !== mapId.value) applyLoadedState(next);
}

function reviewPhase(start: number): void {
  setStep(2);
  focusTime(start);
}

function onMapSelectChange(e: Event): void {
  onSelectMap(Number((e.target as HTMLSelectElement).value));
}

function setSide(side: 1 | -1): void {
  state.side = side;
  feedbackMsg.value = '';
  persistState();
  updateCanvasMetrics();
}

function switchCipherGroup(delta: number): void {
  if (flow.mode === 'revealed') return;
  const count = currentMap.value.cipherCombinations.length;
  state.cipherGroupIndex = ((state.cipherGroupIndex + delta) % count + count) % count;
  persistState(true);
  updateCanvasMetrics();
}

function selectCipherGroup(idx: number): void {
  if (flow.mode === 'revealed') return;
  const count = currentMap.value.cipherCombinations.length;
  state.cipherGroupIndex = ((idx % count) + count) % count;
  persistState(true);
  updateCanvasMetrics();
}

function toggleCipherRow(idx: number): void {
  state.selectedCipherIndex = state.selectedCipherIndex === idx ? -1 : idx;
  persistState();
  updateCanvasMetrics();
}

function resetSelection(): void {
  if (flow.mode === 'revealed') return;
  state.survivorZones = [];
  state.hunterZones = [];
  state.selectedCipherIndex = -1;
  feedbackMsg.value = '';
  persistState(true);
  updateCanvasMetrics();
}

function onZoneToggle(zoneIdx: number): void {
  if (flow.mode === 'revealed') return;
  if (zoneIdx < 0 || zoneIdx >= zones.value.length) return;
  if (state.side > 0) {
    if (state.hunterZones.includes(zoneIdx)) {
      feedbackMsg.value = '该区域已被监管者选择，求生者无法选择';
      return;
    }
    const existing = state.survivorZones.indexOf(zoneIdx);
    if (existing >= 0) {
      state.survivorZones = state.survivorZones.filter((z) => z !== zoneIdx);
      feedbackMsg.value = '';
    } else if (state.survivorZones.length < 4) {
      state.survivorZones = [...state.survivorZones, zoneIdx];
      feedbackMsg.value = '';
      if (state.survivorZones.length === 4 && (practicing() || autoEnabled()) && flow.prefs.regionAutoSwitchCamp) state.side = -1;
    } else {
      feedbackMsg.value = '求生者最多选择 4 个区域';
      return;
    }
  } else {
    if (state.survivorZones.includes(zoneIdx)) {
      feedbackMsg.value = '该区域已被求生者选择，监管者无法选择';
      return;
    }
    if (state.hunterZones.includes(zoneIdx)) {
      state.hunterZones = [];
    } else {
      state.hunterZones = [zoneIdx];
    }
    feedbackMsg.value = '';
  }
  persistState(true);
  updateCanvasMetrics();
}

function onCanvasClick(e: MouseEvent): void {
  const c = canvasEl.value;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  const w = rect.width > 0 ? rect.width : boxWidth.value;
  const h = rect.height > 0 ? rect.height : boxHeight.value;
  if (!(w > 0 && h > 0)) return;
  const px = rect.width > 0 ? e.clientX - rect.left : e.clientX;
  const py = rect.height > 0 ? e.clientY - rect.top : e.clientY;
  const xRel = px / w;
  const yRel = py / h;
  if (xRel < 0 || xRel > 1 || yRel < 0 || yRel > 1) return;
  const list = zones.value;
  for (let i = 0; i < list.length; i++) {
    const z = list[i]!;
    if (xRel >= z.x && xRel <= z.x + z.width && yRel >= z.y && yRel <= z.y + z.height) {
      onZoneToggle(i);
      return;
    }
  }
}

// ------------------------------------------------------------------ Sizing & Image
type Ltrb = [number, number, number, number];

function collectProtectedBoxes(s: number): Ltrb[] {
  const [mw, mh] = currentMap.value.mapSize;
  const gp = currentMap.value.gridPlacement;
  const cssW = mw * s;
  const cssH = mh * s;
  const left = gp.minX * s;
  const top = gp.minY * s;
  const right = gp.maxX * s;
  const bottom = gp.maxY * s;
  const boxes: Ltrb[] = [[left, top, right, bottom]];

  const zList = zones.value;
  const zCenters = centers.value;
  for (let i = 0; i < zList.length; i++) {
    const z = zList[i]!;
    const zx = z.x * cssW;
    const zy = z.y * cssH;
    const zw = z.width * cssW;
    const zh = z.height * cssH;
    const isSurv = showPrediction.value && state.survivorZones.includes(i);
    const isHunt = showPrediction.value && state.hunterZones.includes(i);
    const strokeHalf = isHunt || isSurv ? 1.1 : 0.7;
    boxes.push([zx - strokeHalf, zy - strokeHalf, zx + zw + strokeHalf, zy + zh + strokeHalf]);
    const badgeW = isSurv || isHunt ? 66 : 32;
    boxes.push([zx + 6, zy + 6, zx + 6 + badgeW, zy + 31]);

    if (isSurv || isHunt) {
      const center = zCenters[i]!;
      const r = Math.max(12, Math.min(zw, zh) * (state.roleSize / 100) * 0.16);
      const pad = isHunt ? r + 6 : r + 4.5;
      const cx = center.x * cssW;
      const cy = center.y * cssH;
      boxes.push([cx - pad, cy - pad, cx + pad, cy + pad]);
    }
  }

  const res = analysis.value;
  if (showPrediction.value) {
    if (res.hunterZoneIdx >= 0 && res.lockIndex >= 0 && zCenters[res.hunterZoneIdx] && res.rows[res.lockIndex]) {
      const hc = zCenters[res.hunterZoneIdx]!;
      const lr = res.rows[res.lockIndex]!;
      const x1 = hc.x * cssW;
      const y1 = hc.y * cssH;
      const x2 = lr.relPos[0] * cssW;
      const y2 = lr.relPos[1] * cssH;
      boxes.push([Math.min(x1, x2) - 2, Math.min(y1, y2) - 2, Math.max(x1, x2) + 2, Math.max(y1, y2) + 2]);
    }
    const cSize = Math.max(16, Math.round(cssW * state.cipherSize / 200));
    for (const row of res.rows) {
      const px = row.relPos[0] * cssW;
      const py = row.relPos[1] * cssH;
      const r = row.isLocked ? 39 : Math.max(10, cSize / 2 + 2);
      boxes.push([px - r, py - r, px + r, py + r]);
    }
    if (res.lockCipherName && res.lockIndex >= 0 && res.rows[res.lockIndex]) {
      const row = res.rows[res.lockIndex]!;
      const px = row.relPos[0] * cssW;
      const py = row.relPos[1] * cssH;
      const tag = `预测封禁 · ${res.lockCipherName}`;
      const tagW = Math.max(116, estimatePlaqueWidth(tag, 14) + 6);
      const [tx, ty] = clampBoxInMap(px + 30, py - 12.5, tagW, 25, left, top, right, bottom);
      boxes.push([tx, ty, tx + tagW, ty + 25]);
    }
    if (state.selectedCipherIndex >= 0 && res.rows[state.selectedCipherIndex]) {
      const row = res.rows[state.selectedCipherIndex]!;
      const px = row.relPos[0] * cssW;
      const py = row.relPos[1] * cssH;
      const rr = Math.max(18, cSize * 0.78) + 6;
      boxes.push([px - rr, py - rr, px + rr, py + rr]);
    }
  }

  if (showDungeons.value) {
    for (const [dx, dy] of currentMap.value.dungeons) {
      const px = (dx / mw) * cssW;
      const py = (dy / mh) * cssH;
      boxes.push([px - 8, py - 8, px + 8, py + 8]);
    }
  }
  if (state.showDoors) {
    const half = Math.max(12, Math.round((cssW * state.doorSize) / 100)) / 2 + 1.5;
    for (const [dx, dy] of currentMap.value.escapeDoors.slice(0, 2)) {
      const px = (dx / mw) * cssW;
      const py = (dy / mh) * cssH;
      boxes.push([px - half, py - half, px + half, py + half]);
    }
  }

  // Revealed pro layer only (blind mode never reads flow.reveal).
  if (revealed.value && showPro.value) {
    if (hunterDiff.value && compareLayer.value === 'both') {
      const x1 = hunterDiff.value.x * s;
      const y1 = hunterDiff.value.y * s;
      const x2 = hunterDiff.value.point.px * s;
      const y2 = hunterDiff.value.point.py * s;
      boxes.push([Math.min(x1, x2) - 2, Math.min(y1, y2) - 2, Math.max(x1, x2) + 2, Math.max(y1, y2) + 2]);
      const label = `偏差 ${revealed.value.score.hunterOffsetMeters} 米`;
      const pw = Math.max(96, estimatePlaqueWidth(label, 13));
      const [px, py] = clampBoxInMap((x1 + x2) / 2 - pw / 2, (y1 + y2) / 2 + 12, pw, 24, left, top, right, bottom);
      boxes.push([px, py, px + pw, py + 24]);
    }
    if (actualLock.value) {
      const lx = actualLock.value.location[0] * s;
      const ly = actualLock.value.location[1] * s;
      boxes.push([lx - 22, ly - 22, lx + 22, ly + 22]);
      const label = compareLayer.value === 'both' && revealed.value.score.lockCipherMatch
        ? '✓ 封禁一致'
        : `实际封禁 · ${actualLock.value.name}`;
      const pw = Math.max(108, estimatePlaqueWidth(label, 13));
      const [px, py] = clampBoxInMap(lx + 18, ly - 30, pw, 23, left, top, right, bottom);
      boxes.push([px, py, px + pw, py + 23]);
    }
    for (const point of revealed.value.truth.spawn.perPlayer) {
      const px = point.px * s;
      const py = point.py * s;
      boxes.push([px - 17, py - 17, px + 17, py + 17]);
      const label = `${point.name}${point.nearEdge ? ' · 贴边' : ''}`;
      const pw = Math.max(40, estimatePlaqueWidth(label, 13));
      const [bx, by] = clampBoxInMap(px + 18, py - 30, pw, 23, left, top, right, bottom);
      boxes.push([bx, by, bx + pw, by + 23]);
    }
  }
  return boxes;
}

function solveOccupiedFit(innerW: number, innerH: number): { scale: number; ox: number; oy: number } {
  const [mw, mh] = currentMap.value.mapSize;
  const feasibleRange = (s: number): [number, number, number, number] => {
    const boxes = collectProtectedBoxes(s);
    let minL = Infinity;
    let minT = Infinity;
    let maxR = -Infinity;
    let maxB = -Infinity;
    for (const [l, t, r, b] of boxes) {
      if (l < minL) minL = l;
      if (t < minT) minT = t;
      if (r > maxR) maxR = r;
      if (b > maxB) maxB = b;
    }
    return [-minL, -minT, innerW - maxR, innerH - maxB];
  };

  let s = innerH / mh;
  let [a, c, e, f] = feasibleRange(s);
  if (a > e || c > f) {
    let lo = 0;
    let hi = s;
    for (let iter = 0; iter < 48; iter++) {
      const mid = (lo + hi) / 2;
      const [ma, mc, me, mf] = feasibleRange(mid);
      if (ma <= me && mc <= mf) lo = mid;
      else hi = mid;
    }
    s = lo > 0 ? lo : Math.min(innerW / mw, innerH / mh);
    [a, c, e, f] = feasibleRange(s);
  }
  const centeredX = (innerW - mw * s) / 2;
  const centeredY = (innerH - mh * s) / 2;
  const ox = a <= e ? Math.min(e, Math.max(a, centeredX)) : centeredX;
  const oy = c <= f ? Math.min(f, Math.max(c, centeredY)) : centeredY;
  return { scale: s, ox, oy };
}

function updateCanvasMetrics(): void {
  const [mw, mh] = currentMap.value.mapSize;
  const host = clipEl.value ?? wrapEl.value;
  const rect = host?.getBoundingClientRect();
  const rawW = rect && rect.width > 16 ? rect.width : (host?.clientWidth ?? 0);
  const rawH = rect && rect.height > 16 ? rect.height : (host?.clientHeight ?? 0);
  const hasBox = Boolean(host && rawW > 16 && rawH > 16);
  const innerW = hasBox ? (clipEl.value ? rawW : rawW - 4) : mw;
  const innerH = hasBox ? (clipEl.value ? rawH : rawH - 4) : mh;
  const fit = hasBox ? solveOccupiedFit(innerW, innerH) : { scale: 1, ox: 0, oy: 0 };

  cameraScale.value = fit.scale;
  modelOriginX.value = fit.ox;
  modelOriginY.value = fit.oy;
  clipWidth.value = innerW;
  clipHeight.value = innerH;
  const w = Math.max(1, mw * fit.scale);
  const h = Math.max(1, mh * fit.scale);
  boxWidth.value = w;
  boxHeight.value = h;

  const c = canvasEl.value;
  if (!c) return;
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (c.width !== bw) c.width = bw;
  if (c.height !== bh) c.height = bh;
  drawCanvas();
}

function loadMapArtwork(): void {
  const token = ++imgToken;
  imgReady.value = false;
  imgMissing.value = false;
  loadedImg = null;
  if (typeof window === 'undefined' || typeof window.Image !== 'function') {
    imgMissing.value = true;
    drawCanvas();
    return;
  }
  void getEnhancedMap(currentMap.value.mapImage, visualPreset.value, {
    material: resolveMapToneMaterial(mapId.value),
  }).then((img) => {
    if (token !== imgToken) return;
    loadedImg = img;
    imgReady.value = true;
    imgMissing.value = false;
    drawCanvas();
  }, () => {
    if (token !== imgToken) return;
    loadedImg = null;
    imgReady.value = false;
    imgMissing.value = true;
    drawCanvas();
  });
}

// ------------------------------------------------------------------ Canvas2D Drawing
function drawRotatedGridImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLCanvasElement,
  cssW: number,
  cssH: number,
): void {
  const [mw, mh] = currentMap.value.mapSize;
  const gp = currentMap.value.gridPlacement;
  const sx = cssW / mw;
  const sy = cssH / mh;
  const x0 = gp.minX * sx;
  const y0 = gp.minY * sy;
  const rw = (gp.maxX - gp.minX) * sx;
  const rh = (gp.maxY - gp.minY) * sy;
  const q = gp.rotationQuadrants;

  if (q === 0) {
    ctx.drawImage(img, x0, y0, rw, rh);
    return;
  }
  const rad = (q * Math.PI) / 2;
  const cos = q === 2 ? -1 : 0;
  const sin = q === 1 ? 1 : q === 3 ? -1 : Math.sin(rad);
  ctx.save();
  ctx.transform(cos, sin, -sin, cos, x0 + rw / 2, y0 + rh / 2);
  const odd = q % 2 === 1;
  const dw = odd ? rh : rw;
  const dh = odd ? rw : rh;
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

function traceChamferedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  cut: number,
): void {
  const c = Math.min(cut, w / 4, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

function drawRoleMedallion(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  kind: 'survivor' | 'hunter',
): void {
  ctx.save();
  // Subtle sapphire/crimson outer aura glow matching stage04-region.png
  if (typeof ctx.createRadialGradient === 'function') {
    const auraR = radius + (kind === 'hunter' ? 11 : 10);
    const aura = ctx.createRadialGradient(cx, cy, radius * 0.85, cx, cy, auraR);
    if (kind === 'hunter') {
      aura.addColorStop(0, 'rgba(218, 56, 68, 0.48)');
      aura.addColorStop(0.58, 'rgba(182, 36, 48, 0.22)');
      aura.addColorStop(1, 'rgba(182, 36, 48, 0)');
    } else {
      aura.addColorStop(0, 'rgba(72, 146, 236, 0.48)');
      aura.addColorStop(0.58, 'rgba(46, 108, 196, 0.22)');
      aura.addColorStop(1, 'rgba(46, 108, 196, 0)');
    }
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(cx, cy, auraR, 0, Math.PI * 2);
    ctx.fill();
  }

  // Dark bronze-obsidian outer collar
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 2.6, 0, Math.PI * 2);
  ctx.fillStyle = '#24170f';
  ctx.fill();

  // Outer antique-brass accent ring
  ctx.beginPath();
  ctx.arc(cx, cy, radius + (kind === 'hunter' ? 4.4 : 3.2), 0, Math.PI * 2);
  ctx.lineWidth = kind === 'hunter' ? 1.5 : 1.1;
  ctx.strokeStyle = kind === 'hunter' ? '#f0ca80' : '#a8ccf2';
  ctx.stroke();

  // Deep radial enamel core (>= 7.8:1 contrast against #fff6e0 serif glyph)
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  if (typeof ctx.createRadialGradient === 'function') {
    const enamel = ctx.createRadialGradient(
      cx - radius * 0.28,
      cy - radius * 0.28,
      radius * 0.12,
      cx,
      cy,
      radius,
    );
    if (kind === 'hunter') {
      enamel.addColorStop(0, '#882630');
      enamel.addColorStop(0.58, '#6a1c24');
      enamel.addColorStop(1, '#461016');
    } else {
      enamel.addColorStop(0, '#244e7a');
      enamel.addColorStop(0.58, '#1a3b5f');
      enamel.addColorStop(1, '#102640');
    }
    ctx.fillStyle = enamel;
  } else {
    ctx.fillStyle = kind === 'hunter' ? '#701f28' : '#1f466e';
  }
  ctx.fill();

  // Double antique-brass & bright enamel bevel rings
  ctx.lineWidth = 2.1;
  ctx.strokeStyle = kind === 'hunter' ? '#f4d398' : '#c6def8';
  ctx.stroke();

  if (radius >= 12) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 2.3, 0, Math.PI * 2);
    ctx.lineWidth = 0.85;
    ctx.strokeStyle = kind === 'hunter' ? 'rgba(255, 224, 170, 0.45)' : 'rgba(208, 232, 255, 0.42)';
    ctx.stroke();
  }

  ctx.fillStyle = '#fff6e0';
  ctx.font = `700 ${Math.max(12, Math.round(radius * 0.96))}px ${CANVAS_FONT_CJK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(kind === 'hunter' ? '监' : '求', cx, cy + 0.5);
  ctx.restore();
}

function drawCipherGlyph(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  num: number,
  isLocked: boolean,
  isSelected: boolean,
): void {
  ctx.save();
  if (isLocked) {
    // Warm golden radial aura matching stage04-region.png
    if (typeof ctx.createRadialGradient === 'function') {
      const glow = ctx.createRadialGradient(x, y, 16, x, y, 38);
      glow.addColorStop(0, 'rgba(255, 212, 98, 0.58)');
      glow.addColorStop(0.52, 'rgba(255, 184, 58, 0.26)');
      glow.addColorStop(1, 'rgba(255, 184, 58, 0)');
      ctx.fillStyle = glow;
    } else {
      ctx.fillStyle = 'rgba(255, 200, 78, 0.3)';
    }
    ctx.beginPath();
    ctx.arc(x, y, 38, 0, Math.PI * 2);
    ctx.fill();

    // Double-ringed antique dark-bronze & burnished gold medallion
    const rings: Array<[number, string]> = [
      [25, '#36210f'],
      [23.2, '#f9dc8f'],
      [21, '#855620'],
      [19, '#e7c171'],
      [17.8, '#3b2410'],
    ];
    for (const [rr, fill] of rings) {
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (typeof ctx.createRadialGradient === 'function') {
      const well = ctx.createRadialGradient(x - 4, y - 5, 2, x, y, 17.8);
      well.addColorStop(0, '#5a3a18');
      well.addColorStop(0.65, '#3b240f');
      well.addColorStop(1, '#241508');
      ctx.fillStyle = well;
      ctx.beginPath();
      ctx.arc(x, y, 17.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Vintage cipher typewriter glyph centered inside medallion
    ctx.fillStyle = '#f6e7c4';
    ctx.fillRect(x - 5.5, y - 10, 11, 6.8);
    ctx.fillStyle = '#6f4f28';
    ctx.fillRect(x - 3.8, y - 8.2, 7.6, 1.1);
    ctx.fillRect(x - 3.8, y - 6.1, 6.2, 1.1);

    ctx.fillStyle = '#d8a856';
    ctx.fillRect(x - 9.8, y - 4, 19.6, 3);
    ctx.fillStyle = '#f8df96';
    ctx.fillRect(x - 11.2, y - 3.4, 2, 1.9);
    ctx.fillRect(x + 9.2, y - 3.4, 2, 1.9);

    ctx.beginPath();
    ctx.moveTo(x - 8.8, y - 1);
    ctx.lineTo(x + 8.8, y - 1);
    ctx.lineTo(x + 11.2, y + 8.5);
    ctx.lineTo(x - 11.2, y + 8.5);
    ctx.closePath();
    if (typeof ctx.createLinearGradient === 'function') {
      const bodyGrad = ctx.createLinearGradient(x, y - 1, x, y + 9);
      bodyGrad.addColorStop(0, '#f7d88a');
      bodyGrad.addColorStop(0.55, '#c18b3b');
      bodyGrad.addColorStop(1, '#84571e');
      ctx.fillStyle = bodyGrad;
    } else {
      ctx.fillStyle = '#d49f4c';
    }
    ctx.fill();
    ctx.strokeStyle = '#2a1809';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#331f0d';
    ctx.fillRect(x - 7.8, y + 1, 15.6, 5.4);
    ctx.fillStyle = '#ffe9ae';
    for (let k = 0; k < 5; k++) {
      ctx.fillRect(x - 6.6 + k * 2.9, y + 1.9, 1.9, 1.5);
    }
    for (let k = 0; k < 4; k++) {
      ctx.fillRect(x - 5.2 + k * 3.0, y + 4.1, 1.9, 1.5);
    }
    ctx.fillStyle = '#f2cc7c';
    ctx.fillRect(x - 11.8, y + 8.5, 23.6, 2);

    // Golden padlock badge perched at 12 o'clock
    const ly = y - 22.5;
    ctx.beginPath();
    ctx.arc(x, ly, 9.4, 0, Math.PI * 2);
    ctx.fillStyle = '#2d1a0a';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, ly, 8.3, 0, Math.PI * 2);
    ctx.fillStyle = '#fae196';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, ly, 6.9, 0, Math.PI * 2);
    ctx.fillStyle = '#6c4314';
    ctx.fill();

    ctx.strokeStyle = '#ffe89c';
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.arc(x, ly - 1.6, 2.7, Math.PI, Math.PI * 2);
    ctx.lineTo(x + 2.7, ly + 0.2);
    ctx.moveTo(x - 2.7, ly - 1.6);
    ctx.lineTo(x - 2.7, ly + 0.2);
    ctx.stroke();

    ctx.fillStyle = '#ffe392';
    ctx.fillRect(x - 4, ly - 0.3, 8, 5.5);
    ctx.strokeStyle = '#3d240b';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.rect(x - 4, ly - 0.3, 8, 5.5);
    ctx.stroke();
    ctx.fillStyle = '#3d240b';
    ctx.beginPath();
    ctx.arc(x, ly + 2.1, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const r = Math.max(9.5, size / 2);
  ctx.beginPath();
  ctx.arc(x, y, r + 1.4, 0, Math.PI * 2);
  ctx.fillStyle = '#18120c';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#221810';
  ctx.fill();
  ctx.lineWidth = 1.7;
  ctx.strokeStyle = isSelected ? '#4ade80' : '#e4bf78';
  ctx.stroke();

  ctx.fillStyle = isSelected ? '#b4f8d6' : '#fff4dc';
  ctx.font = `700 ${Math.max(12, Math.round(r * 1.1))}px ${CANVAS_FONT_CJK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(num), x, y + 0.5);
  ctx.restore();
}

function drawHighlightRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  faint: string,
  radius: number,
  dash: number[],
  tag?: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = faint;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(x, y, radius + 4.5, 0, Math.PI * 2);
  ctx.stroke();

  if (tag) {
    ctx.font = `700 12px ${CANVAS_FONT_CJK}`;
    const w = ctx.measureText(tag).width + 10;
    ctx.fillStyle = '#241a12';
    ctx.fillRect(x - w / 2, y - radius - 18, w, 16);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x - w / 2, y - radius - 18, w, 16);
    ctx.stroke();
    ctx.fillStyle = '#fff4da';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag, x, y - radius - 10);
  }
  ctx.restore();
}

function drawCanvas(): void {
  const c = canvasEl.value;
  if (!c) return;
  const ctx = c.getContext('2d');
  if (!ctx) return;

  const cssW = boxWidth.value;
  const cssH = boxHeight.value;
  if (!(cssW > 0 && cssH > 0)) return;
  const scaleX = c.width > 0 ? c.width / cssW : 1;
  const scaleY = c.height > 0 ? c.height / cssH : 1;

  ctx.save();
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const underlay = VISUAL_PRESETS[visualPreset.value].underlay;
  ctx.fillStyle = underlay.backing ?? '#1c1916';
  ctx.fillRect(0, 0, cssW, cssH);

  const [mw, mh] = currentMap.value.mapSize;
  const gp = currentMap.value.gridPlacement;
  const mapLeft = (gp.minX / mw) * cssW;
  const mapTop = (gp.minY / mh) * cssH;
  const mapW = ((gp.maxX - gp.minX) / mw) * cssW;
  const mapH = ((gp.maxY - gp.minY) / mh) * cssH;
  const mapRight = mapLeft + mapW;
  const mapBottom = mapTop + mapH;

  if (loadedImg && imgReady.value) {
    ctx.save();
    ctx.globalAlpha = visualPreset.value === 'clarity' ? 1 : underlay.opacity;
    drawRotatedGridImage(ctx, loadedImg, cssW, cssH);
    ctx.restore();

    // Engraved double brass mat hairline around the calibrated underlay bounds.
    ctx.save();
    ctx.strokeStyle = '#6c4d2b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.rect(mapLeft - 2, mapTop - 2, mapW + 4, mapH + 4);
    ctx.stroke();
    ctx.strokeStyle = '#e7c580';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.rect(mapLeft - 1, mapTop - 1, mapW + 2, mapH + 2);
    ctx.stroke();
    ctx.restore();
  }

  // Zones grid & solid enamel plaques
  const zList = zones.value;
  const zCenters = centers.value;
  for (let i = 0; i < zList.length; i++) {
    const z = zList[i]!;
    const zx = z.x * cssW;
    const zy = z.y * cssH;
    const zw = z.width * cssW;
    const zh = z.height * cssH;
    const isSurv = showPrediction.value && state.survivorZones.includes(i);
    const isHunt = showPrediction.value && state.hunterZones.includes(i);

    ctx.strokeStyle = isHunt
      ? '#e2747d'
      : isSurv
        ? '#8cb4e4'
        : '#f3cd85';
    ctx.lineWidth = isHunt || isSurv ? 1.9 : 1.25;
    ctx.beginPath();
    ctx.rect(zx, zy, zw, zh);
    ctx.stroke();

    const label = isHunt ? `${i + 1} · 监` : isSurv ? `${i + 1} · 求` : String(i + 1);
    ctx.save();
    ctx.font = `700 14px ${CANVAS_FONT_CJK}`;
    const width = isSurv || isHunt ? 66 : 32;
    const height = 25;
    if (typeof ctx.createLinearGradient === 'function') {
      const plaqueGrad = ctx.createLinearGradient(zx + 6, zy + 6, zx + 6, zy + 6 + height);
      if (isHunt) {
        plaqueGrad.addColorStop(0, '#6e222a');
        plaqueGrad.addColorStop(1, '#4c141b');
      } else if (isSurv) {
        plaqueGrad.addColorStop(0, '#21446b');
        plaqueGrad.addColorStop(1, '#142c47');
      } else {
        plaqueGrad.addColorStop(0, '#493621');
        plaqueGrad.addColorStop(1, '#2f2214');
      }
      ctx.fillStyle = plaqueGrad;
    } else {
      ctx.fillStyle = isHunt ? '#682028' : isSurv ? '#1e3e61' : '#3f2e1c';
    }
    ctx.fillRect(zx + 6, zy + 6, width, height);
    ctx.strokeStyle = isHunt ? '#f0ca86' : isSurv ? '#b8d7f6' : '#e6c382';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.rect(zx + 6, zy + 6, width, height);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 236, 188, 0.42)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.rect(zx + 8, zy + 8, width - 4, height - 4);
    ctx.stroke();
    ctx.fillStyle = '#fff5df';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, zx + 6 + width / 2, zy + 6 + height / 2 + 0.5);
    ctx.restore();
  }

  // Sightline from hunter center to locked cipher
  const res = analysis.value;
  if (showPrediction.value && res.hunterZoneIdx >= 0 && res.lockIndex >= 0) {
    const hCenter = zCenters[res.hunterZoneIdx]!;
    const lockRow = res.rows[res.lockIndex]!;
    const hx = hCenter.x * cssW;
    const hy = hCenter.y * cssH;
    const lx = lockRow.relPos[0] * cssW;
    const ly = lockRow.relPos[1] * cssH;

    ctx.save();
    ctx.strokeStyle = 'rgba(38, 23, 12, 0.72)';
    ctx.lineWidth = 5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = '#ffe69c';
    ctx.shadowColor = '#975312';
    ctx.shadowBlur = 3;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    ctx.restore();
  }

  // Dungeons
  if (showDungeons.value) {
    for (const [dx, dy] of currentMap.value.dungeons) {
      const px = (dx / mw) * cssW;
      const py = (dy / mh) * cssH;
      ctx.save();
      ctx.fillStyle = 'rgba(42, 30, 64, 0.85)';
      ctx.strokeStyle = '#c4b5fd';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(px, py - 7);
      ctx.lineTo(px + 7, py);
      ctx.lineTo(px, py + 7);
      ctx.lineTo(px - 7, py);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // Escape doors
  if (state.showDoors) {
    const dSize = Math.max(14, Math.round((cssW * state.doorSize) / 100));
    for (const [dx, dy] of currentMap.value.escapeDoors.slice(0, 2)) {
      const px = (dx / mw) * cssW;
      const py = (dy / mh) * cssH;
      ctx.save();
      ctx.fillStyle = '#182534';
      ctx.strokeStyle = '#a3c1e3';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.rect(px - dSize / 2, py - dSize / 2, dSize, dSize);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#eef5ff';
      ctx.font = `700 ${Math.max(12, Math.round(dSize * 0.56))}px ${CANVAS_FONT_CJK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('门', px, py + 0.5);
      ctx.restore();
    }
  }

  // Ciphers
  const cSize = Math.max(18, Math.round(cssW * state.cipherSize / 200));
  for (const row of showPrediction.value ? res.rows : []) {
    const px = row.relPos[0] * cssW;
    const py = row.relPos[1] * cssH;
    drawCipherGlyph(ctx, px, py, cSize, row.idx + 1, row.isLocked, state.selectedCipherIndex === row.idx);
  }

  // Role medallions
  for (let i = 0; i < zList.length; i++) {
    const z = zList[i]!;
    const center = zCenters[i]!;
    const r = Math.max(13, Math.min(z.width * cssW, z.height * cssH) * (state.roleSize / 100) * 0.16);
    if (showPrediction.value && state.survivorZones.includes(i)) {
      drawRoleMedallion(ctx, center.x * cssW, center.y * cssH, r, 'survivor');
    }
    if (showPrediction.value && state.hunterZones.includes(i)) {
      drawRoleMedallion(ctx, center.x * cssW, center.y * cssH, r, 'hunter');
    }
  }

  // Lock & selected cipher rings
  if (showPrediction.value && res.lockIndex >= 0 && res.rows[res.lockIndex]) {
    const r = res.rows[res.lockIndex]!;
    drawHighlightRing(
      ctx,
      r.relPos[0] * cssW,
      r.relPos[1] * cssH,
      '#ffd87a',
      'rgba(255, 206, 94, 0.48)',
      27,
      [5, 4],
    );
  }
  if (showPrediction.value && res.lockCipherName && res.lockIndex >= 0) {
    const row = res.rows[res.lockIndex]!;
    const tag = `预测封禁 · ${res.lockCipherName}`;
    ctx.save();
    ctx.font = `700 14px ${CANVAS_FONT_CJK}`;
    const width = Math.max(116, Math.ceil(ctx.measureText(tag).width + 20));
    const height = 25;
    const [x, y] = clampBoxInMap(
      row.relPos[0] * cssW + 30,
      row.relPos[1] * cssH - height / 2,
      width,
      height,
      mapLeft,
      mapTop,
      mapRight,
      mapBottom,
    );
    traceChamferedRect(ctx, x, y, width, height, 4.5);
    if (typeof ctx.createLinearGradient === 'function') {
      const tagGrad = ctx.createLinearGradient(x, y, x, y + height);
      tagGrad.addColorStop(0, '#533617');
      tagGrad.addColorStop(1, '#311e0b');
      ctx.fillStyle = tagGrad;
    } else {
      ctx.fillStyle = '#472d12';
    }
    ctx.fill();
    ctx.strokeStyle = '#f0cc82';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    traceChamferedRect(ctx, x + 2.2, y + 2.2, width - 4.4, height - 4.4, 3);
    ctx.strokeStyle = 'rgba(255, 234, 184, 0.45)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    ctx.fillStyle = '#fff5df';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag, x + width / 2, y + height / 2 + 0.5);
    ctx.restore();
  }
  if (showPrediction.value && state.selectedCipherIndex >= 0 && res.rows[state.selectedCipherIndex]) {
    const r = res.rows[state.selectedCipherIndex]!;
    drawHighlightRing(
      ctx,
      r.relPos[0] * cssW,
      r.relPos[1] * cssH,
      '#4ade80',
      'rgba(74, 222, 128, 0.42)',
      Math.max(18, cSize * 0.78),
      [3, 2],
    );
  }

  ctx.restore();
}

function resetRoleSize(): void {
  state.roleSize = ROLE_SIZE_DEFAULT;
  persistState();
  updateCanvasMetrics();
}
function resetCipherSize(): void {
  state.cipherSize = CIPHER_SIZE_DEFAULT;
  persistState();
  updateCanvasMetrics();
}
function resetDoorSize(): void {
  state.doorSize = DOOR_SIZE_DEFAULT;
  persistState();
  updateCanvasMetrics();
}

watch(
  () => [state.showDoors, state.roleSize, state.cipherSize, state.doorSize, showDungeons.value],
  () => {
    persistState();
    updateCanvasMetrics();
  },
);

watch(compareLayer, updateCanvasMetrics);
watch([mapId, visualPreset], () => {
  loadMapArtwork();
  updateCanvasMetrics();
});

watch(
  () => flow.mode,
  (mode) => {
    if (mode === 'blind' || mode === 'revealed') {
      setRegionSubmode('lock');
    }
  },
  { immediate: true },
);

function attachResizeObserver(): void {
  resizeObs?.disconnect();
  resizeObs = null;
  const targetEl = clipEl.value ?? wrapEl.value;
  if (typeof ResizeObserver !== 'undefined' && targetEl) {
    resizeObs = new ResizeObserver(() => updateCanvasMetrics());
    resizeObs.observe(targetEl);
  }
}

watch(
  () => [submode.value, clipEl.value] as const,
  ([mode]) => {
    if (mode !== 'lock') {
      resizeObs?.disconnect();
      resizeObs = null;
      return;
    }
    const latest = getActiveMapId();
    applyLoadedState(latest);
    if (!loadedImg) loadMapArtwork();
    attachResizeObserver();
    updateCanvasMetrics();
  },
  { flush: 'post' },
);

watch(() => [flow.linkRevision, flow.mode, flow.practiceMap, autoEnabled()], () => {
  applyLoadedState(mapId.value);
  updateCanvasMetrics();
});
watch(folioOpen, (open) => { flow.prefs.rightDrawerCollapsed = !open; });

onMounted(() => {
  syncSubmodeFromHash();
  if (typeof window !== 'undefined') window.addEventListener('hashchange', syncSubmodeFromHash);
  void whenFontsReady().then(drawCanvas);
  unsubMap = onActiveMapChange((nextId) => {
    if (nextId !== mapId.value) applyLoadedState(nextId);
  });
  const latest = getActiveMapId();
  if (latest !== mapId.value) applyLoadedState(latest);
  loadMapArtwork();
  if (submode.value === 'lock') {
    updateCanvasMetrics();
    attachResizeObserver();
  }
});

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('hashchange', syncSubmodeFromHash);
  resizeObs?.disconnect();
  unsubMap?.();
  imgToken++;
});

defineExpose({
  mapId,
  state,
  analysis,
  boxWidth,
  boxHeight,
  cameraScale,
  modelOriginX,
  modelOriginY,
  onZoneToggle,
  submode,
  switchSubmode,
});
</script>

<template>
  <div id="regionView" class="pil-stage" :class="{ 'folio-closed': !folioOpen, 'is-predict': submode === 'predict' }">
    <div class="region-submode-bar dark" role="region" aria-label="区域选点工作模式">
      <div class="seg region-submode-tabs" role="tablist" aria-label="区域选点模式切换" data-test="region-submode-tabs">
        <button
          type="button"
          role="tab"
          data-test="btn-region-mode-predict"
          :aria-selected="submode === 'predict'"
          :aria-pressed="submode === 'predict'"
          :class="{ on: submode === 'predict' }"
          @click="switchSubmode('predict')"
        >
          开局选点预测
        </button>
        <button
          type="button"
          role="tab"
          data-test="btn-region-mode-lock"
          :aria-selected="submode === 'lock'"
          :aria-pressed="submode === 'lock'"
          :class="{ on: submode === 'lock' }"
          @click="switchSubmode('lock')"
        >
          封禁与距离分析
        </button>
      </div>
      <span class="region-submode-hint">
        <template v-if="flow.mode === 'blind'">盲练封印中 · 仅开放公共历史统计参考</template>
        <template v-else-if="submode === 'predict'">1,353 局实局开局库 · 点选 4 名求生格推算监管刷点</template>
        <template v-else>区域选点与 7 密码机封禁距离实时分析</template>
      </span>
    </div>

    <button
      type="button"
      class="folio-toggle"
      data-test="folio-toggle"
      :aria-controls="submode === 'predict' ? 'predict-folio' : 'region-folio'"
      :aria-expanded="folioOpen"
      :aria-label="folioOpen ? '收起卷宗' : '展开卷宗'"
      title="卷宗（]）"
      @click="toggleFolio"
    >
      {{ folioOpen ? '›' : '‹' }}
    </button>

    <template v-if="submode === 'lock'">
    <div class="pil-main">
      <div class="pil-topbar dark fr cut">
        <MapPresetSwitch />
        <div class="pil-title-block">
          <select
            class="sel"
            :value="mapId"
            data-test="region-map-select" :disabled="practicing()"
            aria-label="选择地图"
            @change="onMapSelectChange"
          >
            <option v-for="m in MAPS_DATA" :key="m.mapId" :value="m.mapId">
              {{ m.mapName }}
            </option>
          </select>
          <span class="pil-map-en">{{ currentMap.mapNameEn }}</span>
        </div>

        <div v-if="showPrediction" class="pil-cycler">
          <button
            type="button"
            class="gbtn fr cut sm"
            data-test="region-cipher-prev"
            aria-label="上一组密码机"
            @click="switchCipherGroup(-1)"
          >
            ‹
          </button>
          <div class="pil-cycler-label">
            <span data-test="region-cipher-label">
              第 {{ state.cipherGroupIndex + 1 }} / {{ currentMap.cipherCombinations.length }} 组密码机
            </span>
            <span class="pil-dots">
              <button
                v-for="(_, idx) in currentMap.cipherCombinations"
                :key="idx"
                type="button"
                class="pil-dot"
                :class="{ on: state.cipherGroupIndex === idx }"
                :aria-label="`第 ${idx + 1} 组密码机`"
                @click="selectCipherGroup(idx)"
              ></button>
            </span>
          </div>
          <button
            type="button"
            class="gbtn fr cut sm"
            data-test="region-cipher-next"
            aria-label="下一组密码机"
            @click="switchCipherGroup(1)"
          >
            ›
          </button>
        </div>

        <div v-if="showPrediction" class="pil-camp-group">
          <button
            type="button"
            class="gbtn fr cut sm surv"
            :class="{ on: state.side === 1 }"
            data-test="region-side-survivor"
            @click="setSide(1)"
          >
            求生者选点<span class="pil-camp-count">已选 {{ state.survivorZones.length }} / 4</span>
          </button>
          <button
            type="button"
            class="gbtn fr cut sm hunt"
            :class="{ on: state.side === -1 }"
            data-test="region-side-hunter"
            @click="setSide(-1)"
          >
            监管者选点<span class="pil-camp-count">已选 {{ state.hunterZones.length }} / 1</span>
          </button>
        </div>

        <div class="pil-bar-right">
          <div class="pil-pop-wrap">
            <button
              type="button"
              class="gbtn fr cut sm"
              :class="{ on: displayOpen }"
              data-test="region-display-btn"
              @click="displayOpen = !displayOpen"
            >
              显示设置 ▾
            </button>

          </div>

          <button type="button" class="gbtn fr cut sm" data-test="region-reset" @click="resetSelection">
            ⟲ 重置选点
          </button>
        </div>

      </div>

      <div v-show="displayOpen" class="pil-popover dark fr cut" data-test="region-display-popover">
        <div class="pil-pop-row">
          <label><input v-model="state.showDoors" type="checkbox" data-test="region-show-doors" />显示逃生门</label>
          <label><input v-model="showDungeons" type="checkbox" data-test="region-show-dungeons" />显示地窖</label>
        </div>
        <div class="pil-pop-row">
          <span>角色标尺</span>
          <div class="pil-pop-slider">
            <input v-model.number="state.roleSize" type="range" min="20" max="100" step="2" />
            <button type="button" class="gbtn fr cut sm" @click="resetRoleSize">默认</button>
          </div>
        </div>
        <div class="pil-pop-row">
          <span>密码机大小</span>
          <div class="pil-pop-slider">
            <input v-model.number="state.cipherSize" type="range" min="2" max="12" step="0.5" />
            <button type="button" class="gbtn fr cut sm" @click="resetCipherSize">默认</button>
          </div>
        </div>
        <div class="pil-pop-row">
          <span>逃生门大小</span>
          <div class="pil-pop-slider">
            <input v-model.number="state.doorSize" type="range" min="2" max="12" step="0.5" />
            <button type="button" class="gbtn fr cut sm" @click="resetDoorSize">默认</button>
          </div>
        </div>
      </div>
      <div v-if="linkAvailable" class="pil-banner" data-test="region-link">
        {{ linked ? '已联动录像开局' : '录像开局可应用' }}
        <button class="gbtn" @click="applyReplayLink(true)">应用高亮</button>
        <button class="gbtn" @click="keepManual">保留手动</button>
      </div>
      <div v-if="feedbackMsg" class="pil-banner" role="status" data-test="region-msg">
        {{ feedbackMsg }}
      </div>

      <div ref="wrapEl" class="pil-board-wrap">
        <ManorMapFrame
          v-if="frameSupported"
          :style="{
            '--ruler-width': boxWidth * 40 / currentMap.widthM + 40 + 'px',
            '--compass-right': frameMetrics.compassRight + 'px',
            '--compass-top': frameMetrics.compassTop + 'px',
          }"
          :px-per-meter="boxWidth / currentMap.widthM"
          :north-angle="currentMap.gridPlacement.rotationQuadrants * 90"
          :safe-inset="{ left: frameMetrics.scaleLeft, top: frameMetrics.compassTop, bottom: frameMetrics.scaleBottom }"
        />
        <div ref="clipEl" class="pil-viewport-clip">
          <div
            class="pil-aspect-frame"
            :data-camera-scale="cameraScale.toFixed(6)"
            :data-model-origin="`${modelOriginX.toFixed(3)},${modelOriginY.toFixed(3)}`"
            :style="{
              left: `${modelOriginX}px`,
              top: `${modelOriginY}px`,
              width: `${boxWidth}px`,
              height: `${boxHeight}px`,
            }"
          >
            <canvas
              ref="canvasEl"
              data-test="region-canvas"
              aria-label="区域选点地图画布"
              @click="onCanvasClick"
            ></canvas>
            <svg
              v-if="revealed && compareLayer !== 'mine'"
              class="spawn-diff"
              data-test="practice-spawn-diff"
              :viewBox="`0 0 ${boxWidth} ${boxHeight}`"
              aria-label="高手真实出生点与我的选区"
            >
              <g v-if="svgOverlay.offset && compareLayer === 'both'">
                <line
                  :x1="svgOverlay.offset.x1" :y1="svgOverlay.offset.y1"
                  :x2="svgOverlay.offset.x2" :y2="svgOverlay.offset.y2"
                  stroke="#2a190d" stroke-opacity="0.72" stroke-width="5.5" stroke-dasharray="9 6" stroke-linecap="round"
                />
                <line
                  :x1="svgOverlay.offset.x1" :y1="svgOverlay.offset.y1"
                  :x2="svgOverlay.offset.x2" :y2="svgOverlay.offset.y2"
                  stroke="#ffdf95" stroke-width="2.6" stroke-dasharray="9 6" stroke-linecap="round"
                />
                <rect
                  :x="svgOverlay.offset.px" :y="svgOverlay.offset.py"
                  :width="svgOverlay.offset.pw" :height="svgOverlay.offset.ph"
                  rx="3" class="offset-plate"
                />
                <text
                  :x="svgOverlay.offset.px + svgOverlay.offset.pw / 2"
                  :y="svgOverlay.offset.py + svgOverlay.offset.ph / 2 + 4.5"
                  class="plate-text" text-anchor="middle"
                >
                  {{ svgOverlay.offset.label }}
                </text>
              </g>
              <g v-if="svgOverlay.lock">
                <circle :cx="svgOverlay.lock.cx" :cy="svgOverlay.lock.cy" r="21" fill="none" stroke="#ffd877" stroke-width="2.6" stroke-dasharray="5 4" />
                <circle :cx="svgOverlay.lock.cx" :cy="svgOverlay.lock.cy" r="15" fill="#5e411d" stroke="#f0cd87" stroke-width="2" />
                <text :x="svgOverlay.lock.cx" :y="svgOverlay.lock.cy + 5" text-anchor="middle" class="spawn-role">锁</text>
                <rect
                  :x="svgOverlay.lock.px" :y="svgOverlay.lock.py"
                  :width="svgOverlay.lock.pw" :height="svgOverlay.lock.ph"
                  rx="3" class="offset-plate"
                />
                <text
                  :x="svgOverlay.lock.px + svgOverlay.lock.pw / 2"
                  :y="svgOverlay.lock.py + svgOverlay.lock.ph / 2 + 4.5"
                  class="plate-text" text-anchor="middle"
                >
                  {{ svgOverlay.lock.label }}
                </text>
              </g>
              <g v-for="point in svgOverlay.spawns" :key="point.uid">
                <rect
                  v-if="compareLayer === 'pro' && point.zoneRect"
                  :x="point.zoneRect.x" :y="point.zoneRect.y"
                  :width="point.zoneRect.w" :height="point.zoneRect.h"
                  fill="none" :stroke="point.camp === 1 ? '#ff796c' : '#ffd877'" stroke-width="3" stroke-dasharray="9 6"
                />
                <circle
                  data-test="practice-spawn-point"
                  :cx="point.cx" :cy="point.cy" r="14.5"
                  :fill="point.camp === 1 ? '#792a32' : '#264466'"
                  stroke="#f1cf8e" stroke-width="2"
                />
                <text :x="point.cx" :y="point.cy + 5" text-anchor="middle" class="spawn-role">{{ point.camp === 1 ? '监' : '求' }}</text>
                <rect
                  :x="point.px" :y="point.py"
                  :width="point.pw" :height="point.ph"
                  rx="3"
                  :fill="point.camp === 1 ? '#6e2830' : '#264464'"
                  stroke="#dfbf86" stroke-width="1.2"
                />
                <text
                  :x="point.px + point.pw / 2"
                  :y="point.py + point.ph / 2 + 4.5"
                  class="plate-text" text-anchor="middle"
                >
                  {{ point.label }}
                </text>
              </g>
            </svg>
            <div v-if="imgMissing && !imgReady" class="pil-img-fallback">
              {{ currentMap.mapName }} 线框模式（区域仍可点选）
            </div>
          </div>
        </div>
      </div>

      <div class="pil-action-bar dark fr cut">
        <div class="pil-legend">
          <span class="pil-legend-item"><i class="pil-lg-dot surv"></i>求生者区域</span>
          <span class="pil-legend-item"><i class="pil-lg-dot hunt"></i>监管者区域</span>
          <span class="pil-legend-item"><i class="pil-lg-dot lock"></i>封禁密码机</span>
          <span class="pil-legend-item"><i class="pil-lg-dot sel"></i>选中密码机</span>
          <span v-if="state.showDoors" class="pil-legend-item"><i class="pil-lg-dot door"></i>逃生门</span>
          <span v-if="showDungeons" class="pil-legend-item"><i class="pil-lg-dot dungeon"></i>地窖</span>
        </div>
        <button v-if="flow.mode === 'blind'" class="gbtn" @click="openPracticeDraft">开局草稿 → 02</button>
        <NextStepCta v-if="linkAvailable || practicing()" :step="5" :label="flow.mode === 'blind' ? '推演 7 机 → 05' : '查看密码机 → 05'" />
        <button v-if="flow.mode === 'blind' && !folioOpen" class="gbtn" :disabled="!flow.truthReady || !state.survivorZones.length || !state.hunterZones.length" @click="lockPractice">锁定并揭晓</button>
        <button v-if="revealed && !folioOpen" class="gbtn" @click="watchOpening">▶ 看高手开局前 60 秒</button>
        <details v-if="showPrediction" class="zone-picker">
          <summary>区域列表</summary>
          <div class="pil-zone-chips">
            <button
              v-for="(zName, idx) in currentMap.zoneNames"
              :key="idx"
              type="button"
              class="zone-chip"
              :class="{ surv: state.survivorZones.includes(idx), hunt: state.hunterZones.includes(idx) }"
              :data-zone-idx="idx"
              @click="onZoneToggle(idx)"
            >
              {{ idx + 1 }}. {{ zName }}
            </button>
          </div>
        </details>
      </div>
    </div>

    <aside v-show="folioOpen" id="region-folio" class="folio-stack">
      <ManorOrnaments kind="clip" />
      <div class="pil-right paper-folio folio-inner">
        <header class="pil-case-title">
          <small>{{ currentMap.mapNameEn.toUpperCase() }} · SPAWN REGION</small>
          <h2>{{ currentMap.mapName }} · 区域选点</h2>
          <em>{{ currentMap.mapNameEn }} — Spawn Region &amp; Cipher Lock</em>
          <ManorOrnaments kind="stage" stage="04" />
        </header>
        <h3 v-if="flow.mode === 'blind'" class="ribbon-h">盲练开局 <small>Blind Practice</small></h3>
        <PracticeHud :ready="state.survivorZones.length > 0 && state.hunterZones.length > 0" @lock="lockPractice" />
        <nav v-if="flow.mode === 'blind'" class="folio-phases" aria-label="盲练阶段">
          <button class="phase-plate opening" @click="openPracticeDraft">开局草稿</button>
          <button class="phase-plate midgame" @click="setStep(5)">密码机推演</button>
          <button class="phase-plate endgame" :disabled="!flow.truthReady || !state.survivorZones.length || !state.hunterZones.length"
            @click="lockPractice">锁定揭晓</button>
        </nav>

        <section class="card" data-test="region-lock-card">
          <h3 class="ribbon-h">封禁密码机 <small>Locked Cipher</small></h3>
          <div class="lock-entry">
            <svg class="ledger-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 7V5.2a3 3 0 1 1 6 0V7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              <rect x="3.2" y="7" width="9.6" height="7" rx="1.4" fill="currentColor" />
              <circle cx="8" cy="10.4" r="1.1" fill="#f7ebd2" />
            </svg>
            <span>{{ showPrediction ? '预测封禁' : '实际封禁' }}</span>
            <b data-test="lock-cipher-name">{{ (showPrediction ? analysis.lockCipherName : actualLock?.name) ?? '--' }}</b>
          </div>
          <div v-if="showPrediction" class="folio-line">
            <svg class="ledger-ico" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.4" />
              <path d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              <circle cx="8" cy="8" r="1.4" fill="currentColor" />
            </svg>
            <span>距监管区域中心</span>
            <b data-test="lock-cipher-dist">{{ analysis.lockDistanceM !== null ? analysis.lockDistanceM.toFixed(1) + ' m' : '--' }}</b>
          </div>
        </section>
        <label v-if="revealed" class="layer-control">出生点图层
          <select v-model="compareLayer" class="sel">
            <option value="both">同屏对照</option><option value="mine">我的预测</option><option value="pro">高手真值</option>
          </select>
        </label>
        <section v-if="showPro && revealed" class="card">
          <h3 class="ribbon-h">职业选手 <small>Pro Player</small></h3>
          <div :class="{ verdict: compareLayer === 'both' }">
            <ManorOrnaments v-if="compareLayer === 'both'" :kind="revealed.score.lockCipherMatch ? 'win' : 'lose'"
              :label-pair="revealed.score.lockCipherMatch ? { zh: '命中', en: 'Hit' } : { zh: '偏差', en: 'Miss' }" />
            <p class="ledger-row">
              <svg class="ledger-ico" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="5.2" r="2.7" fill="currentColor" />
                <path d="M3.2 13.8c.5-2.7 2.4-4.2 4.8-4.2s4.3 1.5 4.8 4.2Z" fill="currentColor" />
              </svg>
              <span>求生区域　{{ revealed.truth.spawn.survivorZones.map(z => z + 1).join('、') || '—' }}</span>
            </p>
            <p class="ledger-row">
              <svg class="ledger-ico" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.4" />
                <path d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                <circle cx="8" cy="8" r="1.4" fill="currentColor" />
              </svg>
              <span>监管区域　{{ revealed.truth.spawn.hunterZone == null ? '—' : revealed.truth.spawn.hunterZone + 1 }} · 实际封禁 {{ actualLock?.name ?? '—' }}</span>
            </p>
            <span v-if="compareLayer === 'both'" class="verdict-note">
              <svg class="ledger-ico" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.35" />
                <circle cx="8" cy="8" r="2.7" fill="none" stroke="currentColor" stroke-width="1.2" />
                <circle cx="8" cy="8" r="1" fill="currentColor" />
              </svg>
              <span>封禁{{ revealed.score.lockCipherMatch ? '命中' : '偏差' }} · 监管误差 {{ revealed.score.hunterOffsetMeters }} 米</span>
            </span>
          </div>
        </section>
        <section v-if="showPrediction" class="card">
          <h3 class="ribbon-h">我的选点 <small>My Choice</small></h3>
          <p class="ledger-row">
            <svg class="ledger-ico" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="5.2" r="2.7" fill="currentColor" />
              <path d="M3.2 13.8c.5-2.7 2.4-4.2 4.8-4.2s4.3 1.5 4.8 4.2Z" fill="currentColor" />
            </svg>
            <span>求生区域　{{ state.survivorZones.map(z => z + 1).join('、') || '—' }}</span>
          </p>
          <div class="folio-line">
            <svg class="ledger-ico" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.35" />
              <circle cx="8" cy="8" r="2.7" fill="none" stroke="currentColor" stroke-width="1.2" />
              <circle cx="8" cy="8" r="1" fill="currentColor" />
            </svg>
            <span>监管区域</span>
            <b data-test="hunter-zone-name">{{ analysis.hunterZoneName ?? '--' }}</b>
          </div>
          <small>区域中心　<span data-test="hunter-pixel-coord">{{ analysis.hunterPixelCoords?.join(', ') ?? '--' }}</span></small>
        </section>
        <div v-if="showPrediction" class="card" data-test="region-cipher-table">
          <h3 class="ribbon-h">密码机距离 <small>Cipher Distance</small></h3>
          <table class="pil-cipher-table">
            <thead>
              <tr>
                <th>编号</th>
                <th>密码机名称</th>

                <th>距监管距离</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in analysis.rows"
                :key="row.id"
                class="pil-cipher-row"
                :class="{
                  locked: row.isLocked,
                  farthest: row.isFarthest,
                  'selected-cipher': state.selectedCipherIndex === row.idx,
                }"
                :title="row.feature"
                tabindex="0"
                @keydown.enter.prevent="toggleCipherRow(row.idx)"
                @keydown.space.prevent="toggleCipherRow(row.idx)"
                :data-cipher-row="row.idx"
                @click="toggleCipherRow(row.idx)"
              >
                <td class="num">{{ String(row.idx + 1).padStart(2, '0') }}</td>
                <td>
                  <span class="pil-cipher-name-cell">
                    <svg v-if="row.isLocked" class="cipher-row-ico" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M5 7V5.2a3 3 0 1 1 6 0V7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                      <rect x="3.2" y="7" width="9.6" height="7" rx="1.4" fill="currentColor" />
                      <circle cx="8" cy="10.4" r="1.1" fill="#f7ebd2" />
                    </svg>
                    <svg v-else class="cipher-row-ico" viewBox="0 0 16 16" aria-hidden="true">
                      <rect x="4.5" y="2" width="7" height="4.2" fill="none" stroke="currentColor" stroke-width="1.2" />
                      <path d="M2.5 6.2h11l1.2 6.8H1.3Z" fill="currentColor" />
                      <path d="M4.2 8.5h1.6m1.4 0h1.6m1.4 0h1.6M4.8 10.6h6.4" stroke="#f7ebd2" stroke-width="1.1" stroke-linecap="round" />
                    </svg>
                    <span>{{ row.name }}</span>
                    <span v-if="row.isLocked" class="pil-badge">封禁</span>
                    <span v-if="row.isFarthest" class="pil-badge far">最远</span>
                  </span>
                </td>

                <td class="num dist-val">{{ analysis.hunterZoneIdx >= 0 ? `${row.distanceM.toFixed(1)} m` : '--' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="state.selectedCipherIndex >= 0">{{ analysis.rows[state.selectedCipherIndex]?.feature }}</p>
        </div>
        <details v-if="showPrediction" class="card" data-test="region-hints">
          <summary>选点提示</summary><p>{{ currentMap.fixedHint || '—' }}</p><p v-if="dynamicHint">{{ dynamicHint }}</p>
        </details>
        <PracticeRevealCard v-if="revealed && compareLayer === 'both'" />
        <button v-else-if="revealed" class="gbtn" @click="watchOpening">▶ 看高手开局前 60 秒</button>
        <nav v-if="!practicing() && store.analytics && store.replay?.match.map_name === currentMap.mapName && store.analytics.match_id === store.selectedId"
          class="folio-phases" aria-label="按阶段回看对局">
          <button v-for="phase in store.analytics.phases" :key="phase.phase_id" class="phase-plate"
            :class="phase.phase_id" @click="reviewPhase(phase.start_t)">
            <b>{{ phase.label_zh }}</b><small>{{ formatClock(phase.start_t) }}</small>
          </button>
        </nav>
      </div>
    </aside>
    </template>

    <SpawnPredictorView
      v-else
      :folio-open="folioOpen"
      @transfer-to-lock="onPredictTransferToLock"
    />
  </div>
</template>

<style scoped>
.pil-main > .pil-popover { position: absolute; top: 44px; right: 64px; z-index: 30; }
.spawn-diff { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
</style>
