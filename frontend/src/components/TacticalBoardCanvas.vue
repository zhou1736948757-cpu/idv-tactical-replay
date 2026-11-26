<script setup lang="ts">
import { getEnhancedMap, useMapPreset } from "@/lib/mapTone";
import { CANVAS_FONT_CJK, whenFontsReady } from "@/lib/typography";
import ManorMapFrame from "./tactical/ManorMapFrame.vue";
import { computeUnderlayAffine, VISUAL_PRESETS } from "@idv/replay-renderer";
const { visualPreset } = useMapPreset();
/**
 * Browser adapter around the zero-DOM @idv/replay-renderer engine, plus a
 * synchronized DPR-crisp <canvas data-test="tactical-overlay-canvas"> for
 * 2D PIL tactical whiteboard overlays and untainted PNG export.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  TacticalReplayRenderer,
  samplePlayerAtTime,
  wrapDeg360,
  type Canvas2DContextLike,
  type CssRect,
  type FloorId,
  type LayerVisibilityState,
  type PickResult,
  type Replay2DPayload,
  type RulerState,
  type Vec3,
} from '@idv/replay-renderer';
import {
  TAC_ROLES,
  cipherOf,
  type Point2D,
  type TacticalBoardState,
  type TacticalShape,
} from '@/tactical';
import type { FocusRequest } from '@/store/app';
import {
  clamp01,
  type BoardChairCandidate,
  type BoardGeoContext,
  type BoardProp,
  type BoardSelection,
  type BoardToken,
  type BoardToolId,
  type DrawShapeKind,
  type LandmarkVisibility,
  type PlacePending,
  type RangeEvaluation,
  type RangeOverlayState,
  type UnderlayUiState,
} from '@/lib/board';
import { renderTacticalOverlay } from '@/components/tactical/overlayRenderer';

const props = withDefaults(
  defineProps<{
    payload: Replay2DPayload | null;
    t: number;
    pitch?: number;
    yaw?: number;
    yScale?: number;
    layers: Partial<LayerVisibilityState>;
    underlay: UnderlayUiState;
    directorHeight?: number;
    folioOpen?: boolean;
    legendSide?: 'left' | 'right' | null;
    obstacleVersion?: number;
    rulerMode?: boolean;
    ruler?: RulerState | null;
    selectedUid?: number | null;
    followUid?: number | null;
    focus?: FocusRequest | null;
    chaseSegments?: Array<{ survivor_uid: number; start_t: number; end_t: number }> | null;
    board?: TacticalBoardState | null;
    geo?: BoardGeoContext | null;
    landmarks?: LandmarkVisibility | null;
    cipherGroupIndex?: number;
    activeTool?: BoardToolId;
    selection?: BoardSelection;
    placePending?: PlacePending;
    drawShape?: DrawShapeKind;
    drawColor?: string;
    drawWidth?: number;
    rangeState?: RangeOverlayState | null;
    rangeEval?: RangeEvaluation | null;
    boardChairs?: BoardChairCandidate[];
    measurePending?: Point2D | null;
    animTime?: number | null;
    animPlaying?: boolean;
    animArmed?: boolean;
    zoomLocked?: boolean;
    routePickSlot?: 'a' | 'b' | null;
    routePointA?: Point2D | null;
    routePointB?: Point2D | null;
    highlightedCipherId?: string | null;
    exportCrop?: boolean;
    exportRot?: boolean;
  }>(),
  {
    pitch: 90,
    yaw: 0,
    yScale: 1,
    directorHeight: 0,
    folioOpen: true,
    legendSide: null,
    obstacleVersion: 0,
    rulerMode: false,
    ruler: null,
    selectedUid: null,
    followUid: null,
    focus: null,
    chaseSegments: null,
    board: null,
    geo: null,
    landmarks: null,
    cipherGroupIndex: 0,
    activeTool: 'inspect',
    selection: null,
    placePending: null,
    drawShape: 'arrow',
    drawColor: '#c9a25f',
    drawWidth: 2,
    rangeState: null,
    rangeEval: null,
    boardChairs: () => [],
    measurePending: null,
    animTime: null,
    animPlaying: false,
    animArmed: false,
    zoomLocked: false,
    routePickSlot: null,
    routePointA: null,
    routePointB: null,
    highlightedCipherId: null,
    exportCrop: false,
    exportRot: true,
  },
);

const emit = defineEmits<{
  (e: 'map-edges', left: number, right: number): void;
  (e: 'map-rect', rect: { left: number; top: number; right: number; bottom: number; width: number; height: number }): void;
  (e: 'update:pitch', v: number): void;
  (e: 'update:yaw', v: number): void;
  (e: 'update:ruler', v: RulerState | null): void;
  (e: 'update:selectedUid', v: number | null): void;
  (e: 'update:followUid', v: number | null): void;
  (e: 'pick', v: PickResult | null): void;
  (e: 'ruler-point', v: { point: Vec3; index: 0 | 1; snapped: PickResult | null }): void;
  (e: 'underlay-status', v: 'none' | 'loading' | 'ok' | 'missing'): void;
  (e: 'tac-select', v: BoardSelection): void;
  (e: 'tac-place', v: Point2D): void;
  (e: 'tac-drag-start'): void;
  (e: 'tac-drag-end'): void;
  (e: 'tac-move-token', v: { tid: number; x: number; y: number }): void;
  (e: 'tac-move-prop', v: { iid: number; x: number; y: number }): void;
  (e: 'tac-move-text', v: { id: number; x: number; y: number }): void;
  (e: 'tac-move-measure-end', v: { id: number; end: 'a' | 'b'; x: number; y: number }): void;
  (e: 'tac-move-anim-dot', v: { ptIdx: number; x: number; y: number }): void;
  (e: 'tac-draw-commit', v: Omit<TacticalShape, 'id'>): void;
  (e: 'tac-measure-click', v: Point2D): void;
  (e: 'tac-measure-finish'): void;
  (e: 'tac-route-pick', v: Point2D): void;
  (e: 'tac-range-click', v: Point2D): void;
  (e: 'tac-anim-add-point', v: Point2D): void;
}>();

const boardEl = ref<HTMLDivElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const overlayEl = ref<HTMLCanvasElement | null>(null);
const renderer = shallowRef<TacticalReplayRenderer | null>(null);
const canvasSupported = ref(true);
const dragging = ref(false);
const tip = ref<{ x: number; y: number; text: string } | null>(null);
const pulse = ref<{ key: number; x: number; y: number } | null>(null);
const cursorCoords = ref<{ px: number; py: number; mx: number; my: number } | null>(null);
const underlayStatus = ref<'none' | 'loading' | 'ok' | 'missing'>('none');

const drawingPreview = ref<TacticalShape | null>(null);
const measureHover = ref<Point2D | null>(null);
const snapPoint = ref<Point2D | null>(null);
const hunterPortraits = new Map<string, HTMLImageElement>();

let pendingA: Vec3 | null = null;
let fitZoom = 1;
let resizeObs: ResizeObserver | null = null;
let overlayObs: ResizeObserver | null = null;
let dprMedia: MediaQueryList | null = null;
let renderQueued = false;
let postLayoutRaf = 0;
let underlayToken = 0;
let lastMatchId: string | null = null;
let lastAssetUrl: string | null = null;
let cachedObstacles: CssRect[] = [];
let obstaclesDirty = true;

const HOST_OBSTACLE_SELECTORS = [
  '#strip',
  '#strip.hud-expanded .hud-content',
  '#toolbarWrap #toolbar',
  '#toolbarWrap .view-pop',
  '#toolbarWrap .archive-pop',
  '#toolbarWrap .toolbar-menu-pop',
  '.board .compass',
  '.board .scale',
  '.board .hud',
  '.board .map-badges',
  '.board .legend-card.map-key',
  '.board .rail-zoom-tools',
  '.director-band [data-test="director-bar"]',
  '#boardPanel > .folio-toggle',
  '#boardPanel > .linked-cta',
  '[data-test="replay-summary"]',
  '.transport-help[open] p',
  '.flow-preferences',
  '.board .tac-coords-tip',
  '.desk-still > .bookmark',
].join(',');

const OBSERVED_OVERLAY_SELECTORS = [
  '#strip',
  '#toolbarWrap',
  '.director-band',
  '.board .legend-lane',
  '.board .map-badges',
  '.board .scale',
  '.board .compass',
  '.board .hud',
  '#boardPanel > .folio-toggle',
].join(',');

function noop(): void {
  /* no-op drawing sink */
}
const NOOP_CTX: Canvas2DContextLike = {
  fillStyle: '#000',
  strokeStyle: '#000',
  lineWidth: 1,
  globalAlpha: 1,
  font: '10px serif',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  lineCap: 'butt',
  lineJoin: 'miter',
  save: noop,
  restore: noop,
  setTransform: noop,
  transform: noop,
  beginPath: noop,
  closePath: noop,
  moveTo: noop,
  lineTo: noop,
  arc: noop,
  rect: noop,
  fill: noop,
  stroke: noop,
  fillRect: noop,
  clearRect: noop,
  fillText: noop,
  setLineDash: noop,
  drawImage: noop,
  measureText: (s: string) => ({ width: s.length * 7 }),
};

