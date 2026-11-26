<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ManorOrnaments from './components/tactical/ManorOrnaments.vue';
import ArchiveView from './components/ArchiveView.vue';
import SandboxView from './components/SandboxView.vue';
import AnalyticsView from './components/AnalyticsView.vue';
import NoticeDialog from './components/NoticeDialog.vue';
import '@/styles/manor.css';
import '@/styles/dossier-theme.css';
import '@/styles/pil-views.css';
import './styles/dossier-views.css';
import { canEnterStep, goBack, loadMatches, selectedSummary, setStep, store, type StepId } from './store/app';
import {
  autoEnabled,
  flow,
  importFiles,
  openEntry,
  readHashRegionSubmode,
  saveFlowPrefs,
  setRegionSubmode,
  suspendDirector,
  tacticalLink,
} from './store/flow';
import { useMapPreset } from './lib/mapTone';
import GlobalDropOverlay from './components/flow/GlobalDropOverlay.vue';
import FlowToast from './components/flow/FlowToast.vue';
import { modeShort } from './lib/format';
import {
  MAPS_DATA,
  getActiveMapId,
  onActiveMapChange,
  resolvePilMapId,
  setActiveMapId,
  type PilMapId,
} from '@/tactical';

const RegionView = defineAsyncComponent(() => import('./components/RegionView.vue'));
const DeduceView = defineAsyncComponent(() => import('./components/DeduceView.vue'));

type PreloadableAsyncComp = { __asyncLoader?: () => Promise<unknown> };
function preloadStepView(stepId: StepId): void {
  const map: Partial<Record<StepId, PreloadableAsyncComp>> = {
    4: RegionView as unknown as PreloadableAsyncComp,
    5: DeduceView as unknown as PreloadableAsyncComp,
  };
  void map[stepId]?.__asyncLoader?.();
}
function warmStepViews(): void {
  preloadStepView(4);
  preloadStepView(5);
}

const STEPS: ReadonlyArray<{ id: StepId; label: string; en: string; icon: string }> = [
  { id: 1, label: '档案库', en: 'Match Archive', icon: 'M3 5h18v5H3z M4 10h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M9 7.5h6 M9 14h6' },
  { id: 2, label: '战术沙盘', en: 'Tactical Sandbox', icon: 'M12 1.5v3m0 15v3M1.5 12h3m15 0h3 M12 4.5a7.5 7.5 0 1 0 .01 0 M15.8 8.2l-2.3 5.3-5.3 2.3 2.3-5.3z' },
  { id: 3, label: '对比分析', en: 'Match Review', icon: 'M12 2.5v18m-5.5 1h11 M3.5 6.5h17 M6 6.5l-3.5 7.5h7L6 6.5zm12 0-3.5 7.5h7z' },
  { id: 4, label: '区域选点', en: 'Spawn Region', icon: 'M12 21.5s7.5-8.2 7.5-13a7.5 7.5 0 0 0-15 0c0 4.8 7.5 13 7.5 13z M12 5.5a3 3 0 1 0 .01 0' },
  { id: 5, label: '密码机推演', en: 'Cipher Deduction', icon: 'M6 3.5h12v6.5H6z M4 10h16l2 8.5H2z M7 13h1m3 0h1m3 0h1m-9 3h10 M3.5 21h17' },
];

const BOOKMARK_SUBTITLES = ['Archive', 'Atlas', 'Analysis', 'Region', 'Cipher'] as const;

const activeMapId = ref<PilMapId>(getActiveMapId());
let unsubMapChange: (() => void) | null = null;

const ctxLabel = computed(() => {
  const m = selectedSummary();
  if (store.step === 4 || store.step === 5 || (store.step === 2 && !m)) {
    const name = MAPS_DATA[activeMapId.value]!.mapName;
    if (flow.mode === 'blind') return name + ' · 高手盲练中';
    void flow.linkRevision;
    const linked = tacticalLink(activeMapId.value);
    return linked?.groupIndex == null ? name + ' · 战术演练' : name + ' · 录像联动 · 第 ' + (linked.groupIndex + 1) + ' 组';
  }
  if (!m) return '';
  return `${m.map_name} · ${modeShort(m)} · ${m.save_time_utc8}`;
});

