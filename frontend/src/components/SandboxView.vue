<script setup lang="ts">
import { autoEnabled, flow, practicing, rememberManual, sharedCipherGroup, suspendDirector } from '@/store/flow';
import { unprojectReplayPoint } from '@/tactical/replay-link';
import DirectorBar from './flow/DirectorBar.vue';
import NextStepCta from './flow/NextStepCta.vue';
import SummaryBanner from './flow/SummaryBanner.vue';
import { VISUAL_PRESETS } from '@idv/replay-renderer';
import { useMapPreset } from '@/lib/mapTone';
import { useFolio } from './tactical/useFolio';
import ManorOrnaments from './tactical/ManorOrnaments.vue';
import { hasScene3D } from '@/tactical/scene3d/calibration3d';
import '@/styles/tactical-sandbox.css';

const MOBILE_DRAWER_PREF_KEY = 'idv.flow.v1.mobileDrawerOpen';
function readMobileDrawerExplicitOpen(): boolean {
  try {
    return (
      globalThis.sessionStorage?.getItem(MOBILE_DRAWER_PREF_KEY) === '1' ||
      globalThis.localStorage?.getItem(MOBILE_DRAWER_PREF_KEY) === '1'
    );
  } catch {
    return false;
  }
}
function isMobileViewportOnMount(): boolean {
  if (typeof window === 'undefined' || window.innerWidth >= 1100) return false;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent) && window.innerWidth === 1024) {
    return false;
  }
  return true;
}

const { folioOpen, toggleFolio } = useFolio();
folioOpen.value = isMobileViewportOnMount()
  ? !flow.prefs.rightDrawerCollapsed && readMobileDrawerExplicitOpen()
  : !flow.prefs.rightDrawerCollapsed;
watch(folioOpen, (open) => {
  flow.prefs.rightDrawerCollapsed = !open;
  if (typeof window !== 'undefined' && window.innerWidth < 1100) {
    try {
      const flag = open ? '1' : '0';
      globalThis.sessionStorage?.setItem(MOBILE_DRAWER_PREF_KEY, flag);
      globalThis.localStorage?.setItem(MOBILE_DRAWER_PREF_KEY, flag);
    } catch {
      /* storage optional */
    }
  }
});
const hudExpanded = ref(false);
const legendSide = ref<'left' | 'right' | null>(null);
const legendOpen = ref(false);
const legendButton = ref<HTMLButtonElement>();
const legendLane = ref<HTMLElement>();
const boardPanelEl = ref<HTMLElement>();
const boardPanelWidth = ref(0);
const mapEdges = ref([0, 1]);
const mapRect = ref<{ left: number; top: number; right: number; bottom: number; width: number; height: number } | null>(null);
const directorBand = ref<HTMLElement>();
const directorHeight = ref(0);
const compactToolsOpen = ref(false);
const compactMoreOpen = ref(false);
const compactToolsBtn = ref<HTMLButtonElement>();
const compactMoreBtn = ref<HTMLButtonElement>();
const compactToolsMenu = ref<HTMLElement>();
const compactMoreMenu = ref<HTMLElement>();
const obstacleVersion = ref(0);
const compactToolbar = computed(() => boardPanelWidth.value > 0 && boardPanelWidth.value < 940);
watch(compactToolbar, (compact) => {
  if (!compact) {
    compactToolsOpen.value = false;
    compactMoreOpen.value = false;
  }
});
watch(legendSide, () => { legendOpen.value = false; });
watch(directorBand, (band, _, onCleanup) => {
  directorHeight.value = band?.offsetHeight ?? 0;
  if (!band || typeof ResizeObserver === 'undefined') return;
  const observer = new ResizeObserver(() => { directorHeight.value = band.offsetHeight; });
  observer.observe(band);
  onCleanup(() => observer.disconnect());
}, { flush: 'post' });
const legendItems = [
  ['求', '求生者', 'Survivor', 'surv'], ['监', '监管者', 'Hunter', 'hunt'],
  ['机', '密码机', 'Cipher', 'ciph'], ['门', '大门', 'Exit Gate', 'gate'], ['┄', '轨迹', 'Trail', 'trail'],
] as const;

const MAP_ENGLISH: Readonly<Record<string, string>> = Object.freeze({
  军工厂: 'Arms Factory',
  红教堂: 'Red Church',
  圣心医院: 'Sacred Heart Hospital',
  湖景村: 'Lakeside Village',
  月亮河公园: 'Moon River Park',
  里奥的回忆: "Leo's Memory",
  永眠镇: 'Eversleeping Town',
  唐人街: 'Chinatown',
  不归林: 'Darkwoods',
});

const TOOL_LABELS: Readonly<Record<BoardToolId, string>> = Object.freeze({
  inspect: '检视',
  place: '放置',
  draw: '绘制',
  measure: '测算',
  range: '范围',
  anim: '动画',
});

const { visualPreset } = useMapPreset();

import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import {
  samplePlayerAtTime,
  sampleCipherAtTime,
  wrapDeg360,
  type FloorId,
  type LayerVisibilityState,
  type PickResult,
  type RulerState,
} from '@idv/replay-renderer';
import {
  MAPS_DATA,
  TAC_ITEM_TYPES,
  TAC_MOVEMENT_SURVIVOR,
  TAC_ROLES,
  animDuration,
  animPositionAt,
  buildStandaloneMapPayload,
  cipherOf,
  computeCarryField,
  computeTideField,
  consumeSandboxBoardHandoff,
  createEmptyBoardState,
  exportBoardJson,
  findNearestBasement,
  getActiveMapId,
  importBoardJson,
  loadBoardState,
  loadNavGrid,
  onActiveMapChange,
  onSandboxBoardHandoff,
  populateEndgameScenario,
  populateOpeningScenario,
  resolveNavEndpoint,
  resolvePilMapId,
  routeBetweenRel,
  saveBoardState,
  setActiveMapId,
  snapToWalkable,
  syncActiveMapByName,
  type AnimData,
  type AnimSpeedEntry,
  type CancellableNavJob,
  type CarryRangeBand,
  type EndgameScenarioKind,
  type ImportBoardResult,
  type MeasureBase,
  type MeasureBuff,
  type NavFieldResult,
  type NavGridData,
  type PilMapId,
  type Point2D,
  type SandboxBoardHandoff,
  type TacticalBoardState,
  type TacticalMeasureLine,
  type TacticalShape,
  type TideRangeBand,
} from '@/tactical';
import TacticalBoardCanvas from './TacticalBoardCanvas.vue';
import DossierPanel from './DossierPanel.vue';
import HunterPop from './HunterPop.vue';
import ViewSettingsPopover from './tactical/ViewSettingsPopover.vue';
import TacticalToolsPanel from './tactical/TacticalToolsPanel.vue';
import TacticalEventFeed from './tactical/TacticalEventFeed.vue';
import TacticalAnimBar from './tactical/TacticalAnimBar.vue';

const Tactical3DCanvas = defineAsyncComponent(() => import('./tactical/Tactical3DCanvas.vue'));
type Tactical3DCanvasHandle = {
  resetView: () => void;
  setCameraMode: (mode: 'overview' | 'roaming') => void;
};
import {
  ANIM_SPEED_PRESETS,
  attachHittingPointToChain,
  autoLinkCreatedItem,
  autoLinkCreatedToken,
  buildBoardGeoContext,
  buildCarryProfileFromRange,
  buildTideProfileFromRange,
  clamp01,
  clampHittingPointToChain,
  cloneBoardState,
  collectBoardChairs,
  computeRangeEvaluation,
  createDefaultLandmarks,
  createDefaultRangeState,
  createMeasureConfig,
  defaultMeasureBase,
  isChainLinkableProp,
  removeHittingPoint,
  syncBloodyQueenMirror,
  type BoardProp,
  type BoardSelection,
  type BoardToken,
  type BoardToolId,
  type DrawShapeKind,
  type MeasureModeId,
  type PlacePending,
  type RangeNavFieldOverlay,
  type RightTabId,
  type UnderlayUiState,
} from '@/lib/board';
import { renderTacticalOverlay, effectiveAnimDuration } from './tactical/overlayRenderer';
import { duration, PLAYBACK_SPEEDS, seek, setSpeed, stepBy, store, togglePlay } from '@/store/app';
import { fearStateLabel, formatClock, hunterPortraitUrl, pidLabel, SEAL_URL } from '@/lib/format';

type FloorFilter = 'ALL' | FloorId;

const MAX_UNDO = 40;

// ------------------------------------------------------------------ view / camera / replay layers
const viewMode = ref<'2d' | '3d'>('2d');
const is3D = computed(() => viewMode.value === '3d');
const pitch = ref(90);
const yaw = ref(0);
const yScale = ref(1);
const floor = ref<FloorFilter>('ALL');
const viewCones = ref(true);
const trails = ref(true);
const dirArrows = ref(true);
const labels = ref(true);

const activeMapId = ref<PilMapId>(getActiveMapId());
const whiteboardOverride = ref(false);
const isDraft = computed(() => flow.mode === 'blind');
const isStandalone = computed(() => isDraft.value || store.replay === null || whiteboardOverride.value);
const emit = defineEmits<{ 'displayed-map-change': [name: string] }>();
const displayedMap = computed(() => isStandalone.value ? MAPS_DATA[activeMapId.value]!.mapName : store.replay?.match.map_name ?? '');
watch(displayedMap, name => emit('displayed-map-change', name), { immediate: true });
const folioSubtitle = computed(() => {
  const en = MAP_ENGLISH[displayedMap.value] ?? 'Oletus Manor';
  const suffix = isDraft.value ? 'Opening Draft' : isStandalone.value ? 'Whiteboard' : 'Tactical Case File';
  return `${en} — ${suffix}`;
});
const folioSerial = computed(() => {
  if (isDraft.value) return '№ DRAFT';
  const mid = !isStandalone.value ? store.replay?.match.match_id : null;
  if (mid && mid.length >= 6) return `№ ${mid.slice(-6).toUpperCase()}`;
  return `№ ATLAS-${String(activeMapId.value + 1).padStart(2, '0')}`;
});
const folioSerialTitle = computed(() => {
  if (isDraft.value) return '盲练开局草稿（不公开对局编号）';
  const mid = !isStandalone.value ? store.replay?.match.match_id : null;
  if (mid) return `公开对局标识：${mid}`;
  return `白板地图索引：${displayedMap.value}`;
});
const rightRailWidthPx = computed(() => {
  const mr = mapRect.value;
  if (!mr || boardPanelWidth.value <= 0) return 0;
  return Math.max(0, boardPanelWidth.value - mr.right);
});
const railInsetRightPx = computed(() => {
  if (legendSide.value !== 'right') return 12;
  const rw = rightRailWidthPx.value;
  if (rw >= 122 && rw <= 265) return Math.max(6, Math.round((rw - 118) / 2));
  return 12;
});
const mapIntrudesLeftProp = computed(() => {
  if (folioOpen.value || boardPanelWidth.value < 1600 || !mapRect.value) return false;
  return mapRect.value.left < 126;
});
const mapIntrudesRightProp = computed(() => {
  if (folioOpen.value || boardPanelWidth.value < 1600 || !mapRect.value) return false;
  return boardPanelWidth.value - mapRect.value.right < 184;
});
const liveCiphers = computed(() => isStandalone.value ? [] : store.replay?.entities.ciphers ?? []);
const completedCiphers = computed(() => liveCiphers.value.filter(c => sampleCipherAtTime(c, store.t).isCompleted).length);
const showGhost = ref(true);

const underlay = reactive<UnderlayUiState>({
  enabled: true,
  opacity: VISUAL_PRESETS[visualPreset.value].underlay.opacity,
  rotationQuadrants: isStandalone.value
    ? (MAPS_DATA[activeMapId.value]?.gridPlacement.rotationQuadrants ?? 0)
    : 0,
  flipX: false,
  flipZ: false,
});
watch(visualPreset, (preset) => { underlay.opacity = VISUAL_PRESETS[preset].underlay.opacity; }, { flush: 'sync' });
const underlayStatus = ref<'none' | 'loading' | 'ok' | 'missing'>('none');
const rulerMode = ref(false);
const ruler = ref<RulerState | null>(null);
const followUid = ref<number | null>(null);
watch(() => flow.segment, (segment) => {
  if (flow.director === 'running' || flow.mode === 'pro-opening') followUid.value = segment?.followUid ?? null;
}, { immediate: true });
function changeFollow(uid: number | null): void {
  suspendDirector();
  followUid.value = uid;
}
const hunterPopOpen = ref(false);
const board = ref<InstanceType<typeof TacticalBoardCanvas> | null>(null);
const board3d = ref<Tactical3DCanvasHandle | null>(null);

// ------------------------------------------------------------------ Stage 2 tool & popover shell
const activeTool = ref<BoardToolId>('inspect');
const rightTab = ref<RightTabId>('status');
const viewSettingsOpen = ref(false);
const archiveMenuOpen = ref(false);
const landmarks = reactive(createDefaultLandmarks());

// ------------------------------------------------------------------ Board state + Undo + Persistence
function loadEditableBoard(mapId: PilMapId): TacticalBoardState {
  if (isDraft.value && flow.draftBoard) return cloneBoardState(flow.draftBoard);
  return loadBoardState(mapId);
}
const boardState = ref<TacticalBoardState>(loadEditableBoard(activeMapId.value));
const displayBoard = computed(() => {
  const truth = flow.reveal?.truth;
  const draftShapes = flow.draftBoard?.shapes;
  if (flow.mode !== 'pro-opening' || !showGhost.value || !draftShapes?.length || !truth) return boardState.value;
  const [width, height] = MAPS_DATA[truth.mapId]!.mapSize;
  const convert = (x: number, y: number) => {
    const [worldX, worldZ] = unprojectReplayPoint([x * width, y * height], truth.transform);
    return geo.value.worldToRel(worldX, worldZ);
  };
  const ghosts = draftShapes.map((shape) => {
    const a = convert(shape.x1, shape.y1);
    const b = convert(shape.x2, shape.y2);
    return { ...shape, id: -shape.id, color: '#ffe4a78c', dashed: true,
      x1: a.x, y1: a.y, x2: b.x, y2: b.y, points: shape.points?.map((point) => convert(point.x, point.y)) };
  });
  return { ...boardState.value, shapes: [...boardState.value.shapes, ...ghosts] };
});
const cipherGroupIndex = ref(sharedCipherGroup(activeMapId.value) ?? 0);
watch(() => flow.linkRevision, () => {
  const group = sharedCipherGroup(activeMapId.value);
  if (group != null) cipherGroupIndex.value = group;
});
const undoStack = ref<TacticalBoardState[]>([]);
const selection = ref<BoardSelection>(null);
const placePending = ref<PlacePending>(null);
const drawShape = ref<DrawShapeKind>('arrow');
const drawColor = ref('#c9a25f');
const drawWidth = ref(2);
const textInput = ref('转点位');
const textFontSize = ref(15);

const measureMode = ref<MeasureModeId>('chain');
const measureScope = ref<'chain' | 'seg'>('chain');
const measureCamp = ref<'survivor' | 'hunter'>('survivor');
const measureBase = ref<MeasureBase>(defaultMeasureBase('survivor'));
const measureBuffs = ref<MeasureBuff[]>([]);
const measurePending = ref<Point2D | null>(null);
const measureVault = ref(true);
const measureAutoFix = ref(true);
const delSegOnly = ref(false);
const routePickSlot = ref<'a' | 'b' | null>(null);
const routePointA = ref<Point2D | null>(null);
const routePointB = ref<Point2D | null>(null);
const routeFixNote = ref('');
const routeComputing = ref(false);
let activeMeasureChainId: number | null = null;

const rangeState = ref(createDefaultRangeState());
const navGridData = shallowRef<NavGridData | null>(null);
const rangeFieldResult = shallowRef<NavFieldResult<CarryRangeBand> | NavFieldResult<TideRangeBand> | null>(null);
const rangeNavField = shallowRef<RangeNavFieldOverlay | null>(null);
const rangeComputing = ref(false);
let activeRangeJob: CancellableNavJob<unknown> | null = null;
let rangeRunSeq = 0;
let navGridLoadSeq = 0;

const animArmed = ref(false);
const animTime = ref(0);
const animPlaying = ref(false);
const animSinglePlaying = ref(false);
const animAutoRoute = ref(true);
const animVault = ref(true);
const animSpeedPresetKey = ref('surv:state:run');

const zoomLocked = ref(false);
const exportCrop = ref(false);
const exportRot = ref(true);
const highlightedCipherId = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

const archiveMsg = ref('');
const archiveErr = ref('');
const lastExportedJson = ref('');

let dragPreSnapshot: TacticalBoardState | null = null;
let dragChanged = false;
let dragMovedMeasureIds = new Set<number>();
let dragHadRoutedMeasureIds = new Set<number>();
let dragMovedAnimPt: { type: 'token' | 'prop'; id: number; ptIdx: number } | null = null;
let suppressMapSync = false;

const standalonePayload = computed(() =>
  buildStandaloneMapPayload(activeMapId.value, {
    cipherGroupIndex: cipherGroupIndex.value,
    chairSetIndex: boardState.value.chairIndex,
    basementIndex: boardState.value.chairBasementIndex,
    dungeonIndex: boardState.value.dungeonIndex,
    escapeDoorLock: landmarks.escapeDoorLock,
    includeCiphers: !isDraft.value && landmarks.ciphers,
    includeChairs: landmarks.chairs,
    includeBasementChairs: landmarks.basement,
    includeGates: landmarks.gates,
    includeHatch: landmarks.hatch,
    includeChests: landmarks.chests,
  }),
);

const effectivePayload = computed(() =>
  isStandalone.value ? standalonePayload.value : store.replay,
);

const geo = computed(() =>
  buildBoardGeoContext(
    effectivePayload.value,
    activeMapId.value,
    floor.value === 'B1' ? -85 : floor.value === '2F' ? 60 : 0,
  ),
);

