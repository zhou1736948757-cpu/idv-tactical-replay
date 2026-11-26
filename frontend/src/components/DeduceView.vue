<script setup lang="ts">
import { autoEnabled, applyReplayLink, flow, openPracticeDraft, rememberManual, practicing, sharedCipherGroup, tacticalLink } from '@/store/flow';
import { focusTime, setStep, store } from '@/store/app';
import { formatClock } from '@/lib/format';
import PracticeHud from './flow/PracticeHud.vue';
import PracticeRevealCard from './flow/PracticeRevealCard.vue';
import NextStepCta from './flow/NextStepCta.vue';
import { VISUAL_PRESETS } from '@idv/replay-renderer';
import { getEnhancedMap, resolveMapToneMaterial, useMapPreset } from '@/lib/mapTone';
import MapPresetSwitch from './tactical/MapPresetSwitch.vue';
import { useFolio } from './tactical/useFolio';
import ManorMapFrame from './tactical/ManorMapFrame.vue';
import ManorOrnaments from './tactical/ManorOrnaments.vue';

const { visualPreset } = useMapPreset();
const { folioOpen, toggleFolio } = useFolio();
folioOpen.value = !flow.prefs.rightDrawerCollapsed;
watch(folioOpen, (open) => { flow.prefs.rightDrawerCollapsed = !open; });

import { computed, onBeforeUnmount, onMounted, ref, useId, watch, type CSSProperties } from 'vue';
import '@/styles/pil-views.css';
import {
  DED_LEGEND,
  MAPS_DATA,
  deduce,
  getActiveMapId,
  loadDeduceMarks,
  markKind,
  onActiveMapChange,
  posName,
  resolvePilMapId,
  saveDeduceMarks,
  setActiveMapId,
  type DeduceMarksState,
  type DeductionStep,
  type PilMapId,
} from '@/tactical';

const mapId = ref<PilMapId>(getActiveMapId());
const marks = ref<DeduceMarksState>(readMarks(mapId.value));
const selectedStep = ref<number | null>(null);
const layoutView = ref<number | null>(null);

const glowId = `${useId()}-gold-glow`;
const matrixEl = ref<HTMLElement | null>(null);
const wrapEl = ref<HTMLDivElement | null>(null);
const boardWidth = ref<number>(0);
const boardHeight = ref<number>(0);
const boxWidth = ref<number>(MAPS_DATA[mapId.value]!.deduction.mapSize[0]);
const boxHeight = ref<number>(MAPS_DATA[mapId.value]!.deduction.mapSize[1]);
const imgBroken = ref(false);

let resizeObs: ResizeObserver | null = null;
let unsubMap: (() => void) | null = null;

const frameSupported = typeof ResizeObserver !== 'undefined';
const currentMap = computed(() => MAPS_DATA[mapId.value]!);
const dedData = computed(() => currentMap.value.deduction);
const deduceResult = computed(() => deduce(dedData.value, marks.value));

const totalCiphers = computed(() => dedData.value.configs[0]?.length ?? 7);
const yesCount = computed(() => deduceResult.value.state.filter((s) => s === 'yes').length);
const isUniquelyLocked = computed(
  () => !deduceResult.value.contradiction && deduceResult.value.candidates.length === 1,
);

const enhancedUrl = ref('');
watch([() => currentMap.value.mapImage, visualPreset, mapId], ([url, preset, id], _, onCleanup) => {
  enhancedUrl.value = '';
  let stale = false;
  onCleanup(() => { stale = true; });
  void getEnhancedMap(url, preset, { material: resolveMapToneMaterial(id) }).then((image) => {
    if (!stale && image instanceof HTMLCanvasElement) enhancedUrl.value = image.toDataURL();
  }).catch(() => { /* original image reports any load error */ });
}, { immediate: true });

const gridImageStyle = computed<CSSProperties>(() => {
  const gp = currentMap.value.gridPlacement;
  const [mw, mh] = dedData.value.mapSize;
  const rw = gp.maxX - gp.minX;
  const rh = gp.maxY - gp.minY;
  const q = gp.rotationQuadrants;
  const opacity = visualPreset.value === 'clarity' ? 1 : VISUAL_PRESETS[visualPreset.value].underlay.opacity;
  if (q === 1 || q === 3) {
    const cx = (gp.minX + gp.maxX) / 2;
    const cy = (gp.minY + gp.maxY) / 2;
    return {
      opacity,
      left: `${(cx / mw) * 100}%`,
      top: `${(cy / mh) * 100}%`,
      width: `${(rh / mw) * 100}%`,
      height: `${(rw / mh) * 100}%`,
      transform: `translate(-50%, -50%) rotate(${q * 90}deg)`,
    };
  }
  return {
    opacity,
    left: `${(gp.minX / mw) * 100}%`,
    top: `${(gp.minY / mh) * 100}%`,
    width: `${(rw / mw) * 100}%`,
    height: `${(rh / mh) * 100}%`,
    transform: q === 2 ? 'rotate(180deg)' : 'none',
  };
});