const sandboxMapName = ref('');
const bookmark = computed(() => {
  if (store.step === 1 || store.step === 3) return STEPS[store.step - 1]!.label;
  if (store.step === 2) return sandboxMapName.value;
  return MAPS_DATA[activeMapId.value]!.mapName;
});
const deskCompassAngle = computed(() => {
  if (store.step === 1 || store.step === 3) return -18;
  return MAPS_DATA[activeMapId.value]?.mapName === '永眠镇' ? 90 : 0;
});
const settingsOpen = ref(false);
const dragDepth = ref(0);
const stageEl = ref<HTMLElement | null>(null);

function dispatchMapFitReset(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('idv-map-fit-reset'));
}

function onStageClick(e: MouseEvent): void {
  const target = e.target as Element | null;
  if (!target) return;
  if (target.closest('[data-test="btn-reset"], [data-test="btn-switch-whiteboard"], [data-test="btn-switch-replay"], .mode-pills button')) {
    dispatchMapFitReset();
  }
}

watch(() => [store.step, store.selectedId, store.replay, activeMapId.value] as const, dispatchMapFitReset, { flush: 'post' });

const { visualPreset, setPreset } = useMapPreset();
setPreset(flow.prefs.visualPreset);
watch(visualPreset, (preset) => { flow.prefs.visualPreset = preset; });
watch(() => flow.prefs, saveFlowPrefs, { deep: true });

function toggleAuto(): void {
  flow.prefs.autoFlow = !autoEnabled();
  flow.manualOverride = false;
  if (!autoEnabled()) suspendDirector();
}

async function submit(files: File[], practice = false, legacyTopbar = false): Promise<void> {
  if (!files.length) return;
  try {
    await importFiles(files, { entryPath: practice ? 'practice' : undefined, legacyTopbar });
  } catch (error) {
    flow.toast = error instanceof Error ? error.message : String(error);
  }
}

function onBarFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  void submit(files, false, true);
}

function onDrag(event: DragEvent): void {
  if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
  event.preventDefault();
  if (event.type === 'dragenter') dragDepth.value++;
  if (event.type === 'dragleave') dragDepth.value = Math.max(0, dragDepth.value - 1);
  if (event.type === 'drop') {
    dragDepth.value = 0;
    void submit(Array.from(event.dataTransfer?.files ?? []), event.shiftKey);
  }
}
const dragEvents = ['dragenter', 'dragover', 'dragleave', 'drop'] as const;

function stepClass(id: StepId): Record<string, boolean> {
  return { on: store.step === id, done: store.step > id && canEnterStep(id), lock: !canEnterStep(id) };
}

function parseStepParam(raw: string | null): StepId | null {
  const n = Number(raw);
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5 ? n : null;
}

type DeepLink =
  | { kind: 'match'; id: string; step: StepId; t?: number; practice: boolean; manual: boolean; mapId: PilMapId | null }
  | { kind: 'standalone'; step: StepId; mapId: PilMapId | null };

/**
 * Deep link:
 * - `#m=<match_id>&s=<1..5>&t=<seconds>` opens a match directly.
 * - `#s=<2|4|5>&map=<0..8>` opens standalone tactical views directly.
 */
function readDeepLink(): DeepLink | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const id = params.get('m');
  const stepParam = parseStepParam(params.get('s'));
  const mapParam = params.get('map');
  const mapId = mapParam !== null && mapParam.trim() !== '' ? resolvePilMapId(mapParam) : null;
  if (id && /^[0-9a-f]{24}$/i.test(id)) {
    const t = Number(params.get('t'));
    return {
      kind: 'match',
      id,
      step: stepParam ?? 2,
      t: params.has('t') && Number.isFinite(t) ? Math.max(0, t) : undefined,
      practice: params.get('mode') === 'practice',
      manual: params.get('auto') === '0',
      mapId,
    };
  }
  if (stepParam && stepParam !== 3) {
    return { kind: 'standalone', step: stepParam, mapId };
  }
  if (mapId !== null) {
    return { kind: 'standalone', step: 4, mapId };
  }
  return null;
}

