<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  MAPS_DATA,
  SPAWN_PREDICT_DATA,
  applySpawnPredictionToBoard,
  cellIdToPilZone,
  findPredictHunterIndex,
  formatCellCoord,
  getActiveMapId,
  loadRegionState,
  onActiveMapChange,
  pickRandomRealRecord,
  pilZoneToCellId,
  predictHunterPortraitUrl,
  predictHunterSpawn,
  resolvePilMapId,
  saveRegionState,
  setActiveMapId,
  topSurvivorLayouts,
  type PilMapId,
  type SpawnPredictLayoutPreset,
  type SpawnPredictMatchedRecord,
} from '@/tactical';
import { computeReplayLink, type ReplayLinkResult } from '@/tactical/replay-link';
import { flow, practicing, rememberManual } from '@/store/flow';
import { setStep, store } from '@/store/app';
import { getEnhancedMap, resolveMapToneMaterial, useMapPreset } from '@/lib/mapTone';
import MapPresetSwitch from '../tactical/MapPresetSwitch.vue';
import ManorMapFrame from '../tactical/ManorMapFrame.vue';
import ManorOrnaments from '../tactical/ManorOrnaments.vue';
import SpawnHunterModal from './SpawnHunterModal.vue';
import '@/styles/spawn-predictor.css';

defineProps<{
  folioOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'transfer-to-lock', payload: { mapId: PilMapId; survivorZones: number[]; hunterZone: number }): void;
}>();

const { visualPreset } = useMapPreset();

const mapId = ref<PilMapId>(getActiveMapId());
const hunterIdx = ref<number>(-1);
const survCells = ref<number[]>([]);
const myAltCell = ref<number | null>(null);
const markAltMode = ref<boolean>(false);
const hunterModalOpen = ref<boolean>(false);
const feedbackMsg = ref<string>('');

// Map image & board sizing
const wrapEl = ref<HTMLDivElement | null>(null);
const clipEl = ref<HTMLDivElement | null>(null);
const enhancedUrl = ref<string>('');
const imgBroken = ref<boolean>(false);
const boardWidth = ref<number>(720);
const boardHeight = ref<number>(620);
const boardLeft = ref<number>(0);
const boardTop = ref<number>(0);
const clipWidth = ref<number>(740);
const clipHeight = ref<number>(680);

const frameSupported = typeof ResizeObserver !== 'undefined';
let resizeObs: ResizeObserver | null = null;
let unsubMap: (() => void) | null = null;

const currentMap = computed(() => MAPS_DATA[mapId.value]!);
const mapName = computed(() => SPAWN_PREDICT_DATA.maps[mapId.value] ?? currentMap.value.mapName);
const rawMapUrl = computed(() => encodeURI(`/assets/maps/${mapName.value}_grid.jpg`));
const mapGeo = computed(() => SPAWN_PREDICT_DATA.geo[mapName.value]!);
const validCells = computed(() => SPAWN_PREDICT_DATA.cells[mapName.value] ?? []);
const mapCols = computed(() => SPAWN_PREDICT_DATA.cols[mapName.value] ?? 3);

const hunterDisplayName = computed(() =>
  hunterIdx.value >= 0 ? (SPAWN_PREDICT_DATA.hunters[hunterIdx.value] ?? '不限监管') : '不限监管',
);
const hunterPortrait = computed(() => predictHunterPortraitUrl(hunterIdx.value));

const prediction = computed(() =>
  predictHunterSpawn({
    mapId: mapId.value,
    hunterIdx: hunterIdx.value,
    survCells: survCells.value,
    myAltCell: myAltCell.value,
  }),
);

const topLayouts = computed(() => topSurvivorLayouts(mapId.value, hunterIdx.value, 6));

const activeLayoutKey = computed(() =>
  survCells.value.length === 4 ? [...survCells.value].sort((a, b) => a - b).join('-') : '',
);