function viewportSize(): { width: number; height: number; dpr: number } {
  const el = boardEl.value;
  const width = el && el.clientWidth > 0 ? el.clientWidth : 800;
  const height = el && el.clientHeight > 0 ? el.clientHeight : 560;
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return { width, height, dpr };
}

function measure(): void {
  const r = renderer.value;
  const c = canvasEl.value;
  const oc = overlayEl.value;
  if (!r || !c) return;
  const vp = viewportSize();
  const bw = Math.max(1, Math.round(vp.width * vp.dpr));
  const bh = Math.max(1, Math.round(vp.height * vp.dpr));
  if (c.width !== bw) c.width = bw;
  if (c.height !== bh) c.height = bh;
  if (oc) {
    if (oc.width !== bw) oc.width = bw;
    if (oc.height !== bh) oc.height = bh;
  }
  r.resize(vp);
}

function overlayCtx(): Canvas2DContextLike | null {
  const oc = overlayEl.value;
  if (!oc) return null;
  try {
    return (oc.getContext('2d') as CanvasRenderingContext2D | null) ?? null;
  } catch {
    return null;
  }
}

function renderOverlay(): void {
  const r = renderer.value;
  const ctx = overlayCtx();
  if (!r || !ctx || !props.board || !props.geo || !props.landmarks || !props.rangeState) return;
  renderTacticalOverlay(ctx, r.getViewport(), r, {
    geo: props.geo,
    board: props.board,
    landmarks: props.landmarks,
    cipherGroupIndex: props.cipherGroupIndex,
    activeTool: props.activeTool,
    selection: props.selection,
    landmarksChairs: props.boardChairs,
    rangeState: props.rangeState,
    rangeEval: props.rangeEval,
    drawingPreview: drawingPreview.value,
    measurePending: props.measurePending,
    measureHover: measureHover.value,
    snapPoint: snapPoint.value,
    animTime: props.animTime,
    animPlaying: props.animPlaying,
    hunterPortraits,
    routePointA: props.routePointA,
    routePointB: props.routePointB,
    highlightedCipherId: props.highlightedCipherId,
  });
}

const canObserveFrame = typeof ResizeObserver !== 'undefined';
const pxPerMeter = ref(0);
const northAngle = ref(0);
const mapRectCss = ref<{ left: number; top: number; right: number; bottom: number; width: number; height: number } | null>(null);
const compassLeftPx = ref(14);
const hudRightPx = ref(14);
let lastMapLeft = 0;
let lastMapRight = 1;