let incomingTime: number | undefined;
let incomingMatch: string | null = null;
let lastWrittenHash = '';
watch(
  () => [store.selectedId, store.step, activeMapId.value, flow.mode, flow.manualOverride] as const,
  ([id, step, mapId]) => {
    if (typeof window === 'undefined' || !window.history?.replaceState) return;
    let hash = '';
    if (id) {
      hash = `#m=${id}&s=${step}`;
    } else if (step === 2 || step === 4 || step === 5) {
      hash = `#s=${step}&map=${mapId}`;
    }
    if (id && flow.mode === 'blind') hash += '&mode=practice';
    if (id && flow.manualOverride) hash += '&auto=0';
    if (id && id === incomingMatch && step === 2 && incomingTime !== undefined) hash += '&t=' + incomingTime;
    else incomingTime = undefined;
    if (window.location.hash !== hash) {
      lastWrittenHash = hash;
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
  },
);

function applyCurrentHash(): void {
  if (window.location.hash === lastWrittenHash && lastWrittenHash !== '') return;
  const link = readDeepLink();
  if (link?.kind === 'match') {
    if (link.mapId !== null) setActiveMapId(link.mapId);
    incomingTime = link.t;
    incomingMatch = link.id;
    void openEntry(link.id, link.practice ? 'practice' : 'sandbox', { step: link.step, t: link.t, manual: link.manual });
  } else if (link?.kind === 'standalone') {
    if (link.mapId !== null) setActiveMapId(link.mapId);
    setStep(link.step);
  } else if (!window.location.hash) {
    setStep(1);
  }
}

function onWindowKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && settingsOpen.value) {
    settingsOpen.value = false;
  }
}

function onWindowPointerDown(e: PointerEvent): void {
  if (!settingsOpen.value) return;
  const target = e.target as HTMLElement | null;
  if (!target?.closest?.('.flow-settings')) {
    settingsOpen.value = false;
  }
}