const miniGridSlots = computed(() => {
  const cols = mapCols.value;
  const validSet = new Set(validCells.value);
  const slots: Array<{ id: number; valid: boolean }> = [];
  for (let r = 1; r <= 3; r++) {
    for (let c = 1; c <= cols; c++) {
      const id = r * 10 + c;
      slots.push({ id, valid: validSet.has(id) });
    }
  }
  return slots;
});

const bestCellId = computed(() => prediction.value.best?.cellId ?? null);
const altRankMap = computed(() => {
  const map = new Map<number, number>();
  prediction.value.alts.forEach((entry, i) => {
    map.set(entry.cellId, i + 2);
  });
  return map;
});

const canTransfer = computed(
  () => prediction.value.status === 'ok' && prediction.value.best !== null && survCells.value.length === 4,
);
const canSendSandbox = computed(() => canTransfer.value && flow.mode !== 'blind');

/**
 * Strict Zero-Spoiler Guard:
 * NEVER read sealedSession or leak replay truth while `flow.mode === 'blind'`.
 */
const publicReplaySource = computed<ReplayLinkResult | null>(() => {
  if (flow.mode === 'blind') return null;
  if (flow.link && flow.link.spawn.survivorZones.length > 0) return flow.link;
  if (flow.mode === 'revealed' && flow.reveal?.truth && flow.reveal.truth.spawn.survivorZones.length > 0) {
    return flow.reveal.truth;
  }
  if (store.replay) {
    const computedLink = computeReplayLink(store.replay);
    if (computedLink && computedLink.spawn.survivorZones.length > 0) return computedLink;
  }
  return null;
});

const canImportFromReplay = computed(() => {
  if (flow.mode === 'blind') return false;
  const src = publicReplaySource.value;
  if (!src) return false;
  return src.spawn.survivorZones.some((z) => pilZoneToCellId(src.mapId, z) >= 0);
});

const geoCells = computed(() => {
  const cellsRects = mapGeo.value?.cells ?? {};
  const zoneNames = currentMap.value.zoneNames;
  const res = prediction.value;
  const bestId = bestCellId.value;
  const alts = altRankMap.value;

  return validCells.value.map((cellId) => {
    const rect = cellsRects[String(cellId)] ?? [0, 0, 33.3, 33.3];
    const survOrder = survCells.value.indexOf(cellId);
    const isSurv = survOrder >= 0;
    const isAltMark = myAltCell.value === cellId;
    const prob = res.status === 'ok' ? (res.cellProbs[cellId] ?? 0) : 0;
    const pctInt = Math.round(prob * 100);
    const rawCount = res.status === 'ok' ? (res.cellRawCounts[cellId] ?? 0) : 0;
    const isBest = res.status === 'ok' && bestId === cellId;
    const altRank = res.status === 'ok' ? (alts.get(cellId) ?? null) : null;
    const pilZone = cellIdToPilZone(mapId.value, cellId);
    const zoneName = pilZone >= 0 ? (zoneNames[pilZone] ?? formatCellCoord(cellId)) : formatCellCoord(cellId);

    let heatBg = 'transparent';
    if (isSurv) {
      heatBg = 'rgba(34, 67, 102, 0.44)';
    } else if (res.status === 'ok') {
      if (isBest) {
        heatBg = 'rgba(156, 38, 52, 0.44)';
      } else if (altRank !== null) {
        heatBg = `rgba(176, 86, 46, ${(0.22 + Math.min(0.36, prob * 0.65)).toFixed(3)})`;
      } else if (prob > 0) {
        heatBg = `rgba(178, 104, 58, ${(0.12 + Math.min(0.32, prob * 0.6)).toFixed(3)})`;
      } else {
        heatBg = 'rgba(16, 13, 10, 0.14)';
      }
    }

    return {
      cellId,
      coord: formatCellCoord(cellId),
      zoneName,
      isSurv,
      survIndex: survOrder + 1,
      isAltMark,
      isBest,
      altRank,
      prob,
      pctInt,
      rawCount,
      showHeatReadout: res.status === 'ok' && !isSurv,
      style: {
        left: `${rect[0]}%`,
        top: `${rect[1]}%`,
        width: `${rect[2]}%`,
        height: `${rect[3]}%`,
        backgroundColor: heatBg,
      },
    };
  });
});