function isElementVisible(el: Element): boolean {
  if (!el.isConnected || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return false;
  let cur: Element | null = el;
  while (cur) {
    const cs = window.getComputedStyle(cur);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (cur.id === 'app' || cur === document.body) break;
    cur = cur.parentElement;
  }
  return true;
}

function rectListsEqual(a: readonly CssRect[], b: readonly CssRect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const u = a[i]!;
    const v = b[i]!;
    if (
      Math.abs(u.left - v.left) > 0.25 ||
      Math.abs(u.top - v.top) > 0.25 ||
      Math.abs(u.right - v.right) > 0.25 ||
      Math.abs(u.bottom - v.bottom) > 0.25
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Measure all visible host HUD/toolbar/compass/scale/legend/director/folio/prop
 * rectangles intersecting the base canvas, converted to canvas-local CSS pixels
 * (never multiplied by DPR). Cached across frames and refreshed on layout/UI changes.
 */
function measureObstacles(): boolean {
  obstaclesDirty = false;
  const r = renderer.value;
  const c = canvasEl.value;
  if (!r || !c || typeof window === 'undefined') {
    const changed = cachedObstacles.length > 0;
    cachedObstacles = [];
    return changed;
  }
  const cr = c.getBoundingClientRect();
  if (!(cr.width > 0 && cr.height > 0)) {
    const changed = cachedObstacles.length > 0;
    cachedObstacles = [];
    return changed;
  }
  const vp = r.getViewport();
  const sx = vp.width / cr.width;
  const sy = vp.height / cr.height;
  const root =
    c.closest('#app') ??
    c.closest('#stage') ??
    c.closest('#stage2') ??
    boardEl.value;
  if (!root) {
    const changed = cachedObstacles.length > 0;
    cachedObstacles = [];
    return changed;
  }
  const next: CssRect[] = [];
  const seen = new Set<Element>();
  for (const el of root.querySelectorAll(HOST_OBSTACLE_SELECTORS)) {
    if (seen.has(el) || !isElementVisible(el)) continue;
    seen.add(el);
    const er = el.getBoundingClientRect();
    if (!(er.width > 0 && er.height > 0)) continue;
    const l = Math.max(cr.left, er.left);
    const t = Math.max(cr.top, er.top);
    const ri = Math.min(cr.right, er.right);
    const b = Math.min(cr.bottom, er.bottom);
    if (ri <= l + 0.5 || b <= t + 0.5) continue;
    next.push({
      left: (l - cr.left) * sx,
      top: (t - cr.top) * sy,
      right: (ri - cr.left) * sx,
      bottom: (b - cr.top) * sy,
    });
  }
  next.sort((u, v) => u.top - v.top || u.left - v.left || u.bottom - v.bottom || u.right - v.right);
  const changed = !rectListsEqual(cachedObstacles, next);
  cachedObstacles = next;
  return changed;
}

function markObstaclesDirty(): void {
  obstaclesDirty = true;
}

function schedulePostLayoutObstacleSync(): void {
  if (typeof requestAnimationFrame !== 'function') return;
  if (postLayoutRaf) return;
  postLayoutRaf = requestAnimationFrame(() => {
    postLayoutRaf = 0;
    if (measureObstacles()) requestRender();
  });
}

function refreshObstacles(): void {
  obstaclesDirty = true;
  if (measureObstacles()) requestRender();
  schedulePostLayoutObstacleSync();
}

function calibrateFrame(r: TacticalReplayRenderer): void {
  const viewport = r.getViewport();
  const x = viewport.width / 2;
  const y = viewport.height / 2;
  const a = r.screenToWorld(x, y, 0);
  const b = r.screenToWorld(x + 100, y, 0);
  const distance = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const nextPpm = Number((100 / distance * (45 / 3.8)).toFixed(5));
  const ppmChanged = Math.abs(nextPpm - pxPerMeter.value) > 1e-4;
  pxPerMeter.value = nextPpm;
  const rect = props.payload?.world.map_underlay?.world_rect;
  let left = 0, right = 1;
  let mapLeftPx = 0, mapRightPx = viewport.width, mapTopPx = 0, mapBottomPx = viewport.height;
  if (rect) {
    // The negative image-v axis is north in the calibrated map artwork.
    const [ux, uy, dx, dy, originX, originY] = computeUnderlayAffine(rect, 1, 1, r.getCamera(), viewport, props.underlay);
    northAngle.value = Math.atan2(-dx, dy) * 180 / Math.PI;
    const xs = [originX, originX + ux, originX + dx, originX + ux + dx];
    const ys = [originY, originY + uy, originY + dy, originY + uy + dy];
    mapLeftPx = Math.min(...xs);
    mapRightPx = Math.max(...xs);
    mapTopPx = Math.min(...ys);
    mapBottomPx = Math.max(...ys);
    left = mapLeftPx / viewport.width;
    right = mapRightPx / viewport.width;
    const clampedLeft = Math.max(0, Math.min(viewport.width, mapLeftPx));
    const clampedTop = Math.max(0, Math.min(viewport.height, mapTopPx));
    const clampedRight = Math.max(clampedLeft, Math.min(viewport.width, mapRightPx));
    const clampedBottom = Math.max(clampedTop, Math.min(viewport.height, mapBottomPx));
    const nextRect = {
      left: clampedLeft,
      top: clampedTop,
      right: clampedRight,
      bottom: clampedBottom,
      width: clampedRight - clampedLeft,
      height: clampedBottom - clampedTop,
    };
    const prev = mapRectCss.value;
    if (
      !prev ||
      Math.abs(prev.left - nextRect.left) > 0.25 ||
      Math.abs(prev.top - nextRect.top) > 0.25 ||
      Math.abs(prev.right - nextRect.right) > 0.25 ||
      Math.abs(prev.bottom - nextRect.bottom) > 0.25
    ) {
      mapRectCss.value = nextRect;
      emit('map-rect', nextRect);
    }
  } else {
    mapRectCss.value = null;
  }

  // Place compass centered above the right legend rail when space is available,
  // clearing the right-edge folio toggle (22px wide at top 55..93).
  const rightRailW = viewport.width - mapRightPx;
  let nextCompassLeft = 14;
  if (rightRailW >= 112) {
    if (rightRailW <= 265) {
      nextCompassLeft = Math.min(
        viewport.width - 28 - 64,
        Math.max(mapRightPx + 6, mapRightPx + (rightRailW - 64) / 2),
      );
    } else {
      nextCompassLeft = Math.max(mapRightPx + 12, viewport.width - 14 - 60 - 32);
    }
  } else if (viewport.width >= 420) {
    nextCompassLeft = viewport.width - 96;
  }
  const roundedCompassLeft = Math.round(nextCompassLeft * 100) / 100;
  const compassMoved = Math.abs(roundedCompassLeft - compassLeftPx.value) > 0.25;
  compassLeftPx.value = roundedCompassLeft;

  const nextHudRight = props.folioOpen && rightRailW >= 112 && rightRailW <= 265
    ? Math.max(14, Math.round(rightRailW))
    : 14;
  const hudMoved = nextHudRight !== hudRightPx.value;
  hudRightPx.value = nextHudRight;

  if (Math.abs(left - lastMapLeft) > 1e-5 || Math.abs(right - lastMapRight) > 1e-5) {
    lastMapLeft = left;
    lastMapRight = right;
    emit('map-edges', left, right);
    obstaclesDirty = true;
    schedulePostLayoutObstacleSync();
  } else if (ppmChanged || compassMoved || hudMoved) {
    obstaclesDirty = true;
    schedulePostLayoutObstacleSync();
  }
}

function renderNow(): void {
  const r = renderer.value;
  if (!r) return;
  if (props.followUid !== null && props.payload) {
    const s = samplePlayerAtTime(props.payload.trajectories?.[String(props.followUid)], props.t);
    if (s) r.setCamera({ centerX: s.pos[0], centerZ: s.pos[2] });
  }
  calibrateFrame(r);
  if (obstaclesDirty) measureObstacles();
  r.render(props.t, cachedObstacles);
  renderOverlay();
}

function requestRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  void Promise.resolve().then(() => {
    renderQueued = false;
    renderNow();
  });
}

function setUnderlayStatus(s: 'none' | 'loading' | 'ok' | 'missing'): void {
  underlayStatus.value = s;
  emit('underlay-status', s);
}

function normalizeAssetUrl(url: string): string {
  try {
    return encodeURI(decodeURI(url));
  } catch {
    return encodeURI(url);
  }
}

function preloadHunterPortraits(): void {
  if (!props.board || typeof window === 'undefined' || typeof window.Image !== 'function') return;
  for (const tk of props.board.tokens) {
    const url = TAC_ROLES[tk.role]?.portraitUrl;
    if (!url || hunterPortraits.has(url)) continue;
    const img = new window.Image();
    img.decoding = 'async';
    hunterPortraits.set(url, img);
    img.onload = () => requestRender();
    img.src = normalizeAssetUrl(url);
  }
}

function loadUnderlay(p: Replay2DPayload | null): void {
  const token = ++underlayToken;
  const url = p?.world.map_underlay.asset_url ?? p?.match.map_asset_url ?? null;
  lastAssetUrl = url;
  if (!p || !url || typeof window === 'undefined' || typeof window.Image !== 'function') {
    setUnderlayStatus(p ? 'missing' : 'none');
    return;
  }
  setUnderlayStatus('loading');
  void getEnhancedMap(normalizeAssetUrl(url), visualPreset.value).then((img) => {
    if (token !== underlayToken || !renderer.value) return;
    renderer.value.setUnderlay({
      image: img,
      imageWidth: 'naturalWidth' in img ? img.naturalWidth || img.width : img.width,
      imageHeight: 'naturalHeight' in img ? img.naturalHeight || img.height : img.height,
      worldRect: { ...p.world.map_underlay.world_rect },
      tone: img instanceof HTMLCanvasElement
        ? (visualPreset.value === 'clarity' ? { brightness: 1, contrast: 1.04, saturation: 2.25 } : null)
        : VISUAL_PRESETS[visualPreset.value].underlay.tone,
    });
    setUnderlayStatus('ok');
    requestRender();
  }, () => {
    if (token !== underlayToken || !renderer.value) return;
    renderer.value.setUnderlay({ image: null });
    setUnderlayStatus('missing');
    requestRender();
  });
}

function applyCameraProps(): void {
  renderer.value?.setCamera({ pitchDeg: 90, yawDeg: props.yaw, yScale: 1 });
}

function fit(): void {
  const r = renderer.value;
  if (!r) return;
  const vp = r.getViewport();
  const p = props.payload;
  if (!p || vp.width <= 1 || vp.height <= 1) {
    const cam = r.fitToWorld();
    fitZoom = cam.zoom;
    markObstaclesDirty();
    requestRender();
    return;
  }
  const baseCam = r.fitToWorld();
  const bounds = p.world.bounds;
  const uRect = props.underlay.enabled ? p.world.map_underlay?.world_rect : null;
  const minX = uRect ? Math.min(bounds.min_x, uRect.min_x) : bounds.min_x;
  const maxX = uRect ? Math.max(bounds.max_x, uRect.max_x) : bounds.max_x;
  const minZ = uRect ? Math.min(bounds.min_z, uRect.min_z) : bounds.min_z;
  const maxZ = uRect ? Math.max(bounds.max_z, uRect.max_z) : bounds.max_z;
  const minY = bounds.min_y;
  const maxY = bounds.max_y;

  // Display-layer safe insets inside the board frame (D-016 / T-018 02.json):
  // preserves Euclidean aspect, world bounds, entities, and calibrated metric scale.
  const padTop = vp.height >= 480 ? 45 : Math.round(vp.height * 0.08);
  const padBottom = vp.height >= 480 ? 43 : Math.round(vp.height * 0.08);
  const padLeft = vp.width >= 480 ? 14 : 10;
  const padRight = vp.width >= 480 ? 14 : 10;
  const availW = Math.max(1, vp.width - padLeft - padRight);
  const availH = Math.max(1, vp.height - padTop - padBottom);

  const unitCam = {
    ...baseCam,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    zoom: 1,
  };
  r.setCamera(unitCam);
  let sxMin = Infinity;
  let sxMax = -Infinity;
  let syMin = Infinity;
  let syMax = -Infinity;
  for (const wx of [minX, maxX]) {
    for (const wz of [minZ, maxZ]) {
      for (const wy of [minY, maxY]) {
        const sp = r.project([wx, wy, wz]);
        if (sp.x < sxMin) sxMin = sp.x;
        if (sp.x > sxMax) sxMax = sp.x;
        if (sp.y < syMin) syMin = sp.y;
        if (sp.y > syMax) syMax = sp.y;
      }
    }
  }
  const spanPxX = Math.max(1e-6, sxMax - sxMin);
  const spanPxY = Math.max(1e-6, syMax - syMin);
  const zoom = Math.min(availW / spanPxX, availH / spanPxY);
  const fittedW = spanPxX * zoom;
  const fittedH = spanPxY * zoom;

  // Expanded desktop with tall enough viewport for the right legend rail (>= 600px):
  // anchor fitted map to padLeft so residual horizontal space consolidates into the right
  // compass/legend rail (zero unassigned left black band). Otherwise center horizontally.
  const excessW = availW - fittedW;
  const hasRealLayout = (boardEl.value?.clientWidth ?? 0) >= 680;
  const dockLeft = Boolean(props.folioOpen && hasRealLayout && vp.height >= 600 && excessW >= 112);
  const targetLeft = dockLeft ? padLeft : padLeft + excessW / 2;
  const targetTop = padTop + (availH - fittedH) / 2;

  r.setCamera({ ...unitCam, zoom });
  let curMinX = Infinity;
  let curMinY = Infinity;
  for (const wx of [minX, maxX]) {
    for (const wz of [minZ, maxZ]) {
      for (const wy of [minY, maxY]) {
        const sp = r.project([wx, wy, wz]);
        if (sp.x < curMinX) curMinX = sp.x;
        if (sp.y < curMinY) curMinY = sp.y;
      }
    }
  }
  const shiftScreenX = targetLeft - curMinX;
  const shiftScreenY = targetTop - curMinY;
  const w0 = r.screenToWorld(vp.width / 2, vp.height / 2, 0);
  const w1 = r.screenToWorld(vp.width / 2 - shiftScreenX, vp.height / 2 - shiftScreenY, 0);
  const finalCam = r.setCamera({
    centerX: unitCam.centerX + (w1[0] - w0[0]),
    centerZ: unitCam.centerZ + (w1[2] - w0[2]),
    zoom,
  });
  fitZoom = finalCam.zoom;
  markObstaclesDirty();
  requestRender();
}

function applyPayload(p: Replay2DPayload | null): void {
  const r = renderer.value;
  if (!r) return;
  const matchId = p?.match.match_id ?? null;
  const assetUrl = p?.world.map_underlay.asset_url ?? p?.match.map_asset_url ?? null;
  if (matchId && matchId === lastMatchId) {
    r.setPayload(p);
    r.setUnderlay({ worldRect: p ? { ...p.world.map_underlay.world_rect } : null });
    if (assetUrl !== lastAssetUrl) loadUnderlay(p);
    else requestRender();
    return;
  }
  lastMatchId = matchId;
  pendingA = null;
  r.setPayload(p);
  r.setUnderlay({ image: null, worldRect: p ? { ...p.world.map_underlay.world_rect } : null });
  loadUnderlay(p);
  applyCameraProps();
  fit();
}

function centerOn(pos: readonly number[]): void {
  const r = renderer.value;
  if (!r) return;
  r.setCamera({ centerX: pos[0], centerZ: pos[2] });
  requestRender();
}

function localPoint(e: MouseEvent): { x: number; y: number } {
  const c = canvasEl.value;
  const rect = c ? c.getBoundingClientRect() : { left: 0, top: 0 };
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function visibleSingleFloor(): FloorId | null {
  const vf = props.layers.visibleFloors;
  if (!vf) return props.layers.focusFloor ?? null;
  const on = (Object.keys(vf) as FloorId[]).filter((f) => vf[f]);
  return on.length === 1 ? (on[0] as FloorId) : (props.layers.focusFloor ?? null);
}

function rulerPlaneY(): number {
  const f = visibleSingleFloor();
  if (!f || !props.payload) return 0;
  const info = props.payload.world.floors?.[f];
  return info && Number.isFinite(info.y_plane) ? info.y_plane : 0;
}

function screenToRel(sx: number, sy: number): Point2D {
  const r = renderer.value;
  const g = props.geo;
  if (!r || !g) return { x: 0.5, y: 0.5 };
  const w = r.screenToWorld(sx, sy, 0);
  const rel = g.worldToRel(w[0], w[2]);
  return { x: clamp01(rel.x), y: clamp01(rel.y) };
}

function snapRel(sx: number, sy: number, fallbackRel: Point2D): Point2D {
  const r = renderer.value;
  const g = props.geo;
  const lm = props.landmarks;
  if (!r || !g || !lm?.snapLandmarks) {
    snapPoint.value = null;
    return fallbackRel;
  }
  const st = lm.snapTargets;
  const candidates: Point2D[] = [];
  const map = g.mapData;
  const [dw, dh] = map.mapSize;
  if (lm.ciphers && (st?.cipher ?? true)) {
    const grp = map.cipherCombinations[props.cipherGroupIndex] ?? [];
    for (const cid of grp) {
      const c = cipherOf(g.mapId, cid);
      if (c) candidates.push({ x: c.location[0] / dw, y: c.location[1] / dh });
    }
  }
  if (lm.chairs && (st?.chair ?? true)) {
    for (const ch of props.boardChairs) {
      candidates.push({ x: ch.relPos[0], y: ch.relPos[1] });
    }
  }
  if (lm.gates && (st?.door ?? true)) {
    const dPts = lm.escapeDoorLock && map.escapeDoors.length >= 4
      ? map.escapeDoors.slice(2, 4)
      : map.escapeDoors.slice(0, 2);
    for (const pt of dPts) candidates.push({ x: pt[0] / dw, y: pt[1] / dh });
  }
  if (lm.hatch && (st?.dungeon ?? true)) {
    for (const pt of map.dungeons) candidates.push({ x: pt[0] / dw, y: pt[1] / dh });
  }
  if (lm.lockers && (st?.locker ?? true)) {
    for (const pt of map.lockers) candidates.push({ x: pt[0] / dw, y: pt[1] / dh });
  }
  if ((lm.chests || lm.basementChest) && (st?.box ?? true)) {
    if (lm.chests) {
      for (const pt of map.chests.fixed) {
        const pz = pt.length === 3 ? pt[2] : pt[1];
        candidates.push({ x: pt[0] / dw, y: pz / dh });
      }
    }
    if (lm.basementChest && props.board) {
      const bs = Object.values(map.basements);
      if (bs.length > 0) {
        const bIdx = ((props.board.boxBasementIndex % bs.length) + bs.length) % bs.length;
        for (const pt of bs[bIdx]!.chest) {
          const pz = pt.length === 3 ? pt[2] : pt[1];
          candidates.push({ x: pt[0] / dw, y: pz / dh });
        }
      }
    }
  }
  if (lm.phoneBooths && (st?.phoneBooth ?? true) && map.phoneBooths) {
    for (const pt of map.phoneBooths) candidates.push({ x: pt[0] / dw, y: pt[1] / dh });
  }
  if (lm.spawns && (st?.spawn ?? true) && map.spawnPoints.length > 0 && props.board) {
    const sIdx = ((props.board.spawnIndex % map.spawnPoints.length) + map.spawnPoints.length) % map.spawnPoints.length;
    const grp = map.spawnPoints[sIdx]!;
    for (const pt of grp.survivor) candidates.push({ x: pt[0] / dw, y: pt[1] / dh });
    candidates.push({ x: grp.hunter[0] / dw, y: grp.hunter[1] / dh });
  }
  if (props.board && (st?.endpoint ?? true)) {
    for (const m of props.board.measures) {
      candidates.push({ x: m.x1, y: m.y1 }, { x: m.x2, y: m.y2 });
    }
    for (const s of props.board.shapes) {
      if (s.kind === 'arrow' || s.kind === 'line') {
        candidates.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
      }
    }
  }
  let best: Point2D | null = null;
  let bestDist = 14;
  for (const c of candidates) {
    const sp = r.project(g.relToWorld(c.x, c.y, 0));
    const d = Math.hypot(sp.x - sx, sp.y - sy);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  snapPoint.value = best;
  return best ?? fallbackRel;
}

type OverlayHit =
  | { kind: 'anim-dot'; ptIdx: number }
  | { kind: 'measure-end'; id: number; end: 'a' | 'b' }
  | { kind: 'token'; tid: number }
  | { kind: 'prop'; iid: number }
  | { kind: 'text'; id: number }
  | { kind: 'measure'; id: number }
  | { kind: 'shape'; id: number };

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hitTestOverlay(sx: number, sy: number): OverlayHit | null {
  const r = renderer.value;
  const g = props.geo;
  const b = props.board;
  if (!r || !g || !b) return null;

  // 1. Animation dots of selected creation
  const curSel = props.selection;
  if (props.activeTool === 'anim' && curSel) {
    const selObj =
      curSel.type === 'token'
        ? b.tokens.find((t) => t.tid === curSel.tid)
        : curSel.type === 'prop'
          ? b.items.find((i) => i.iid === curSel.iid)
          : null;
    if (selObj?.anim?.points) {
      for (let i = selObj.anim.points.length - 1; i >= 0; i--) {
        const pt = selObj.anim.points[i]!;
        const sp = r.project(g.relToWorld(pt.x, pt.y, 0));
        if (Math.hypot(sp.x - sx, sp.y - sy) <= 13) return { kind: 'anim-dot', ptIdx: i };
      }
    }
  }

  // 2. Measure endpoints
  if (props.activeTool === 'measure' || props.activeTool === 'inspect') {
    for (let i = b.measures.length - 1; i >= 0; i--) {
      const m = b.measures[i]!;
      const pa = r.project(g.relToWorld(m.x1, m.y1, 0));
      if (Math.hypot(pa.x - sx, pa.y - sy) <= 10) return { kind: 'measure-end', id: m.id, end: 'a' };
      const pb = r.project(g.relToWorld(m.x2, m.y2, 0));
      if (Math.hypot(pb.x - sx, pb.y - sy) <= 10) return { kind: 'measure-end', id: m.id, end: 'b' };
    }
  }

  // 3. Tokens
  for (let i = b.tokens.length - 1; i >= 0; i--) {
    const tk = b.tokens[i] as BoardToken;
    const sp = r.project(g.relToWorld(tk.x, tk.y, 0));
    if (Math.hypot(sp.x - sx, sp.y - sy) <= 18) return { kind: 'token', tid: tk.tid };
  }

  // 4. Props
  for (let i = b.items.length - 1; i >= 0; i--) {
    const it = b.items[i] as BoardProp;
    const sp = r.project(g.relToWorld(it.x, it.y, 0));
    if (Math.hypot(sp.x - sx, sp.y - sy) <= 15) return { kind: 'prop', iid: it.iid };
  }

  // 5. Texts
  for (let i = b.texts.length - 1; i >= 0; i--) {
    const tn = b.texts[i]!;
    const sp = r.project(g.relToWorld(tn.x, tn.y, 0));
    if (Math.abs(sp.x - sx) <= 36 && Math.abs(sp.y - sy) <= 16) return { kind: 'text', id: tn.id };
  }

  // 6. Measure lines (supports both straight and routed seg.path polylines)
  if (props.activeTool === 'measure' || props.activeTool === 'inspect') {
    for (let i = b.measures.length - 1; i >= 0; i--) {
      const m = b.measures[i]!;
      if (m.path && m.path.length >= 2) {
        for (let k = 1; k < m.path.length; k++) {
          const pa = r.project(g.relToWorld(m.path[k - 1]!.x, m.path[k - 1]!.y, 0));
          const pb = r.project(g.relToWorld(m.path[k]!.x, m.path[k]!.y, 0));
          if (distToSegment(sx, sy, pa.x, pa.y, pb.x, pb.y) <= 10) return { kind: 'measure', id: m.id };
        }
      } else {
        const pa = r.project(g.relToWorld(m.x1, m.y1, 0));
        const pb = r.project(g.relToWorld(m.x2, m.y2, 0));
        if (distToSegment(sx, sy, pa.x, pa.y, pb.x, pb.y) <= 10) return { kind: 'measure', id: m.id };
      }
    }
  }

  // 7. Shapes (in inspect mode)
  if (props.activeTool === 'inspect') {
    for (let i = b.shapes.length - 1; i >= 0; i--) {
      const sh = b.shapes[i]!;
      const pa = r.project(g.relToWorld(sh.x1, sh.y1, 0));
      const pb = r.project(g.relToWorld(sh.x2, sh.y2, 0));
      if (distToSegment(sx, sy, pa.x, pa.y, pb.x, pb.y) <= 10) return { kind: 'shape', id: sh.id };
    }
  }

  return null;
}

const KIND_ZH: Record<string, string> = {
  player: '角色',
  cipher: '密码机',
  chair: '狂欢之椅',
  pallet: '木板',
  window: '窗户',
  gate: '大门',
  chest: '箱子',
  hatch: '地窖',
};

function describePick(p: PickResult): string {
  if (p.kind === 'player') {
    const pl = props.payload?.players.find((x) => x.uid === p.uid);
    if (pl) return `${pl.camp === 1 ? '监管者' : '求生者'} ${pl.player_name} · ${p.floor}`;
  }
  return `${KIND_ZH[p.kind] ?? p.kind} #${p.uid} · ${p.floor}`;
}

// ------------------------------------------------------------------ pointer

type DragMode =
  | { kind: 'pan' }
  | { kind: 'rotate' }
  | { kind: 'draw' }
  | { kind: 'tac-token'; tid: number }
  | { kind: 'tac-prop'; iid: number }
  | { kind: 'tac-text'; id: number }
  | { kind: 'tac-measure-end'; id: number; end: 'a' | 'b' }
  | { kind: 'tac-anim-dot'; ptIdx: number };

interface DragState {
  mode: DragMode;
  x: number;
  y: number;
  sx: number;
  sy: number;
  moved: boolean;
  pointerId: number | null;
}
let drag: DragState | null = null;
const activePointers = new Map<number, { x: number; y: number }>();
let pinchState: { midX: number; midY: number; dist: number } | null = null;

function onPointerDown(e: PointerEvent | MouseEvent): void {
  if (!renderer.value) return;
  const p = localPoint(e);
  const pointerId = 'pointerId' in e && typeof e.pointerId === 'number' ? e.pointerId : null;

  if (pointerId !== null) {
    activePointers.set(pointerId, { x: p.x, y: p.y });
    capturePtr(pointerId);
  }

  if (activePointers.size >= 2) {
    if (drag) {
      if (drag.mode.kind === 'draw') {
        drawingPreview.value = null;
      } else if (
        drag.mode.kind === 'tac-token' ||
        drag.mode.kind === 'tac-prop' ||
        drag.mode.kind === 'tac-text' ||
        drag.mode.kind === 'tac-measure-end' ||
        drag.mode.kind === 'tac-anim-dot'
      ) {
        emit('tac-drag-end');
      }
      drag = null;
    }
    const [p1, p2] = Array.from(activePointers.values());
    pinchState = {
      midX: (p1!.x + p2!.x) / 2,
      midY: (p1!.y + p2!.y) / 2,
      dist: Math.hypot(p2!.x - p1!.x, p2!.y - p1!.y),
    };
    dragging.value = true;
    tip.value = null;
    requestRender();
    return;
  }

  if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
    if (props.activeTool === 'measure' && props.measurePending && e.button === 2) {
      emit('tac-measure-finish');
      return;
    }
    drag = { mode: { kind: 'rotate' }, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, pointerId };
    capturePtr(pointerId);
    return;
  }
  if (e.button !== 0) return;

  // 2-point ruler mode owns left click cleanly
  if (props.rulerMode) {
    drag = { mode: { kind: 'pan' }, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, pointerId };
    capturePtr(pointerId);
    return;
  }

  // Draw shape tool (non-text)
  if (props.activeTool === 'draw' && props.drawShape !== 'text') {
    const rel = snapRel(p.x, p.y, screenToRel(p.x, p.y));
    drawingPreview.value = {
      id: -1,
      kind: props.drawShape,
      x1: rel.x,
      y1: rel.y,
      x2: rel.x,
      y2: rel.y,
      points: props.drawShape === 'freehand' ? [{ x: rel.x, y: rel.y }] : undefined,
      color: props.drawColor,
      width: props.drawWidth,
    };
    drag = { mode: { kind: 'draw' }, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, pointerId };
    capturePtr(pointerId);
    requestRender();
    return;
  }

  // Check tactical overlay hits when not armed to place
  const placingArmed =
    (props.activeTool === 'place' && props.placePending !== null) ||
    (props.activeTool === 'draw' && props.drawShape === 'text') ||
    props.activeTool === 'range' ||
    props.routePickSlot !== null;

  if (!placingArmed && !(props.activeTool === 'measure' && props.measurePending)) {
    const hit = hitTestOverlay(p.x, p.y);
    if (hit) {
      if (hit.kind === 'anim-dot') {
        emit('tac-drag-start');
        drag = { mode: { kind: 'tac-anim-dot', ptIdx: hit.ptIdx }, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, pointerId };
        capturePtr(pointerId);
        return;
      }
      if (hit.kind === 'measure-end') {
        emit('tac-drag-start');
        drag = { mode: { kind: 'tac-measure-end', id: hit.id, end: hit.end }, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, pointerId };
        capturePtr(pointerId);
        return;
      }
      if (hit.kind === 'token' && props.activeTool !== 'anim') {
        emit('tac-select', { type: 'token', tid: hit.tid });
        emit('tac-drag-start');
        drag = { mode: { kind: 'tac-token', tid: hit.tid }, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, pointerId };
        capturePtr(pointerId);
        return;
      }
      if (hit.kind === 'prop' && props.activeTool !== 'anim') {
        emit('tac-select', { type: 'prop', iid: hit.iid });
        emit('tac-drag-start');
        drag = { mode: { kind: 'tac-prop', iid: hit.iid }, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, pointerId };
        capturePtr(pointerId);
        return;
      }
      if (hit.kind === 'text') {
        emit('tac-select', { type: 'text', id: hit.id });
        emit('tac-drag-start');
        drag = { mode: { kind: 'tac-text', id: hit.id }, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, pointerId };
        capturePtr(pointerId);
        return;
      }
    }
  }

  drag = { mode: { kind: 'pan' }, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, pointerId };
  capturePtr(pointerId);
}

function capturePtr(pointerId: number | null): void {
  if (pointerId === null) return;
  try {
    canvasEl.value?.setPointerCapture?.(pointerId);
  } catch {
    /* capture unsupported */
  }
}

function onPointerMove(e: PointerEvent | MouseEvent): void {
  const r = renderer.value;
  if (!r) return;
  const p = localPoint(e);
  const pointerId = 'pointerId' in e && typeof e.pointerId === 'number' ? e.pointerId : null;

  if (pointerId !== null && activePointers.has(pointerId)) {
    activePointers.set(pointerId, { x: p.x, y: p.y });
  }

  if (activePointers.size >= 2) {
    const [p1, p2] = Array.from(activePointers.values());
    const midX = (p1!.x + p2!.x) / 2;
    const midY = (p1!.y + p2!.y) / 2;
    const dist = Math.hypot(p2!.x - p1!.x, p2!.y - p1!.y);
    if (pinchState && !props.zoomLocked) {
      const worldAnchor = r.screenToWorld(pinchState.midX, pinchState.midY, 0);
      const cam = r.getCamera();
      const factor = pinchState.dist > 8 && dist > 8 ? dist / pinchState.dist : 1;
      const nextZoom = Math.max(fitZoom * 0.25, Math.min(fitZoom * 40, cam.zoom * factor));
      r.setCamera({ zoom: nextZoom });
      const worldAtNewMid = r.screenToWorld(midX, midY, 0);
      const c2 = r.getCamera();
      r.setCamera({
        centerX: c2.centerX + (worldAnchor[0] - worldAtNewMid[0]),
        centerZ: c2.centerZ + (worldAnchor[2] - worldAtNewMid[2]),
      });
      if (props.followUid !== null) emit('update:followUid', null);
      markObstaclesDirty();
      requestRender();
      schedulePostLayoutObstacleSync();
    }
    pinchState = { midX, midY, dist };
    return;
  }

  if (props.landmarks?.showCoords && props.geo) {
    const rel = screenToRel(p.x, p.y);
    const [dw, dh] = props.geo.mapData.mapSize;
    const px = Math.round(rel.x * dw);
    const py = Math.round(rel.y * dh);
    const mPerPx = dw > 0 ? props.geo.effectiveWidthM / dw : 0;
    cursorCoords.value = { px, py, mx: px * mPerPx, my: py * mPerPx };
  } else if (cursorCoords.value) {
    cursorCoords.value = null;
  }

  if (!drag) {
    if (props.activeTool === 'measure' && props.measurePending) {
      const rel = snapRel(p.x, p.y, screenToRel(p.x, p.y));
      measureHover.value = rel;
      requestRender();
    } else if (props.activeTool === 'draw' || props.activeTool === 'measure' || props.routePickSlot) {
      snapRel(p.x, p.y, screenToRel(p.x, p.y));
      requestRender();
    } else if (snapPoint.value) {
      snapPoint.value = null;
      requestRender();
    }
    const hit = props.payload ? r.pickEntityAtScreen(p.x, p.y, props.t) : null;
    tip.value = hit ? { x: p.x, y: p.y, text: describePick(hit) } : null;
    return;
  }

  if (!drag.moved && Math.hypot(p.x - drag.sx, p.y - drag.sy) > 4) {
    if (!(drag.mode.kind === 'pan' && props.zoomLocked)) {
      drag.moved = true;
      dragging.value = true;
      tip.value = null;
    }
  }

  const m = drag.mode;
  if (m.kind === 'draw' && drawingPreview.value) {
    const rel = snapRel(p.x, p.y, screenToRel(p.x, p.y));
    if (drawingPreview.value.kind === 'freehand') {
      drawingPreview.value.points = [...(drawingPreview.value.points ?? []), { x: rel.x, y: rel.y }];
    }
    drawingPreview.value.x2 = rel.x;
    drawingPreview.value.y2 = rel.y;
    requestRender();
    drag.x = p.x;
    drag.y = p.y;
    return;
  }

  if (m.kind === 'tac-token') {
    const rel = screenToRel(p.x, p.y);
    emit('tac-move-token', { tid: m.tid, x: rel.x, y: rel.y });
    requestRender();
    return;
  }
  if (m.kind === 'tac-prop') {
    const rel = screenToRel(p.x, p.y);
    emit('tac-move-prop', { iid: m.iid, x: rel.x, y: rel.y });
    requestRender();
    return;
  }
  if (m.kind === 'tac-text') {
    const rel = screenToRel(p.x, p.y);
    emit('tac-move-text', { id: m.id, x: rel.x, y: rel.y });
    requestRender();
    return;
  }
  if (m.kind === 'tac-measure-end') {
    const rel = snapRel(p.x, p.y, screenToRel(p.x, p.y));
    emit('tac-move-measure-end', { id: m.id, end: m.end, x: rel.x, y: rel.y });
    requestRender();
    return;
  }
  if (m.kind === 'tac-anim-dot') {
    const rel = screenToRel(p.x, p.y);
    emit('tac-move-anim-dot', { ptIdx: m.ptIdx, x: rel.x, y: rel.y });
    requestRender();
    return;
  }

  if (!drag.moved) return;
  const dx = p.x - drag.x;
  const dy = p.y - drag.y;
  if (m.kind === 'pan') {
    if (props.zoomLocked) return;
    const a = r.screenToWorld(drag.x, drag.y, 0);
    const b = r.screenToWorld(p.x, p.y, 0);
    const cam = r.getCamera();
    r.setCamera({ centerX: cam.centerX - (b[0] - a[0]), centerZ: cam.centerZ - (b[2] - a[2]) });
    if (props.followUid !== null) emit('update:followUid', null);
  } else if (m.kind === 'rotate') {
    if (props.zoomLocked) return;
    const yaw = wrapDeg360(props.yaw + dx * 0.4);
    r.setCamera({ yawDeg: yaw, pitchDeg: 90 });
    emit('update:yaw', Math.round(yaw * 10) / 10);
  }
  drag.x = p.x;
  drag.y = p.y;
  markObstaclesDirty();
  requestRender();
  schedulePostLayoutObstacleSync();
}

function handleClick(x: number, y: number): void {
  const r = renderer.value;
  if (!r || !props.payload) return;
  const hit = r.pickEntityAtScreen(x, y, props.t);
  if (props.rulerMode) {
    const point: Vec3 = hit ? [hit.pos[0], hit.pos[1], hit.pos[2]] : r.screenToWorld(x, y, rulerPlaneY());
    if (!pendingA) {
      pendingA = point;
      r.setRuler({ a: point, b: point });
      emit('update:ruler', null);
      emit('ruler-point', { point, index: 0, snapped: hit });
    } else {
      const ruler: RulerState = { a: pendingA, b: point };
      pendingA = null;
      r.setRuler(ruler);
      emit('update:ruler', ruler);
      emit('ruler-point', { point, index: 1, snapped: hit });
    }
    requestRender();
    return;
  }

  if (props.activeTool === 'place' && props.placePending) {
    const rel = screenToRel(x, y);
    emit('tac-place', rel);
    return;
  }

  if (props.activeTool === 'draw' && props.drawShape === 'text') {
    const rel = screenToRel(x, y);
    emit('tac-place', rel);
    return;
  }

  if (props.routePickSlot) {
    const rel = snapRel(x, y, screenToRel(x, y));
    emit('tac-route-pick', rel);
    return;
  }

  if (props.activeTool === 'measure') {
    const oHit = hitTestOverlay(x, y);
    if (oHit && oHit.kind === 'measure' && !props.measurePending) {
      emit('tac-select', { type: 'measure', id: oHit.id });
      return;
    }
    const rel = snapRel(x, y, screenToRel(x, y));
    emit('tac-measure-click', rel);
    return;
  }

  if (props.activeTool === 'range') {
    const rel = screenToRel(x, y);
    emit('tac-range-click', rel);
    return;
  }

  if (props.activeTool === 'anim') {
    const oHit = hitTestOverlay(x, y);
    if (oHit?.kind === 'token') {
      emit('tac-select', { type: 'token', tid: oHit.tid });
      return;
    }
    if (oHit?.kind === 'prop') {
      emit('tac-select', { type: 'prop', iid: oHit.iid });
      return;
    }
    if (props.animArmed) {
      const rel = screenToRel(x, y);
      emit('tac-anim-add-point', rel);
      return;
    }
  }

  // Inspect mode: prioritize overlay hit before replay pick
  const oHit = hitTestOverlay(x, y);
  if (oHit) {
    if (oHit.kind === 'token') emit('tac-select', { type: 'token', tid: oHit.tid });
    else if (oHit.kind === 'prop') emit('tac-select', { type: 'prop', iid: oHit.iid });
    else if (oHit.kind === 'text') emit('tac-select', { type: 'text', id: oHit.id });
    else if (oHit.kind === 'shape') emit('tac-select', { type: 'shape', id: oHit.id });
    else if (oHit.kind === 'measure') emit('tac-select', { type: 'measure', id: oHit.id });
    return;
  }

  emit('tac-select', null);
  emit('update:selectedUid', hit ? hit.uid : null);
  emit('pick', hit);
}

function onPointerUp(e: PointerEvent | MouseEvent): void {
  const pointerId = 'pointerId' in e && typeof e.pointerId === 'number' ? e.pointerId : null;
  if (pointerId !== null && activePointers.has(pointerId)) {
    activePointers.delete(pointerId);
    try {
      canvasEl.value?.releasePointerCapture?.(pointerId);
    } catch {
      /* ignore */
    }
  }

  if (pinchState !== null) {
    if (activePointers.size >= 2) {
      const [p1, p2] = Array.from(activePointers.values());
      pinchState = {
        midX: (p1!.x + p2!.x) / 2,
        midY: (p1!.y + p2!.y) / 2,
        dist: Math.hypot(p2!.x - p1!.x, p2!.y - p1!.y),
      };
    } else if (activePointers.size === 1) {
      pinchState = null;
      const [remId, remPt] = Array.from(activePointers.entries())[0]!;
      drag = {
        mode: { kind: 'pan' },
        x: remPt.x,
        y: remPt.y,
        sx: remPt.x,
        sy: remPt.y,
        moved: true,
        pointerId: remId,
      };
    } else {
      pinchState = null;
      dragging.value = false;
    }
    return;
  }

  if (!drag) return;
  const d = drag;
  drag = null;
  dragging.value = false;
  if (d.pointerId !== null) {
    try {
      canvasEl.value?.releasePointerCapture?.(d.pointerId);
    } catch {
      /* ignore */
    }
  }

  if (d.mode.kind === 'draw' && drawingPreview.value) {
    const sh = drawingPreview.value;
    drawingPreview.value = null;
    const p = localPoint(e);
    const distPx = Math.hypot(p.x - d.sx, p.y - d.sy);
    if (distPx >= 8 || (sh.points && sh.points.length >= 3)) {
      emit('tac-draw-commit', {
        kind: sh.kind,
        x1: sh.x1,
        y1: sh.y1,
        x2: sh.x2,
        y2: sh.y2,
        ...(sh.points ? { points: sh.points } : {}),
        color: sh.color,
        width: sh.width,
        dashed: sh.kind === 'circle' || sh.kind === 'rect',
      });
    }
    requestRender();
    return;
  }

  if (
    d.mode.kind === 'tac-token' ||
    d.mode.kind === 'tac-prop' ||
    d.mode.kind === 'tac-text' ||
    d.mode.kind === 'tac-measure-end' ||
    d.mode.kind === 'tac-anim-dot'
  ) {
    emit('tac-drag-end');
    requestRender();
    return;
  }

  if (!d.moved && d.mode.kind === 'pan') {
    const p = localPoint(e);
    handleClick(p.x, p.y);
  }
}

function onPointerLeave(): void {
  tip.value = null;
  cursorCoords.value = null;
  if (measureHover.value || snapPoint.value) {
    measureHover.value = null;
    snapPoint.value = null;
    requestRender();
  }
}

function onWheel(e: WheelEvent): void {
  const r = renderer.value;
  if (!r || props.zoomLocked) return;
  const p = localPoint(e);
  const before = r.screenToWorld(p.x, p.y, 0);
  const cam = r.getCamera();
  const factor = Math.exp(-e.deltaY * 0.0015);
  const zoom = Math.max(fitZoom * 0.25, Math.min(fitZoom * 40, cam.zoom * factor));
  r.setCamera({ zoom });
  const after = r.screenToWorld(p.x, p.y, 0);
  const c2 = r.getCamera();
  r.setCamera({ centerX: c2.centerX + (before[0] - after[0]), centerZ: c2.centerZ + (before[2] - after[2]) });
  markObstaclesDirty();
  requestRender();
  schedulePostLayoutObstacleSync();
}

function zoomBy(factor: number): void {
  const r = renderer.value;
  if (!r || props.zoomLocked) return;
  const cam = r.getCamera();
  r.setCamera({ zoom: Math.max(fitZoom * 0.25, Math.min(fitZoom * 40, cam.zoom * factor)) });
  markObstaclesDirty();
  requestRender();
  schedulePostLayoutObstacleSync();
}

function pulseRel(pt: Point2D): void {
  const r = renderer.value;
  const g = props.geo;
  if (!r || !g) return;
  const sp = r.project(g.relToWorld(pt.x, pt.y, 0));
  pulse.value = { key: Date.now(), x: sp.x, y: sp.y };
  requestRender();
}

function clearRuler(): void {
  pendingA = null;
  renderer.value?.setRuler(null);
  requestRender();
}

function exportBoardPng(
  opts?: { crop?: boolean; keepRotation?: boolean },
): { dataUrl: string; fileName: string; crop: boolean; keepRotation: boolean } {
  const crop = opts?.crop ?? props.exportCrop;
  const keepRotation = opts?.keepRotation ?? props.exportRot;
  const r = renderer.value;
  const savedCam = r ? { ...r.getCamera() } : null;
  const savedFitZoom = fitZoom;
  const mapName = props.geo?.mapData.mapName ?? props.payload?.match.map_name ?? '战术沙盘';
  const fileName = `${mapName}-战术沙盘.png`;
  const base = canvasEl.value;
  const over = overlayEl.value;
  if (!base || typeof document === 'undefined') {
    return { dataUrl: '', fileName, crop, keepRotation };
  }

  let dataUrl = '';
  const needsCameraSwap = Boolean(r && savedCam && (!crop || (!keepRotation && Math.abs(savedCam.yawDeg) > 0.05)));
  try {
    if (r && savedCam && needsCameraSwap) {
      if (!keepRotation) {
        r.setCamera({ yawDeg: 0 });
      }
      if (!crop) {
        fit();
      }
    }
    measureObstacles();
    renderNow();

    const w = base.width || 800;
    const h = base.height || 560;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    if (ctx) {
      ctx.drawImage(base, 0, 0, w, h);
      if (over && over.width > 0 && over.height > 0) {
        ctx.drawImage(over, 0, 0, w, h);
      }
    }
    dataUrl = out.toDataURL('image/png');
    if (dataUrl && dataUrl.startsWith('data:image/png') && typeof navigator !== 'undefined' && !/jsdom/i.test(navigator.userAgent)) {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } catch {
    dataUrl = '';
  } finally {
    if (r && savedCam && needsCameraSwap) {
      r.setCamera(savedCam);
      fitZoom = savedFitZoom;
      measureObstacles();
      renderNow();
    }
  }
  return { dataUrl, fileName, crop, keepRotation };
}

function initializeRenderer() {
  const c = canvasEl.value;
  let ctx: Canvas2DContextLike | null = null;
  try {
    ctx = (c?.getContext('2d') as CanvasRenderingContext2D | null) ?? null;
  } catch {
    ctx = null;
  }
  canvasSupported.value = !!ctx;
  const camera = renderer.value?.getCamera();
  const r = new TacticalReplayRenderer(ctx ?? NOOP_CTX, viewportSize(), {
    visualPreset: visualPreset.value, topSafeInset: 48, font: CANVAS_FONT_CJK,
  });
  renderer.value = r;
  r.setLayers(props.layers);
  r.setUnderlay({ ...props.underlay, ...VISUAL_PRESETS[visualPreset.value].underlay });
  r.setSelectedUid(props.selectedUid);
  r.setChaseSegments(props.chaseSegments);
  measure();
  applyPayload(props.payload);
  if (camera) {
    r.setCamera(camera);
    loadUnderlay(props.payload);
  }
  if (props.ruler) r.setRuler(props.ruler);
  markObstaclesDirty();
  renderNow();
}

function onViewportOrScrollChange(): void {
  const r = renderer.value;
  if (!r) return;
  const prev = r.getViewport();
  measure();
  const vp = r.getViewport();
  const dprChanged = prev.dpr !== vp.dpr;
  const obstaclesChanged = measureObstacles();
  if (dprChanged || obstaclesChanged) requestRender();
  schedulePostLayoutObstacleSync();
}

function bindDprListener(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  if (dprMedia) dprMedia.removeEventListener('change', onDprMediaChange);
  const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  dprMedia = window.matchMedia(`(resolution: ${dpr}dppx)`);
  dprMedia.addEventListener('change', onDprMediaChange);
}

function onDprMediaChange(): void {
  bindDprListener();
  onViewportOrScrollChange();
}

onMounted(() => {
  initializeRenderer();
  preloadHunterPortraits();
  void whenFontsReady().then(() => {
    refreshObstacles();
    requestRender();
  });
  if (typeof ResizeObserver !== 'undefined' && boardEl.value) {
    resizeObs = new ResizeObserver(() => {
      const r = renderer.value;
      if (!r) return;
      const prev = r.getViewport();
      measure();
      const vp = r.getViewport();
      const atFit = Math.abs(fitZoom - r.getCamera().zoom) <= 1e-6 * Math.max(1, fitZoom);
      if (prev.width <= 1 || prev.height <= 1 || (atFit && (prev.width !== vp.width || prev.height !== vp.height))) {
        fit();
      }
      refreshObstacles();
      requestRender();
    });
    resizeObs.observe(boardEl.value);

    const scope = boardEl.value.closest('#stage2') ?? boardEl.value;
    overlayObs = new ResizeObserver(() => {
      if (measureObstacles()) requestRender();
    });
    for (const el of scope.querySelectorAll(OBSERVED_OVERLAY_SELECTORS)) {
      overlayObs.observe(el);
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onViewportOrScrollChange, { passive: true });
    window.addEventListener('scroll', onViewportOrScrollChange, { passive: true, capture: true });
    bindDprListener();
  }
  refreshObstacles();
  renderNow();
});

onBeforeUnmount(() => {
  resizeObs?.disconnect();
  resizeObs = null;
  overlayObs?.disconnect();
  overlayObs = null;
  if (dprMedia) {
    dprMedia.removeEventListener('change', onDprMediaChange);
    dprMedia = null;
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', onViewportOrScrollChange);
    window.removeEventListener('scroll', onViewportOrScrollChange, true);
  }
  if (typeof cancelAnimationFrame === 'function' && postLayoutRaf) {
    cancelAnimationFrame(postLayoutRaf);
    postLayoutRaf = 0;
  }
  activePointers.clear();
  pinchState = null;
  underlayToken++;
});

watch(visualPreset, () => { if (renderer.value) initializeRenderer(); });
watch(() => props.payload, (p) => applyPayload(p));
watch(() => [props.pitch, props.yaw, props.yScale], () => {
  applyCameraProps();
  requestRender();
});
watch(
  () => props.layers,
  (l) => {
    renderer.value?.setLayers(l);
    requestRender();
  },
  { deep: true },
);
watch(
  () => props.underlay,
  (u) => {
    renderer.value?.setUnderlay({ enabled: u.enabled, opacity: u.opacity, rotationQuadrants: u.rotationQuadrants, flipX: u.flipX, flipZ: u.flipZ });
    requestRender();
  },
  { deep: true },
);
watch(() => props.landmarks?.showCoords, (on) => {
  if (!on) cursorCoords.value = null;
});
watch(() => props.t, () => requestRender());
watch(() => props.rangeEval, () => requestRender());
watch(
  () => [
    props.selection,
    props.measurePending,
    props.animTime,
    props.animPlaying,
    props.activeTool,
    props.cipherGroupIndex,
    props.routePointA,
    props.routePointB,
    props.highlightedCipherId,
  ],
  () => {
    requestRender();
  },
);
watch(
  () => [
    props.board,
    props.landmarks,
    props.rangeState,
  ],
  () => {
    preloadHunterPortraits();
    requestRender();
  },
  { deep: true },
);
watch(
  () => props.ruler,
  (rv) => {
    if (rv) renderer.value?.setRuler(rv);
    else if (!pendingA) renderer.value?.setRuler(null);
    requestRender();
  },
);
watch(
  () => props.rulerMode,
  (on) => {
    if (!on) pendingA = null;
  },
);
watch(
  () => props.selectedUid,
  (uid) => {
    renderer.value?.setSelectedUid(uid);
    requestRender();
  },
);
watch(() => [props.obstacleVersion, props.directorHeight, props.folioOpen, props.legendSide, underlayStatus.value], () => {
  refreshObstacles();
}, { flush: 'post' });
watch(() => props.followUid, () => {
  markObstaclesDirty();
  requestRender();
  schedulePostLayoutObstacleSync();
});
watch(
  () => props.chaseSegments,
  (s) => {
    renderer.value?.setChaseSegments(s);
    requestRender();
  },
);
watch(
  () => props.focus,
  (f) => {
    const r = renderer.value;
    if (!f || !r || !props.payload) return;
    let pos: readonly number[] | null = f.pos;
    if (!pos && f.uid !== null) {
      const s = samplePlayerAtTime(props.payload.trajectories?.[String(f.uid)], f.t);
      pos = s ? s.pos : null;
    }
    if (!pos) return;
    if (props.followUid !== null) emit('update:followUid', null);
    r.setCamera({ centerX: pos[0], centerZ: pos[2] });
    const sp = r.project([pos[0], pos[1], pos[2]]);
    pulse.value = { key: f.key, x: sp.x, y: sp.y };
    markObstaclesDirty();
    requestRender();
    schedulePostLayoutObstacleSync();
  },
);

const hud = computed(() => '2D 俯视');
const showMatFrame = computed(() => Boolean(mapRectCss.value && Math.abs(props.yaw) < 0.05 && props.underlay.enabled));
const frameSafeInset = computed(() => ({
  left: 14,
  top: 62,
  bottom: props.directorHeight > 0 ? Math.max(40, props.directorHeight + 20) : 7,
  right: 14,
}));
const boardStyleVars = computed(() => ({
  '--compass-left': `${compassLeftPx.value}px`,
  '--hud-right': `${hudRightPx.value}px`,
  '--hud-bottom': `${props.directorHeight > 0 ? Math.max(40, props.directorHeight + 20) : 8}px`,
}));

function getReservedRects(): readonly CssRect[] {
  return cachedObstacles.map((r) => ({ ...r }));
}

defineExpose({
  renderer,
  fit,
  centerOn,
  zoomBy,
  pulseRel,
  clearRuler,
  renderNow,
  refreshObstacles,
  getReservedRects,
  exportBoardPng,
  underlayStatus,
  canvasSupported,
  cursorCoords,
});
</script>

<template>
  <div
    ref="boardEl"
    class="board"
    :class="{ ruler: rulerMode || activeTool === 'draw' || activeTool === 'measure', dragging }"
    :style="boardStyleVars"
    data-test="board"
  >
    <canvas
      ref="canvasEl"
      data-test="board-canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @lostpointercapture="onPointerUp"
      @pointerleave="onPointerLeave"
      @wheel.prevent="onWheel"
      @contextmenu.prevent
    ></canvas>
    <canvas ref="overlayEl" class="tac-overlay-canvas" data-test="tactical-overlay-canvas"></canvas>
    <div
      v-if="showMatFrame && mapRectCss"
      class="map-mat-frame"
      aria-hidden="true"
      :style="{
        left: `${mapRectCss.left}px`,
        top: `${mapRectCss.top}px`,
        width: `${mapRectCss.width}px`,
        height: `${mapRectCss.height}px`,
      }"
    ></div>
    <ManorMapFrame v-if="canObserveFrame" :px-per-meter="pxPerMeter" :north-angle="northAngle"
      :safe-inset="frameSafeInset" />
    <slot name="map-badges" />
    <div class="hud">
      <b>{{ hud }}</b> · 偏航 <span class="num">{{ yaw.toFixed(0) }}°</span>
      <template v-if="underlayStatus === 'missing'"> · <span class="red">底图缺失</span></template>
      <template v-if="rulerMode"> · <span class="gold">测距：依次点击两点（可吸附实体）</span></template>
      <template v-else-if="activeTool === 'place' && placePending"> · <span class="gold">放置：点击沙盘落子</span></template>
      <template v-else-if="activeTool === 'draw'"> · <span class="gold">绘制：左键拖拽或点击放置文字</span></template>
      <template v-else-if="activeTool === 'measure'"> · <span class="gold">测算：点击两点测距与估算用时</span></template>
      <template v-else-if="activeTool === 'range'"> · <span class="gold">范围：点击沙盘椅位或起点</span></template>
      <template v-else-if="activeTool === 'anim' && animArmed"> · <span class="gold">动画：点击沙盘追加路径点</span></template>
      <template v-if="!canvasSupported"> · <span class="red">当前环境不支持 Canvas 2D</span></template>
    </div>
    <div v-if="landmarks?.showCoords && cursorCoords" class="tac-coords-tip num" data-test="tac-coords-tip">
      X {{ cursorCoords.px }}px ({{ cursorCoords.mx.toFixed(1) }}m) · Y {{ cursorCoords.py }}px ({{ cursorCoords.my.toFixed(1) }}m)
    </div>
    <div v-if="tip" class="tip" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }">{{ tip.text }}</div>
    <div v-if="pulse" :key="pulse.key" class="pulse" data-test="pulse" :style="{ left: `${pulse.x}px`, top: `${pulse.y}px` }"></div>
    <div v-if="!payload" class="loading"><slot name="empty">尚未载入录像</slot></div>
  </div>
</template>

<style scoped>
.board { background:#14110e; }
.board canvas { touch-action:none; }
.board::after { display:none; }
.map-mat-frame {
  position:absolute;
  z-index:2;
  pointer-events:none;
  border:1px solid #c9a25faa;
  box-shadow:inset 0 0 0 1px #1d150e, 0 0 0 1px #3b2a19, 0 0 16px #07050488;
}
.board :deep(.compass) {
  left:var(--compass-left, 14px) !important;
  width:64px;
  height:64px;
  box-shadow:0 0 0 1px #ae8955, inset 0 0 12px #100e0c, 0 3px 8px #07050399;
}
.board :deep(.scale) {
  /* Trim the frame's trailing gutter. SVG ticks keep their projected coordinates. */
  width:calc(attr(width type(<number>)) * 1px - 8px);
  height:31px;
}
.board :deep(.compass text) { font-size:14px; }
.board :deep(.scale), .board .hud { background:linear-gradient(130deg,#30271e,#1a1714); border:1px solid #a98149; border-radius:4px; box-shadow:0 2px 5px #0008; }
.board .hud { z-index:3; left:auto; right:var(--hud-right, 14px); bottom:var(--hud-bottom, 8px); max-width:38%; padding:2px 8px; font-size:12px; color:#f3e3c6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
</style>