onMounted(() => {
  unsubMapChange = onActiveMapChange((id) => {
    activeMapId.value = id;
  });
  activeMapId.value = getActiveMapId();
  dragEvents.forEach((name) => window.addEventListener(name, onDrag));
  window.addEventListener('hashchange', applyCurrentHash);
  window.addEventListener('keydown', onWindowKeyDown);
  window.addEventListener('pointerdown', onWindowPointerDown);
  stageEl.value?.addEventListener('click', onStageClick, true);
  void loadMatches();
  applyCurrentHash();
  // Idle-warm lazy step chunks after first paint without blocking Stage 01
  if (typeof window !== 'undefined' && typeof (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback === 'function') {
    (window as Window & { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(() => warmStepViews());
  }
});

onBeforeUnmount(() => {
  unsubMapChange?.();
  dragEvents.forEach((name) => window.removeEventListener(name, onDrag));
  window.removeEventListener('hashchange', applyCurrentHash);
  window.removeEventListener('keydown', onWindowKeyDown);
  window.removeEventListener('pointerdown', onWindowPointerDown);
  stageEl.value?.removeEventListener('click', onStageClick, true);
});
</script>

<template>
  <div id="app">
    <header id="bar">
      <button id="backBtn" aria-label="返回" :disabled="store.step === 1" @click="goBack">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M15 4 7 12l8 8" /></svg>
      </button>
      <div class="ttl" tabindex="0" :title="ctxLabel || '庄园战术复盘档案'">
        <span class="identity">第五人格<i>V</i><small>IDENTITY V</small></span>
        <span class="archive-brand">庄园战术复盘档案<small>Oletus Manor · Dossiers</small></span>
        <span class="manor-vista" aria-hidden="true"></span>
        <span id="ctx">{{ ctxLabel }}</span>
      </div>
      <nav id="steps" aria-label="复盘阶段">
        <button
          v-for="s in STEPS"
          :key="s.id"
          :data-step="s.id"
          :aria-current="store.step === s.id ? 'step' : undefined"
          :class="stepClass(s.id)"
          :title="canEnterStep(s.id) ? `${s.label} / ${s.en}` : '请先在档案库选择对局'"
          @click="setStep(s.id)"
        >
          <svg class="step-icon" viewBox="0 0 24 24" aria-hidden="true"><path :d="s.icon" /></svg>
          <span class="step-copy">
            <span class="step-title">{{ s.label }}</span>
            <small>{{ s.en }}</small>
          </span>
        </button>
      </nav>

      <div class="flow-settings">
        <button class="gbtn fr cut" data-test="flow-settings" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen">⚙ 设置 · {{ autoEnabled() ? '自动' : '手动' }}</button>
        <div v-if="settingsOpen" class="flow-preferences dark fr cut">
          <div class="pref-quick-actions">
            <label id="uploadBtn" class="gbtn fr cut" :class="{ on: flow.uploading }" title="上传 .zip 录像">
              {{ flow.uploading ? '解析中…' : '导入录像' }}
              <input type="file" multiple accept=".zip,application/zip" :disabled="flow.uploading" @change="onBarFile($event); settingsOpen = false" />
            </label>
            <button type="button" class="gbtn fr cut" id="noticeBtn" aria-label="须知" @click="store.noticeOpen = true; settingsOpen = false">须知 · 图例</button>
          </div>
          <div class="pref-divider" aria-hidden="true" />
          <button class="gbtn" data-test="flow-toggle-auto" @click="toggleAuto">{{ autoEnabled() ? '切换手动模式' : '开启自动流程' }}</button>
          <label><input v-model="flow.prefs.autoOpenAfterUpload" type="checkbox" />投递后自动打开</label>
          <label><input v-model="flow.prefs.director" type="checkbox" />智能导播</label>
          <label><input v-model="flow.prefs.autoLinkTactics" type="checkbox" />联动选点与推演</label>
          <label>投递入口 <select v-model="flow.prefs.defaultEntryPath" class="sel"><option value="sandbox">实况复盘</option><option value="practice">盲练开局</option><option value="ask">留在档案库</option></select></label>
          <label>开局定位 <select v-model="flow.prefs.cue" class="sel"><option value="opening-fast">快进至首追</option><option value="first-chase">跳至首追</option><option value="none">不自动播放</option></select></label>
          <label>播完 <select v-model="flow.prefs.endAction" class="sel"><option value="banner">显示总结</option><option value="auto-analytics">进入对比分析</option><option value="off">停在结尾</option></select></label>
          <label><input v-model="flow.prefs.regionAutoSwitchCamp" type="checkbox" />选满求生者后切换阵营</label>
          <label>地图 <select class="sel" :value="visualPreset" @change="setPreset(($event.target as HTMLSelectElement).value as typeof visualPreset)">
            <option value="clarity">清晰彩色</option><option value="original">原图</option><option value="dossier">旧卷宗</option>
          </select></label>
        </div>
      </div>
    </header>

    <main id="stage" ref="stageEl" :data-page="store.step">
      <div class="desk-still" aria-hidden="true">
        <div class="bookmark" aria-hidden="true">
          <svg class="bookmark-rig" viewBox="0 0 68 76" aria-hidden="true" focusable="false">
            <defs>
              <linearGradient id="bm-cord" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#f2d69b" />
                <stop offset="52%" stop-color="#b68746" />
                <stop offset="100%" stop-color="#6b4821" />
              </linearGradient>
              <radialGradient id="bm-grommet" cx="35%" cy="30%" r="72%">
                <stop offset="0%" stop-color="#fff0be" />
                <stop offset="48%" stop-color="#c99b53" />
                <stop offset="85%" stop-color="#765023" />
                <stop offset="100%" stop-color="#4e3214" />
              </radialGradient>
            </defs>
            <!-- Organic curved twine cord loop rising from grommet to topbar -->
            <path d="M32 61 C26 42, 24 14, 39 5 C53 -3, 64 18, 52 44 C47 54, 41 59, 36 61" fill="none" stroke="#3c2511" stroke-width="3.4" stroke-linecap="round" opacity="0.62" />
            <path d="M32 61 C26 42, 24 14, 39 5 C53 -3, 64 18, 52 44 C47 54, 41 59, 36 61" fill="none" stroke="url(#bm-cord)" stroke-width="2" stroke-linecap="round" />
            <path d="M34 61 C30 41, 31 18, 42 10 C51 4, 57 20, 48 42" fill="none" stroke="#f7dfa5" stroke-width="0.95" stroke-linecap="round" opacity="0.72" />
            <!-- Reinforced brass eyelet grommet -->
            <circle cx="34" cy="61" r="8.4" fill="url(#bm-grommet)" stroke="#5b3b18" stroke-width="1.15" />
            <circle cx="34" cy="61" r="6.3" fill="none" stroke="#fff0bf" stroke-width="0.85" opacity="0.72" />
            <circle cx="34" cy="61" r="4.1" fill="#1b1510" stroke="#4d3214" stroke-width="1" />
            <!-- Double twine wrap knot over top of eyelet -->
            <path d="M31.2 55.6 C32 49.8, 36 49.8, 36.8 55.6" fill="none" stroke="url(#bm-cord)" stroke-width="2.6" stroke-linecap="round" />
            <path d="M30.5 53.2 h7" fill="none" stroke="#6c4921" stroke-width="1.1" stroke-linecap="round" opacity="0.8" />
          </svg>
          <svg class="bookmark-plate" viewBox="0 0 88 260" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <defs>
              <linearGradient id="bm-vellum" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#f5e3be" />
                <stop offset="48%" stop-color="#e7cda0" />
                <stop offset="100%" stop-color="#d2b07a" />
              </linearGradient>
              <radialGradient id="bm-vignette" cx="50%" cy="42%" r="66%">
                <stop offset="38%" stop-color="#fff9ea" stop-opacity="0.34" />
                <stop offset="100%" stop-color="#7c5020" stop-opacity="0.38" />
              </radialGradient>
            </defs>
            <!-- Chamfered archival luggage tag silhouette -->
            <polygon points="18,2 70,2 86,20 86,257 2,257 2,20" fill="url(#bm-vellum)" stroke="#886133" stroke-width="2" stroke-linejoin="round" />
            <polygon points="18,2 70,2 86,20 86,257 2,257 2,20" fill="url(#bm-vignette)" />
            <!-- Recessed double hairline inner border following beveled shoulders -->
            <polygon points="20,6 68,6 81,22 81,252 7,252 7,22" fill="none" stroke="#99723d" stroke-width="1.2" opacity="0.86" />
            <polygon points="21.5,9 66.5,9 78,23.5 78,249 10,249 10,23.5" fill="none" stroke="#b69057" stroke-width="0.75" opacity="0.72" />
            <!-- Delicate inner corner engraving curls -->
            <path d="M12 24l4-4 4 4M68 24l4-4 4 4M12 246l5 0 0-5M76 246l-5 0 0-5" fill="none" stroke="#8f6736" stroke-width="0.9" opacity="0.75" />
            <!-- Subtle divider above bottom seal -->
            <line x1="16" y1="196" x2="72" y2="196" stroke="#99723d" stroke-width="0.9" opacity="0.68" />
            <path d="M44 194l2.2 2-2.2 2-2.2-2z" fill="#8f6736" opacity="0.75" />
          </svg>
          <span class="bookmark-ink">{{ bookmark }}</span>
          <small>{{ BOOKMARK_SUBTITLES[store.step - 1] }}</small>
          <ManorOrnaments kind="seal" hunter />
        </div>
        <div class="desk-compass" data-test="desk-compass" aria-hidden="true">
          <svg viewBox="0 0 120 136" aria-hidden="true" focusable="false">
            <defs>
              <linearGradient id="dc-brass" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#fff0c0" />
                <stop offset="28%" stop-color="#dfb468" />
                <stop offset="68%" stop-color="#9b6e32" />
                <stop offset="100%" stop-color="#533513" />
              </linearGradient>
              <linearGradient id="dc-rim" x1="100%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#f7dca0" />
                <stop offset="50%" stop-color="#8b612a" />
                <stop offset="100%" stop-color="#3e260e" />
              </linearGradient>
              <radialGradient id="dc-dial" cx="46%" cy="42%" r="58%">
                <stop offset="0%" stop-color="#2a2219" />
                <stop offset="62%" stop-color="#17120d" />
                <stop offset="100%" stop-color="#0d0a07" />
              </radialGradient>
              <linearGradient id="dc-glass" x1="15%" y1="8%" x2="80%" y2="85%">
                <stop offset="0%" stop-color="#fff7e0" stop-opacity="0.22" />
                <stop offset="42%" stop-color="#fff7e0" stop-opacity="0.04" />
                <stop offset="100%" stop-color="#000000" stop-opacity="0" />
              </linearGradient>
              <radialGradient id="dc-cap" cx="35%" cy="32%" r="70%">
                <stop offset="0%" stop-color="#fff4cd" />
                <stop offset="55%" stop-color="#c9984c" />
                <stop offset="100%" stop-color="#5e3d17" />
              </radialGradient>
            </defs>
            <!-- Top vintage compass bail ring & knurled crown -->
            <ellipse cx="60" cy="12" rx="11.5" ry="9" fill="none" stroke="url(#dc-brass)" stroke-width="3.2" />
            <ellipse cx="60" cy="12" rx="11.5" ry="9" fill="none" stroke="#472c11" stroke-width="0.75" opacity="0.65" />
            <rect x="53.5" y="18.5" width="13" height="8" rx="2.4" fill="url(#dc-brass)" stroke="#4c3012" stroke-width="1" />
            <path d="M56.5 19.5v6M60 19.5v6M63.5 19.5v6" stroke="#5b3b17" stroke-width="0.85" opacity="0.72" />
            <!-- Outer sculpted antique brass case -->
            <circle cx="60" cy="76" r="53" fill="url(#dc-brass)" stroke="#3e250d" stroke-width="1.6" />
            <circle cx="60" cy="76" r="48.5" fill="url(#dc-rim)" stroke="#fce7b2" stroke-width="0.9" opacity="0.9" />
            <!-- Recessed smoked-obsidian compass dial -->
            <circle cx="60" cy="76" r="44.2" fill="url(#dc-dial)" stroke="#68471f" stroke-width="1.2" />
            <circle cx="60" cy="76" r="41" fill="none" stroke="#c89e5a" stroke-width="0.7" opacity="0.58" />
            <circle cx="60" cy="76" r="32.5" fill="none" stroke="#b58a48" stroke-width="0.65" stroke-dasharray="1.8 2.4" opacity="0.55" />
            <!-- 16-point degree ticks -->
            <g stroke="#d8b06c" stroke-linecap="round" opacity="0.78">
              <path d="M60 35.5v4.5M60 112v4.5M19.5 76h4.5M96 76h4.5" stroke-width="1.4" />
              <path d="M31.4 47.4l3.2 3.2M85.4 101.4l3.2 3.2M88.6 47.4l-3.2 3.2M34.6 101.4l-3.2 3.2" stroke-width="1.15" />
              <path d="M44.5 38.6l1.4 3.4M74.1 110l1.4 3.4M75.5 38.6l-1.4 3.4M45.9 110l-1.4 3.4M22.6 60.5l3.4 1.4M94 90.1l3.4 1.4M22.6 91.5l3.4-1.4M94 61.9l3.4-1.4" stroke-width="0.85" opacity="0.65" />
            </g>
            <!-- Engraved 8-point mariner's wind rose -->
            <g opacity="0.92">
              <polygon points="60,44 64.5,71.5 60,76" fill="#f1cf88" />
              <polygon points="60,44 55.5,71.5 60,76" fill="#9a6e33" />
              <polygon points="60,108 55.5,80.5 60,76" fill="#d9b26a" />
              <polygon points="60,108 64.5,80.5 60,76" fill="#7a5324" />
              <polygon points="92,76 64.5,71.5 60,76" fill="#e5be76" />
              <polygon points="92,76 64.5,80.5 60,76" fill="#825a28" />
              <polygon points="28,76 55.5,80.5 60,76" fill="#e5be76" />
              <polygon points="28,76 55.5,71.5 60,76" fill="#825a28" />
              <!-- Intercardinal brass star points -->
              <polygon points="81,55 64,73.5 60,76 62.5,72" fill="#c79b55" />
              <polygon points="81,97 62.5,80 60,76 64,78.5" fill="#9b7034" />
              <polygon points="39,97 56,78.5 60,76 57.5,80" fill="#c79b55" />
              <polygon points="39,55 57.5,72 60,76 56,73.5" fill="#9b7034" />
            </g>
            <!-- Crisp vector-engraved cardinal markers (N/E/S/W — zero tiny SVG <text> nodes) -->
            <path d="M57.2 42.2V36.4l5.6 5.8V36.4" fill="none" stroke="#ff7c72" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M98 73.2h-4v5.6h4M94 76h3.2" fill="none" stroke="#f0d394" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M62.4 110.5c-.4-.7-1.4-1-2.4-1-1.3 0-2.2.5-2.2 1.3 0 1.8 4.6 1 4.6 2.8 0 .9-1 1.4-2.4 1.4-1.1 0-2-.3-2.5-1" fill="none" stroke="#f0d394" stroke-width="1.15" stroke-linecap="round" />
            <path d="M21 73.2l1.2 5.6 1.5-3.8 1.5 3.8 1.2-5.6" fill="none" stroke="#f0d394" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" />
            <!-- Rotating dual-tone magnetic compass needle -->
            <g class="desk-compass-needle" :style="{ transform: `rotate(${deskCompassAngle}deg)` }">
              <polygon points="60,42.5 64.2,76 60,76" fill="#e2544b" />
              <polygon points="60,42.5 55.8,76 60,76" fill="#9d201c" />
              <polygon points="60,106.5 63.8,76 60,76" fill="#efe0be" />
              <polygon points="60,106.5 56.2,76 60,76" fill="#9a7846" />
              <circle cx="60" cy="76" r="5.2" fill="url(#dc-cap)" stroke="#472c10" stroke-width="1" />
              <circle cx="60" cy="76" r="1.9" fill="#fff3c8" opacity="0.85" />
            </g>
            <!-- Curved glass dome sheen -->
            <path d="M25 60a38 38 0 0 1 67-10c-13 6-36 10-67 10z" fill="url(#dc-glass)" />
            <circle cx="60" cy="76" r="44.2" fill="none" stroke="#ffeab5" stroke-width="0.6" opacity="0.32" />
          </svg>
        </div>
      </div>
      <section v-if="store.step === 1" class="step show" id="s1"><ArchiveView /></section>
      <section v-if="store.step === 2" class="step show" id="s2"><SandboxView @displayed-map-change="sandboxMapName = $event" /></section>
      <section v-if="store.step === 3" class="step show" id="s3"><AnalyticsView /></section>
      <section v-if="store.step === 4" class="step show" id="s4"><RegionView /></section>
      <section v-if="store.step === 5" class="step show" id="s5"><DeduceView /></section>
    </main>
  </div>
  <NoticeDialog />
  <GlobalDropOverlay :active="dragDepth > 0" :uploading="flow.uploading" />
  <FlowToast :message="flow.toast" @dismiss="flow.toast = ''" />
</template>

<style scoped>
.flow-settings { position: static; flex: none; }
.flow-preferences { position: absolute; z-index: 75; top: calc(100% + 9px); right: 12px; display: grid; gap: 8px; width: max-content; padding: 12px 14px; }
</style>