const frameMetrics = computed(() => {
  const bw = clipWidth.value + 6;
  const mapRight = 3 + boardLeft.value + boardWidth.value;
  return {
    scaleLeft: Math.max(12, Math.round(3 + boardLeft.value)),
    scaleBottom: 40,
    compassRight: Math.max(12, Math.round(bw - mapRight + 10)),
    compassTop: Math.max(12, Math.round(3 + boardTop.value + 6)),
  };
});

// ------------------------------------------------------------------ Actions
function applyMapChange(nextId: PilMapId, syncGlobal: boolean): void {
  const prev = mapId.value;
  mapId.value = nextId;
  if (syncGlobal && !practicing()) {
    setActiveMapId(nextId);
  }
  if (nextId !== prev) {
    survCells.value = [];
    myAltCell.value = null;
    markAltMode.value = false;
    feedbackMsg.value = '';
  }
}

function onMapSelectChange(e: Event): void {
  const next = resolvePilMapId(Number((e.target as HTMLSelectElement).value));
  applyMapChange(next, true);
}

function onSelectHunter(idx: number): void {
  hunterIdx.value = idx;
  feedbackMsg.value = '';
}

function toggleMarkAltMode(): void {
  markAltMode.value = !markAltMode.value;
  feedbackMsg.value = '';
}

function onCellClick(cellId: number): void {
  feedbackMsg.value = '';
  if (markAltMode.value) {
    if (survCells.value.includes(cellId)) {
      feedbackMsg.value = '求生者已占用该格，监管者预判请标在空闲格';
      return;
    }
    myAltCell.value = myAltCell.value === cellId ? null : cellId;
    return;
  }

  const existingIdx = survCells.value.indexOf(cellId);
  if (existingIdx >= 0) {
    survCells.value = survCells.value.filter((c) => c !== cellId);
    return;
  }
  if (survCells.value.length >= 4) {
    feedbackMsg.value = '已选满 4 名求生者点位，点击已选格可取消或清空重选';
    return;
  }
  survCells.value = [...survCells.value, cellId];
  if (myAltCell.value === cellId) {
    myAltCell.value = null;
  }
}

function applyLayoutPreset(preset: SpawnPredictLayoutPreset): void {
  survCells.value = [...preset.cells];
  if (myAltCell.value !== null && preset.cells.includes(myAltCell.value)) {
    myAltCell.value = null;
  }
  markAltMode.value = false;
  feedbackMsg.value = '';
}

function pickRandomRecord(): void {
  const rec = pickRandomRealRecord(mapId.value, hunterIdx.value);
  if (!rec) {
    feedbackMsg.value = '当前地图与监管者暂无实局样本，可切换「不限监管」查询';
    return;
  }
  survCells.value = [...rec.survCells];
  if (myAltCell.value !== null && rec.survCells.includes(myAltCell.value)) {
    myAltCell.value = null;
  }
  markAltMode.value = false;
  feedbackMsg.value = '';
}

function clearSelection(): void {
  survCells.value = [];
  myAltCell.value = null;
  markAltMode.value = false;
  feedbackMsg.value = '';
}

function loadMatchedRecord(rec: SpawnPredictMatchedRecord): void {
  survCells.value = [...rec.survCells];
  if (myAltCell.value !== null && rec.survCells.includes(myAltCell.value)) {
    myAltCell.value = null;
  }
  markAltMode.value = false;
  feedbackMsg.value = '';
}

function transferToLockAnalysis(): void {
  const best = prediction.value.best;
  if (!canTransfer.value || !best) return;
  const survivorZones = survCells.value
    .map((c) => cellIdToPilZone(mapId.value, c))
    .filter((z) => z >= 0);
  const hunterZone = cellIdToPilZone(mapId.value, best.cellId);
  if (hunterZone < 0) return;

  if (!practicing()) {
    const existing = loadRegionState(mapId.value);
    rememberManual(mapId.value, {
      groupIndex: existing.cipherGroupIndex,
      survivorZones,
      hunterZone,
    });
    saveRegionState(mapId.value, {
      ...existing,
      side: -1,
      survivorZones,
      hunterZones: [hunterZone],
    });
  }

  emit('transfer-to-lock', {
    mapId: mapId.value,
    survivorZones,
    hunterZone,
  });
}