const activeScope = computed(() => {
  if (selectedStep.value === null) return null;
  return deduceResult.value.steps[selectedStep.value]?.scope ?? null;
});

const chainPointsAttr = computed<string | null>(() => {
  const scope = activeScope.value;
  if (!scope || (scope.kind !== 'chain' && scope.kind !== 'chainThree') || scope.positions.length < 2) {
    return null;
  }
  const pts = scope.positions
    .map((id) => dedData.value.ciphers[id]?.location)
    .filter((loc): loc is [number, number] => Boolean(loc))
    .map((loc) => `${loc[0]},${loc[1]}`);
  if (scope.cyclic && pts.length > 0) pts.push(pts[0]!);
  return pts.join(' ');
});

const circleScopeIds = computed<number[]>(() => {
  const scope = activeScope.value;
  return scope && scope.kind === 'circle' ? scope.positions : [];
});

const samePairs = computed(() => {
  const res = deduceResult.value;
  const scope = activeScope.value;
  if (scope && (scope.kind === 'chain' || scope.kind === 'chainThree')) return [];
  const pairs = dedData.value.rules
    .filter((r) => r.kind === 'same' && r.positions.length === 2)
    .map((r) => {
      const a = r.positions[0]!;
      const b = r.positions[1]!;
      const pa = dedData.value.ciphers[a]?.location;
      const pb = dedData.value.ciphers[b]?.location;
      if (!pa || !pb) return null;
      const determined = layoutView.value !== null || res.state[a] !== null || res.state[b] !== null;
      const highlighted = Boolean(
        scope && scope.kind === 'circle' && scope.positions.length === 2
        && scope.positions.includes(a) && scope.positions.includes(b),
      );
      if (!determined && !highlighted) return null;
      return {
        key: `${a}-${b}`,
        a,
        b,
        label: `${String(a + 1).padStart(2, '0')} / ${String(b + 1).padStart(2, '0')}`,
        x1: pa[0],
        y1: pa[1],
        x2: pb[0],
        y2: pb[1],
        highlighted,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (scope && scope.kind === 'circle') {
    const matched = pairs.filter((p) => p.highlighted);
    return matched.length ? matched : [];
  }
  return pairs;
});

const dedFrameMetrics = computed(() => {
  const [mw, mh] = dedData.value.mapSize;
  const gp = currentMap.value.gridPlacement;
  const bw = boardWidth.value || boxWidth.value;
  const bh = boardHeight.value || boxHeight.value;
  const s = boxWidth.value / mw;
  const originX = (bw - boxWidth.value) / 2;
  const originY = (bh - boxHeight.value) / 2;
  const mapLeft = originX + gp.minX * s;
  const mapTop = originY + gp.minY * s;
  const mapRight = originX + gp.maxX * s;
  const mapBottom = originY + gp.maxY * s;
  const showSideLegend = mapLeft >= 86;
  const railCenter = folioOpen.value ? mapLeft / 2 : mapLeft - 49;
  const compassLeft = showSideLegend ? Math.max(8, Math.round(railCenter - 32)) : 12;
  const compassTop = showSideLegend ? 32 : Math.max(12, Math.round(mapTop + 8));
  const legendLeft = Math.max(6, Math.round(railCenter - 39));
  const legendTop = compassTop + 78;
  const scaleLeft = Math.max(12, Math.round(mapLeft));
  const scaleBottom = 40;
  return {
    showSideLegend,
    compassLeft,
    compassTop,
    legendLeft,
    legendTop,
    scaleLeft,
    scaleBottom,
    mapLeft,
    mapRight,
    mapBottom,
  };
});

function markerPosStyle(id: number): CSSProperties {
  const [mw, mh] = dedData.value.mapSize;
  const pos = dedData.value.ciphers[id];
  if (!pos) return {};
  return {
    left: `${(pos.location[0] / mw) * 100}%`,
    top: `${(pos.location[1] / mh) * 100}%`,
  };
}

type BadgeSide = 'below' | 'above' | 'right' | 'left';
type Rect4 = [number, number, number, number];

function rectsOverlap(a: Rect4, b: Rect4, pad = 2): boolean {
  return a[0] < b[2] + pad && a[2] + pad > b[0] && a[1] < b[3] + pad && a[3] + pad > b[1];
}

// Keep every numbered ring and status plaque at 0 px^2 overlap across all 9 maps & viewports.
const badgePlacements = computed<BadgeSide[]>(() => {
  const { ciphers, mapSize: [mw, mh] } = dedData.value;
  const w = boxWidth.value;
  const h = boxHeight.value;
  const centers = ciphers.map(({ location: [x, y] }) => [(x / mw) * w, (y / mh) * h] as const);
  const rings: Rect4[] = centers.map(([cx, cy]) => [cx - 22, cy - 22, cx + 22, cy + 22]);
  const placed: Rect4[] = [];
  const sides: BadgeSide[] = [];

  for (let i = 0; i < centers.length; i++) {
    const [cx, cy] = centers[i]!;
    const candidates: Array<{ side: BadgeSide; box: Rect4 }> = [
      { side: 'below', box: [cx - 27, cy + 20, cx + 27, cy + 40] },
      { side: 'above', box: [cx - 27, cy - 40, cx + 27, cy - 20] },
      { side: 'right', box: [cx + 22, cy - 10, cx + 76, cy + 10] },
      { side: 'left', box: [cx - 76, cy - 10, cx - 22, cy + 10] },
    ];
    let bestSide: BadgeSide = 'below';
    let bestBox = candidates[0]!.box;
    let bestScore = Infinity;

    for (let idx = 0; idx < candidates.length; idx++) {
      const cand = candidates[idx]!;
      let hits = 0;
      for (let j = 0; j < rings.length; j++) {
        if (j !== i && rectsOverlap(cand.box, rings[j]!, 2)) hits += 100;
      }
      for (const prev of placed) {
        if (rectsOverlap(cand.box, prev, 2)) hits += 100;
      }
      if (cand.box[0] < 0 || cand.box[2] > w || cand.box[1] < 0 || cand.box[3] > h) hits += 10;
      const score = hits + idx;
      if (score < bestScore) {
        bestScore = score;
        bestSide = cand.side;
        bestBox = cand.box;
        if (hits === 0) break;
      }
    }
    sides.push(bestSide);
    placed.push(bestBox);
  }
  return sides;
});

function pointSourceTag(id: number): string {
  if (dedData.value.ciphers[id]?.locked) return '地图固定';
  if (layoutView.value !== null) return '布局预览';
  if (marks.value[id]) return '我的标记';
  return deduceResult.value.state[id] !== null ? '规则推演' : '待标记';
}

function markerInfo(id: number): {
  kind: string;
  icon: 'lock' | 'bolt' | 'cross' | '';
  stateText: string;
} {
  const pos = dedData.value.ciphers[id]!;
  const res = deduceResult.value;
  const eff =
    layoutView.value !== null
      ? dedData.value.configs[layoutView.value]!.includes(id)
        ? 'yes'
        : 'no'
      : res.state[id]!;
  const [kind, icon, stateText] = markKind(pos, eff, res.marks[id]);
  return { kind, icon, stateText: stateText.replace(/^(标记|推断)[：:]\s*/, (_, source) => source === '推断' ? '推断' : '') };
}

function pointReason(id: number): string {
  if (dedData.value.ciphers[id]?.locked) return '地图固定必刷点';
  if (layoutView.value !== null) return `第 ${layoutView.value + 1} 组布局预览`;
  if (marks.value[id]) return '手动标记';
  const source = deduceResult.value.sources[id];
  return (source != null && deduceResult.value.steps[source - 1]?.rule) || '尚无确定依据';
}

function readMarks(id: PilMapId): DeduceMarksState {
  if (practicing()) return { ...flow.draftMarks };
  const replayMarks = tacticalLink(id)?.marks;
  if (replayMarks) return { ...replayMarks };
  const marks = loadDeduceMarks(id);
  const group = MAPS_DATA[id]!.cipherCombinations[sharedCipherGroup(id) ?? -1];
  if (!group || Object.keys(marks).length) return marks;
  MAPS_DATA[id]!.deduction.ciphers.forEach((cipher, index) => {
    if (!cipher.locked) marks[index] = group.includes(cipher.id) ? 'yes' : 'no';
  });
  return marks;
}

const linkAvailable = computed(() => autoEnabled() && !practicing() && !flow.dismissedLink && flow.link?.mapId === mapId.value);
const nextCipher = computed(() => {
  if ((!autoEnabled() && !practicing()) || flow.mode === 'revealed') return null;
  const groups = dedData.value.configs.filter((group) => Object.entries(marks.value)
    .every(([index, mark]) => group.includes(Number(index)) === (mark === 'yes')));
  let best = 0;
  let id: number | null = null;
  dedData.value.ciphers.forEach((cipher, index) => {
    if (cipher.locked || marks.value[index] !== undefined) return;
    const yes = groups.filter((group) => group.includes(index)).length;
    const gain = Math.min(yes, groups.length - yes);
    if (gain > best) { best = gain; id = index; }
  });
  return id;
});

function keepManual(): void {
  flow.dismissedLink = true;
  rememberManual(mapId.value, {});
  marks.value = readMarks(mapId.value);
}

function storeMarks(next: DeduceMarksState): void {
  if (flow.mode === 'blind') { flow.draftMarks = next; return; }
  if (practicing()) return;
  const result = deduce(dedData.value, next);
  const groupIndex = result.contradiction ? null : currentMap.value.cipherCombinations.findIndex((group) =>
    dedData.value.ciphers.every((cipher, index) => group.includes(cipher.id) === (result.state[index] === 'yes')));
  rememberManual(mapId.value, { marks: next, groupIndex: groupIndex === -1 ? null : groupIndex }, groupIndex !== null && groupIndex >= 0 ? 'deduce' : 'manual');
  saveDeduceMarks(mapId.value, next);
}

function comparison(id: string): string | null {
  if (flow.mode !== 'revealed' || !flow.reveal) return null;
  const { truth, attempt } = flow.reveal;
  const predicted = attempt.cipherIds ?? currentMap.value.cipherCombinations[attempt.groupIndex] ?? [];
  if (truth.matchedCipherIds.includes(id)) return predicted.includes(id) ? '✓ 命中' : '✗ 漏判';
  return predicted.includes(id) ? '! 误判' : null;
}

watch(() => [flow.linkRevision, autoEnabled()], () => { marks.value = readMarks(mapId.value); });

function applyMapState(nextId: PilMapId): void {
  mapId.value = nextId;
  marks.value = readMarks(nextId);
  selectedStep.value = null;
  layoutView.value = null;
  imgBroken.value = false;
  updateBoxSize();
}

function onSelectMap(idInput: number | string): void {
  if (practicing()) return;
  const next = setActiveMapId(resolvePilMapId(idInput));
  if (next !== mapId.value) applyMapState(next);
}

function reviewPhase(start: number): void {
  setStep(2);
  focusTime(start);
}

function onMapSelectChange(e: Event): void {
  onSelectMap(Number((e.target as HTMLSelectElement).value));
}

function toggleDedMark(id: number): void {
  if (flow.mode === 'revealed') return;
  const pos = dedData.value.ciphers[id];
  if (!pos || pos.locked) return;
  layoutView.value = null;
  selectedStep.value = null;
  const next: DeduceMarksState = { ...marks.value };
  const cur = next[id];
  if (cur === undefined) next[id] = 'yes';
  else if (cur === 'yes') next[id] = 'no';
  else delete next[id];
  marks.value = next;
  storeMarks(next);
}

function resetMarks(): void {
  if (flow.mode === 'revealed') return;
  marks.value = {};
  selectedStep.value = null;
  layoutView.value = null;
  storeMarks({});
}

function toggleStep(idx: number): void {
  selectedStep.value = selectedStep.value === idx ? null : idx;
}

function setLayoutView(idx: number | null): void {
  layoutView.value = idx;
  selectedStep.value = null;
}

function toggleLayoutView(ci: number): void {
  layoutView.value = layoutView.value === ci ? null : ci;
  selectedStep.value = null;
}

function isLayoutExcluded(ci: number): boolean {
  const res = deduceResult.value;
  return Boolean(res.contradiction) || !res.candidates.includes(ci);
}

function isLayoutUnique(ci: number): boolean {
  const res = deduceResult.value;
  return !res.contradiction && res.candidates.length === 1 && res.candidates[0] === ci;
}

function layoutChipClass(cipherIdx: number): string {
  const res = deduceResult.value;
  const userMark = res.marks[cipherIdx];
  const s = res.state[cipherIdx];
  if (userMark === 'yes') return 'm-yes';
  if (userMark === 'no') return 'm-no';
  if (s === 'yes') return 'i-yes';
  if (s === 'no') return 'i-no';
  return '';
}

function splitDedRule(step: DeductionStep): { kind: string; rest: string | null } {
  const sep = step.rule.indexOf(' · ');
  return sep > 0
    ? { kind: step.rule.slice(0, sep), rest: step.rule.slice(sep + 3) }
    : { kind: step.rule, rest: step.detail || null };
}

function updateBoxSize(): void {
  const [mw, mh] = dedData.value.mapSize;
  const el = wrapEl.value;
  const rect = el?.getBoundingClientRect();
  const rawW = rect && rect.width > 16 ? rect.width : (el?.clientWidth ?? 0);
  const rawH = rect && rect.height > 16 ? rect.height : (el?.clientHeight ?? 0);
  const hasBox = Boolean(el && rawW > 16 && rawH > 16);
  boardWidth.value = hasBox ? rawW : mw;
  boardHeight.value = hasBox ? rawH : mh;
  const availW = hasBox ? rawW - 6 : mw;
  const availH = hasBox ? rawH - 6 : mh;
  const scale = Math.min(availW / mw, availH / mh);
  boxWidth.value = Math.max(1, mw * scale);
  boxHeight.value = Math.max(1, mh * scale);
}

watch(mapId, () => {
  imgBroken.value = false;
  updateBoxSize();
});

onMounted(() => {
  unsubMap = onActiveMapChange((nextId) => {
    if (nextId !== mapId.value) applyMapState(nextId);
  });
  const latest = getActiveMapId();
  if (latest !== mapId.value) applyMapState(latest);
  updateBoxSize();
  if (typeof ResizeObserver !== 'undefined' && wrapEl.value) {
    resizeObs = new ResizeObserver(() => updateBoxSize());
    resizeObs.observe(wrapEl.value);
  }
});

onBeforeUnmount(() => {
  resizeObs?.disconnect();
  unsubMap?.();
});

defineExpose({ mapId, marks, deduceResult, selectedStep, layoutView, toggleDedMark });
</script>

<template>
  <div id="deduceView" class="pil-stage" :class="{ 'ded-dimmed': Boolean(deduceResult.contradiction), 'folio-closed': !folioOpen }">
    <div class="pil-main">
      <div class="pil-topbar dark fr cut">
        <MapPresetSwitch />
        <div class="pil-title-block">
          <select
            class="sel"
            :value="mapId"
            data-test="deduce-map-select" :disabled="practicing()"
            aria-label="选择地图"
            @change="onMapSelectChange"
          >
            <option v-for="m in MAPS_DATA" :key="m.mapId" :value="m.mapId">
              {{ m.mapName }}
            </option>
          </select>
          <span class="pil-map-en">{{ currentMap.mapNameEn }}</span>
        </div>

        <div
          class="ded-conclusion"
          :class="{
            bad: Boolean(deduceResult.contradiction),
            gold: !deduceResult.contradiction && (layoutView !== null || isUniquelyLocked),
          }"
          data-test="deduce-conclusion"
        >
          <template v-if="deduceResult.contradiction">矛盾 · 不存在该布局</template>
          <template v-else-if="layoutView !== null">第 {{ layoutView + 1 }} 组密码机</template>
          <template v-else-if="isUniquelyLocked">第 {{ deduceResult.candidates[0]! + 1 }} 组密码机</template>
          <template v-else>
            待定<small> · 剩余 {{ deduceResult.candidates.length }} / {{ dedData.configs.length }} 组</small>
          </template>
        </div>

        <div class="pil-bar-right">
          <button type="button" class="gbtn fr cut sm" data-test="deduce-reset" @click="resetMarks">
            ⟲ 重置标记
          </button>
        </div>

      </div>

      <div v-if="linkAvailable" class="pil-banner" data-test="deduce-link">
        录像密码机联动
        <button class="gbtn" @click="applyReplayLink(true)">应用高亮</button>
        <button class="gbtn" @click="keepManual">保留手动</button>
      </div>
      <div v-if="deduceResult.contradiction" class="pil-banner" role="alert" data-test="deduce-alert">
        <strong>标记相互矛盾：</strong>
        <span>{{ deduceResult.contradiction }}</span>
      </div>

      <div ref="wrapEl" class="pil-board-wrap">
        <ManorMapFrame
          v-if="frameSupported"
          :style="{
            '--ruler-width': boxWidth * 40 / currentMap.widthM + 40 + 'px',
            '--ded-compass-left': dedFrameMetrics.compassLeft + 'px',
            '--ded-compass-top': dedFrameMetrics.compassTop + 'px',
          }"
          :px-per-meter="boxWidth / currentMap.widthM"
          :north-angle="currentMap.gridPlacement.rotationQuadrants * 90"
          :safe-inset="{ left: dedFrameMetrics.scaleLeft, top: dedFrameMetrics.compassTop, bottom: dedFrameMetrics.scaleBottom }"
        />
        <aside
          v-if="frameSupported && dedFrameMetrics.showSideLegend"
          class="ded-side-legend"
          :style="{ left: `${dedFrameMetrics.legendLeft}px`, top: `${dedFrameMetrics.legendTop}px` }"
          aria-hidden="true"
        >
          <span class="ded-side-title">图例</span>
          <div class="ded-side-item">
            <span class="ded-side-icon locked">锁</span>
            <span>必刷</span>
          </div>
          <div class="ded-side-item">
            <span class="ded-side-icon user-yes">有</span>
            <span>有</span>
          </div>
          <div class="ded-side-item">
            <span class="ded-side-icon inf-yes">推</span>
            <span>推断有</span>
          </div>
          <div class="ded-side-item">
            <span class="ded-side-icon user-no">无</span>
            <span>无</span>
          </div>
          <div class="ded-side-item">
            <span class="ded-side-icon inf-no">推</span>
            <span>推断无</span>
          </div>
          <div class="ded-side-item">
            <span class="ded-side-icon unknown"></span>
            <span>未知</span>
          </div>
        </aside>
        <div
          v-if="samePairs.length > 0"
          class="ded-same-caption"
          :style="{ right: `${Math.max(14, Math.round((boardWidth || boxWidth) - dedFrameMetrics.mapRight + 6))}px` }"
          aria-hidden="true"
        >
          <i class="ded-same-swatch"></i>
          <span>同生共死</span>
          <b class="num">{{ samePairs.map((p) => p.label).join('  ') }}</b>
        </div>
        <div
          class="pil-aspect-frame"
          data-test="deduce-map"
          :style="{
            width: `${boxWidth}px`,
            height: `${boxHeight}px`,
            aspectRatio: `${dedData.mapSize[0]} / ${dedData.mapSize[1]}`,
          }"
        >
          <img
            v-show="!imgBroken"
            class="ded-map-img"
            :data-map-preset="visualPreset"
            :src="enhancedUrl || currentMap.mapImage"
            :alt="currentMap.mapName"
            :style="gridImageStyle"
            :data-rot-quadrants="currentMap.gridPlacement.rotationQuadrants"
            draggable="false"
            @error="imgBroken = true"
          />
          <div v-if="imgBroken" class="pil-img-fallback">{{ currentMap.mapName }}</div>

          <svg
            class="ded-chain-svg"
            :viewBox="`0 0 ${dedData.mapSize[0]} ${dedData.mapSize[1]}`"
            aria-hidden="true"
          >
            <defs>
              <filter :id="glowId" x="-25%" y="-25%" width="150%" height="150%">
                <feGaussianBlur stdDeviation="3.4" />
              </filter>
            </defs>
            <g v-for="pair in samePairs" :key="pair.key" class="cond-pair-group" :class="{ highlighted: pair.highlighted }">
              <line
                class="cond-pair-glow"
                :x1="pair.x1" :y1="pair.y1" :x2="pair.x2" :y2="pair.y2"
                fill="none" stroke="#ffbe44" stroke-opacity="0.48" stroke-width="11" stroke-dasharray="11 6"
                stroke-linecap="round" vector-effect="non-scaling-stroke" :filter="`url(#${glowId})`"
              />
              <line
                class="cond-pair-halo"
                :x1="pair.x1" :y1="pair.y1" :x2="pair.x2" :y2="pair.y2"
                fill="none" stroke="#3c230f" stroke-width="8" stroke-dasharray="11 6"
                stroke-linecap="round" vector-effect="non-scaling-stroke"
              />
              <line
                class="cond-pair-line"
                :x1="pair.x1" :y1="pair.y1" :x2="pair.x2" :y2="pair.y2"
                fill="none" stroke="#ffc654" stroke-width="4.8" stroke-dasharray="11 6"
                stroke-linecap="round" vector-effect="non-scaling-stroke"
              />
              <line
                class="cond-pair-core"
                :x1="pair.x1" :y1="pair.y1" :x2="pair.x2" :y2="pair.y2"
                fill="none" stroke="#fff3b5" stroke-width="1.7" stroke-dasharray="11 6"
                stroke-linecap="round" vector-effect="non-scaling-stroke"
              />
            </g>
            <g v-if="chainPointsAttr" class="chain-line-group">
              <polyline
                class="chain-line-glow"
                :points="chainPointsAttr"
                fill="none" stroke="#ffbe44" stroke-opacity="0.52" stroke-width="11" stroke-dasharray="11 6"
                stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" :filter="`url(#${glowId})`"
              />
              <polyline
                class="chain-line-halo"
                :points="chainPointsAttr"
                fill="none" stroke="#3c230f" stroke-width="8" stroke-dasharray="11 6"
                stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"
              />
              <polyline
                class="chain-line"
                :points="chainPointsAttr"
                fill="none" stroke="#ffc654" stroke-width="4.8" stroke-dasharray="11 6"
                stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"
              />
              <polyline
                class="chain-line-core"
                :points="chainPointsAttr"
                fill="none" stroke="#fff3b5" stroke-width="1.7" stroke-dasharray="11 6"
                stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"
              />
            </g>
          </svg>

          <div class="ded-grid" aria-hidden="true"></div>

          <span
            v-for="id in circleScopeIds"
            :key="`ring-${id}`"
            class="scope-ring"
            :style="markerPosStyle(id)"
            aria-hidden="true"
          ></span>

          <button
            v-for="(pos, id) in dedData.ciphers"
            :key="pos.id"
            type="button"
            class="ded-marker"
            :class="[markerInfo(id).kind, { recommend: id === nextCipher, actual: comparison(pos.id) && comparison(pos.id) !== '! 误判' }]"
            :disabled="Boolean(pos.locked)"
            :data-cipher-idx="id"
            :data-cipher-name="pos.name"
            :style="markerPosStyle(id)"
            :title="`${pos.name}·${markerInfo(id).stateText}`"
            :aria-label="`${pos.name}，${markerInfo(id).stateText}`"
            @click="toggleDedMark(id)"
          >
            <span class="ded-marker-circle">
              <svg v-if="pos.locked" class="guaranteed-lock" viewBox="0 0 16 18" aria-hidden="true">
                <path d="M4 8V6a4 4 0 1 1 8 0v2" fill="none" stroke="currentColor" stroke-width="2" />
                <rect x="2" y="8" width="12" height="9" rx="2" fill="currentColor" />
              </svg>
              <ManorOrnaments kind="typewriter" />
              <b class="ded-marker-number num">{{ String(id + 1).padStart(2, '0') }}</b>
            </span>
            <span
              class="ded-marker-label"
              :class="{
                'badge-above': badgePlacements[id] === 'above',
                'badge-left': badgePlacements[id] === 'left',
                'badge-right': badgePlacements[id] === 'right',
              }"
            >{{ markerInfo(id).kind === 'unknown' ? '未知' : markerInfo(id).stateText }}
              <b v-if="comparison(pos.id)" class="comparison" data-test="practice-cipher-diff">{{ comparison(pos.id) }}</b>
            </span>
          </button>
        </div>
      </div>

      <div class="pil-action-bar dark fr cut">
        <div class="pil-legend">
          <span v-for="item in DED_LEGEND" :key="item.dot" class="pil-legend-item">
            <i class="ded-lg-dot" :class="item.dot"></i>{{ item.label }}
          </span>
          <span class="pil-legend-item"><i class="ded-lg-dot lg-lock"></i>必刷</span>
          <span class="pil-legend-item"><i class="ded-lg-dot lg-unknown"></i>未知</span>
        </div>
        <NextStepCta v-if="linkAvailable" :step="2" label="返回实况 → 02" />
        <NextStepCta v-if="practicing()" :step="4" label="返回选点 → 04" />
        <span class="muted">点击点位循环：未知 → 有机 → 无机 → 取消</span>
      </div>
    </div>

    <button type="button" class="folio-toggle" data-test="folio-toggle" aria-controls="deduce-folio" :aria-expanded="folioOpen"
      :aria-label="folioOpen ? '收起卷宗' : '展开卷宗'" title="卷宗（]）" @click="toggleFolio">{{ folioOpen ? '›' : '‹' }}</button>
    <aside v-show="folioOpen" id="deduce-folio" class="folio-stack">
      <ManorOrnaments kind="clip" />
      <div class="pil-right paper-folio folio-inner">
        <header class="pil-case-title">
          <small>OLETUS MANOR · CIPHER LAYOUT DEDUCTION</small>
          <h2>{{ currentMap.mapName }} · 密码机推演</h2>
          <em>{{ currentMap.mapNameEn }} — Cipher Layout Deduction</em>
          <ManorOrnaments kind="stage" stage="05" />
        </header>
        <h3 v-if="flow.mode === 'blind'" class="ribbon-h">盲练开局 <small>Blind Practice</small></h3>
        <PracticeHud />
        <nav v-if="flow.mode === 'blind'" class="folio-phases" aria-label="盲练阶段">
          <button class="phase-plate opening" @click="openPracticeDraft">开局草稿</button>
          <button class="phase-plate midgame" @click="matrixEl?.focus()">候选矩阵</button>
          <button class="phase-plate endgame" @click="setStep(4)">返回锁定</button>
        </nav>

        <PracticeRevealCard />
        <div class="ded-progress-band">
          <h3 class="ribbon-h">推演进度 <small>Progress</small></h3>
          <div class="ded-progress" data-test="deduce-progress" title="已确定密码机">
            <span class="ded-progress-bars">
              <i v-for="n in totalCiphers" :key="n" :class="{ on: n <= yesCount }"></i>
            </span>
            <span class="ded-progress-num num">
              {{ yesCount }}<small> / {{ totalCiphers }}</small>
            </span>
          </div>
        </div>
        <div class="card" data-test="deduce-steps">
          <h3 class="ribbon-h">推演步骤 <small>Deduction Steps</small></h3>
          <p v-if="deduceResult.steps.length === 0" class="muted" style="line-height: 1.6">
            {{ dedData.emptyHint }}
          </p>
          <ol v-else class="ded-steps">
            <li
              v-for="(step, i) in deduceResult.steps"
              :key="i"
              class="ded-step"
              :class="{ active: selectedStep === i }"
            >
              <button
                type="button"
                class="ded-step-btn"
                :data-step-idx="i"
                :aria-pressed="selectedStep === i"
                @click="toggleStep(i)"
              >
                <span class="ded-step-num">{{ String(i + 1).padStart(2, '0') }}</span>
                <span class="ded-step-body">
                  <span class="ded-step-rule">
                    <span class="ded-step-kind">{{ splitDedRule(step).kind }}</span>
                    <span v-if="splitDedRule(step).rest" class="ded-step-rest">{{ splitDedRule(step).rest }}</span>
                  </span>
                  <p class="ded-step-result">
                    推断：
                    <template v-for="(c, j) in step.conclusions" :key="c.id">
                      <span v-if="j > 0">，</span>
                      <span :class="c.value === 'yes' ? 'c-yes' : 'c-no'">
                        {{ posName(dedData, c.id) }} {{ c.value === 'yes' ? '有' : '无' }}
                      </span>
                    </template>
                  </p>
                </span>
              </button>
            </li>
          </ol>
        </div>

        <section ref="matrixEl" class="card ded-matrix" tabindex="-1">
          <h3 class="ribbon-h">候选布局矩阵 <small>Candidate Matrix</small></h3>
          <div class="ded-matrix-head" data-test="deduce-matrix-head">
            <span>编号</span>
            <span>点位名称</span>
            <span>位置状态</span>
            <span>判定来源</span>
          </div>
          <details v-for="(pos, id) in dedData.ciphers" :key="pos.id">
            <summary>
              <i>{{ String(id + 1).padStart(2, '0') }}</i>
              <span class="matrix-name">{{ pos.name }}</span>
              <b :class="markerInfo(id).kind"><svg v-if="pos.locked" class="matrix-lock-ico" viewBox="0 0 12 14" aria-hidden="true"><path d="M3 6V4.4a3 3 0 1 1 6 0V6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /><rect x="1.8" y="6" width="8.4" height="6.6" rx="1.2" fill="currentColor" /><circle cx="6" cy="9.2" r="1" fill="#4f3110" /></svg>{{ markerInfo(id).stateText }}</b>
              <small class="matrix-src">{{ pointSourceTag(id) }}</small>
            </summary>
            <p>{{ pointReason(id) }}</p>
          </details>
          <div class="ded-folio-legend" data-test="deduce-status-legend">
            <span class="ded-fl-heading">
              <b>状态图例</b>
              <small>Legend</small>
            </span>
            <div class="ded-fl-items">
              <span class="ded-fl-item">
                <i class="ded-fl-dot locked" aria-hidden="true"></i>
                <span class="ded-fl-text"><b>必刷</b><small>Must Spawn</small></span>
              </span>
              <span class="ded-fl-item">
                <i class="ded-fl-dot user-yes" aria-hidden="true"></i>
                <span class="ded-fl-text"><b>有</b><small>Present</small></span>
              </span>
              <span class="ded-fl-item">
                <i class="ded-fl-dot inf-yes" aria-hidden="true"></i>
                <span class="ded-fl-text"><b>推断有</b><small>Inferred</small></span>
              </span>
              <span class="ded-fl-item">
                <i class="ded-fl-dot user-no" aria-hidden="true"></i>
                <span class="ded-fl-text"><b>无</b><small>Absent</small></span>
              </span>
            </div>
          </div>
        </section>
        <details open class="card" data-test="deduce-layouts">
          <summary class="k">候选密码机布局</summary>
          <div class="ded-layouts">
            <button
              type="button"
              class="ded-layout-btn ded-layout-all"
              :class="{ active: layoutView === null }"
              data-test="deduce-layout-all"
              @click="setLayoutView(null)"
            >
              全部布局（实时推演）
            </button>
            <button
              v-for="(cfg, ci) in dedData.configs"
              :key="ci"
              type="button"
              class="ded-layout-btn"
              :class="{ excluded: isLayoutExcluded(ci), active: layoutView === ci }"
              :data-layout-idx="ci"
              @click="toggleLayoutView(ci)"
            >
              <span class="ded-layout-badge" :class="{ unique: isLayoutUnique(ci) }">第{{ ci + 1 }}组</span>
              <span class="ded-layout-names" :style="{ gridTemplateColumns: `repeat(${cfg.length}, minmax(0, 1fr))` }">
                <span v-for="p in cfg" :key="p" :class="layoutChipClass(p)">{{ posName(dedData, p) }}</span>
              </span>
            </button>
          </div>
        </details>

        <details class="card" data-test="deduce-rules">
          <summary class="k">规律速查</summary>
          <p v-if="currentMap.fixedHint" class="pil-hint-line" style="margin-bottom: 8px">{{ currentMap.fixedHint }}</p>
          <ul class="ded-rules-list">
            <li v-for="(r, idx) in dedData.ruleBook" :key="idx">
              <span class="rule-title">{{ r.title }}</span>
              <span v-if="r.text" class="rule-text"> — {{ r.text }}</span>
            </li>
          </ul>
        </details>
        <nav v-if="!practicing() && store.analytics && store.replay?.match.map_name === currentMap.mapName && store.analytics.match_id === store.selectedId"
          class="folio-phases" aria-label="按阶段回看对局">
          <button v-for="phase in store.analytics.phases" :key="phase.phase_id" class="phase-plate"
            :class="phase.phase_id" @click="reviewPhase(phase.start_t)">
            <b>{{ phase.label_zh }}</b><small>{{ formatClock(phase.start_t) }}</small>
          </button>
        </nav>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.ded-conclusion small, .ded-progress-num small { font-size: 12px; }
.recommend .ded-marker-circle { outline: 2px solid #ffd877; animation: suggest-cipher 1.8s infinite alternate; }
.actual .ded-marker-circle { outline: 3px solid #ffd877; }
.comparison { margin-inline: 4px; color: #ffdc87; }
@keyframes suggest-cipher { to { box-shadow: 0 0 0 6px #ffdc8790; } }
@media (prefers-reduced-motion: reduce) { .recommend .ded-marker-circle { animation: none; } }
</style>