const dur = computed(() => isDraft.value ? 0 : duration());

const layers = computed<Partial<LayerVisibilityState>>(() => ({
  visibleFloors:
    floor.value === 'ALL'
      ? { B1: true, '1F': true, '2F': true }
      : { B1: floor.value === 'B1', '1F': floor.value === '1F', '2F': floor.value === '2F' },
  focusFloor: null,
  floorPlanes: false,
  dropLines: false,
  viewCones: viewCones.value,
  trails: trails.value,
  dirArrows: dirArrows.value,
  labels: labels.value,
}));

const chaseSegments = computed(() =>
  isStandalone.value ? null : store.analytics?.chase_segments ?? null,
);

const boardChairs = computed(() =>
  collectBoardChairs(
    effectivePayload.value,
    geo.value,
    boardState.value.chairIndex,
    boardState.value.chairBasementIndex,
    landmarks.basement,
  ),
);

const rangeEval = computed(() =>
  computeRangeEvaluation(
    rangeState.value,
    boardChairs.value,
    geo.value,
    navGridData.value,
    rangeFieldResult.value,
    rangeNavField.value,
  ),
);

async function ensureNavGrid(mapId: PilMapId): Promise<NavGridData | null> {
  if (navGridData.value && navGridData.value.mapId === mapId) {
    return navGridData.value;
  }
  const seq = ++navGridLoadSeq;
  const loaded = await loadNavGrid(mapId);
  if (seq === navGridLoadSeq && activeMapId.value === mapId) {
    navGridData.value = loaded;
  }
  return loaded;
}

function cancelRangeJob(): void {
  activeRangeJob?.cancel();
  activeRangeJob = null;
  rangeRunSeq++;
  rangeComputing.value = false;
}

async function recomputeRangeNavField(): Promise<void> {
  cancelRangeJob();
  const origin = rangeState.value.origin;
  if (!origin) {
    rangeFieldResult.value = null;
    rangeNavField.value = null;
    return;
  }

  const seq = ++rangeRunSeq;
  const mapId = activeMapId.value;
  const scenario = rangeState.value.scenario;
  const mode = rangeState.value.mode;
  const [dw, dh] = MAPS_DATA[mapId]!.mapSize;
  const px = origin.x * dw;
  const py = origin.y * dh;
  const originKey = `${mapId}|${scenario}|${mode}|${origin.x.toFixed(4)},${origin.y.toFixed(4)}|${origin.isBasement ? 'B1' : '1F'}|${boardState.value.chairBasementIndex}`;

  rangeComputing.value = true;
  const grid = await ensureNavGrid(mapId);
  if (seq !== rangeRunSeq || activeMapId.value !== mapId || !grid) {
    if (seq === rangeRunSeq) {
      rangeComputing.value = false;
      rangeFieldResult.value = null;
      rangeNavField.value = null;
    }
    return;
  }

  const carryProfile = scenario === 'carry' ? buildCarryProfileFromRange(rangeState.value) : null;
  const tideProfile = scenario === 'tide' ? buildTideProfileFromRange(rangeState.value) : null;
  const baseSpeed = Math.max(carryProfile ? carryProfile.speedAt(0) : tideProfile!.speedAt(0), 1e-6);

  let startCell: { x: number; y: number } | null = null;
  let initialSeconds = 0;

  if (mode === 'chair' && (origin.isBasement || origin.floor === 'B1') && grid.basements.length > 0) {
    const bIdx = origin.basementIdx ?? boardState.value.chairBasementIndex;
    const bMeta =
      findNearestBasement(grid, px, py)?.basement ??
      grid.basements[((bIdx % grid.basements.length) + grid.basements.length) % grid.basements.length]!;
    startCell = snapToWalkable(grid, bMeta.exit[0], bMeta.exit[1], 40);
    initialSeconds = bMeta.slopeExtraM / baseSpeed;
  } else {
    const resolved = resolveNavEndpoint(grid, px, py, {
      autoFix: true,
      allowBasement: false,
      speedMps: baseSpeed,
    });
    startCell = resolved?.cell ?? null;
    initialSeconds = resolved?.extraSeconds ?? 0;
  }

  if (!startCell) {
    if (seq === rangeRunSeq) {
      rangeComputing.value = false;
      rangeFieldResult.value = null;
      rangeNavField.value = null;
    }
    return;
  }

  const job =
    scenario === 'carry'
      ? computeCarryField(grid, startCell, carryProfile!, { initialSeconds })
      : computeTideField(grid, startCell, tideProfile!, { initialSeconds });
  activeRangeJob = job;

  const res = await job.promise;
  if (seq !== rangeRunSeq || res.cancelled || activeMapId.value !== mapId) return;

  activeRangeJob = null;
  rangeComputing.value = false;
  rangeFieldResult.value = res;
  rangeNavField.value = {
    mapId,
    scenario,
    gridW: grid.gridW,
    gridH: grid.gridH,
    bandOf: res.bandOf,
    bands: res.bands,
    reached: res.reached,
    originKey,
  };
}

watch(
  () => [
    activeMapId.value,
    rangeState.value.origin?.x,
    rangeState.value.origin?.y,
    rangeState.value.origin?.kind,
    rangeState.value.origin?.isBasement,
    rangeState.value.origin?.basementIdx,
    rangeState.value.scenario,
    rangeState.value.mode,
    rangeState.value.survivorId,
    rangeState.value.carryBaseSpeed,
    rangeState.value.initialProgress,
    rangeState.value.pickupSeconds,
    rangeState.value.carryBuffs.map((b) => `${b.key}:${b.level}`).join(','),
    rangeState.value.tideBase.speed,
    rangeState.value.tideBuffs.map((b) => `${b.key}:${b.mult}:${b.duration}`).join(','),
    boardState.value.chairBasementIndex,
  ],
  () => {
    void recomputeRangeNavField();
  },
);

const maxAnimDur = computed(() =>
  Math.max(
    effectiveAnimDuration(boardState.value.tokens, geo.value),
    effectiveAnimDuration(boardState.value.items, geo.value),
  ),
);

const showAnimBar = computed(
  () => activeTool.value === 'anim' || (isStandalone.value && maxAnimDur.value > 0),
);

// ------------------------------------------------------------------ Board mutation + undo + storage
function pushUndoSnapshot(snap: TacticalBoardState): void {
  undoStack.value.push(snap);
  if (undoStack.value.length > MAX_UNDO) {
    undoStack.value.shift();
  }
}

function persistNow(): void {
  const snapshot = cloneBoardState(boardState.value);
  if (isDraft.value) flow.draftBoard = snapshot;
  else saveBoardState(activeMapId.value, snapshot);
}

function reconcileMirrorIfNeeded(): void {
  const aq = (boardState.value.items as BoardProp[]).find((it) => it.kind === 'aquaMirror');
  if (aq) {
    syncBloodyQueenMirror(boardState.value, null, aq);
  }
}

function mutateBoard(fn: () => void, recordUndo = true): void {
  if (recordUndo) {
    pushUndoSnapshot(cloneBoardState(boardState.value));
  }
  fn();
  reconcileMirrorIfNeeded();
  persistNow();
}

function undo(): void {
  const prev = undoStack.value.pop();
  if (!prev) return;
  boardState.value = prev;
  measurePending.value = null;
  activeMeasureChainId = null;
  selection.value = null;
  persistNow();
}

function clearBoard(): void {
  const cur = boardState.value;
  mutateBoard(() => {
    const empty = createEmptyBoardState(activeMapId.value);
    empty.chairIndex = cur.chairIndex;
    empty.chairBasementIndex = cur.chairBasementIndex;
    empty.boxBasementIndex = cur.boxBasementIndex;
    empty.dungeonIndex = cur.dungeonIndex;
    empty.spawnIndex = cur.spawnIndex;
    boardState.value = empty;
    selection.value = null;
    measurePending.value = null;
    activeMeasureChainId = null;
    rangeState.value.origin = null;
    animPlaying.value = false;
    animSinglePlaying.value = false;
    animTime.value = 0;
  }, true);
}

// ------------------------------------------------------------------ Map switching & pub/sub sync
function applyMapState(nextId: PilMapId, fromPubSub = false): void {
  cancelRangeJob();
  rangeFieldResult.value = null;
  rangeNavField.value = null;
  navGridData.value = null;
  activeMapId.value = nextId;
  boardState.value = loadEditableBoard(nextId);
  cipherGroupIndex.value = sharedCipherGroup(nextId) ?? 0;
  undoStack.value = [];
  selection.value = null;
  measurePending.value = null;
  routePickSlot.value = null;
  routePointA.value = null;
  routePointB.value = null;
  routeFixNote.value = '';
  highlightedCipherId.value = null;
  activeMeasureChainId = null;
  rangeState.value.origin = null;
  animPlaying.value = false;
  animSinglePlaying.value = false;
  animTime.value = 0;
  ruler.value = null;
  if (viewMode.value === '3d' && !hasScene3D(nextId)) {
    viewMode.value = '2d';
  }
  if (isStandalone.value) {
    underlay.rotationQuadrants = MAPS_DATA[nextId]?.gridPlacement.rotationQuadrants ?? 0;
    underlay.flipX = false;
    underlay.flipZ = false;
  }
  if (!fromPubSub) {
    suppressMapSync = true;
    try {
      setActiveMapId(nextId);
    } finally {
      suppressMapSync = false;
    }
  }
  void ensureNavGrid(nextId);
}

function onSelectMap(e: Event): void {
  if (isDraft.value) return;
  const nextId = resolvePilMapId(Number((e.target as HTMLSelectElement).value));
  applyMapState(nextId, false);
}

const mapCountObj = computed(() => MAPS_DATA[activeMapId.value]!);
const cipherGroupCount = computed(() => Math.max(1, mapCountObj.value.cipherCombinations.length));
const chairSetCount = computed(() => mapCountObj.value.rocketChairs.sets.length);
const basementCount = computed(() => Object.keys(mapCountObj.value.basements).length);
const dungeonCount = computed(() => mapCountObj.value.dungeons.length);
const spawnCount = computed(() => mapCountObj.value.spawnPoints.length);
const hasPhoneBooths = computed(() => Boolean(mapCountObj.value.phoneBooths?.length));

function cycleCiphers(delta: number): void {
  const n = cipherGroupCount.value;
  cipherGroupIndex.value = ((cipherGroupIndex.value + delta) % n + n) % n;
  highlightedCipherId.value = null;
  if (autoEnabled() && !practicing()) rememberManual(activeMapId.value, { groupIndex: cipherGroupIndex.value });
}

function highlightCipher(cipherId: string): void {
  const c = cipherOf(activeMapId.value, cipherId);
  if (!c) return;
  landmarks.ciphers = true;
  highlightedCipherId.value = cipherId;
  const [dw, dh] = MAPS_DATA[activeMapId.value]!.mapSize;
  board.value?.pulseRel({ x: c.location[0] / dw, y: c.location[1] / dh });
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    if (highlightedCipherId.value === cipherId) highlightedCipherId.value = null;
  }, 3500);
}

function cycleChairs(delta: number): void {
  const n = chairSetCount.value;
  if (!n) return;
  mutateBoard(() => {
    boardState.value.chairIndex = ((boardState.value.chairIndex + delta) % n + n) % n;
  }, false);
}

function cycleBasement(delta: number): void {
  const n = basementCount.value;
  if (!n) return;
  mutateBoard(() => {
    boardState.value.chairBasementIndex =
      ((boardState.value.chairBasementIndex + delta) % n + n) % n;
  }, false);
  if (rangeState.value.mode === 'chair' && rangeState.value.origin?.isBasement) {
    selectBasementRangeChair(true);
  }
}

function cycleBoxBasement(delta: number): void {
  const n = basementCount.value;
  if (!n) return;
  mutateBoard(() => {
    boardState.value.boxBasementIndex =
      ((boardState.value.boxBasementIndex + delta) % n + n) % n;
  }, false);
}

function selectBasementRangeChair(forceActivate = false): void {
  const map = MAPS_DATA[activeMapId.value]!;
  const bVals = Object.values(map.basements);
  if (!bVals.length) return;
  if (!forceActivate && rangeState.value.origin?.isBasement) {
    rangeState.value.origin = null;
    return;
  }
  landmarks.basement = true;
  const bIdx = ((boardState.value.chairBasementIndex % bVals.length) + bVals.length) % bVals.length;
  const bInfo = bVals[bIdx]!;
  const [dw, dh] = map.mapSize;
  const firstChair = bInfo.rocketChairs[0];
  const rx = firstChair ? firstChair[0] / dw : 0.5;
  const ry = firstChair ? (firstChair.length === 3 ? firstChair[2] : firstChair[1]) / dh : 0.5;
  rangeState.value.mode = 'chair';
  rangeState.value.origin = {
    kind: 'chair',
    x: rx,
    y: ry,
    label: `地下室 #${bIdx + 1} 狂欢之椅`,
    floor: 'B1',
    isBasement: true,
    basementIdx: bIdx,
  };
}

function cycleDungeon(delta: number): void {
  const n = dungeonCount.value;
  if (!n) return;
  mutateBoard(() => {
    boardState.value.dungeonIndex = ((boardState.value.dungeonIndex + delta) % n + n) % n;
  }, false);
}

function cycleSpawn(delta: number): void {
  const n = spawnCount.value;
  if (!n) return;
  mutateBoard(() => {
    boardState.value.spawnIndex = ((boardState.value.spawnIndex + delta) % n + n) % n;
  }, false);
}

function toggleWhiteboardOverride(on: boolean): void {
  suspendDirector();
  whiteboardOverride.value = on;
  ruler.value = null;
  followUid.value = null;
  if (on) {
    underlay.rotationQuadrants = MAPS_DATA[activeMapId.value]?.gridPlacement.rotationQuadrants ?? 0;
  } else {
    underlay.rotationQuadrants = 0;
    if (store.replay) syncActiveMapByName(store.replay.match.map_name);
  }
}

// ------------------------------------------------------------------ camera helpers
function set2D(): void {
  suspendDirector();
  pitch.value = 90;
  if (viewMode.value !== '2d') {
    viewMode.value = '2d';
    void nextTick(() => {
      board.value?.refreshObstacles();
      board.value?.renderNow();
      positionLegend();
      bumpObstacles();
    });
  }
}
const canUse3D = computed(() => hasScene3D(activeMapId.value));
function set3D(): void {
  if (!canUse3D.value) return;
  suspendDirector();
  pitch.value = 90;
  hudExpanded.value = false;
  viewMode.value = '3d';
}
function resetView(): void {
  suspendDirector();
  pitch.value = 90;
  yaw.value = 0;
  yScale.value = 1;
  followUid.value = null;
  if (viewMode.value === '3d') {
    board3d.value?.resetView();
  } else {
    board.value?.fit();
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('idv-map-fit-reset'));
}
watch([yaw, floor, viewMode], suspendDirector);

function rotateUnderlay(): void {
  underlay.rotationQuadrants = ((underlay.rotationQuadrants + 1) % 4) as 0 | 1 | 2 | 3;
}

function rotateBoard90(): void {
  suspendDirector();
  yaw.value = wrapDeg360(Math.round(yaw.value / 90) * 90 + 90);
  void nextTick(() => {
    board.value?.fit();
  });
}

// ------------------------------------------------------------------ tool selection & ruler
function selectTool(tool: BoardToolId): void {
  activeTool.value = tool;
  if (tool !== 'inspect') {
    rulerMode.value = false;
    rightTab.value = 'tools';
  }
  if (tool !== 'measure') {
    measurePending.value = null;
    routePickSlot.value = null;
    activeMeasureChainId = null;
  }
  if (tool === 'anim') {
    rightTab.value = 'tools';
  }
}

function toggleRuler(): void {
  rulerMode.value = !rulerMode.value;
  if (rulerMode.value) {
    activeTool.value = 'inspect';
  }
}

function clearRuler(): void {
  ruler.value = null;
  board.value?.clearRuler();
}

function toggleViewSettings(): void {
  viewSettingsOpen.value = !viewSettingsOpen.value;
  if (viewSettingsOpen.value) {
    archiveMenuOpen.value = false;
    compactToolsOpen.value = false;
    compactMoreOpen.value = false;
  }
}

function toggleArchiveMenu(): void {
  archiveMenuOpen.value = !archiveMenuOpen.value;
  if (archiveMenuOpen.value) {
    viewSettingsOpen.value = false;
    compactToolsOpen.value = false;
    compactMoreOpen.value = false;
    archiveErr.value = '';
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }
}