function sendToTacticalSandbox(): void {
  const best = prediction.value.best;
  if (!canSendSandbox.value || !best) return;
  applySpawnPredictionToBoard(mapId.value, {
    survCells: [...survCells.value],
    hunterCell: best.cellId,
    hunterIdx: hunterIdx.value,
  });
  setStep(2);
}

function resolveReplayHunterIndex(): number {
  if (flow.mode === 'blind') return -1;
  const replay = store.replay;
  const hunterSummary = replay?.match?.hunter as
    | { player_name?: string; name?: string; character_name?: string; role?: string }
    | string
    | null
    | undefined;
  const candidates: Array<string | null | undefined> = [];
  if (typeof hunterSummary === 'string') {
    candidates.push(hunterSummary);
  } else if (hunterSummary && typeof hunterSummary === 'object') {
    candidates.push(hunterSummary.character_name, hunterSummary.role, hunterSummary.name, hunterSummary.player_name);
  }
  const hunterPlayer = replay?.players?.find((p) => p.camp === 1) as
    | { player_name?: string; character_name?: string; role?: string }
    | undefined;
  if (hunterPlayer) {
    candidates.push(hunterPlayer.character_name, hunterPlayer.role, hunterPlayer.player_name);
  }
  for (const name of candidates) {
    const idx = findPredictHunterIndex(name);
    if (idx >= 0) return idx;
  }
  return -1;
}

function importFromCurrentReplay(): void {
  if (flow.mode === 'blind') return;
  const src = publicReplaySource.value;
  if (!src) return;

  applyMapChange(src.mapId, true);
  hunterIdx.value = resolveReplayHunterIndex();

  const mappedSurv: number[] = [];
  for (const z of src.spawn.survivorZones) {
    const cid = pilZoneToCellId(src.mapId, z);
    if (cid >= 0 && !mappedSurv.includes(cid)) {
      mappedSurv.push(cid);
      if (mappedSurv.length === 4) break;
    }
  }
  survCells.value = mappedSurv;

  if (src.spawn.hunterZone !== null) {
    const hCell = pilZoneToCellId(src.mapId, src.spawn.hunterZone);
    myAltCell.value = hCell >= 0 && !mappedSurv.includes(hCell) ? hCell : null;
  } else {
    myAltCell.value = null;
  }
  markAltMode.value = false;
  feedbackMsg.value = '';
}

// ------------------------------------------------------------------ Sizing & Map Tone
function updateBoardMetrics(): void {
  const host = clipEl.value ?? wrapEl.value;
  const rect = host?.getBoundingClientRect();
  const rawW = rect && rect.width > 16 ? rect.width : (host?.clientWidth ?? 0);
  const rawH = rect && rect.height > 16 ? rect.height : (host?.clientHeight ?? 0);
  const ar = mapGeo.value?.ar ?? 1.15;

  if (!host || rawW <= 16 || rawH <= 16) {
    clipWidth.value = 740;
    clipHeight.value = 680;
    boardWidth.value = Math.round(620 * ar);
    boardHeight.value = 620;
    boardLeft.value = 12;
    boardTop.value = 10;
    return;
  }

  clipWidth.value = rawW;
  clipHeight.value = rawH;

  const padX = 18;
  const padTop = 12;
  const padBottom = 46; // clearance for bottom .pil-action-bar
  const availW = Math.max(200, rawW - padX * 2);
  const availH = Math.max(180, rawH - padTop - padBottom);

  let w = availW;
  let h = w / ar;
  if (h > availH) {
    h = availH;
    w = h * ar;
  }
  boardWidth.value = Math.max(160, Math.round(w));
  boardHeight.value = Math.max(140, Math.round(h));
  boardLeft.value = Math.max(padX, Math.round((rawW - boardWidth.value) / 2));
  boardTop.value = Math.max(padTop, Math.round(padTop + (availH - boardHeight.value) / 2));
}

watch(
  [rawMapUrl, visualPreset, mapId],
  ([url, preset, id], _, onCleanup) => {
    enhancedUrl.value = '';
    imgBroken.value = false;
    let stale = false;
    onCleanup(() => {
      stale = true;
    });
    if (typeof window === 'undefined' || typeof window.Image !== 'function') return;
    void getEnhancedMap(url, preset, { material: resolveMapToneMaterial(id) })
      .then((image) => {
        if (stale) return;
        if (image instanceof HTMLCanvasElement) {
          try {
            enhancedUrl.value = image.toDataURL();
          } catch {
            enhancedUrl.value = '';
          }
        }
      })
      .catch(() => {
        if (!stale) imgBroken.value = true;
      });
  },
  { immediate: true },
);

watch(mapId, () => {
  updateBoardMetrics();
});

onMounted(() => {
  unsubMap = onActiveMapChange((nextId) => {
    if (!practicing() && nextId !== mapId.value) {
      applyMapChange(nextId, false);
    }
  });
  const latest = getActiveMapId();
  if (latest !== mapId.value) applyMapChange(latest, false);
  updateBoardMetrics();
  const targetEl = clipEl.value ?? wrapEl.value;
  if (typeof ResizeObserver !== 'undefined' && targetEl) {
    resizeObs = new ResizeObserver(() => updateBoardMetrics());
    resizeObs.observe(targetEl);
  }
});

onBeforeUnmount(() => {
  resizeObs?.disconnect();
  unsubMap?.();
});

defineExpose({
  mapId,
  hunterIdx,
  survCells,
  myAltCell,
  markAltMode,
  prediction,
  topLayouts,
});
</script>