function toggleCompactTools(): void {
  compactToolsOpen.value = !compactToolsOpen.value;
  if (compactToolsOpen.value) {
    viewSettingsOpen.value = false;
    archiveMenuOpen.value = false;
    compactMoreOpen.value = false;
    void nextTick(() => {
      compactToolsMenu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
  }
}

function toggleCompactMore(): void {
  compactMoreOpen.value = !compactMoreOpen.value;
  if (compactMoreOpen.value) {
    viewSettingsOpen.value = false;
    archiveMenuOpen.value = false;
    compactToolsOpen.value = false;
    void nextTick(() => {
      compactMoreMenu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
  }
}

function selectCompactTool(tool: BoardToolId): void {
  selectTool(tool);
  compactToolsOpen.value = false;
  compactToolsBtn.value?.focus();
}

function onCompactMenuKeydown(e: KeyboardEvent, kind: 'tools' | 'more'): void {
  if ((kind === 'tools' && !compactToolsOpen.value) || (kind === 'more' && !compactMoreOpen.value)) {
    return;
  }
  const menu = kind === 'tools' ? compactToolsMenu.value : compactMoreMenu.value;
  const trigger = kind === 'tools' ? compactToolsBtn.value : compactMoreBtn.value;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (kind === 'tools') compactToolsOpen.value = false;
    else compactMoreOpen.value = false;
    trigger?.focus();
    return;
  }
  if (!menu) return;
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[(idx + 1 + items.length) % items.length]?.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[(idx - 1 + items.length) % items.length]?.focus();
  } else if (e.key === 'Home') {
    e.preventDefault();
    items[0]?.focus();
  } else if (e.key === 'End') {
    e.preventDefault();
    items[items.length - 1]?.focus();
  }
}

// ------------------------------------------------------------------ Canvas overlay actions
function onTacSelect(sel: BoardSelection): void {
  selection.value = sel;
  if (sel) {
    store.selectedUid = null;
    animSinglePlaying.value = false;
  }
}

function onReplayPick(hit: PickResult | null): void {
  if (hit) {
    selection.value = null;
  }
}

function onTacPlace(pt: Point2D): void {
  const x = clamp01(pt.x);
  const y = clamp01(pt.y);

  if (activeTool.value === 'draw' && drawShape.value === 'text') {
    mutateBoard(() => {
      const id = ++boardState.value.textSeq;
      boardState.value.texts.push({
        id,
        x,
        y,
        text: textInput.value.trim() || '标记',
        color: drawColor.value,
        fontSize: textFontSize.value,
      });
      selection.value = { type: 'text', id };
    });
    return;
  }

  const pend = placePending.value;
  if (!pend) return;

  if (pend.kind === 'role') {
    mutateBoard(() => {
      const tid = ++boardState.value.tokenSeq;
      const def = TAC_ROLES[pend.role];
      const tok: BoardToken = {
        tid,
        role: pend.role,
        x,
        y,
        label: def?.name ?? pend.role,
        showFearRadius: def?.camp === 'hunter',
      };
      boardState.value.tokens.push(tok);
      autoLinkCreatedToken(boardState.value, tok);
      selection.value = { type: 'token', tid };
      store.selectedUid = null;
    });
    return;
  }

  if (pend.kind === 'prop') {
    mutateBoard(() => {
      const iid = ++boardState.value.itemSeq;
      const def = TAC_ITEM_TYPES[pend.propKind];
      const prop: BoardProp = {
        iid,
        role: pend.role,
        kind: pend.propKind,
        x,
        y,
        color: def?.color,
        label: def?.name,
        showRange: Boolean(def?.ranges?.options?.length),
        rangeSubIndex: 0,
        showMirror: pend.propKind === 'aquaMirror' ? true : undefined,
      };
      boardState.value.items.push(prop);
      if (isChainLinkableProp(prop.kind)) {
        const ms = geo.value.mapData.mapSize;
        attachHittingPointToChain(boardState.value, prop, geo.value.effectiveWidthM, ms[1] / Math.max(1, ms[0]));
      } else {
        autoLinkCreatedItem(boardState.value, prop);
      }
      if (pend.propKind === 'aquaMirror') {
        syncBloodyQueenMirror(boardState.value, 'aq', prop);
      }
      selection.value = { type: 'prop', iid };
      store.selectedUid = null;
    });
  }
}

function formatFixNote(res: {
  fixedA?: { from: Point2D; to: Point2D };
  fixedB?: { from: Point2D; to: Point2D };
  basementA?: { slopeExtraM: number };
  basementB?: { slopeExtraM: number };
}): string {
  const notes: string[] = [];
  if (res.basementA) notes.push(`起点经地下室楼梯出口 (+${res.basementA.slopeExtraM.toFixed(1)}m)`);
  else if (res.fixedA) notes.push('起点位于障碍内，已自动修正至最近可行走点');
  if (res.basementB) notes.push(`终点经地下室楼梯出口 (+${res.basementB.slopeExtraM.toFixed(1)}m)`);
  else if (res.fixedB) notes.push('终点位于障碍内，已自动修正至最近可行走点');
  return notes.join('；');
}

async function computeMeasureRoute(
  segId: number,
  fromPt: Point2D,
  toPt: Point2D,
): Promise<boolean> {
  const startMapId = activeMapId.value;
  const vault = measureVault.value;
  const autoFix = measureAutoFix.value;
  const speedMps = measureBase.value.speed;
  const grid = await ensureNavGrid(startMapId);
  if (!grid || activeMapId.value !== startMapId) return false;

  const res = await routeBetweenRel(grid, MAPS_DATA[startMapId]!.mapSize, fromPt, toPt, {
    vault,
    autoFix,
    allowBasement: true,
    speedMps,
  });
  if (activeMapId.value !== startMapId) return false;
  const live = boardState.value.measures.find((m) => m.id === segId);
  if (!live) return false;
  if (
    Math.abs(live.x1 - fromPt.x) > 1e-6 ||
    Math.abs(live.y1 - fromPt.y) > 1e-6 ||
    Math.abs(live.x2 - toPt.x) > 1e-6 ||
    Math.abs(live.y2 - toPt.y) > 1e-6
  ) {
    return false;
  }
  if (!res) {
    routeFixNote.value = autoFix
      ? '未能规划出绕障路线（目标区域不可达）'
      : '端点位于障碍内且未开启「自动修正阻挡点」，保留直线距离';
    return false;
  }
  live.path = res.points;
  const note = formatFixNote(res);
  if (note) routeFixNote.value = note;
  persistNow();
  return true;
}

async function computeAnimSegmentPath(
  targetType: 'token' | 'prop',
  targetId: number,
  segIdx: number,
  fromPt: Point2D,
  toPt: Point2D,
): Promise<boolean> {
  const startMapId = activeMapId.value;
  const vault = animVault.value;
  const grid = await ensureNavGrid(startMapId);
  if (!grid || activeMapId.value !== startMapId) return false;

  const res = await routeBetweenRel(grid, MAPS_DATA[startMapId]!.mapSize, fromPt, toPt, {
    vault,
    autoFix: true,
    allowBasement: true,
  });
  if (!res || activeMapId.value !== startMapId) return false;

  const live =
    targetType === 'token'
      ? boardState.value.tokens.find((t) => t.tid === targetId)
      : boardState.value.items.find((i) => i.iid === targetId);
  const pts = live?.anim?.points;
  if (!live?.anim || !pts || segIdx < 0 || segIdx + 1 >= pts.length) return false;
  const a = pts[segIdx]!;
  const b = pts[segIdx + 1]!;
  if (
    Math.abs(a.x - fromPt.x) > 1e-6 ||
    Math.abs(a.y - fromPt.y) > 1e-6 ||
    Math.abs(b.x - toPt.x) > 1e-6 ||
    Math.abs(b.y - toPt.y) > 1e-6
  ) {
    return false;
  }
  const paths = (live.anim.paths ??= []);
  paths[segIdx] = res.points;
  persistNow();
  return true;
}

function armRoutePick(slot: 'a' | 'b'): void {
  routePickSlot.value = routePickSlot.value === slot ? null : slot;
  if (routePickSlot.value) {
    measurePending.value = null;
    activeMeasureChainId = null;
  }
}

function onTacRoutePick(pt: Point2D): void {
  const p = { x: clamp01(pt.x), y: clamp01(pt.y) };
  if (routePickSlot.value === 'a') {
    routePointA.value = p;
    routePickSlot.value = null;
  } else if (routePickSlot.value === 'b') {
    routePointB.value = p;
    routePickSlot.value = null;
  }
}

function clearTwoPointRoute(): void {
  routePickSlot.value = null;
  routePointA.value = null;
  routePointB.value = null;
  routeFixNote.value = '';
}

async function runTwoPointRoute(): Promise<boolean> {
  const a = routePointA.value;
  const b = routePointB.value;
  if (!a || !b) return false;
  const startMapId = activeMapId.value;
  routeComputing.value = true;
  routeFixNote.value = '';
  try {
    const grid = await ensureNavGrid(startMapId);
    if (!grid || activeMapId.value !== startMapId) {
      routeFixNote.value = '导航网格尚未就绪';
      return false;
    }
    const res = await routeBetweenRel(grid, MAPS_DATA[startMapId]!.mapSize, a, b, {
      vault: measureVault.value,
      autoFix: measureAutoFix.value,
      allowBasement: true,
      speedMps: measureBase.value.speed,
    });
    if (activeMapId.value !== startMapId) return false;
    if (!res) {
      routeFixNote.value = measureAutoFix.value
        ? '未能规划出绕障路线（起点或终点不可达）'
        : '起点或终点位于障碍内（请勾选「自动修正阻挡点」重试）';
      return false;
    }
    mutateBoard(() => {
      const id = ++boardState.value.measureSeq;
      const lid = ++boardState.value.lcSeq;
      const lc = createMeasureConfig(lid, 1, measureBase.value, measureBuffs.value);
      const seg: TacticalMeasureLine = {
        id,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        path: res.points,
        chain: null,
        lc,
        color: '#20d6a0',
      };
      boardState.value.measures.push(seg);
      selection.value = { type: 'measure', id };
    });
    const note = formatFixNote(res);
    routeFixNote.value = note || `已规划绕障路线：${res.distanceM.toFixed(1)}m · 约 ${res.durationS.toFixed(2)}s`;
    return true;
  } finally {
    routeComputing.value = false;
  }
}

watch(selection, (sel) => {
  if (sel?.type === 'token') {
    const tk = boardState.value.tokens.find((t) => t.tid === sel.tid);
    if (tk) {
      const huntPreset = ANIM_SPEED_PRESETS.find((p) => p.key === `hunt:${tk.role}:0`);
      if (huntPreset) {
        animSpeedPresetKey.value = huntPreset.key;
      } else {
        const survRolePreset = ANIM_SPEED_PRESETS.find((p) => p.key === `surv:role:${tk.role}:0`);
        animSpeedPresetKey.value = survRolePreset?.key ?? 'surv:state:run';
      }
    }
  }
});

watch([measureVault, measureAutoFix], () => {
  const sel = selection.value;
  if (sel?.type !== 'measure') return;
  const target = boardState.value.measures.find((m) => m.id === sel.id);
  if (!target) return;
  const segs =
    target.chain !== null && target.chain !== undefined
      ? boardState.value.measures.filter((m) => m.chain === target.chain && m.path?.length)
      : target.path?.length
        ? [target]
        : [];
  for (const s of segs) {
    void computeMeasureRoute(s.id, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
  }
});

function onTacDragStart(): void {
  dragPreSnapshot = cloneBoardState(boardState.value);
  dragChanged = false;
  dragMovedMeasureIds = new Set<number>();
  dragHadRoutedMeasureIds = new Set<number>();
  dragMovedAnimPt = null;
}

function onTacDragEnd(): void {
  const movedMeasures = Array.from(dragMovedMeasureIds);
  const hadRouted = new Set(dragHadRoutedMeasureIds);
  const movedAnim = dragMovedAnimPt;
  dragMovedMeasureIds = new Set<number>();
  dragHadRoutedMeasureIds = new Set<number>();
  dragMovedAnimPt = null;

  if (dragPreSnapshot && dragChanged) {
    pushUndoSnapshot(dragPreSnapshot);
    persistNow();
    for (const segId of movedMeasures) {
      const seg = boardState.value.measures.find((m) => m.id === segId);
      if (seg && (hadRouted.has(segId) || measureMode.value === 'route')) {
        void computeMeasureRoute(seg.id, { x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 });
      }
    }
    if (movedAnim && animAutoRoute.value) {
      const target =
        movedAnim.type === 'token'
          ? boardState.value.tokens.find((t) => t.tid === movedAnim.id)
          : boardState.value.items.find((i) => i.iid === movedAnim.id);
      const pts = target?.anim?.points;
      if (pts) {
        if (movedAnim.ptIdx > 0) {
          void computeAnimSegmentPath(
            movedAnim.type,
            movedAnim.id,
            movedAnim.ptIdx - 1,
            { ...pts[movedAnim.ptIdx - 1]! },
            { ...pts[movedAnim.ptIdx]! },
          );
        }
        if (movedAnim.ptIdx + 1 < pts.length) {
          void computeAnimSegmentPath(
            movedAnim.type,
            movedAnim.id,
            movedAnim.ptIdx,
            { ...pts[movedAnim.ptIdx]! },
            { ...pts[movedAnim.ptIdx + 1]! },
          );
        }
      }
    }
  }
  dragPreSnapshot = null;
  dragChanged = false;
}

function onTacMoveToken(v: { tid: number; x: number; y: number }): void {
  const tk = boardState.value.tokens.find((t) => t.tid === v.tid);
  if (!tk) return;
  tk.x = clamp01(v.x);
  tk.y = clamp01(v.y);
  dragChanged = true;
  if (tk.role === 'bloodyQueen') {
    syncBloodyQueenMirror(boardState.value, 'bq');
  }
}

function onTacMoveProp(v: { iid: number; x: number; y: number }): void {
  const pr = boardState.value.items.find((i) => i.iid === v.iid) as BoardProp | undefined;
  if (!pr) return;
  pr.x = clamp01(v.x);
  pr.y = clamp01(v.y);
  dragChanged = true;
  if (pr.kind === 'aquaMirror') {
    syncBloodyQueenMirror(boardState.value, 'aq', pr);
  } else if (pr.kind === 'mirrorImage') {
    const aq = (boardState.value.items as BoardProp[]).find(
      (i) => i.kind === 'aquaMirror' && (pr.aqIid == null || i.iid === pr.aqIid),
    );
    syncBloodyQueenMirror(boardState.value, 'mi', aq);
  } else if (isChainLinkableProp(pr.kind)) {
    const ms = geo.value.mapData.mapSize;
    clampHittingPointToChain(boardState.value, pr, geo.value.effectiveWidthM, ms[1] / Math.max(1, ms[0]));
  }
}

function onTacMoveText(v: { id: number; x: number; y: number }): void {
  const tx = boardState.value.texts.find((t) => t.id === v.id);
  if (!tx) return;
  tx.x = clamp01(v.x);
  tx.y = clamp01(v.y);
  dragChanged = true;
}

function onTacMoveMeasureEnd(v: { id: number; end: 'a' | 'b'; x: number; y: number }): void {
  const x = clamp01(v.x);
  const y = clamp01(v.y);
  const seg = boardState.value.measures.find((m) => m.id === v.id);
  if (!seg) return;
  const oldX = v.end === 'a' ? seg.x1 : seg.x2;
  const oldY = v.end === 'a' ? seg.y1 : seg.y2;
  if (seg.path?.length) dragHadRoutedMeasureIds.add(seg.id);
  delete seg.path;
  dragMovedMeasureIds.add(seg.id);
  if (v.end === 'a') {
    seg.x1 = x;
    seg.y1 = y;
  } else {
    seg.x2 = x;
    seg.y2 = y;
  }
  // Keep adjacent chain endpoints joined when dragging a shared vertex
  if (seg.chain !== null) {
    for (const m of boardState.value.measures) {
      if (m.id === seg.id || m.chain !== seg.chain) continue;
      let touched = false;
      if (Math.hypot(m.x1 - oldX, m.y1 - oldY) < 1e-4) {
        m.x1 = x;
        m.y1 = y;
        touched = true;
      }
      if (Math.hypot(m.x2 - oldX, m.y2 - oldY) < 1e-4) {
        m.x2 = x;
        m.y2 = y;
        touched = true;
      }
      if (touched) {
        if (m.path?.length) dragHadRoutedMeasureIds.add(m.id);
        delete m.path;
        dragMovedMeasureIds.add(m.id);
      }
    }
  }
  dragChanged = true;
}

function onTacMoveAnimDot(v: { ptIdx: number; x: number; y: number }): void {
  const sel = selection.value;
  if (!sel || (sel.type !== 'token' && sel.type !== 'prop')) return;
  const target =
    sel.type === 'token'
      ? boardState.value.tokens.find((t) => t.tid === sel.tid)
      : boardState.value.items.find((i) => i.iid === sel.iid);
  const pt = target?.anim?.points?.[v.ptIdx];
  if (!pt || !target?.anim) return;
  pt.x = clamp01(v.x);
  pt.y = clamp01(v.y);
  // Clear stale adjacent routed paths immediately during manual drag
  if (target.anim.paths) {
    if (v.ptIdx > 0) target.anim.paths[v.ptIdx - 1] = undefined;
    if (v.ptIdx < target.anim.paths.length) target.anim.paths[v.ptIdx] = undefined;
  }
  dragMovedAnimPt = {
    type: sel.type,
    id: sel.type === 'token' ? sel.tid : sel.iid,
    ptIdx: v.ptIdx,
  };
  dragChanged = true;
}

function onTacDrawCommit(shape: Omit<TacticalShape, 'id'>): void {
  mutateBoard(() => {
    const id = ++boardState.value.shapeSeq;
    boardState.value.shapes.push({ ...shape, id });
    selection.value = { type: 'shape', id };
  });
}

function onTacMeasureClick(pt: Point2D): void {
  const p = { x: clamp01(pt.x), y: clamp01(pt.y) };
  if (!measurePending.value) {
    measurePending.value = p;
    activeMeasureChainId = null;
    return;
  }
  const a = measurePending.value;
  const isChainedMode = measureMode.value === 'chain' || measureMode.value === 'route';
  const isRouteMode = measureMode.value === 'route';
  let createdSegId = 0;

  mutateBoard(() => {
    const id = ++boardState.value.measureSeq;
    createdSegId = id;
    let seg: TacticalMeasureLine;
    if (isChainedMode && activeMeasureChainId !== null) {
      const chainSegs = boardState.value.measures.filter((m) => m.chain === activeMeasureChainId);
      const lc = chainSegs[0]?.lc ?? createMeasureConfig(++boardState.value.lcSeq, 1, measureBase.value, measureBuffs.value);
      lc.bases.forEach((b) => {
        if (b.to === chainSegs.length) b.to = chainSegs.length + 1;
      });
      lc.buffs.forEach((b) => {
        if (b.to === chainSegs.length) b.to = chainSegs.length + 1;
      });
      seg = {
        id,
        x1: a.x,
        y1: a.y,
        x2: p.x,
        y2: p.y,
        chain: activeMeasureChainId,
        lc,
        color: isRouteMode ? '#20d6a0' : drawColor.value,
      };
    } else {
      const chainId = isChainedMode ? ++boardState.value.measureSeq : null;
      const lid = ++boardState.value.lcSeq;
      const lc = createMeasureConfig(lid, 1, measureBase.value, measureBuffs.value);
      seg = {
        id,
        x1: a.x,
        y1: a.y,
        x2: p.x,
        y2: p.y,
        chain: chainId,
        lc,
        color: isRouteMode ? '#20d6a0' : drawColor.value,
      };
      activeMeasureChainId = chainId;
    }
    boardState.value.measures.push(seg);
    selection.value = { type: 'measure', id };
  });

  if (isRouteMode && createdSegId > 0) {
    void computeMeasureRoute(createdSegId, a, p);
  }

  if (isChainedMode) {
    measurePending.value = p;
  } else {
    measurePending.value = null;
    activeMeasureChainId = null;
  }
}

function finishMeasureChain(): void {
  measurePending.value = null;
  activeMeasureChainId = null;
}

function onTacRangeClick(pt: Point2D): void {
  const x = clamp01(pt.x);
  const y = clamp01(pt.y);
  if (rangeState.value.mode === 'chair' && boardChairs.value.length > 0) {
    let best = boardChairs.value[0]!;
    let bestD = Infinity;
    for (const ch of boardChairs.value) {
      const d = Math.hypot(ch.relPos[0] - x, ch.relPos[1] - y);
      if (d < bestD) {
        bestD = d;
        best = ch;
      }
    }
    rangeState.value.origin = {
      kind: 'chair',
      x: best.relPos[0],
      y: best.relPos[1],
      label: best.label,
      floor: best.floor,
      isBasement: best.kind === 'basement' || best.floor === 'B1',
      basementIdx: best.kind === 'basement' || best.floor === 'B1' ? boardState.value.chairBasementIndex : undefined,
    };
    return;
  }
  rangeState.value.origin = {
    kind: 'point',
    x,
    y,
    label: `自定义 (${(x * 100).toFixed(0)}%, ${(y * 100).toFixed(0)}%)`,
    floor: floor.value === 'ALL' ? '1F' : floor.value,
    isBasement: false,
  };
}

function onTacAnimAddPoint(pt: Point2D): void {
  const sel = selection.value;
  if (!sel || (sel.type !== 'token' && sel.type !== 'prop')) return;
  const target =
    sel.type === 'token'
      ? boardState.value.tokens.find((t) => t.tid === sel.tid)
      : boardState.value.items.find((i) => i.iid === sel.iid);
  if (!target) return;

  const preset = ANIM_SPEED_PRESETS.find((p) => p.key === animSpeedPresetKey.value);
  const defaultSpd =
    preset?.speed ??
    (sel.type === 'token' ? getDefaultRoleSpeed(target as BoardToken) : TAC_MOVEMENT_SURVIVOR.states.run.speed);
  const defaultName = preset?.name ?? '默认移速';

  let segIdxToRoute = -1;
  let routeFrom: Point2D | null = null;
  let routeTo: Point2D | null = null;

  mutateBoard(() => {
    if (!target.anim) {
      target.anim = {
        mode: 'speed',
        points: [{ x: target.x, y: target.y }],
        times: [0],
        speeds: [{ speed: defaultSpd, name: defaultName }],
      };
    }
    const anim = target.anim;
    const pts = anim.points;
    const nextPt = { x: clamp01(pt.x), y: clamp01(pt.y) };
    if (pts.length === 0) {
      pts.push({ x: target.x, y: target.y });
      anim.times = [0];
    }
    const prevPt = pts[pts.length - 1]!;
    pts.push(nextPt);
    const segIdx = pts.length - 2;
    if (anim.mode === 'speed') {
      const list: AnimSpeedEntry[] = anim.speeds ?? [];
      while (list.length <= segIdx) list.push({ speed: defaultSpd, name: defaultName });
      anim.speeds = list;
    } else {
      const prevT = anim.times?.[segIdx] ?? 0;
      const times = anim.times ?? [0];
      while (times.length <= segIdx + 1) times.push(Number((prevT + 2).toFixed(2)));
      anim.times = times;
    }
    segIdxToRoute = segIdx;
    routeFrom = { x: prevPt.x, y: prevPt.y };
    routeTo = { x: nextPt.x, y: nextPt.y };
  });

  if (animAutoRoute.value && segIdxToRoute >= 0 && routeFrom && routeTo) {
    const id = sel.type === 'token' ? sel.tid : sel.iid;
    void computeAnimSegmentPath(sel.type, id, segIdxToRoute, routeFrom, routeTo);
  }
}

function onAnimApplyPreset(speed: number, name: string): void {
  const sel = selection.value;
  if (!sel || (sel.type !== 'token' && sel.type !== 'prop')) return;
  const target =
    sel.type === 'token'
      ? boardState.value.tokens.find((t) => t.tid === sel.tid)
      : boardState.value.items.find((i) => i.iid === sel.iid);
  if (!target?.anim || target.anim.points.length < 2) return;
  mutateBoard(() => {
    const a = target.anim!;
    const segCount = Math.max(0, a.points.length - 1);
    a.speeds = Array.from({ length: segCount }, (_, i) => ({
      ...(a.speeds?.[i] ?? {}),
      name,
      speed,
    }));
  });
}

function onAnimRemovePoint(idx: number): void {
  const sel = selection.value;
  if (!sel || (sel.type !== 'token' && sel.type !== 'prop')) return;
  const target =
    sel.type === 'token'
      ? boardState.value.tokens.find((t) => t.tid === sel.tid)
      : boardState.value.items.find((i) => i.iid === sel.iid);
  if (!target?.anim) return;

  let bridgeSeg = -1;
  let fromPt: Point2D | null = null;
  let toPt: Point2D | null = null;

  mutateBoard(() => {
    const a: AnimData = target.anim!;
    const oldLen = a.points.length;
    if (idx < 0 || idx >= oldLen) return;
    a.points.splice(idx, 1);
    a.times?.splice(idx, 1);
    if (a.points.length > 0 && a.speeds) {
      a.speeds.splice(idx === 0 ? 0 : idx - 1, 1);
    }
    if (a.paths) {
      if (idx === 0) {
        a.paths.splice(0, 1);
      } else if (idx === oldLen - 1) {
        a.paths.splice(Math.max(0, idx - 1), 1);
      } else {
        a.paths.splice(idx, 1);
        a.paths[idx - 1] = undefined;
        bridgeSeg = idx - 1;
        fromPt = { ...a.points[idx - 1]! };
        toPt = { ...a.points[idx]! };
      }
    } else if (idx > 0 && idx < oldLen - 1) {
      bridgeSeg = idx - 1;
      fromPt = { ...a.points[idx - 1]! };
      toPt = { ...a.points[idx]! };
    }
  });

  if (animAutoRoute.value && bridgeSeg >= 0 && fromPt && toPt) {
    const id = sel.type === 'token' ? sel.tid : sel.iid;
    void computeAnimSegmentPath(sel.type, id, bridgeSeg, fromPt, toPt);
  }
}

function recomputeAllAnimPaths(): void {
  const sel = selection.value;
  if (!sel || (sel.type !== 'token' && sel.type !== 'prop')) return;
  const target =
    sel.type === 'token'
      ? boardState.value.tokens.find((t) => t.tid === sel.tid)
      : boardState.value.items.find((i) => i.iid === sel.iid);
  const pts = target?.anim?.points;
  if (!pts || pts.length < 2) return;
  const id = sel.type === 'token' ? sel.tid : sel.iid;
  for (let i = 0; i + 1 < pts.length; i++) {
    void computeAnimSegmentPath(sel.type, id, i, { ...pts[i]! }, { ...pts[i + 1]! });
  }
}

function getDefaultRoleSpeed(tk: BoardToken): number {
  const def = TAC_ROLES[tk.role];
  if (!def) return TAC_MOVEMENT_SURVIVOR.states.run.speed;
  if (typeof def.speed === 'number') return def.speed;
  if (def.speed && typeof def.speed === 'object') {
    const first = Object.values(def.speed).find((v) => typeof v === 'number');
    return first ?? 4.64;
  }
  return TAC_MOVEMENT_SURVIVOR.states.run.speed;
}

function deleteSelection(): void {
  const sel = selection.value;
  if (!sel) return;
  mutateBoard(() => {
    if (sel.type === 'token') {
      boardState.value.tokens = boardState.value.tokens.filter((t) => t.tid !== sel.tid);
      // Clean linked mirror props
      for (const it of boardState.value.items) {
        if (it.linkTid === sel.tid) it.linkTid = null;
      }
    } else if (sel.type === 'prop') {
      const removed = boardState.value.items.find((i) => i.iid === sel.iid) as BoardProp | undefined;
      if (removed && isChainLinkableProp(removed.kind)) {
        removeHittingPoint(boardState.value, removed);
      } else {
        boardState.value.items = boardState.value.items.filter(
          (i) =>
            i.iid !== sel.iid &&
            !(removed?.kind === 'aquaMirror' && i.kind === 'mirrorImage' && (i as BoardProp).aqIid === sel.iid),
        );
      }
    } else if (sel.type === 'shape') {
      boardState.value.shapes = boardState.value.shapes.filter((s) => s.id !== sel.id);
    } else if (sel.type === 'text') {
      boardState.value.texts = boardState.value.texts.filter((t) => t.id !== sel.id);
    } else if (sel.type === 'measure') {
      const target = boardState.value.measures.find((m) => m.id === sel.id);
      if (!delSegOnly.value && target?.chain !== null && target?.chain !== undefined) {
        boardState.value.measures = boardState.value.measures.filter((m) => m.chain !== target.chain);
      } else {
        boardState.value.measures = boardState.value.measures.filter((m) => m.id !== sel.id);
      }
      if (activeMeasureChainId === target?.chain && !boardState.value.measures.some((m) => m.chain === target?.chain)) {
        activeMeasureChainId = null;
        measurePending.value = null;
      }
    }
    selection.value = null;
  });
}

function deleteMeasure(id: number): void {
  selection.value = { type: 'measure', id };
  deleteSelection();
}
function deleteShape(id: number): void {
  selection.value = { type: 'shape', id };
  deleteSelection();
}
function deleteText(id: number): void {
  selection.value = { type: 'text', id };
  deleteSelection();
}

function swapMirror(aqIid: number): void {
  const items = boardState.value.items as BoardProp[];
  const aq = items.find((i) => i.iid === aqIid);
  const bq = aq?.linkTid != null ? boardState.value.tokens.find((t) => t.tid === aq.linkTid) : undefined;
  const mi = items.find((i) => i.kind === 'mirrorImage' && (i.aqIid == null || i.aqIid === aqIid));
  if (!bq || !mi) return;
  mutateBoard(() => {
    const bx = bq.x;
    const by = bq.y;
    bq.x = mi.x;
    bq.y = mi.y;
    mi.x = bx;
    mi.y = by;
  });
}

function clearAnimTarget(): void {
  const sel = selection.value;
  if (!sel || (sel.type !== 'token' && sel.type !== 'prop')) return;
  mutateBoard(() => {
    const target =
      sel.type === 'token'
        ? boardState.value.tokens.find((t) => t.tid === sel.tid)
        : boardState.value.items.find((i) => i.iid === sel.iid);
    if (target) delete target.anim;
  });
  animArmed.value = false;
  animSinglePlaying.value = false;
}

// ------------------------------------------------------------------ P0 Opening / Endgame Scenarios & P1 3D->2D Handoff
function applyOpeningScenario(hunterRole = 'operaSinger'): void {
  if (!isStandalone.value && store.replay) {
    whiteboardOverride.value = true;
  }
  landmarks.spawns = true;
  landmarks.ciphers = true;
  mutateBoard(() => {
    populateOpeningScenario(boardState.value, activeMapId.value, {
      spawnGroupIndex: boardState.value.spawnIndex,
      cipherGroupIndex: cipherGroupIndex.value,
      hunterRole,
      withAnim: true,
    });
    selection.value = boardState.value.tokens[0]
      ? { type: 'token', tid: boardState.value.tokens[0].tid }
      : null;
  });
  resetAnimPlayback();
  rightTab.value = 'tools';
  activeTool.value = 'inspect';
}

function applyEndgameScenario(variant: EndgameScenarioKind, hunterRole = 'operaSinger'): void {
  if (!isStandalone.value && store.replay) {
    whiteboardOverride.value = true;
  }
  landmarks.ciphers = true;
  landmarks.chairs = true;
  landmarks.gates = true;
  let resChairRel: Point2D | null = null;
  let resChairLabel: string | null = null;
  mutateBoard(() => {
    const res = populateEndgameScenario(boardState.value, activeMapId.value, variant, {
      cipherGroupIndex: cipherGroupIndex.value,
      chairIndex: boardState.value.chairIndex,
      hunterRole,
      withAnim: true,
    });
    resChairRel = res.recommendedChairRel ?? null;
    resChairLabel = res.recommendedChairLabel ?? null;
    selection.value = boardState.value.tokens[0]
      ? { type: 'token', tid: boardState.value.tokens[0].tid }
      : null;
  });
  if (variant === 'chair-rescue' && resChairRel) {
    rangeState.value.scenario = 'tide';
    rangeState.value.mode = 'chair';
    rangeState.value.origin = {
      kind: 'chair',
      x: (resChairRel as Point2D).x,
      y: (resChairRel as Point2D).y,
      label: resChairLabel ?? '固定椅 #1',
      floor: '1F',
    };
  }
  resetAnimPlayback();
  rightTab.value = 'tools';
  activeTool.value = 'inspect';
}

function onHandoffFrom3D(payload: {
  pointA?: Point2D | null;
  pointB?: Point2D | null;
  rangeOrigin?: { x: number; y: number; label: string; scenario: 'carry' | 'tide'; mode: 'chair' | 'point' } | null;
  floor?: FloorFilter;
}): void {
  if (payload.floor) {
    floor.value = payload.floor;
  }
  if (payload.pointA && payload.pointB) {
    routePointA.value = { x: clamp01(payload.pointA.x), y: clamp01(payload.pointA.y) };
    routePointB.value = { x: clamp01(payload.pointB.x), y: clamp01(payload.pointB.y) };
    activeTool.value = 'measure';
    measureMode.value = 'route';
    rightTab.value = 'tools';
    viewMode.value = '2d';
    void runTwoPointRoute();
    return;
  }
  if (payload.rangeOrigin) {
    rangeState.value.scenario = payload.rangeOrigin.scenario;
    rangeState.value.mode = payload.rangeOrigin.mode;
    rangeState.value.origin = {
      kind: payload.rangeOrigin.mode === 'chair' ? 'chair' : 'point',
      x: clamp01(payload.rangeOrigin.x),
      y: clamp01(payload.rangeOrigin.y),
      label: payload.rangeOrigin.label,
      floor: payload.floor && payload.floor !== 'ALL' ? payload.floor : '1F',
    };
    activeTool.value = 'range';
    rightTab.value = 'tools';
    viewMode.value = '2d';
  }
}

// ------------------------------------------------------------------ Animation playback loop
let animRafId: number | null = null;
let animLastTs = 0;

function stopAnimRaf(): void {
  if (animRafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(animRafId);
  }
  animRafId = null;
  animLastTs = 0;
}

function stepAnimLoop(now: number): void {
  if (!animPlaying.value && !animSinglePlaying.value) {
    stopAnimRaf();
    return;
  }
  if (animLastTs > 0) {
    const dt = Math.min(0.1, (now - animLastTs) / 1000);
    const limit = getCurrentAnimLimit();
    const next = animTime.value + dt;
    if (limit <= 0 || next >= limit) {
      animTime.value = limit;
      animPlaying.value = false;
      animSinglePlaying.value = false;
      stopAnimRaf();
      return;
    }
    animTime.value = next;
  }
  animLastTs = now;
  animRafId = requestAnimationFrame(stepAnimLoop);
}

function getCurrentAnimLimit(): number {
  if (animSinglePlaying.value && selection.value) {
    const sel = selection.value;
    const target =
      sel.type === 'token'
        ? boardState.value.tokens.find((t) => t.tid === sel.tid)
        : sel.type === 'prop'
          ? boardState.value.items.find((i) => i.iid === sel.iid)
          : null;
    if (target?.anim && target.anim.points.length >= 2) {
      return animDuration(target.anim, geo.value.animGeom).end;
    }
  }
  return maxAnimDur.value;
}

function ensureAnimLoop(): void {
  if ((animPlaying.value || animSinglePlaying.value) && animRafId === null && typeof requestAnimationFrame === 'function') {
    animLastTs = 0;
    animRafId = requestAnimationFrame(stepAnimLoop);
  }
}

function toggleGlobalAnimPlay(): void {
  if (maxAnimDur.value <= 0) return;
  animSinglePlaying.value = false;
  if (!animPlaying.value && animTime.value >= maxAnimDur.value - 1e-3) {
    animTime.value = 0;
  }
  animPlaying.value = !animPlaying.value;
  if (animPlaying.value) ensureAnimLoop();
  else stopAnimRaf();
}

function toggleSingleAnimPlay(): void {
  animPlaying.value = false;
  const limit = getCurrentAnimLimit();
  if (limit <= 0) return;
  if (!animSinglePlaying.value && animTime.value >= limit - 1e-3) {
    animTime.value = 0;
  }
  animSinglePlaying.value = !animSinglePlaying.value;
  if (animSinglePlaying.value) ensureAnimLoop();
  else stopAnimRaf();
}

function resetAnimPlayback(): void {
  animPlaying.value = false;
  animSinglePlaying.value = false;
  stopAnimRaf();
  animTime.value = 0;
}

function scrubAnim(t: number): void {
  animTime.value = Math.max(0, Math.min(maxAnimDur.value, t));
}

// ------------------------------------------------------------------ JSON Import/Export & PNG Export
function exportJsonArchive(): string {
  const json = exportBoardJson(activeMapId.value, cloneBoardState(boardState.value));
  lastExportedJson.value = json;
  archiveErr.value = '';
  archiveMsg.value = `已生成 ${mapCountObj.value.mapName} 存档 JSON (${boardState.value.tokens.length} 棋子)`;
  if (
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function' &&
    typeof navigator !== 'undefined' &&
    !/jsdom/i.test(navigator.userAgent)
  ) {
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `idv-tactic-${mapCountObj.value.mapName}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* headless environment fallback */
    }
  }
  return json;
}

function importJsonText(raw: string): ImportBoardResult {
  const res = importBoardJson(raw);
  if (!res.ok) {
    archiveErr.value = res.error;
    archiveMsg.value = '';
    return res;
  }
  archiveErr.value = '';
  if (res.mapId !== activeMapId.value) {
    applyMapState(res.mapId, false);
  }
  mutateBoard(() => {
    boardState.value = res.state;
    selection.value = null;
    measurePending.value = null;
    activeMeasureChainId = null;
  });
  archiveMsg.value = `已导入「${MAPS_DATA[res.mapId]!.mapName}」战术板 (${res.state.tokens.length} 棋子, ${res.state.shapes.length} 图形)`;
  return res;
}

async function onImportJsonFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const txt = await file.text();
    importJsonText(txt);
  } catch {
    archiveErr.value = '读取文件失败';
    archiveMsg.value = '';
  }
}

function exportBoardPng(
  opts?: { crop?: boolean; keepRotation?: boolean },
): { dataUrl: string; fileName: string; crop?: boolean; keepRotation?: boolean } {
  const crop = opts?.crop ?? exportCrop.value;
  const keepRotation = opts?.keepRotation ?? exportRot.value;
  if (board.value) {
    return board.value.exportBoardPng({ crop, keepRotation });
  }
  return { dataUrl: '', fileName: `${mapCountObj.value.mapName}-战术沙盘.png`, crop, keepRotation };
}

// ------------------------------------------------------------------ Top strip: replay hunters/survivors
const hunter = computed(() => effectivePayload.value?.players.find((p) => p.camp === 1) ?? null);
const survivors = computed(() => effectivePayload.value?.players.filter((p) => p.camp === 2) ?? []);
const survivorStates = computed(() =>
  survivors.value.map((p) => {
    const s = samplePlayerAtTime(effectivePayload.value?.trajectories?.[String(p.uid)], store.t);
    return { p, fear: s ? s.fearState : null };
  }),
);

const portraitKey = computed(() => (hunter.value ? `ivp.hunterPortrait.${hunter.value.pid}` : null));
const portrait = ref<string | null>(null);
function readPortrait(): void {
  if (!portraitKey.value) {
    portrait.value = null;
    return;
  }
  try {
    portrait.value = localStorage.getItem(portraitKey.value);
  } catch {
    portrait.value = null;
  }
}
watch(portraitKey, readPortrait, { immediate: true });
function onPortraitSelect(name: string | null): void {
  portrait.value = name;
  if (!portraitKey.value) return;
  try {
    if (name) localStorage.setItem(portraitKey.value, name);
    else localStorage.removeItem(portraitKey.value);
  } catch {
    /* storage unavailable */
  }
}
const portraitSrc = computed(() => (portrait.value ? hunterPortraitUrl(portrait.value) : SEAL_URL));
function onPortraitError(e: Event): void {
  const img = e.target as HTMLImageElement;
  if (!img.src.endsWith(SEAL_URL)) img.src = SEAL_URL;
}

function toggleFollow(uid: number): void {
  changeFollow(followUid.value === uid ? null : uid);
  store.selectedUid = uid;
  selection.value = null;
}

// ------------------------------------------------------------------ transport & keyboard shortcuts
function onScrub(e: Event): void {
  seek(Number((e.target as HTMLInputElement).value));
}
function onSpeed(e: Event): void {
  setSpeed(Number((e.target as HTMLSelectElement).value));
}
function markerLeft(t: number): string {
  return dur.value > 0 ? `${(t / dur.value) * 100}%` : '0%';
}

function nudgeSelection(dxScreen: number, dyScreen: number): boolean {
  const sel = selection.value;
  if (!sel || (sel.type !== 'token' && sel.type !== 'prop' && sel.type !== 'text')) return false;
  const rad = -(yaw.value * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = dxScreen * cos - dyScreen * sin;
  const dy = dxScreen * sin + dyScreen * cos;

  mutateBoard(() => {
    if (sel.type === 'token') {
      const tk = boardState.value.tokens.find((t) => t.tid === sel.tid);
      if (!tk) return;
      tk.x = clamp01(tk.x + dx);
      tk.y = clamp01(tk.y + dy);
      if (tk.role === 'bloodyQueen') {
        syncBloodyQueenMirror(boardState.value, 'bq');
      }
    } else if (sel.type === 'prop') {
      const pr = boardState.value.items.find((i) => i.iid === sel.iid) as BoardProp | undefined;
      if (!pr) return;
      pr.x = clamp01(pr.x + dx);
      pr.y = clamp01(pr.y + dy);
      if (pr.kind === 'aquaMirror') {
        syncBloodyQueenMirror(boardState.value, 'aq', pr);
      } else if (pr.kind === 'mirrorImage') {
        const aq = (boardState.value.items as BoardProp[]).find(
          (i) => i.kind === 'aquaMirror' && (pr.aqIid == null || i.iid === pr.aqIid),
        );
        syncBloodyQueenMirror(boardState.value, 'mi', aq);
      }
    } else if (sel.type === 'text') {
      const tx = boardState.value.texts.find((t) => t.id === sel.id);
      if (!tx) return;
      tx.x = clamp01(tx.x + dx);
      tx.y = clamp01(tx.y + dy);
    }
  });
  return true;
}

function onKey(e: KeyboardEvent): void {
  const tgt = e.target as HTMLElement | null;
  const tag = tgt?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;
  if (hunterPopOpen.value || store.noticeOpen) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selection.value) {
    e.preventDefault();
    deleteSelection();
    return;
  }
  if (e.key === 'Escape') {
    if (legendOpen.value) {
      legendOpen.value = false;
      legendButton.value?.focus();
      return;
    }
    if (compactToolsOpen.value) {
      compactToolsOpen.value = false;
      compactToolsBtn.value?.focus();
      return;
    }
    if (compactMoreOpen.value) {
      compactMoreOpen.value = false;
      compactMoreBtn.value?.focus();
      return;
    }
    const hadPending =
      viewSettingsOpen.value ||
      archiveMenuOpen.value ||
      measurePending.value !== null ||
      placePending.value !== null ||
      routePickSlot.value !== null ||
      animArmed.value;
    viewSettingsOpen.value = false;
    archiveMenuOpen.value = false;
    measurePending.value = null;
    activeMeasureChainId = null;
    placePending.value = null;
    routePickSlot.value = null;
    animArmed.value = false;
    if (!hadPending) {
      selection.value = null;
      store.selectedUid = null;
    }
    return;
  }

  // WASD / Arrow key nudge for selected token / prop / text (2D only — 3D roaming owns WASD & Arrows)
  if (viewMode.value === '2d' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const k = e.key.toLowerCase();
    const step = e.shiftKey ? 0.02 : 0.005;
    if (k === 'w' || e.key === 'ArrowUp') {
      if (nudgeSelection(0, -step)) {
        e.preventDefault();
        return;
      }
    } else if (k === 's' || e.key === 'ArrowDown') {
      if (nudgeSelection(0, step)) {
        e.preventDefault();
        return;
      }
    } else if (k === 'a' || e.key === 'ArrowLeft') {
      if (nudgeSelection(-step, 0)) {
        e.preventDefault();
        return;
      }
    } else if (k === 'd' || e.key === 'ArrowRight') {
      if (nudgeSelection(step, 0)) {
        e.preventDefault();
        return;
      }
    }
  }

  if (e.code === 'Space' || e.key === ' ') {
    if (tgt instanceof HTMLElement && tgt.closest('button, summary, [role=button]')) return;
    e.preventDefault();
    if (showAnimBar.value) toggleGlobalAnimPlay();
    else if (!isStandalone.value && store.replay) togglePlay();
  } else if (viewMode.value === '2d' && e.key === 'ArrowLeft' && !isStandalone.value && store.replay) {
    e.preventDefault();
    stepBy(-5);
  } else if (viewMode.value === '2d' && e.key === 'ArrowRight' && !isStandalone.value && store.replay) {
    e.preventDefault();
    stepBy(5);
  } else if (e.key === '2') {
    set2D();
  } else if (e.key === '3') {
    set3D();
  }
}

function applySandboxHandoff(handoff: SandboxBoardHandoff): void {
  suspendDirector();
  if (handoff.whiteboard !== false) {
    whiteboardOverride.value = true;
  }
  const targetMap = resolvePilMapId(handoff.mapId);
  applyMapState(targetMap, false);
  if (handoff.enableZones !== false) {
    landmarks.zones = true;
  }
  if (handoff.highlightTid != null) {
    const found = boardState.value.tokens.find((t) => t.tid === handoff.highlightTid);
    if (found) {
      selection.value = { type: 'token', tid: found.tid };
      store.selectedUid = null;
    }
  }
  rightTab.value = 'tools';
}

let unsubMapChange: (() => void) | null = null;
let unsubHandoff: (() => void) | null = null;
let legendObserver: ResizeObserver | undefined;
let panelObserver: ResizeObserver | undefined;
const dockObstacles = [
  '.map-badges', '.compass', '.bookmark', '.bookmark .wax-seal',
  '.scale', '.board .hud', '.board .tac-coords-tip', '#strip', '#toolbar', '.view-pop', '.archive-pop', '.toolbar-menu-pop',
  '.director-band', '.control-band', '.folio-toggle', '.linked-cta', '[data-test=replay-summary]',
].join(',');

function bumpObstacles(): void {
  obstacleVersion.value++;
}

function positionLegend(): void {
  const lane = legendLane.value;
  const stage = lane?.closest('#stage') ?? lane?.closest('#stage2');
  const canvas = stage?.querySelector('[data-test=board-canvas]');
  const card = lane?.firstElementChild;
  if (!lane || !stage || !canvas || !card) return;
  const viewport = canvas.getBoundingClientRect();
  const track = lane.getBoundingClientRect();
  const width = card.getBoundingClientRect().width;
  const [mapLeft, mapRight] = mapEdges.value.map(edge => viewport.left + edge * viewport.width);
  const obstacles = Array.from(stage.querySelectorAll(dockObstacles), el => el.getBoundingClientRect());
  const fits = (left: number) => obstacles.every(r => !r.width || !r.height ||
    r.left >= left + width || r.right <= left || r.top >= track.bottom || r.bottom <= track.top);
  if (viewport.height < 600 || track.bottom > viewport.bottom || width > track.width) legendSide.value = null;
  else if (track.right - width >= mapRight + 4 && fits(track.right - width)) legendSide.value = 'right';
  else if (track.left + width <= mapLeft - 4 && fits(track.left)) legendSide.value = 'left';
  else legendSide.value = null;
  bumpObstacles();
}

watch(
  [
    mapEdges, hudExpanded, folioOpen, directorHeight, viewSettingsOpen, archiveMenuOpen,
    compactToolsOpen, compactMoreOpen, legendOpen, followUid, activeTool, rulerMode, isStandalone,
    () => flow.director, () => flow.summary, () => flow.mode, () => flow.link,
  ],
  () => {
    positionLegend();
    bumpObstacles();
  },
  { flush: 'post' },
);
onMounted(() => {
  if (boardPanelEl.value) {
    boardPanelWidth.value = boardPanelEl.value.clientWidth;
    if (typeof ResizeObserver !== 'undefined') {
      panelObserver = new ResizeObserver(([entry]) => {
        if (!entry) return;
        const w = Math.round(entry.contentRect.width);
        if (w !== boardPanelWidth.value) {
          boardPanelWidth.value = w;
          bumpObstacles();
        }
      });
      panelObserver.observe(boardPanelEl.value);
    }
  }
  const stage = legendLane.value?.closest('#stage');
  if (stage && legendLane.value && typeof ResizeObserver !== 'undefined') {
    legendObserver = new ResizeObserver(positionLegend);
    legendObserver.observe(legendLane.value);
    stage.querySelectorAll(dockObstacles).forEach(el => legendObserver!.observe(el));
  }
  window.addEventListener('keydown', onKey);
  unsubMapChange = onActiveMapChange((nextId) => {
    if (suppressMapSync) return;
    if (nextId !== activeMapId.value) {
      applyMapState(nextId, true);
    }
  });
  unsubHandoff = onSandboxBoardHandoff((h) => {
    consumeSandboxBoardHandoff();
    applySandboxHandoff(h);
  });
  const pendingHandoff = consumeSandboxBoardHandoff();
  if (pendingHandoff) {
    applySandboxHandoff(pendingHandoff);
  } else {
    void ensureNavGrid(activeMapId.value);
  }
});

onBeforeUnmount(() => {
  panelObserver?.disconnect();
  panelObserver = undefined;
  legendObserver?.disconnect();
  window.removeEventListener('keydown', onKey);
  unsubMapChange?.();
  unsubMapChange = null;
  unsubHandoff?.();
  unsubHandoff = null;
  cancelRangeJob();
  if (highlightTimer) clearTimeout(highlightTimer);
  stopAnimRaf();
});

watch(
  () => store.selectedId,
  () => {
    ruler.value = null;
    followUid.value = null;
    whiteboardOverride.value = false;
    if (store.replay) {
      underlay.rotationQuadrants = isDraft.value ? MAPS_DATA[activeMapId.value]!.gridPlacement.rotationQuadrants : 0;
      const synced = syncActiveMapByName(store.replay.match.map_name);
      if (synced !== null && synced !== activeMapId.value) {
        applyMapState(synced, true);
      }
    }
  },
);

watch(
  () => store.replay,
  (rep) => {
    if (rep) {
      whiteboardOverride.value = false;
      underlay.rotationQuadrants = isDraft.value ? MAPS_DATA[activeMapId.value]!.gridPlacement.rotationQuadrants : 0;
      const synced = syncActiveMapByName(rep.match.map_name);
      if (synced !== null && synced !== activeMapId.value) {
        applyMapState(synced, true);
      }
    } else {
      underlay.rotationQuadrants = MAPS_DATA[activeMapId.value]?.gridPlacement.rotationQuadrants ?? 0;
    }
  },
);

defineExpose({
  viewMode,
  is3D,
  set2D,
  set3D,
  pitch,
  yaw,
  yScale,
  floor,
  rulerMode,
  ruler,
  followUid,
  board,
  board3d,
  underlay,
  // Stage 2 additions exposed for verification
  activeTool,
  rightTab,
  viewSettingsOpen,
  archiveMenuOpen,
  whiteboardOverride,
  isStandalone,
  activeMapId,
  cipherGroupIndex,
  boardState,
  selection,
  placePending,
  drawShape,
  measureMode,
  measurePending,
  measureVault,
  measureAutoFix,
  delSegOnly,
  routePickSlot,
  routePointA,
  routePointB,
  routeFixNote,
  rangeState,
  rangeEval,
  rangeNavField,
  navGridData,
  animTime,
  animPlaying,
  animArmed,
  animAutoRoute,
  animVault,
  animSpeedPresetKey,
  zoomLocked,
  exportCrop,
  exportRot,
  highlightedCipherId,
  undoStack,
  lastExportedJson,
  landmarks,
  geo,
  undo,
  clearBoard,
  rotateBoard90,
  runTwoPointRoute,
  selectBasementRangeChair,
  exportJsonArchive,
  importJsonText,
  exportBoardPng,
  animPositionAt,
  renderTacticalOverlay,
});
</script>

<template>
  <div id="stage2" :class="{ 'folio-closed': !folioOpen }">
    <div
      id="boardPanel"
      ref="boardPanelEl"
      :data-prop-retreat="(compactToolsOpen || compactMoreOpen) ? 'true' : undefined"
      :data-prop-retreat-left="mapIntrudesLeftProp ? 'true' : undefined"
      :data-prop-retreat-right="mapIntrudesRightProp ? 'true' : undefined"
    >
      <div v-if="isDraft" class="linked-cta" data-test="practice-draft"><NextStepCta :step="4" label="返回盲练选点 → 04" /></div>
      <label v-if="flow.mode === 'pro-opening' && flow.draftBoard?.shapes.length" class="linked-cta dark fr cut">
        <input v-model="showGhost" type="checkbox" data-test="practice-draft-ghost" />我的开局草稿
      </label>
      <SummaryBanner v-if="!isStandalone" />
      <div v-if="flow.link?.matchId === store.selectedId && autoEnabled() && !isStandalone" class="linked-cta"><NextStepCta :step="4" label="选点复盘 → 04" /></div>
      <button type="button" class="folio-toggle" data-test="folio-toggle" aria-controls="rightCol" :aria-expanded="folioOpen"
        :aria-label="folioOpen ? '收起卷宗' : '展开卷宗'" title="卷宗（]）" @click="toggleFolio">
        {{ folioOpen ? '›' : '‹' }}
      </button>
      <!-- Top Context Strip: Replay Players OR Standalone 9-Map Selector & Cyclers -->
      <div id="strip" :class="{ standalone: isStandalone, 'hud-expanded': hudExpanded }">
        <button type="button" class="gbtn fr cut sm hud-toggle" :aria-expanded="hudExpanded" @click="hudExpanded = !hudExpanded">
          {{ isStandalone ? '地图' : '玩家' }} ▾
        </button>
        <div class="hud-content">
          <template v-if="!isStandalone && store.replay">
            <button
              id="hSlot"
              class="fr cut"
              :class="{ on: hunter && followUid === hunter.uid }"
              :aria-label="hunter?.player_name ?? '监管者'"
              :aria-pressed="Boolean(hunter && followUid === hunter.uid)"
              :title="hunter ? '点击锁定镜头跟随监管者' : ''"
              @click="hunter && toggleFollow(hunter.uid)"
            >
              <span class="hm" :class="{ seal: !portrait }"><img :src="portraitSrc" alt="监管者" @error="onPortraitError" /></span>
              <span class="hunter-hud-label">
                <b>{{ hunter?.player_name ?? '监管者' }}</b>
                <small>{{ pidLabel(hunter?.pid) }}{{ followUid !== null && followUid === hunter?.uid ? ' · 跟随中' : '' }}</small>
              </span>
            </button>
            <button class="hpick" data-test="hunter-pick" title="选择展示用监管者肖像" @click="hunterPopOpen = true">肖像 ▾</button>
            <div id="svRow">
              <button
                v-for="(s, i) in survivorStates"
                :key="s.p.uid"
                class="svtok"
                :class="[`s${s.fear ?? 0}`, { on: followUid === s.p.uid }]"
                :data-uid="s.p.uid"
                :aria-label="s.p.player_name"
                :aria-pressed="followUid === s.p.uid"
                :title="`${s.p.player_name} · ${pidLabel(s.p.pid)} · 点击锁定跟随`"
                @click="toggleFollow(s.p.uid)"
              >
                <span class="sv">{{ i + 1 }}</span>
                <span class="nm"><b>{{ s.p.player_name }}</b><em>{{ fearStateLabel(s.fear) }}{{ followUid === s.p.uid ? ' · 跟随' : '' }}</em></span>
              </button>
            </div>
            <button class="gbtn fr cut sm" data-test="btn-switch-whiteboard" @click="toggleWhiteboardOverride(true)">演练白板</button>
          </template>

          <template v-else>
            <div class="tac-strip-maps">
              <span class="k">白板地图</span>
              <select
                class="sel"
                :value="activeMapId"
                data-test="sandbox-map-select" :disabled="isDraft"
                aria-label="选择地图"
                @change="onSelectMap"
              >
                <option v-for="m in MAPS_DATA" :key="m.mapId" :value="m.mapId">{{ m.mapName }}</option>
              </select>

              <span class="tac-cyc" v-if="!isDraft">
                <span class="k">电机</span>
                <button class="gbtn fr cut sm" data-test="btn-cipher-prev" @click="cycleCiphers(-1)">‹</button>
                <span class="num">{{ (cipherGroupIndex % cipherGroupCount) + 1 }}/{{ cipherGroupCount }}</span>
                <button class="gbtn fr cut sm" data-test="btn-cipher-next" @click="cycleCiphers(1)">›</button>
              </span>

              <span v-if="chairSetCount > 0" class="tac-cyc">
                <span class="k">椅组</span>
                <button class="gbtn fr cut sm" data-test="btn-chair-prev" @click="cycleChairs(-1)">‹</button>
                <span class="num">{{ (boardState.chairIndex % chairSetCount) + 1 }}/{{ chairSetCount }}</span>
                <button class="gbtn fr cut sm" data-test="btn-chair-next" @click="cycleChairs(1)">›</button>
              </span>

              <span v-if="basementCount > 0" class="tac-cyc">
                <span class="k">地下室</span>
                <button class="gbtn fr cut sm" data-test="btn-basement-prev" @click="cycleBasement(-1)">‹</button>
                <span class="num">{{ (boardState.chairBasementIndex % basementCount) + 1 }}/{{ basementCount }}</span>
                <button class="gbtn fr cut sm" data-test="btn-basement-next" @click="cycleBasement(1)">›</button>
              </span>

              <span v-if="dungeonCount > 0" class="tac-cyc">
                <span class="k">地窖</span>
                <button class="gbtn fr cut sm" data-test="btn-dungeon-prev" @click="cycleDungeon(-1)">‹</button>
                <span class="num">{{ (boardState.dungeonIndex % dungeonCount) + 1 }}/{{ dungeonCount }}</span>
                <button class="gbtn fr cut sm" data-test="btn-dungeon-next" @click="cycleDungeon(1)">›</button>
              </span>

              <button
                v-if="!isDraft && store.replay"
                class="gbtn fr cut sm on"
                data-test="btn-switch-replay"
                @click="toggleWhiteboardOverride(false)"
              >
                返回复盘
              </button>
              <span v-else-if="!isDraft && store.replayLoading" class="muted" style="font-size: 12px">录像载入中…</span>
            </div>
          </template>
        </div>
      </div>

      <!-- Compact Single-Row Toolbar + Popovers inside #toolbarWrap -->
      <div id="toolbarWrap" :class="{ 'is-compact': compactToolbar }">
        <div id="toolbar" class="dark fr cut">
          <div class="tgroup seg">
            <button class="gbtn fr cut sm" :class="{ on: viewMode === '2d' }" data-test="btn-2d" @click="set2D">2D</button>
            <button class="gbtn fr cut sm" :class="{ on: viewMode === '3d' }" :disabled="!canUse3D" data-test="btn-3d" @click="set3D">3D</button>
          </div>

          <div class="tgroup seg">
            <button
              v-for="f in (['ALL', 'B1', '1F', '2F'] as const)"
              :key="f"
              class="gbtn fr cut sm"
              :class="{ on: floor === f }"
              :data-floor="f"
              @click="floor = f"
            >
              {{ f === 'ALL' ? '全部' : f }}
            </button>
          </div>

          <div class="tgroup seg">
            <template v-if="!compactToolbar">
              <button class="gbtn fr cut sm" :class="{ on: activeTool === 'inspect' }" data-tool="inspect" @click="selectTool('inspect')">检视</button>
              <button class="gbtn fr cut sm" :class="{ on: activeTool === 'place' }" data-tool="place" @click="selectTool('place')">放置</button>
              <button class="gbtn fr cut sm" :class="{ on: activeTool === 'draw' }" data-tool="draw" @click="selectTool('draw')">绘制</button>
              <button class="gbtn fr cut sm" :class="{ on: activeTool === 'measure' }" data-tool="measure" @click="selectTool('measure')">测算</button>
              <button class="gbtn fr cut sm" :class="{ on: activeTool === 'range' }" data-tool="range" @click="selectTool('range')">范围</button>
              <button class="gbtn fr cut sm" :class="{ on: activeTool === 'anim' }" data-tool="anim" @click="selectTool('anim')">动画</button>
            </template>
            <button
              v-else
              ref="compactToolsBtn"
              type="button"
              class="gbtn fr cut sm"
              :class="{ on: compactToolsOpen || activeTool !== 'inspect' }"
              data-test="btn-compact-tools"
              aria-haspopup="menu"
              aria-controls="compact-tools-menu"
              :aria-expanded="compactToolsOpen"
              @click="toggleCompactTools"
            >
              {{ activeTool === 'inspect' ? '工具' : TOOL_LABELS[activeTool] }} ▾
            </button>
            <button class="gbtn fr cut sm" :class="{ on: rulerMode }" data-test="btn-ruler" @click="toggleRuler">{{ rulerMode ? '测距中' : '测距' }}</button>
            <button v-show="ruler" class="gbtn fr cut sm" data-test="btn-ruler-clear" @click="clearRuler">清除</button>
          </div>

          <div class="tgroup seg" style="margin-left: auto">
            <button class="gbtn fr cut sm" :class="{ on: viewSettingsOpen }" :aria-expanded="viewSettingsOpen" data-test="btn-view-settings" @click="toggleViewSettings">视图/图层 ▾</button>
            <template v-if="!compactToolbar">
              <button class="gbtn fr cut sm" :disabled="!undoStack.length" data-test="btn-tac-undo" @click="undo">撤销</button>
              <button class="gbtn fr cut sm" data-test="btn-tac-clear" @click="clearBoard">清空</button>
              <button class="gbtn fr cut sm" :class="{ on: archiveMenuOpen }" :aria-expanded="archiveMenuOpen" data-test="btn-tac-archive" @click="toggleArchiveMenu">存档 ▾</button>
              <button class="gbtn fr cut sm" data-test="btn-tac-export" @click="exportBoardPng()">导出PNG</button>
            </template>
            <button
              v-else
              ref="compactMoreBtn"
              type="button"
              class="gbtn fr cut sm"
              :class="{ on: compactMoreOpen || archiveMenuOpen }"
              data-test="btn-compact-more"
              aria-haspopup="menu"
              aria-controls="compact-more-menu"
              :aria-expanded="compactMoreOpen"
              @click="toggleCompactMore"
            >
              更多 ▾
            </button>
          </div>
        </div>

        <div
          v-if="compactToolbar"
          v-show="compactToolsOpen"
          id="compact-tools-menu"
          ref="compactToolsMenu"
          class="toolbar-menu-pop dark fr cut"
          role="menu"
          aria-label="战术工具菜单"
          data-test="compact-tools-menu"
          @keydown="onCompactMenuKeydown($event, 'tools')"
        >
          <button
            v-for="toolId in (['inspect', 'place', 'draw', 'measure', 'range', 'anim'] as const)"
            :key="toolId"
            type="button"
            role="menuitem"
            class="gbtn fr cut sm"
            :class="{ on: activeTool === toolId }"
            :data-tool="toolId"
            @click="selectCompactTool(toolId)"
          >
            {{ TOOL_LABELS[toolId] }}
          </button>
        </div>

        <div
          v-if="compactToolbar"
          v-show="compactMoreOpen"
          id="compact-more-menu"
          ref="compactMoreMenu"
          class="toolbar-menu-pop toolbar-more-pop dark fr cut"
          role="menu"
          aria-label="更多操作菜单"
          data-test="compact-more-menu"
          @keydown="onCompactMenuKeydown($event, 'more')"
        >
          <button type="button" role="menuitem" class="gbtn fr cut sm" :disabled="!undoStack.length" data-test="btn-tac-undo" @click="undo(); compactMoreOpen = false">撤销</button>
          <button type="button" role="menuitem" class="gbtn fr cut sm" data-test="btn-tac-clear" @click="clearBoard(); compactMoreOpen = false">清空</button>
          <button type="button" role="menuitem" class="gbtn fr cut sm" :class="{ on: archiveMenuOpen }" data-test="btn-tac-archive" @click="toggleArchiveMenu">存档 ▾</button>
          <button type="button" role="menuitem" class="gbtn fr cut sm" data-test="btn-tac-export" @click="exportBoardPng(); compactMoreOpen = false">导出PNG</button>
        </div>

        <ViewSettingsPopover
          v-model:open="viewSettingsOpen"
          v-model:viewCones="viewCones"
          v-model:trails="trails"
          v-model:dirArrows="dirArrows"
          v-model:labels="labels"
          v-model:zoomLocked="zoomLocked"
          :underlay="underlay"
          :underlay-status="underlayStatus"
          :landmarks="landmarks"
          :spawn-index="boardState.spawnIndex"
          :spawn-count="spawnCount"
          :cipher-group-index="cipherGroupIndex"
          :cipher-group-count="cipherGroupCount"
          :chair-index="boardState.chairIndex"
          :chair-set-count="chairSetCount"
          :chair-basement-index="boardState.chairBasementIndex"
          :box-basement-index="boardState.boxBasementIndex"
          :basement-count="basementCount"
          :dungeon-index="boardState.dungeonIndex"
          :dungeon-count="dungeonCount"
          :has-phone-booths="hasPhoneBooths"
          @zoom="(f) => board?.zoomBy(f)"
          @reset-view="resetView"
          @rotate-underlay="rotateUnderlay"
          @rotate-board-90="rotateBoard90"
          @cycle-spawn="cycleSpawn"
          @cycle-cipher="cycleCiphers"
          @cycle-chair="cycleChairs"
          @cycle-basement="cycleBasement"
          @cycle-box-basement="cycleBoxBasement"
          @cycle-dungeon="cycleDungeon"
        />

        <div v-show="archiveMenuOpen" class="archive-pop dark fr cut" data-test="archive-popover">
          <div class="vp-head">
            <span class="k">战术板存档与导出 · {{ mapCountObj.mapName }}</span>
            <button class="gbtn fr cut sm" @click="archiveMenuOpen = false">收起</button>
          </div>
          <div class="vp-row">
            <button class="gbtn fr cut sm" data-test="btn-export-json" @click="exportJsonArchive">导出 JSON</button>
            <label class="gbtn fr cut sm tac-file-btn">
              导入 JSON
              <input type="file" accept=".json,application/json" data-test="input-import-json" @change="onImportJsonFile" />
            </label>
            <button class="gbtn fr cut sm" data-test="btn-archive-export-png" @click="exportBoardPng()">导出 PNG</button>
          </div>
          <div class="tac-export-opts">
            <label class="tac-export-chk">
              <input v-model="exportCrop" type="checkbox" data-test="toggle-export-crop" />
              导出裁剪当前视野
            </label>
            <label class="tac-export-chk">
              <input v-model="exportRot" type="checkbox" data-test="toggle-export-rot" />
              导出保留旋转
            </label>
          </div>
          <p v-if="archiveMsg" class="gold" style="margin: 4px 0 0; font-size: 12px" data-test="tac-archive-msg">{{ archiveMsg }}</p>
          <p v-if="archiveErr" class="red" style="margin: 4px 0 0; font-size: 12px" data-test="tac-archive-err">{{ archiveErr }}</p>
        </div>
      </div>

      <!-- Canvas Viewport -->
      <div class="boardWrap">
        <div v-if="!isStandalone" v-show="viewMode === '2d'" ref="directorBand" class="director-band"><DirectorBar /></div>
        <TacticalBoardCanvas
          v-show="viewMode === '2d'"
          ref="board"
          :director-height="directorHeight"
          :folio-open="folioOpen"
          :legend-side="legendSide"
          :obstacle-version="obstacleVersion"
          @map-edges="(left, right) => mapEdges = [left, right]"
          @map-rect="(rect) => mapRect = rect"
          v-model:pitch="pitch"
          v-model:yaw="yaw"
          v-model:ruler="ruler"
          v-model:selected-uid="store.selectedUid"
          :follow-uid="followUid" @update:follow-uid="changeFollow"
          :payload="effectivePayload"
          :t="store.t"
          :y-scale="yScale"
          :layers="layers"
          :underlay="underlay"
          :ruler-mode="rulerMode"
          :focus="store.focus"
          :chase-segments="chaseSegments"
          :board="displayBoard"
          :geo="geo"
          :landmarks="landmarks"
          :cipher-group-index="cipherGroupIndex"
          :active-tool="activeTool"
          :selection="selection"
          :place-pending="placePending"
          :draw-shape="drawShape"
          :draw-color="drawColor"
          :draw-width="drawWidth"
          :range-state="rangeState"
          :range-eval="rangeEval"
          :board-chairs="boardChairs"
          :measure-pending="measurePending"
          :anim-time="animTime"
          :anim-playing="animPlaying || animSinglePlaying"
          :anim-armed="animArmed"
          :zoom-locked="zoomLocked"
          :route-pick-slot="routePickSlot"
          :route-point-a="routePointA"
          :route-point-b="routePointB"
          :highlighted-cipher-id="highlightedCipherId"
          :export-crop="exportCrop"
          :export-rot="exportRot"
          @underlay-status="underlayStatus = $event"
          @pick="onReplayPick"
          @tac-select="onTacSelect"
          @tac-place="onTacPlace"
          @tac-drag-start="onTacDragStart"
          @tac-drag-end="onTacDragEnd"
          @tac-move-token="onTacMoveToken"
          @tac-move-prop="onTacMoveProp"
          @tac-move-text="onTacMoveText"
          @tac-move-measure-end="onTacMoveMeasureEnd"
          @tac-move-anim-dot="onTacMoveAnimDot"
          @tac-draw-commit="onTacDrawCommit"
          @tac-measure-click="onTacMeasureClick"
          @tac-measure-finish="finishMeasureChain"
          @tac-route-pick="onTacRoutePick"
          @tac-range-click="onTacRangeClick"
          @tac-anim-add-point="onTacAnimAddPoint"
        >
          <template #map-badges>
            <div class="map-badges">
              <b>{{ displayedMap }}</b><i>Map</i>
              <span v-if="!isStandalone">{{ completedCiphers }}/{{ liveCiphers.length }} 机</span>
              <span v-else>{{ isDraft ? '草稿' : '白板' }}</span>
            </div>
            <div v-show="viewMode === '2d'" ref="legendLane" class="legend-lane" :class="legendSide">
              <div
                class="legend-card"
                :class="legendSide && ['map-key', legendSide]"
                :style="legendSide === 'right' ? { marginRight: `${Math.max(0, railInsetRightPx - 10)}px` } : undefined"
                aria-label="地图图例"
              >
                <strong>图例 <i>Legend</i></strong>
                <span v-for="[icon, zh, en, camp] in legendItems" :key="en"><b :class="camp">{{ icon }}</b>{{ zh }}<i>{{ en }}</i></span>
              </div>
            </div>
            <div
              v-if="folioOpen && legendSide === 'right'"
              v-show="viewMode === '2d'"
              class="rail-zoom-tools"
              :style="{ right: `${railInsetRightPx}px` }"
              role="group"
              aria-label="地图缩放快捷控制"
            >
              <button type="button" class="rail-btn" data-test="rail-zoom-in" title="放大地图" :disabled="zoomLocked" @click="board?.zoomBy(1.25)">＋</button>
              <button type="button" class="rail-btn" data-test="rail-zoom-out" title="缩小地图" :disabled="zoomLocked" @click="board?.zoomBy(0.8)">－</button>
              <button type="button" class="rail-btn" :class="{ on: zoomLocked }" data-test="rail-zoom-lock" title="锁定缩放/拖动" @click="zoomLocked = !zoomLocked">{{ zoomLocked ? '解锁' : '锁定' }}</button>
              <button type="button" class="rail-btn" data-test="rail-rotate-90" title="顺时针旋转 90°" @click="rotateBoard90">↻90°</button>
              <button type="button" class="rail-btn" data-test="rail-reset" title="复位视角" @click="resetView">复位</button>
            </div>
            <div
              v-if="viewMode === '2d' && legendSide === null && boardPanelWidth > 0 && boardPanelWidth < 900"
              class="mobile-zoom-tools"
              data-test="mobile-zoom-tools"
              role="group"
              aria-label="移动端地图缩放快捷控制"
            >
              <button type="button" class="rail-btn" data-test="mobile-zoom-in" title="放大地图" aria-label="放大地图" :disabled="zoomLocked" @click="board?.zoomBy(1.25)">＋</button>
              <button type="button" class="rail-btn" data-test="mobile-zoom-out" title="缩小地图" aria-label="缩小地图" :disabled="zoomLocked" @click="board?.zoomBy(0.8)">－</button>
              <button type="button" class="rail-btn" data-test="mobile-zoom-reset" title="复位视角" aria-label="复位视角" @click="resetView">复位</button>
            </div>
          </template>
        </TacticalBoardCanvas>
        <Tactical3DCanvas
          v-if="viewMode === '3d'"
          ref="board3d"
          class="board-3d-layer"
          :map-id="activeMapId"
          :payload="effectivePayload"
          :t="store.t"
          :is-standalone="isStandalone"
          :hud-expanded="hudExpanded"
          :floor="floor"
          :board="displayBoard"
          :cipher-group-index="cipherGroupIndex"
          :anim-time="animTime"
          :anim-playing="animPlaying || animSinglePlaying"
          :route-point-a="routePointA"
          :route-point-b="routePointB"
          :range-state="rangeState"
          :selected-uid="store.selectedUid != null ? String(store.selectedUid) : null"
          :follow-uid="followUid != null ? String(followUid) : null"
          :landmarks="landmarks"
          @handoff-to-2d="onHandoffFrom3D"
        />
      </div>

      <!-- Bottom Transport: Global Animation Bar OR Replay Scrubber -->
      <div class="control-band" :class="{ 'legend-open': legendOpen }">
        <TacticalAnimBar
          v-if="showAnimBar"
          :board="boardState"
          :geo="geo"
          :anim-time="animTime"
          :anim-playing="animPlaying"
          :selection="selection"
          @toggle-play="toggleGlobalAnimPlay"
          @reset="resetAnimPlayback"
          @scrub="scrubAnim"
          @select="onTacSelect"
        />

        <div v-else id="transport" class="dark fr cut">
          <div v-if="!isDraft && store.replay" class="mode-pills" role="group" aria-label="沙盘模式">
            <button type="button" :aria-pressed="!isStandalone" @click="isStandalone && toggleWhiteboardOverride(false)">实况</button>
            <button type="button" :aria-pressed="isStandalone" @click="!isStandalone && toggleWhiteboardOverride(true)">白板</button>
          </div>
          <div class="row1">
            <button class="gbtn fr cut sm" data-test="btn-back5" :disabled="isStandalone" @click="stepBy(-5)">−5s</button>
            <button class="gbtn fr cut" :class="{ on: store.playing }" data-test="btn-play" :disabled="isStandalone" @click="togglePlay">
              {{ store.playing ? '暂停' : '播放' }}
            </button>
            <button class="gbtn fr cut sm" data-test="btn-fwd5" :disabled="isStandalone" @click="stepBy(5)">+5s</button>
            <select class="sel" :value="store.speed" data-test="speed" aria-label="倍速" :disabled="isStandalone" @change="onSpeed">
              <option v-for="s in PLAYBACK_SPEEDS" :key="s" :value="s">{{ s }}x</option>
            </select>
            <span class="clock num" data-test="clock">{{ formatClock(isStandalone ? 0 : store.t, true) }} / {{ formatClock(isStandalone ? 0 : dur) }}</span>
            <details class="transport-help">
              <summary aria-label="快捷键">?</summary>
              <p>空格 播放/暂停 · ←/→ ±5s 或微调选中造物 · WASD微调(Shift粗调) · 2/3 切换2D/3D · Esc 取消 · Del 删除 · Ctrl+Z 撤销 · ] 卷宗</p>
            </details>
          </div>
          <div id="timeline">
            <span v-if="flow.mode === 'pro-opening' && flow.segment" class="opening-window"
              :style="{ width: flow.segment.end / Math.max(1, dur) * 100 + '%' }"></span>
            <button
              v-for="(m, i) in !isStandalone ? (store.replay?.markers ?? []) : []"
              :key="`${m.type}-${i}`"
              class="mk"
              :class="m.type"
              :style="{ left: markerLeft(m.t) }"
              :title="`${formatClock(m.t)} ${m.label_zh}`"
              :data-marker="m.type"
              @click="seek(m.t)"
            ></button>
            <input
              type="range"
              min="0"
              :max="isStandalone ? 1 : dur"
              step="0.1"
              :value="isStandalone ? 0 : store.t"
              data-test="scrubber"
              :disabled="isStandalone"
              aria-label="时间轴"
              @input="onScrub"
            />
          </div>
        </div>
        <div v-if="!legendSide" class="legend-controls">
          <div v-show="legendOpen" id="sandbox-legend" class="legend-strip" aria-label="地图图例">
            <span v-for="[icon, zh, en, camp] in legendItems" :key="en"><b :class="camp">{{ icon }}</b>{{ zh }}<i>{{ en }}</i></span>
          </div>
          <button ref="legendButton" type="button" class="gbtn" aria-controls="sandbox-legend" :aria-expanded="legendOpen"
            @click="legendOpen = !legendOpen">图例</button>
        </div>
      </div>
    </div>

    <!-- Clean 3-Tab Right Column -->
    <div v-show="folioOpen" id="rightCol" class="paper-folio folio-stack">
      <ManorOrnaments kind="clip" />
      <header class="file-heading">
        <ManorOrnaments kind="laurel" class="heading-laurel" />
        <small class="folio-eyebrow">OLETUS MANOR · CASE FILES</small>
        <h2>{{ displayedMap }} · {{ isDraft ? '开局草稿' : isStandalone ? '演练白板' : '战术卷宗' }}</h2>
        <div class="folio-subrow">
          <span class="folio-en">{{ folioSubtitle }}</span>
          <span class="folio-serial num" data-test="folio-serial" :title="folioSerialTitle">{{ folioSerial }}</span>
        </div>
      </header>
      <div class="folio-inner">
        <div id="rightTabs" class="dark fr cut">
          <button
            class="gbtn fr cut sm"
            :class="{ on: rightTab === 'status' }"
            data-right-tab="status"
            @click="rightTab = 'status'"
          >
            {{ isStandalone ? '地图资料' : '阵容与天赋' }}
          </button>
          <button
            class="gbtn fr cut sm"
            :class="{ on: rightTab === 'events' }"
            data-right-tab="events"
            @click="rightTab = 'events'"
          >
            大事件轴
          </button>
          <button
            class="gbtn fr cut sm"
            :class="{ on: rightTab === 'tools' }"
            data-right-tab="tools"
            @click="rightTab = 'tools'"
          >
            战术工具
          </button>
        </div>

        <section v-if="isDraft && rightTab === 'status'" class="card dark fr cut">
          <h3>我的开局草稿</h3>
          <p>用「绘制」画出预测路线，揭晓后可和实况叠加查看。</p>
        </section>
        <DossierPanel
          v-if="!isDraft"
          v-show="rightTab === 'status'"
          :payload="effectivePayload"
          :analytics="isStandalone ? null : store.analytics"
          :t="store.t"
          :selected-uid="store.selectedUid"
          :ruler="ruler"
          :is-standalone="isStandalone"
          :geo="geo"
          :cipher-group-index="cipherGroupIndex"
          :board="boardState"
          :selection="selection"
          @inspect-player="uid => { selection = null; store.selectedUid = uid; }"
          @clear-selection="store.selectedUid = null; selection = null"
          @delete-tac="deleteSelection"
          @focus-tools="rightTab = 'tools'"
          @focus-place="selectTool('place')"
          @quick-opening="applyOpeningScenario()"
          @quick-endgame="applyEndgameScenario($event)"
        />

        <section v-if="rightTab === 'status' && !isStandalone && store.replay" class="recent-events">
          <div class="ribbon-track">
            <h3 class="ribbon-h">近期关键事件 <small>Recent Events</small></h3>
          </div>
          <ul v-if="store.replay.markers.some(m => m.t <= store.t)">
            <li v-for="(m, index) in store.replay.markers.filter(m => m.t <= store.t).slice(-5).reverse()" :key="index">
              <button class="recent-event" @click="seek(m.t)">
                <span class="note-bullet" aria-hidden="true">❖</span>
                <time class="num">{{ formatClock(m.t) }}</time>
                <span class="note-label">{{ m.label_zh }}</span>
              </button>
            </li>
          </ul>
          <p v-else class="recent-empty">当前时间之前暂无关键事件。</p>
        </section>
        <TacticalToolsPanel
          v-show="rightTab === 'tools'"
          v-model:active-tool="activeTool"
          v-model:selection="selection"
          v-model:place-pending="placePending"
          v-model:draw-shape="drawShape"
          v-model:draw-color="drawColor"
          v-model:draw-width="drawWidth"
          v-model:text-input="textInput"
          v-model:text-font-size="textFontSize"
          v-model:snap-landmarks="landmarks.snapLandmarks"
          v-model:measure-mode="measureMode"
          v-model:measure-scope="measureScope"
          v-model:measure-camp="measureCamp"
          v-model:measure-base="measureBase"
          v-model:measure-buffs="measureBuffs"
          v-model:measure-vault="measureVault"
          v-model:measure-auto-fix="measureAutoFix"
          v-model:del-seg-only="delSegOnly"
          v-model:anim-armed="animArmed"
          v-model:anim-auto-route="animAutoRoute"
          v-model:anim-vault="animVault"
          v-model:anim-speed-preset-key="animSpeedPresetKey"
          :board="boardState"
          :geo="geo"
          :landmarks="landmarks"
          :cipher-group-index="cipherGroupIndex"
          :cipher-group-count="cipherGroupCount"
          :is-draft="isDraft"
          :highlighted-cipher-id="highlightedCipherId"
          :measure-pending="measurePending"
          :route-pick-slot="routePickSlot"
          :route-point-a="routePointA"
          :route-point-b="routePointB"
          :route-fix-note="routeFixNote"
          :route-computing="routeComputing"
          :range-state="rangeState"
          :range-eval="rangeEval"
          :basement-count="basementCount"
          :range-computing="rangeComputing"
          :anim-single-playing="animSinglePlaying"
          @route-pick-arm="armRoutePick"
          @route-run="runTwoPointRoute"
          @route-clear="clearTwoPointRoute"
          @finish-measure-chain="finishMeasureChain"
          @delete-measure="deleteMeasure"
          @delete-shape="deleteShape"
          @delete-text="deleteText"
          @mutate="mutateBoard"
          @delete-selection="deleteSelection"
          @anim-apply-preset="onAnimApplyPreset"
          @anim-remove-point="onAnimRemovePoint"
          @anim-recompute-all="recomputeAllAnimPaths"
          @toggle-anim-single="toggleSingleAnimPlay"
          @reset-anim-single="resetAnimPlayback"
          @clear-anim="clearAnimTarget"
          @range-pick-arm="() => { activeTool = 'range'; rightTab = 'tools'; }"
          @range-clear="rangeState.origin = null"
          @range-toggle-basement="selectBasementRangeChair()"
          @cycle-basement="cycleBasement"
          @cycle-cipher="cycleCiphers"
          @cycle-spawn="cycleSpawn"
          @highlight-cipher="highlightCipher"
          @swap-mirror="swapMirror"
          @apply-opening-scenario="applyOpeningScenario"
          @apply-endgame-scenario="applyEndgameScenario"
        />

        <p v-if="isDraft && rightTab === 'events'" class="draft-note">草稿阶段没有公开事件。</p>
        <TacticalEventFeed
          v-if="!isDraft"
          v-show="rightTab === 'events'"
          :payload="isStandalone ? null : store.replay"
          :is-standalone="isStandalone"
          :t="store.t"
        />
      </div>
    </div>

    <HunterPop v-model:open="hunterPopOpen" :selected="portrait" :pid="hunter?.pid ?? null" @select="onPortraitSelect" />
  </div>
</template>

<style scoped>
.boardWrap { position: relative; }
.boardWrap > :deep(.board-3d-layer),
.board-3d-layer {
  position: absolute !important;
  inset: 0;
  z-index: 5;
  width: 100%;
  height: 100%;
}
.opening-window { position: absolute; inset: 0 auto 0 0; background: #c9a25f40; pointer-events: none; }
.linked-cta { position: absolute; z-index: 4; right: 12px; bottom: 92px; }

/* Ebony-and-burnished-brass top HUD strip (#strip) */
#strip .hud-toggle {
  border: 1px solid #b58d52;
  border-radius: 4px;
  clip-path: none;
  min-height: 30px;
  padding: 3px 9px;
  background: linear-gradient(180deg, #2b241c 0%, #171411 100%);
  box-shadow:
    inset 0 0 0 1px rgba(244, 214, 156, 0.2),
    inset 0 1px 0 rgba(255, 245, 218, 0.16),
    0 3px 8px rgba(0, 0, 0, 0.56);
  color: #f4e4c4;
  font: 600 12px/1.2 var(--font-cjk);
  letter-spacing: 0.03em;
}
#strip .hud-toggle::before { content: none; }
#strip .hud-toggle:hover {
  border-color: #e6be78;
  color: #fff6df;
  background: linear-gradient(180deg, #3b3024 0%, #201a14 100%);
}
#strip.hud-expanded .hud-content {
  background: linear-gradient(180deg, #221c16 0%, #141210 100%);
  border: 1px solid #b89154;
  border-radius: 5px;
  box-shadow:
    inset 0 0 0 1px rgba(244, 214, 156, 0.2),
    0 14px 30px rgba(0, 0, 0, 0.76);
}
#strip .hud-content .gbtn {
  border: 1px solid #8f6c3c;
  border-radius: 4px;
  clip-path: none;
  background: linear-gradient(180deg, #2d251d 0%, #1a1612 100%);
  color: #f3e2c2;
  font: 600 12px/1.2 var(--font-cjk);
  letter-spacing: 0.02em;
}
#strip .hud-content .gbtn::before { content: none; }
#strip .hud-content .gbtn.on {
  border-color: #e4bd77;
  background: linear-gradient(180deg, #744e29 0%, #4b3119 100%);
  color: #fff5de;
}
#strip .tac-strip-maps select.sel {
  height: 30px;
  padding: 2px 24px 2px 9px;
  font: 600 12.5px/1.2 var(--font-cjk);
}
#strip .tac-cyc {
  padding: 1px 4px;
  border: 1px solid rgba(181, 141, 82, 0.42);
  border-radius: 4px;
  background: rgba(18, 15, 12, 0.78);
  color: #dfd0b2;
}
#strip #hSlot {
  clip-path: none;
  border: 1px solid rgba(181, 141, 82, 0.56);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(38, 30, 22, 0.94), rgba(20, 17, 14, 0.94));
}
#strip #hSlot::before { content: none; }
#strip .svtok {
  border-radius: 14px;
  background: rgba(20, 17, 14, 0.78);
}

/* Ebony-and-burnished-brass top toolbar (#toolbar — strictly within TOOLBAR_NET_BUDGET_*) */
#toolbarWrap #toolbar {
  border: 1px solid #b89154;
  border-radius: 5px;
  clip-path: none;
  background: linear-gradient(180deg, #27221c 0%, #171513 56%, #1c1916 100%);
  box-shadow:
    inset 0 0 0 1px rgba(244, 214, 156, 0.22),
    inset 0 1px 0 rgba(255, 245, 218, 0.16),
    0 4px 12px rgba(0, 0, 0, 0.62);
}
#toolbarWrap #toolbar::before { content: none; }
#toolbarWrap #toolbar .tgroup.seg {
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  padding: 0 2px;
  gap: 2px;
}
#toolbarWrap #toolbar .tgroup + .tgroup {
  border-left: 1px solid rgba(202, 162, 100, 0.42);
  padding-left: 5px;
}
#toolbarWrap:not(.is-compact) #toolbar { gap: 2px; padding: 2px 4px; }
#toolbarWrap:not(.is-compact) #toolbar .tgroup { gap: 1px; }
#toolbarWrap:not(.is-compact) #toolbar .tgroup + .tgroup { padding-left: 4px; }
#toolbarWrap:not(.is-compact) #toolbar .gbtn { padding: 2px 5px; }
#toolbarWrap #toolbar .gbtn {
  clip-path: none;
  border: 1px solid transparent;
  border-radius: 4px;
  min-height: 24px;
  height: 26px;
  padding: 2px 6px;
  background: transparent;
  box-shadow: none;
  color: #f2e2c2;
  font: 600 12px/1.2 var(--font-cjk);
  letter-spacing: 0.01em;
  transition: filter 0.12s ease;
}
#toolbarWrap #toolbar .gbtn::before { content: none; }
#toolbarWrap #toolbar .gbtn:not(.on):enabled:hover {
  background: rgba(216, 179, 106, 0.14);
  border-color: rgba(216, 179, 106, 0.42);
  color: #fff6df;
}
#toolbarWrap #toolbar .gbtn.on,
#toolbarWrap #toolbar .gbtn.on:hover {
  color: #fff6df;
  border-color: #d6ae6c;
  background: linear-gradient(180deg, #744e29 0%, #4a3019 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 242, 206, 0.34),
    0 1px 3px rgba(0, 0, 0, 0.45);
}
#toolbarWrap #toolbar .seg:first-child button {
  clip-path: none;
  border-radius: 12px;
}
#toolbarWrap #toolbar .seg:first-child .on,
#toolbarWrap #toolbar .seg:first-child .on:hover {
  border-color: #f3d697;
  background: linear-gradient(180deg, #f8e6bb 0%, #d8b06d 100%);
  color: #26160b;
  box-shadow: inset 0 1px 0 rgba(255, 250, 232, 0.82);
}
.toolbar-menu-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 46;
  display: grid;
  grid-template-columns: repeat(2, minmax(84px, 1fr));
  gap: 5px;
  padding: 8px;
  border: 1px solid #b89154;
  border-radius: 5px;
  clip-path: none;
  background: linear-gradient(180deg, #231d17 0%, #151210 100%);
  box-shadow:
    inset 0 0 0 1px rgba(244, 214, 156, 0.22),
    0 14px 32px rgba(0, 0, 0, 0.78);
}
.toolbar-menu-pop::before { content: none; }
.toolbar-more-pop { grid-template-columns: minmax(108px, 1fr); }
.toolbar-menu-pop .gbtn {
  justify-content: center;
  min-height: 28px;
  padding: 3px 10px;
  clip-path: none;
  border: 1px solid #8a683a;
  border-radius: 4px;
  background: linear-gradient(180deg, #2d251d 0%, #1b1713 100%);
  font: 600 12px/1.2 var(--font-cjk);
  letter-spacing: 0.02em;
  color: #f2e2c2;
}
.toolbar-menu-pop .gbtn::before { content: none; }
.toolbar-menu-pop .gbtn.on {
  border-color: #e4bd77;
  background: linear-gradient(180deg, #744e29 0%, #4b3119 100%);
  color: #fff6df;
}
.toolbar-menu-pop .gbtn:focus-visible { outline: 2px solid #f4d298; outline-offset: -2px; }

/* Right parchment folio header + embossed laurel watermark + antique index tabs */
#rightCol.folio-stack { overflow: visible; padding-top: 0; padding-inline: 2px; display: flex; flex-direction: column; gap: 0; }
#rightCol .folio-inner { flex: 1; min-height: 0; scrollbar-width: thin; scrollbar-color: #a88c64 transparent; padding: 0 16px 18px; }
.file-heading {
  position: relative;
  flex: none;
  margin: 18px 20px 0;
  padding: 0 2px 8px;
  border-bottom: 1px solid rgba(154, 118, 66, 0.56);
  box-shadow: 0 1px 0 rgba(255, 250, 236, 0.62);
}
.file-heading :deep(.heading-laurel) {
  position: absolute;
  right: 0;
  top: 26px;
  width: 44px;
  height: 44px;
  z-index: 0;
  pointer-events: none;
  opacity: 0.92;
}
.file-heading :deep(.heading-laurel text) {
  fill: #4f3212;
}
.file-heading .folio-eyebrow {
  display: block;
  padding-right: 54px;
  color: #5d4020;
  font: 600 12px/1.25 var(--font-latin);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin-bottom: 5px;
}
.file-heading h2 {
  position: relative;
  z-index: 1;
  margin: 0;
  padding-right: 52px;
  color: #24150c;
  font: 900 clamp(22px, 1.8vw, 29px)/1.3 var(--font-cjk);
  letter-spacing: 0.04em;
  text-shadow: 0 1px 0 rgba(255, 248, 232, 0.72);
}
.folio-subrow {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-top: 3px;
  padding-right: 52px;
}
.folio-en {
  color: #4d341c;
  font: italic 600 15px/1.25 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
  letter-spacing: 0.015em;
}
.folio-serial {
  color: #7d2329;
  font: italic 700 14.5px/1.25 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

#rightTabs {
  position: sticky;
  top: 0;
  z-index: 4;
  padding: 8px 0 8px;
  gap: 6px;
  margin-bottom: 10px;
  background: var(--paper-stock);
  clip-path: none;
  border: 0;
  border-bottom: 1px solid rgba(154, 118, 66, 0.56);
  box-shadow: 0 1px 0 rgba(255, 250, 236, 0.62);
}
#rightTabs::before { content: none; }
#rightTabs button {
  border: 1px solid #9b7848;
  border-radius: 4px;
  clip-path: none;
  min-height: 30px;
  padding: 4px 6px;
  color: #2a1b0f;
  font: 700 13px/1.2 var(--font-cjk);
  letter-spacing: 0.03em;
  background: linear-gradient(180deg, #f3e4c6 0%, #e7d4af 55%, #dec79e 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 251, 238, 0.82),
    inset 0 -1px 2px rgba(132, 92, 42, 0.22),
    0 1px 2px rgba(42, 24, 10, 0.14);
  transition: filter 0.12s ease;
}
#rightTabs button::before { content: none; }
#rightTabs button:hover:not(.on) {
  border-color: #7c5829;
  background: linear-gradient(180deg, #f8ecd2 0%, #ebd6ae 100%);
  color: #22140a;
}
#rightTabs button.on,
#rightTabs button.on:hover {
  background: linear-gradient(180deg, #5e3822 0%, #4b2b19 52%, #3c2214 100%);
  color: #fff5de;
  border-color: #5e3822;
  box-shadow:
    inset 0 0 0 1px #e8c488,
    inset 0 1px 0 rgba(255, 244, 214, 0.34),
    0 2px 5px rgba(42, 22, 10, 0.36);
}
#rightTabs button.on:hover { filter: brightness(1.07); }

/* Recent events ledger below DossierPanel */
.recent-events {
  padding: 10px 14px;
  margin-top: 10px;
  border: 1px solid rgba(154, 118, 66, 0.42);
  border-radius: 4px;
  background: linear-gradient(180deg, rgba(252, 245, 229, 0.62) 0%, rgba(238, 223, 194, 0.38) 100%);
  box-shadow: inset 0 0 0 1px rgba(255, 250, 236, 0.58);
}
.recent-events .ribbon-track {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}
.recent-events .ribbon-track::after {
  content: "";
  flex: 1;
  height: 1px;
  margin-left: -6px;
  background: linear-gradient(90deg, rgba(162, 122, 66, 0.72), rgba(162, 122, 66, 0.14));
}
.recent-events .ribbon-h {
  width: fit-content;
  min-height: 29px;
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 700 15px/1.25 var(--font-cjk);
}
.recent-events ul { list-style: none; margin: 0; padding: 0; }
.recent-event {
  display: flex;
  align-items: baseline;
  width: 100%;
  gap: 8px;
  text-align: left;
  padding: 5px 4px;
  border-bottom: 1px solid rgba(154, 118, 66, 0.32);
  color: #24160c;
  font: 500 13.5px/1.35 var(--font-cjk);
}
.recent-events li:last-child .recent-event { border-bottom: 0; }
.recent-event:hover { background: rgba(255, 245, 220, 0.8); }
.recent-event .note-bullet { color: #6d471d; font-size: 12px; flex: none; }
.recent-event time { color: #7d2229; font-weight: 700; min-width: 42px; font-variant-numeric: tabular-nums; flex: none; }
.recent-event .note-label { min-width: 0; color: #24160c; }
.recent-empty { margin: 4px 0 0; color: #513d2a; font-size: 13px; }

/* Inset dark-slate brass map badges, legend rail (.legend-card 118px locked!), & zoom plaques */
.map-badges,
.legend-card {
  color: #f5e6c8;
  border: 1px solid #c49b5a;
  background: linear-gradient(160deg, rgba(31, 28, 25, 0.95) 0%, rgba(17, 19, 25, 0.96) 100%);
  box-shadow:
    inset 0 0 0 2px rgba(19, 17, 14, 0.92),
    inset 0 0 0 3px rgba(206, 168, 102, 0.36),
    0 5px 14px rgba(0, 0, 0, 0.62);
}
.map-badges, .legend-lane { position: absolute; z-index: 2; pointer-events: none; }
.map-badges {
  left: 14px;
  top: 151px;
  border-radius: 4px;
  padding: 5px 9px;
  display: grid;
  grid-template-columns: auto auto;
  gap: 2px 6px;
  font: 600 12.5px/1.25 var(--font-cjk);
}
.map-badges b { color: #faebc8; font-weight: 700; }
.map-badges i { font: italic 600 12.5px/1.2 var(--font-num, Georgia, serif); font-synthesis-style: none; color: #dfc494; }
.map-badges span {
  grid-column: span 2;
  font: 600 12px/1.25 var(--font-cjk);
  border-top: 1px solid rgba(194, 155, 92, 0.48);
  padding-top: 2px;
  color: #f6dfb3;
}
.legend-lane { inset: 136px 10px auto 10px; display: flex; justify-content: flex-end; visibility: hidden; }
.legend-lane.right, .legend-lane.left { visibility: visible; }
.legend-lane.left { justify-content: flex-start; }
.legend-card {
  box-sizing: border-box;
  width: 118px;
  display: grid;
  gap: 7px;
  padding: 9px 8px 11px;
  border-radius: 5px;
  font-size: 12px;
  position: relative;
}
.legend-card::after {
  content: "";
  display: block;
  height: 1px;
  margin-top: 1px;
  background: linear-gradient(90deg, transparent, rgba(212, 173, 106, 0.65) 50%, transparent);
}
.legend-card strong {
  border-bottom: 1px solid rgba(202, 162, 98, 0.56);
  padding-bottom: 5px;
  font: 700 12.5px/1.2 var(--font-cjk);
  color: #faebc8;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 5px;
}
.legend-card strong i {
  font: italic 600 12.5px/1.1 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
  color: #e0c492;
}
.legend-card span {
  display: grid;
  grid-template-columns: 24px 1fr;
  align-items: center;
  gap: 0 6px;
  line-height: 1.22;
  color: #f5e6c8;
  font-weight: 600;
}
.legend-card span i {
  grid-column: 2;
  display: block;
  font: italic 600 12px/1.15 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
  color: #dcc397;
}
.legend-card b {
  grid-row: span 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1.5px solid #c69c59;
  background: radial-gradient(circle at 35% 30%, #372d21, #191511);
  box-shadow: inset 0 1px 0 rgba(255, 245, 218, 0.25), 0 1px 3px rgba(0, 0, 0, 0.6);
  color: #f6d591;
  font: 700 12px/1 var(--font-cjk);
}
.legend-card .surv {
  background: radial-gradient(circle at 35% 30%, #2a5e94, #143252);
  border-color: #8cc2f0;
  color: #e6f4ff;
}
.legend-card .hunt {
  background: radial-gradient(circle at 35% 30%, #992b39, #54141e);
  border-color: #e0828f;
  color: #ffe6e9;
}
.legend-card .ciph {
  background: radial-gradient(circle at 35% 30%, #6b4c1d, #36250e);
  border-color: #e3bc72;
  color: #fff0cc;
}
.legend-card .gate {
  background: radial-gradient(circle at 35% 30%, #564126, #2c2114);
  border-color: #c8a265;
  color: #f7e6c2;
}
.legend-card .trail {
  border-style: dashed;
  background: radial-gradient(circle at 35% 30%, #30281f, #191613);
  border-color: #c29e62;
  color: #eedab2;
}
.rail-zoom-tools {
  position: absolute;
  top: auto;
  bottom: 48px;
  z-index: 3;
  width: 118px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
.rail-btn {
  min-height: 28px;
  padding: 2px 6px;
  border: 1px solid #b89154;
  border-radius: 4px;
  background: linear-gradient(180deg, #2f271e 0%, #191714 100%);
  color: #f6e4bf;
  font: 700 12.5px/1.2 var(--font-cjk);
  box-shadow:
    inset 0 0 0 1px rgba(244, 214, 156, 0.2),
    inset 0 1px 0 rgba(255, 245, 218, 0.16),
    0 2px 6px rgba(0, 0, 0, 0.54);
}
.rail-btn[data-test="rail-reset"] { grid-column: span 2; font-size: 12px; letter-spacing: 0.06em; }
.rail-btn:hover:enabled {
  background: linear-gradient(180deg, #4b3926 0%, #271f17 100%);
  border-color: #ecc57d;
  color: #fff6df;
}
.rail-btn:disabled {
  opacity: 1;
  color: #beb098;
  border-color: rgba(168, 134, 78, 0.45);
  background: linear-gradient(180deg, #231e18 0%, #161412 100%);
}
.rail-btn:focus-visible { outline: 2px solid #f4d298; outline-offset: 1px; }
.mobile-zoom-tools {
  position: absolute;
  right: 10px;
  bottom: calc(var(--hud-bottom, 8px) + 28px);
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  border: 1px solid #b89154;
  border-radius: 6px;
  background: linear-gradient(180deg, rgba(35, 29, 22, 0.94) 0%, rgba(20, 17, 14, 0.96) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 245, 218, 0.18),
    0 4px 12px rgba(0, 0, 0, 0.62);
}
.mobile-zoom-tools .rail-btn {
  min-width: 30px;
  min-height: 28px;
  padding: 2px 8px;
  font-size: 12px;
}
@media (min-width: 1100px) {
  .mobile-zoom-tools { display: none; }
}

/* Bottom transport rail (48px height strictly locked!) */
.control-band { display: flex; flex: 0 0 48px; min-height: 0; gap: 4px; }
.control-band > #transport { flex: 1; min-width: 0; height: 48px; }
#transport {
  border: 1px solid #b89154;
  border-radius: 5px;
  clip-path: none;
  background: linear-gradient(180deg, #29231d 0%, #191817 52%, #13151a 100%);
  box-shadow:
    inset 0 0 0 1px rgba(244, 214, 156, 0.24),
    inset 0 1px 0 rgba(255, 245, 218, 0.18),
    0 4px 12px rgba(0, 0, 0, 0.56);
}
#transport::before { content: none; }
#transport .gbtn {
  clip-path: none;
  border: 1px solid #8f6c3c;
  border-radius: 4px;
  padding: 3px 9px;
  min-height: 28px;
  background: linear-gradient(180deg, #2d251d 0%, #1a1612 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 245, 218, 0.16),
    0 1px 3px rgba(0, 0, 0, 0.48);
  color: #f3e2c2;
  font: 600 12.5px/1.2 var(--font-cjk);
  letter-spacing: 0.02em;
}
#transport .gbtn::before { content: none; }
#transport .gbtn:enabled:hover {
  border-color: #e6be78;
  color: #fff6df;
  background: linear-gradient(180deg, #3c3024 0%, #221c16 100%);
}
#transport .gbtn.on {
  border-color: #e4bd77;
  background: linear-gradient(180deg, #744e29 0%, #4b3119 100%);
  color: #fff6df;
}
#transport .gbtn:disabled {
  opacity: 1;
  color: #bfb198;
  border-color: rgba(154, 122, 72, 0.45);
  background: linear-gradient(180deg, #221d17 0%, #171411 100%);
}
#transport select.sel {
  height: 28px;
  padding: 2px 24px 2px 8px;
  font: 700 12.5px/1.2 var(--font-num, Georgia, serif);
}
#transport .clock {
  color: #f4dca6;
  font: 700 14.5px/1.2 var(--font-num, Georgia, serif);
  letter-spacing: 0.02em;
}
#transport .transport-help summary {
  border: 1px solid #9e7a48;
  border-radius: 4px;
  background: linear-gradient(180deg, #2c241b 0%, #191511 100%);
  color: #f2d79c;
  font: 700 12px/1.3 var(--font-latin);
  padding: 3px 8px;
}
#transport .transport-help p {
  background: linear-gradient(180deg, #221c16 0%, #141210 100%);
  border: 1px solid #b89154;
  color: #f3e4c7;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.72);
}

.mode-pills {
  display: flex;
  flex: none;
  border: 1px solid #b58d52;
  border-radius: 18px;
  padding: 2px;
  background: #141210;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.7);
}
.mode-pills button {
  border: 0;
  padding: 3px 9px;
  background: transparent;
  color: #e8d7b8;
  border-radius: 15px;
  font: 700 12.5px/1.2 var(--font-cjk);
  letter-spacing: 0.03em;
}
.mode-pills button[aria-pressed="true"] {
  color: #26160b;
  background: linear-gradient(180deg, #faecc8 0%, #d8ae68 100%);
  box-shadow: inset 0 1px 0 rgba(255, 250, 236, 0.85), 0 1px 3px rgba(0, 0, 0, 0.45);
}
.director-band { position: absolute; z-index: 4; bottom: 9px; left: 50%; transform: translateX(-50%); max-width: 42%; }
.director-band :deep(.director) { position: static; transform: none; }
.legend-controls, .legend-strip { display: flex; align-items: center; gap: 8px; }
.legend-controls {
  padding: 0 6px;
  background: linear-gradient(180deg, #29231d 0%, #171513 100%);
  border: 1px solid #b89154;
  border-radius: 5px;
  color: #f5dfb4;
}
.legend-controls > .gbtn {
  clip-path: none;
  border: 1px solid #8f6c3c;
  border-radius: 4px;
  padding: 3px 8px;
  color: #f5e4c2;
  font: 600 12px/1.2 var(--font-cjk);
}
.legend-controls > .gbtn::before { content: none; }
.legend-strip { flex-wrap: wrap; overflow: auto; max-height: 100%; font: 13px var(--font-cjk); }
.legend-strip span { white-space: nowrap; }
.legend-strip i { display: block; font: italic 600 12px var(--font-num, Georgia, serif); color: #e5cfa8; }
.legend-strip b { color: #efc477; }
.legend-strip .surv { color: #8fc6ef; } .legend-strip .hunt { color: #ef8391; }
@media(max-width:850px){.map-badges { display: none; } .control-band.legend-open > #transport { display: none; }}
@media (max-width: 640px) {
  .control-band { flex: 0 0 auto; height: auto; align-items: stretch; }
  .control-band > #transport:not(.tac-anim-bar) {
    height: auto;
    flex: 1 1 auto;
    flex-wrap: wrap;
    padding: 4px 8px 6px;
    gap: 4px 6px;
  }
  #transport .gbtn { padding: 2px 6px; min-height: 26px; font-size: 12px; }
  #transport select.sel { height: 26px; padding: 2px 20px 2px 6px; font-size: 12px; }
  #transport .clock { font-size: 12px; }
  .mode-pills button { padding: 2px 7px; font-size: 12px; }
}
</style>