<template>
  <div class="pil-main sp-main">
    <div class="pil-topbar dark fr cut sp-topbar">
      <MapPresetSwitch />

      <div class="pil-title-block">
        <select
          class="sel"
          :value="mapId"
          data-test="predict-map-select"
          aria-label="选择预测地图"
          @change="onMapSelectChange"
        >
          <option v-for="m in MAPS_DATA" :key="m.mapId" :value="m.mapId">
            {{ m.mapName }}
          </option>
        </select>
      </div>

      <button
        type="button"
        class="gbtn fr cut sm sp-hunter-btn"
        :class="{ on: hunterIdx >= 0 }"
        data-test="btn-predict-hunter"
        @click="hunterModalOpen = true"
      >
        <span class="sp-hunter-btn-av" :class="{ seal: hunterIdx < 0 }">
          <img :src="hunterPortrait" :alt="hunterDisplayName" />
        </span>
        <span class="sp-hunter-btn-name">{{ hunterDisplayName }}</span>
        <span class="sp-hunter-btn-count">{{ prediction.totalPool }}局</span>
      </button>

      <div class="pil-bar-right sp-bar-actions">
        <button
          type="button"
          class="gbtn fr cut sm sp-alt-toggle"
          :class="{ on: markAltMode }"
          :aria-pressed="markAltMode"
          data-test="btn-predict-mark-alt"
          @click="toggleMarkAltMode"
        >
          标备选 (我)
        </button>
        <button
          type="button"
          class="gbtn fr cut sm"
          data-test="btn-predict-random"
          @click="pickRandomRecord"
        >
          🎲 随机实局
        </button>
        <button
          type="button"
          class="gbtn fr cut sm"
          data-test="btn-predict-clear"
          @click="clearSelection"
        >
          清空
        </button>
      </div>
    </div>

    <div v-if="feedbackMsg" class="pil-banner" role="status" data-test="predict-msg">
      {{ feedbackMsg }}
    </div>

    <div ref="wrapEl" class="pil-board-wrap sp-board-wrap">
      <ManorMapFrame
        v-if="frameSupported"
        :style="{
          '--ruler-width': boardWidth * 40 / currentMap.widthM + 40 + 'px',
          '--compass-right': frameMetrics.compassRight + 'px',
          '--compass-top': frameMetrics.compassTop + 'px',
        }"
        :px-per-meter="boardWidth / currentMap.widthM"
        :north-angle="0"
        :safe-inset="{ left: frameMetrics.scaleLeft, top: frameMetrics.compassTop, bottom: frameMetrics.scaleBottom }"
      />

      <div ref="clipEl" class="pil-viewport-clip">
        <div
          class="sp-board-stage"
          data-test="spawn-predict-board"
          :data-map-name="mapName"
          :style="{
            left: `${boardLeft}px`,
            top: `${boardTop}px`,
            width: `${boardWidth}px`,
            height: `${boardHeight}px`,
          }"
        >
          <img
            v-if="!imgBroken"
            class="sp-map-img"
            :src="enhancedUrl || rawMapUrl"
            :alt="`${mapName} 开局网格底图`"
            :data-map-preset="visualPreset"
            @error="imgBroken = true"
          />
          <div v-else class="pil-img-fallback">
            {{ mapName }} 线框模式（区域仍可点选）
          </div>

          <div class="sp-geo-layer">
            <button
              v-for="cell in geoCells"
              :key="cell.cellId"
              type="button"
              class="sp-cell"
              :class="{
                surv: cell.isSurv,
                best: cell.isBest,
                alt: cell.altRank !== null,
                'my-alt': cell.isAltMark,
              }"
              :data-predict-cell="cell.cellId"
              :aria-pressed="cell.isSurv || cell.isAltMark"
              :title="`${cell.coord} ${cell.zoneName}`"
              :style="cell.style"
              @click="onCellClick(cell.cellId)"
            >
              <span class="sp-cell-coord">{{ cell.coord }}</span>

              <span v-if="cell.isSurv" class="sp-cell-surv-badge">
                求生 {{ cell.survIndex }}
              </span>

              <div
                v-if="cell.isBest"
                class="sp-best-badge"
                data-test="predict-best-badge"
              >
                <span class="sp-best-portrait" :class="{ seal: hunterIdx < 0 }">
                  <img :src="hunterPortrait" :alt="hunterDisplayName" />
                </span>
                <span class="sp-best-caption">首选 {{ cell.pctInt }}%</span>
              </div>

              <span v-else-if="cell.altRank !== null" class="sp-alt-badge">
                候补 {{ cell.pctInt }}%
              </span>

              <span v-if="cell.showHeatReadout" class="sp-cell-stat" :class="{ zero: cell.prob <= 0 }">
                {{ cell.pctInt }}% · {{ cell.rawCount }}局
              </span>

              <span v-if="cell.isAltMark" class="sp-my-alt-chip" data-test="predict-my-alt-marker">
                我
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="pil-action-bar dark fr cut sp-action-bar">
      <div class="pil-legend">
        <span class="pil-legend-item"><i class="pil-lg-dot surv"></i>求生已选 {{ survCells.length }}/4</span>
        <span class="pil-legend-item"><i class="pil-lg-dot hunt"></i>预测监管首选</span>
        <span class="pil-legend-item"><i class="pil-lg-dot lock"></i>候补 / 备选 (我)</span>
      </div>
      <span class="sp-action-note">
        {{ markAltMode ? '当前点击空闲格：标记/取消个人预判「我」' : '点击网格选 4 名求生者，自动推算监管出生概率' }}
      </span>
    </div>
  </div>

  <aside v-show="folioOpen" id="predict-folio" class="folio-stack">
    <ManorOrnaments kind="clip" />
    <div class="pil-right paper-folio folio-inner sp-folio-inner">
      <header class="pil-case-title">
        <small>{{ currentMap.mapNameEn.toUpperCase() }} · SPAWN PREDICTOR</small>
        <h2>{{ currentMap.mapName }} · 开局预测</h2>
        <em>{{ currentMap.mapNameEn }} — Opening Spawn Predictor</em>
        <ManorOrnaments kind="stage" stage="04" />
      </header>

      <!-- Top-6 Common Layouts -->
      <section class="card sp-card" data-test="predict-top-layouts">
        <h3 class="ribbon-h">常见求生布局 <small>Top-6 Layouts</small></h3>
        <div v-if="topLayouts.length" class="sp-layouts-grid">
          <button
            v-for="preset in topLayouts"
            :key="preset.key"
            type="button"
            class="sp-layout-btn"
            :class="{ active: activeLayoutKey === preset.key }"
            :data-layout-key="preset.key"
            :title="`点击套用求生布局：${preset.cells.map(formatCellCoord).join(' ')}（${preset.count} 局）`"
            @click="applyLayoutPreset(preset)"
          >
            <span
              class="sp-mini-grid"
              :style="{ gridTemplateColumns: `repeat(${mapCols}, 1fr)` }"
              aria-hidden="true"
            >
              <i
                v-for="slot in miniGridSlots"
                :key="slot.id"
                class="sp-mini-cell"
                :class="{
                  empty: !slot.valid,
                  surv: slot.valid && preset.cells.includes(slot.id),
                  hunt: slot.valid && preset.topHunterCell === slot.id,
                }"
              ></i>
            </span>
            <span class="sp-layout-count">{{ preset.count }} 局</span>
          </button>
        </div>
        <div v-else class="sp-empty-note">
          <span>该监管在 {{ mapName }} 暂无历史对局样本。</span>
          <button type="button" class="sp-inline-btn" @click="hunterIdx = -1">切换为不限监管</button>
        </div>
      </section>

      <!-- Prediction Verdict Card + Linkage CTAs -->
      <section class="card sp-card" data-test="predict-verdict-card">
        <h3 class="ribbon-h">监管者出生预测 <small>Verdict</small></h3>

        <template v-if="prediction.status === 'ok' && prediction.best">
          <div class="sp-verdict-meta">
            <span
              class="sp-mode-badge"
              :class="prediction.mode === 'exact' ? 'exact' : 'fuzzy'"
              data-test="predict-mode-badge"
            >
              {{ prediction.mode === 'exact' ? `精确匹配 · ${prediction.exactCount} 局` : `近似推算 · ${prediction.usedCount} 局` }}
            </span>
            <span class="sp-pool-note">筛选池 {{ prediction.totalPool }} 局</span>
          </div>

          <div class="sp-best-row">
            <span class="sp-best-row-av" :class="{ seal: hunterIdx < 0 }">
              <img :src="hunterPortrait" :alt="hunterDisplayName" />
            </span>
            <div class="sp-best-row-main">
              <div class="sp-best-row-title">
                <strong data-test="predict-best-coord">{{ prediction.best.coord }}</strong>
                <span data-test="predict-best-zone">{{ prediction.best.zoneName }}</span>
              </div>
              <small>{{ hunterDisplayName }} · 命中样本 {{ prediction.best.rawCount }} 局</small>
            </div>
            <div class="sp-best-row-pct num" data-test="predict-best-pct">
              {{ prediction.best.pct.toFixed(1) }}%
            </div>
          </div>

          <div v-if="prediction.alts.length" class="sp-alts-list">
            <div v-for="(alt, idx) in prediction.alts" :key="alt.cellId" class="sp-alt-row">
              <span class="sp-alt-rank">候补 {{ idx + 2 }}</span>
              <span class="sp-alt-name">{{ alt.coord }} · {{ alt.zoneName }}</span>
              <span class="sp-alt-val num">{{ alt.pct.toFixed(1) }}% · {{ alt.rawCount }}局</span>
            </div>
          </div>

          <div
            v-if="prediction.myAltComparison"
            class="sp-my-alt-diff"
            :class="prediction.myAltComparison.isMatch ? 'match' : 'mismatch'"
            data-test="predict-my-alt-diff"
          >
            <span class="sp-diff-label">我的预判对比</span>
            <template v-if="prediction.myAltComparison.isMatch">
              <strong>✓ 与首选一致</strong>
              <span>{{ prediction.myAltComparison.coord }} · {{ prediction.myAltComparison.pct.toFixed(1) }}%</span>
            </template>
            <template v-else>
              <span>
                <s>{{ prediction.myAltComparison.coord }}</s>
                {{ prediction.myAltComparison.pct.toFixed(1) }}%
              </span>
              <small>首选 {{ prediction.best.coord }} {{ prediction.best.pct.toFixed(1) }}%</small>
            </template>
          </div>
        </template>

        <template v-else-if="prediction.status === 'need-4'">
          <p class="sp-verdict-prompt">
            请在左侧地图点选 <strong>4</strong> 个求生者出生格（当前 {{ survCells.length }} / 4），或直接点击上方常见布局 / 随机实局。
          </p>
          <div
            v-if="prediction.myAltComparison"
            class="sp-my-alt-diff pending"
            data-test="predict-my-alt-diff"
          >
            <span class="sp-diff-label">我的预判对比</span>
            <span>已标备选 (我) {{ prediction.myAltComparison.coord }} · 选满 4 名求生后对比</span>
          </div>
        </template>

        <template v-else>
          <p class="sp-verdict-prompt">
            当前地图与监管组合暂无可用的空闲格预测样本（总池 {{ prediction.totalPool }} 局）。
          </p>
        </template>

        <div class="sp-cta-group">
          <button
            type="button"
            class="btn-primary sp-cta-btn"
            data-test="btn-predict-to-lock"
            :disabled="!canTransfer"
            @click="transferToLockAnalysis"
          >
            带入封禁分析
          </button>
          <button
            type="button"
            class="btn-ghost sp-cta-btn"
            data-test="btn-predict-to-sandbox"
            :disabled="!canSendSandbox"
            @click="sendToTacticalSandbox"
          >
            发送到战术沙盘
          </button>
        </div>

        <button
          v-if="canImportFromReplay"
          type="button"
          class="btn-ghost sp-cta-replay"
          data-test="btn-predict-from-replay"
          @click="importFromCurrentReplay"
        >
          从当前录像带入
        </button>
      </section>

      <!-- Top-20 Matched Historical Games -->
      <section class="card sp-card">
        <h3 class="ribbon-h">匹配实局记录 <small>Top {{ prediction.matchedRecords.length }}</small></h3>
        <div class="sp-records-wrap" data-test="predict-records-table">
          <table v-if="prediction.matchedRecords.length" class="sp-records-table">
            <thead>
              <tr>
                <th class="col-h">监管</th>
                <th class="col-s">求生点位</th>
                <th class="col-hc">监管格</th>
                <th class="col-src">来源</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(rec, idx) in prediction.matchedRecords"
                :key="`${rec.hunterIdx}-${rec.filename}-${idx}`"
                class="sp-rec-row"
                tabindex="0"
                :title="`点击套用本局求生点位：${rec.filename}`"
                @click="loadMatchedRecord(rec)"
                @keydown.enter.prevent="loadMatchedRecord(rec)"
                @keydown.space.prevent="loadMatchedRecord(rec)"
              >
                <td class="col-h">
                  <span class="sp-rec-hunter">
                    <img
                      :src="predictHunterPortraitUrl(rec.hunterIdx)"
                      :alt="rec.hunterName"
                      loading="lazy"
                    />
                    <span>{{ rec.hunterName }}</span>
                  </span>
                </td>
                <td class="col-s num">
                  {{ rec.survCells.map(formatCellCoord).join(' ') }}
                </td>
                <td class="col-hc num">
                  {{ formatCellCoord(rec.hunterCell) }}
                </td>
                <td class="col-src">
                  <span class="sp-src-tag" :class="rec.sourceType">
                    {{ rec.sourceType === 'solo' ? '本人录像' : '实局观战' }}
                  </span>
                  <span v-if="rec.reviewed" class="sp-rev-tag">已审核</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="sp-empty-note">选满 4 个求生者点位后，将展示最匹配的 Top-20 历史实局记录。</p>
        </div>
      </section>
    </div>
  </aside>

  <SpawnHunterModal
    v-if="hunterModalOpen"
    :map-id="mapId"
    :selected-idx="hunterIdx"
    @select="onSelectHunter"
    @close="hunterModalOpen = false"
  />
</template>
