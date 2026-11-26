/**
 * TacticalReplayRenderer — zero-DOM Canvas 2D / 2.5D tactical replay renderer.
 * Draws strictly through an injected Canvas2DContextLike (browser canvas or
 * WeChat Mini Program <canvas type="2d">).
 */
import {
  clamp,
  computeUnderlayAffine,
  createDefaultCamera,
  fitCameraToBounds,
  normalizeCamera,
  OBLIQUE_PITCH_THRESHOLD_DEG,
  projectWorldToScreen,
  screenToWorldOnPlane,
} from './projection.js';
import {
  classifyFloor,
  DEFAULT_FLOOR_PLANES,
  FLOOR_IDS,
  formatCrossFloorBadge,
  formatRulerLabel,
  measureTacticalDistance,
} from './ruler.js';
import {
  DEFAULT_PULSE_WINDOW_S,
  DEFAULT_TRAIL_SECONDS,
  extractPlayerTrail,
  getActivePulsesAtTime,
  isChaseActiveAtTime,
  isWindowSealedAtTime,
  sampleChairAtTime,
  sampleCipherAtTime,
  sampleGateAtTime,
  samplePalletAtTime,
  samplePlayerAtTime,
  sortEventsByTime,
} from './state.js';
import type {
  CssRect,
  CameraState,
  Canvas2DContextLike,
  FloorId,
  LayerVisibilityState,
  PickEntityKind,
  PickResult,
  PlayerSample,
  Replay2DPayload,
  ReplayPlayer,
  ReplayTimelineEvent,
  RulerState,
  ScreenPoint,
  StaticSceneEntity,
  UnderlayConfig,
  Vec3,
  ViewportSize,
  WorldRect,
} from './types.js';

// ---------------------------------------------------------------------------
// Palette (Manor Dossier, matching template.html tokens)
// ---------------------------------------------------------------------------

export interface ManorPalette {
  bg: string;
  bg3: string;
  line: string;
  line2: string;
  text: string;
  muted: string;
  dim: string;
  gold: string;
  goldD: string;
  red: string;
  redL: string;
  blue: string;
  ice: string;
}

export const MANOR_DOSSIER_PALETTE: Readonly<ManorPalette> = Object.freeze({
  bg: '#0b0a09',
  bg3: '#1a1714',
  line: '#3a332a',
  line2: '#5c4e3a',
  text: '#ddd3bd',
  muted: '#9a8f7a',
  dim: '#655c4e',
  gold: '#c9a25f',
  goldD: '#8e7a4a',
  red: '#8e2f3c',
  redL: '#b04a58',
  blue: '#6f8fb8',
  ice: '#a9c7e8',
});

export const MANOR_CLARITY_PALETTE: Readonly<ManorPalette> = Object.freeze({
  ...MANOR_DOSSIER_PALETTE,
  bg: '#14110e',
  bg3: '#2b251d',
  text: '#f0e6d2',
  muted: '#b9ac98',
  dim: '#948879',
  gold: '#d8b36a',
  goldD: '#f2c96b',
  redL: '#e0626f',
  blue: '#8fb3e0',
  ice: '#bfe0ff',
});

export type VisualPresetId = 'clarity' | 'original' | 'dossier';

export interface VisualPresetConfig {
  readonly palette: Readonly<ManorPalette>;
  readonly underlay: Readonly<{
    opacity: number;
    backing: string;
    tone: Readonly<NonNullable<UnderlayConfig['tone']>> | null;
  }>;
  readonly grid: Readonly<{ minor: string; major: string; majorEvery: number }>;
  readonly glyphScale: number;
}

export const VISUAL_PRESETS: Readonly<Record<VisualPresetId, VisualPresetConfig>> = Object.freeze({
  clarity: Object.freeze({
    palette: MANOR_CLARITY_PALETTE,
    underlay: Object.freeze({
      opacity: 0.95, backing: '#2b251d',
      tone: Object.freeze({ brightness: 1.35, contrast: 1.12, saturation: 1.08 }),
    }),
    grid: Object.freeze({ minor: 'rgba(240,230,210,.14)', major: 'rgba(216,179,106,.32)', majorEvery: 5 }),
    glyphScale: 1.35,
  }),
  original: Object.freeze({
    palette: MANOR_CLARITY_PALETTE,
    underlay: Object.freeze({ opacity: 1, backing: '#1c1915', tone: null }),
    grid: Object.freeze({ minor: 'rgba(240,230,210,.10)', major: 'rgba(216,179,106,.22)', majorEvery: 5 }),
    glyphScale: 1.2,
  }),
  dossier: Object.freeze({
    palette: MANOR_DOSSIER_PALETTE,
    underlay: Object.freeze({ opacity: 0.72, backing: '#0b0a09', tone: null }),
    grid: Object.freeze({ minor: 'rgba(58,51,42,.35)', major: 'rgba(58,51,42,.35)', majorEvery: 5 }),
    glyphScale: 1,
  }),
});

export interface RendererOptions {
  /** Hosts can select clarity for new views. Omission keeps the legacy palette and framing. */
  visualPreset?: VisualPresetId;
  glyphScale?: number;
  /** Reserved space above the fitted world in CSS pixels. */
  topSafeInset?: number;
  palette?: Partial<ManorPalette>;
  pickRadiusPx?: number;
  trailSeconds?: number;
  pulseWindowS?: number;
  /** World radius of the et=304 camera view cone. */
  viewConeRadiusU?: number;
  viewConeHalfAngleDeg?: number;
  font?: string;
}

export function createDefaultLayers(overrides: Partial<LayerVisibilityState> = {}): LayerVisibilityState {
  return {
    visibleFloors: { B1: true, '1F': true, '2F': true },
    focusFloor: null,
    grid: true,
    floorPlanes: true,
    dropLines: true,
    trails: true,
    viewCones: true,
    dirArrows: true,
    ciphers: true,
    pallets: true,
    windows: true,
    chairs: true,
    gates: true,
    chests: true,
    hatch: true,
    pulses: true,
    labels: true,
    ...overrides,
  };
}

interface Drawable {
  depth: number;
  order: number;
  draw: () => void;
}

type StaticPickKind = Exclude<PickEntityKind, 'player'>;
type Point2D = Pick<ScreenPoint, 'x' | 'y'>;
type ScreenSegment = [Point2D, Point2D];

function pointToSegmentDistance(sx: number, sy: number, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp(((sx - a.x) * dx + (sy - a.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(sx - (a.x + t * dx), sy - (a.y + t * dy));
}

interface PickCandidate {
  kind: PickEntityKind;
  uid: number;
  pos: Vec3;
  floor: FloorId;
  priority: number;
  hitRadiusPx: number;
  segment?: ScreenSegment;
}

const DROP_LINE_MIN_ABS_Y = 2.0;
const FOCUS_DIM_ALPHA = 0.28;
const HALO_COLOR = '#0b0a09';
const HALO_ALPHA = 0.85;
const DEFAULT_UNDERLAY_OPACITY = 0.92;

interface NameAnchor extends Point2D {
  uid: number;
  name: string;
  hunter: boolean;
  selected: boolean;
  token: CssRect;
}

interface NamePlate {
  anchor: NameAnchor;
  lines: { text: string; x: number; y: number }[];
  width: number;
  height: number;
}

interface PlacedPlate extends NamePlate {
  box: CssRect;
  leader: boolean;
  degraded?: boolean;
}

function box(left: number, top: number, width: number, height: number): CssRect {
  return { left, top, right: left + width, bottom: top + height };
}

function expand(r: CssRect, n: number): CssRect {
  return { left: r.left - n, right: r.right + n, top: r.top - n, bottom: r.bottom + n };
}

function intersects(a: CssRect, b: CssRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// Squared distance to the closest viewport point. All geometry here is CSS-local.
function viewportDistanceSq(p: Point2D, v: ViewportSize): number {
  return (p.x - clamp(p.x, 0, v.width)) ** 2 + (p.y - clamp(p.y, 0, v.height)) ** 2;
}

function ringVisible(p: Point2D, r: number, halfStroke: number, v: ViewportSize): boolean {
  const farthest = Math.max(p.x ** 2, (v.width - p.x) ** 2) + Math.max(p.y ** 2, (v.height - p.y) ** 2);
  return viewportDistanceSq(p, v) <= (r + halfStroke) ** 2 && farthest >= Math.max(0, r - halfStroke) ** 2;
}

// The filled triangle and its round halo are the triangle dilated by a disc.
// A closest pair lies on intersecting edges, or includes a vertex of either polygon.
function headingVisible(vertices: Point2D[], halfStroke: number, v: ViewportSize): boolean {
  const board = box(0, 0, v.width, v.height);
  const corners = [{ x: 0, y: 0 }, { x: v.width, y: 0 }, { x: 0, y: v.height }, { x: v.width, y: v.height }];
  if (vertices.some(p => viewportDistanceSq(p, v) <= halfStroke ** 2)) return true;
  const sides = vertices.map((a, i) => ({ a, b: vertices[(i + 1) % vertices.length] }));
  if (sides.some(({ a, b }) => lineInterval(a, b, board))) return true;
  return corners.some(c => {
    const crosses = sides.map(({ a, b }) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (crosses.every(n => n >= 0) || crosses.every(n => n <= 0)) return true;
    return sides.some(({ a, b }) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = clamp(((c.x - a.x) * dx + (c.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
      return (c.x - a.x - t * dx) ** 2 + (c.y - a.y - t * dy) ** 2 <= halfStroke ** 2;
    });
  });
}

// Signed ink bearings refer to the current alignment and baseline.
function textBounds(ctx: Canvas2DContextLike, text: string, size: number): CssRect {
  const m = ctx.measureText?.(text);
  const width = m?.width ?? Array.from(text).length * size * 1.1;
  const left = ctx.textAlign === 'center' ? width / 2 : 0;
  const middle = ctx.textBaseline === 'middle';
  return {
    left: -(m?.actualBoundingBoxLeft ?? left + size * 0.12),
    right: m?.actualBoundingBoxRight ?? width - left + size * 0.12,
    top: -(m?.actualBoundingBoxAscent ?? size * (middle ? 0.7 : 1.15)),
    bottom: m?.actualBoundingBoxDescent ?? size * (middle ? 0.7 : 0.25),
  };
}

function measurePlate(ctx: Canvas2DContextLike, anchor: NameAnchor, texts: string[], size: number): NamePlate {
  const ink = texts.map(text => expand(textBounds(ctx, text, size), ctx.strokeText ? 1.5 : 1));
  const height = ink.reduce((sum, r) => sum + r.bottom - r.top + 2, 0) + 2;
  const span = Math.max(1, ...ink.map(r => r.right - r.left));
  // Keep the outlined ink in the straight section. Both caps extend
  // half a lineWidth beyond their respective endpoints.
  const width = span + height;
  let y = 2;
  const lines = texts.map((text, i) => {
    const r = ink[i];
    const line = { text, x: (width - r.left - r.right) / 2, y: y - r.top };
    y += r.bottom - r.top + 2;
    return line;
  });
  return { anchor, lines, width, height };
}

const DIRECTIONS = [[0, -1], [1, -1], [-1, -1], [0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0]] as const;

function fits(r: CssRect, board: CssRect, blocked: CssRect[]): boolean {
  // Subtracting a fractional height and adding it back may land one ULP
  // inside the two-pixel clearance. Test its interior, keeping the paint exact.
  const interior = expand(r, -1e-9);
  return interior.left >= board.left && interior.right <= board.right &&
    interior.top >= board.top && interior.bottom <= board.bottom && !blocked.some(b => intersects(interior, b));
}

function* freeSlots(w: number, h: number, preferred: Point2D, board: CssRect, blocked: CssRect[]): Generator<CssRect> {
  if (w > board.right - board.left || h > board.bottom - board.top) return;
  const xs = new Set([preferred.x, board.left, board.right - w]);
  const ys = new Set([preferred.y, board.top, board.bottom - h]);
  for (const b of blocked) {
    xs.add(b.right);
    xs.add(b.left - w);
    ys.add(b.bottom);
    ys.add(b.top - h);
  }
  for (const x of xs) {
    if (x < board.left || x > board.right - w) continue;
    for (const y of ys) {
      const r = box(x, y, w, h);
      if (fits(r, board, blocked)) yield r;
    }
  }
}

function nearestSlots(w: number, h: number, preferred: Point2D, anchor: Point2D, board: CssRect, blocked: CssRect[]): CssRect[] {
  const distance = (r: CssRect) => (r.left + w / 2 - anchor.x) ** 2 + (r.top + h / 2 - anchor.y) ** 2;
  return [...freeSlots(w, h, preferred, board, blocked)]
    .sort((u, v) => distance(u) - distance(v) || u.top - v.top || u.left - v.left);
}

function* localSlots(p: NamePlate, board: CssRect, blocked: CssRect[]): Generator<PlacedPlate> {
  const { anchor: a, width: w, height: h } = p;
  for (let ring = 0; ring < 4; ring++) {
    const gap = 2 + ring * (h + 4);
    for (const [dx, dy] of DIRECTIONS) {
      const x = dx > 0 ? a.token.right + gap : dx < 0 ? a.token.left - w - gap : a.x - w / 2;
      const y = dy > 0 ? a.token.bottom + gap : dy < 0 ? a.token.top - h - gap : a.y - h / 2;
      const r = box(x, y, w, h);
      if (fits(r, board, blocked)) yield { ...p, box: r, leader: ring !== 0 || dx !== 0 || dy !== -1 };
    }
  }
  const preferred = { x: a.x - w / 2, y: a.token.top - h - 2 };
  for (const slot of nearestSlots(w, h, preferred, a, board, blocked)) yield { ...p, box: slot, leader: true };
}

// A separation is a lower bound on the start of one plate relative to another.
// For any chosen set of separations the componentwise earliest coordinates are
// sufficient. A collision there requires at least one of the branches below.
function feasibleLayout(plates: NamePlate[], board: CssRect, fixed: CssRect[]): PlacedPlate[] | undefined {
  type Edge = { from: number; to: number; vertical: boolean };
  function solve(x: number[], y: number[], edges: Edge[]): PlacedPlate[] | undefined {
    for (let pass = 0; pass <= plates.length; pass++) {
      let changed = false;
      for (const { from, to, vertical } of edges) {
        const axis = vertical ? y : x;
        const bound = axis[from] + (vertical ? plates[from].height : plates[from].width) + 2;
        if (bound > axis[to] + 1e-9) {
          axis[to] = bound;
          changed = true;
        }
      }
      if (!changed) break;
      if (pass === plates.length) return; // positive cycle
    }
    const boxes = plates.map((p, i) => box(x[i], y[i], p.width, p.height));
    if (boxes.some(b => b.right > board.right + 1e-9 || b.bottom > board.bottom + 1e-9)) return;
    for (const [i, b] of boxes.entries()) {
      const interior = expand(b, -1e-9);
      const obstacle = fixed.find(f => intersects(f, interior));
      if (obstacle) {
        // Moving left/up is impossible from the earliest point.
        const right = x.slice(), below = y.slice();
        right[i] = obstacle.right;
        below[i] = obstacle.bottom;
        return solve(right, y.slice(), edges) ?? solve(x.slice(), below, edges);
      }
      for (let j = 0; j < i; j++) {
        if (!intersects(expand(boxes[j], 2), interior)) continue;
        for (const vertical of [false, true]) for (const [from, to] of [[j, i], [i, j]]) {
          const result = solve(x.slice(), y.slice(), [...edges, { from, to, vertical }]);
          if (result) return result;
        }
        return;
      }
    }
    return plates.map((p, i) => ({ ...p, box: boxes[i], leader: true }));
  }
  return solve(plates.map(() => board.left), plates.map(() => board.top), []);
}

function retryLayout(order: NamePlate[], board: CssRect, blocked: CssRect[]): PlacedPlate[] | undefined {
  const [first, ...rest] = order;
  if (!first) return [];
  for (const p of localSlots(first, board, blocked)) {
    const remaining = retryLayout(rest, board, [...blocked, expand(p.box, 2)]);
    if (remaining) return [p, ...remaining];
  }
}

function* placementOrders(plates: NamePlate[]): Generator<NamePlate[]> {
  if (!plates.length) yield [];
  for (const p of plates) {
    for (const rest of placementOrders(plates.filter(other => other !== p))) yield [p, ...rest];
  }
}

// A numbered column can occupy a separate free pocket on either side of a HUD.
function packRoster(plates: NamePlate[], board: CssRect, obstacles: CssRect[]): PlacedPlate[] | undefined {
  // A nearest first column may consume the only pocket wide enough for
  // the second. Backtrack over legal edge slots before abandoning the split.
  function fillColumns(columns: NamePlate[][], blocked: CssRect[]): PlacedPlate[] | undefined {
    const [column, ...remaining] = columns;
    if (!column) return [];
    const w = Math.max(...column.map(p => p.width));
    const h = column.reduce((sum, p) => sum + p.height + 2, -2);
    const anchor = column[0].anchor;
    const preferred = { x: anchor.x - w / 2, y: anchor.y - h / 2 };
    for (const slot of nearestSlots(w, h, preferred, anchor, board, blocked)) {
      let y = slot.top;
      const placed = column.map(p => {
        const r = box(slot.left, y, p.width, p.height);
        y = r.bottom + 2;
        return { ...p, box: r, leader: true };
      });
      const rest = fillColumns(remaining, [...blocked, ...placed.map(p => expand(p.box, 2))]);
      if (rest) return placed.concat(rest);
    }
  }
  for (let split = plates.length; split >= 1; split--) {
    const columns = [plates.slice(0, split), plates.slice(split)].filter(c => c.length);
    const result = fillColumns(columns, obstacles);
    if (result) return result;
  }
}

// Parametric interval inside a box, used to trim leaders at both ends
// and leave a gap wherever another plate covers their path.
function lineInterval(a: Point2D, b: Point2D, r: CssRect): [number, number] | undefined {
  let lo = 0, hi = 1;
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, r.left, r.right], [a.y, b.y - a.y, r.top, r.bottom]]) {
    if (!delta) {
      if (start < min || start > max) return;
    } else {
      const t1 = (min - start) / delta, t2 = (max - start) / delta;
      lo = Math.max(lo, Math.min(t1, t2));
      hi = Math.min(hi, Math.max(t1, t2));
    }
  }
  if (lo <= hi) return [lo, hi];
}

export class TacticalReplayRenderer {
  private ctx: Canvas2DContextLike;
  // Exists only during the scene pass, so glyphs can reserve their painted text.
  private labelFrame?: { anchors: NameAnchor[]; obstacles: CssRect[]; pulseOwners: Set<number> };
  private degradedLabels = 0;

  /** Number wrapped, shortened or omitted on the last physically constrained frame. */
  getLabelDegradationCount(): number { return this.degradedLabels; }
  private viewport: Required<ViewportSize>;
  private camera: CameraState = createDefaultCamera();
  private layers: LayerVisibilityState = createDefaultLayers();
  private underlay: UnderlayConfig;
  private payload: Replay2DPayload | null = null;
  private sortedEvents: ReplayTimelineEvent[] = [];
  private ruler: RulerState | null = null;
  private chaseSegments: Array<{ survivor_uid: number; start_t: number; end_t: number }> | null = null;
  private selectedUid: number | null = null;
  private readonly palette: ManorPalette;
  private readonly preset: VisualPresetConfig | undefined;
  private readonly opts: Required<Omit<RendererOptions, 'palette' | 'visualPreset'>>;
  private readonly clarity: boolean;
  private readonly hasExplicitPickRadius: boolean;

  constructor(ctx: Canvas2DContextLike, viewport: ViewportSize, options: RendererOptions = {}) {
    this.ctx = ctx;
    this.viewport = { width: viewport.width, height: viewport.height, dpr: viewport.dpr ?? 1 };
    this.preset = options.visualPreset ? VISUAL_PRESETS[options.visualPreset] : undefined;
    this.clarity = options.visualPreset === 'clarity';
    this.hasExplicitPickRadius = options.pickRadiusPx !== undefined;
    this.palette = { ...(this.preset?.palette ?? MANOR_DOSSIER_PALETTE), ...options.palette };
    this.underlay = {
      enabled: false, image: null, worldRect: null,
      opacity: DEFAULT_UNDERLAY_OPACITY,
      ...this.preset?.underlay,
    };
    const glyphScale = options.glyphScale ?? this.preset?.glyphScale ?? 1;
    const topSafeInset = options.topSafeInset ?? 0;
    this.opts = {
      glyphScale: Number.isFinite(glyphScale) && glyphScale > 0 ? glyphScale : this.preset?.glyphScale ?? 1,
      topSafeInset: Number.isFinite(topSafeInset) ? topSafeInset : 0,
      pickRadiusPx: options.pickRadiusPx ?? 14,
      trailSeconds: options.trailSeconds ?? DEFAULT_TRAIL_SECONDS,
      pulseWindowS: options.pulseWindowS ?? DEFAULT_PULSE_WINDOW_S,
      viewConeRadiusU: options.viewConeRadiusU ?? 60,
      viewConeHalfAngleDeg: options.viewConeHalfAngleDeg ?? 40,
      font: options.font ?? '"Noto Serif SC", serif',
    };
  }

  // ------------------------------------------------------------------ state

  setContext(ctx: Canvas2DContextLike): void {
    this.ctx = ctx;
  }

  resize(viewport: ViewportSize): void {
    this.viewport = { width: viewport.width, height: viewport.height, dpr: viewport.dpr ?? this.viewport.dpr };
  }

  getViewport(): Required<ViewportSize> {
    return { ...this.viewport };
  }

  getPalette(): ManorPalette {
    return { ...this.palette };
  }

  setPayload(payload: Replay2DPayload | null): void {
    this.payload = payload;
    this.sortedEvents = payload ? sortEventsByTime(payload.events ?? []) : [];
    if (payload && !this.underlay.worldRect) {
      this.underlay = { ...this.underlay, worldRect: { ...payload.world.map_underlay.world_rect } };
    }
  }

  getPayload(): Replay2DPayload | null {
    return this.payload;
  }

  setCamera(camera: Partial<CameraState>): CameraState {
    this.camera = normalizeCamera({ ...this.camera, ...camera });
    return this.getCamera();
  }

  getCamera(): CameraState {
    return { ...this.camera };
  }

  /** Fits the payload world bounds while retaining the camera orientation. */
  fitToWorld(paddingRatio = 0.08): CameraState {
    if (!this.payload) return this.getCamera();
    const fitted = fitCameraToBounds(this.payload.world.bounds, this.viewport, paddingRatio);
    const camera = { ...this.camera, centerX: fitted.centerX, centerZ: fitted.centerZ, zoom: fitted.zoom };
    const inset = clamp(this.opts.topSafeInset, 0, Math.max(0, this.viewport.height - 1));
    if (inset > 0) {
      // Fit the projected world bounds, then move their midpoint below the HUD.
      const bounds = this.payload.world.bounds;
      const unitCamera = { ...camera, zoom: 1 };
      const corners: ScreenPoint[] = [];
      for (const x of [bounds.min_x, bounds.max_x]) {
        for (const z of [bounds.min_z, bounds.max_z]) {
          for (const y of [bounds.min_y, bounds.max_y]) {
            corners.push(projectWorldToScreen([x, y, z], unitCamera, { width: 0, height: 0 }));
          }
        }
      }
      const minX = Math.min(...corners.map((p) => p.x));
      const maxX = Math.max(...corners.map((p) => p.x));
      const minY = Math.min(...corners.map((p) => p.y));
      const maxY = Math.max(...corners.map((p) => p.y));
      const area = 1 - 2 * clamp(paddingRatio, 0, 0.45);
      camera.zoom = Math.min(
        Math.max(1, this.viewport.width * area) / Math.max(1e-6, maxX - minX),
        Math.max(1, (this.viewport.height - inset) * area) / Math.max(1e-6, maxY - minY),
      );
      const center = screenToWorldOnPlane(
        this.viewport.width / 2 + (minX + maxX) * camera.zoom / 2,
        this.viewport.height / 2 + (minY + maxY) * camera.zoom / 2 - inset / 2,
        0, camera, this.viewport,
      );
      [camera.centerX, , camera.centerZ] = center;
    }
    this.camera = normalizeCamera(camera);
    return this.getCamera();
  }

  /** Alias for hosts fitting the payload into the current view. */
  fitToView(paddingRatio = 0.08): CameraState {
    return this.fitToWorld(paddingRatio);
  }

  setLayers(layers: Partial<LayerVisibilityState>): LayerVisibilityState {
    this.layers = {
      ...this.layers,
      ...layers,
      visibleFloors: { ...this.layers.visibleFloors, ...(layers.visibleFloors ?? {}) },
    };
    return this.getLayers();
  }

  getLayers(): LayerVisibilityState {
    return { ...this.layers, visibleFloors: { ...this.layers.visibleFloors } };
  }

  setUnderlay(config: Partial<UnderlayConfig>): void {
    this.underlay = { ...this.underlay, ...config };
  }

  getUnderlay(): UnderlayConfig {
    return { ...this.underlay };
  }

  setRuler(ruler: RulerState | null): void {
    this.ruler = ruler ? { a: [...ruler.a] as Vec3, b: [...ruler.b] as Vec3 } : null;
  }

  getRuler(): RulerState | null {
    return this.ruler;
  }

  setChaseSegments(segments: Array<{ survivor_uid: number; start_t: number; end_t: number }> | null): void {
    this.chaseSegments = segments ? [...segments] : null;
  }

  setSelectedUid(uid: number | null): void {
    this.selectedUid = uid;
  }

  project(world: Vec3): ScreenPoint {
    return projectWorldToScreen(world, this.camera, this.viewport);
  }

  screenToWorld(sx: number, sy: number, yPlane = 0): Vec3 {
    return screenToWorldOnPlane(sx, sy, yPlane, this.camera, this.viewport);
  }

  isOblique(): boolean {
    return this.camera.pitchDeg < OBLIQUE_PITCH_THRESHOLD_DEG;
  }

  /** 0 when the floor is filtered out, dimmed alpha when another floor is focused, else 1. */
  floorAlpha(floor: FloorId): number {
    if (!this.layers.visibleFloors[floor]) return 0;
    if (this.layers.focusFloor && this.layers.focusFloor !== floor) return FOCUS_DIM_ALPHA;
    return 1;
  }

  // ---------------------------------------------------------------- render

  /** Redraw a complete frame. Obstacles use canvas-local CSS pixels at the current viewport. */
  render(tSeconds: number, reservedRects: readonly CssRect[] = []): void {
    const ctx = this.ctx;
    const { width, height, dpr } = this.viewport;
    ctx.save();
    try {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.fillStyle = this.palette.bg;
      ctx.fillRect(0, 0, width, height);

      this.degradedLabels = 0;
      const frame = this.layers.labels ? { anchors: [] as NameAnchor[], obstacles: [...reservedRects], pulseOwners: new Set<number>() } : undefined;
      this.labelFrame = frame;
      const foreground: Array<() => void> = [];
      this.drawUnderlay();
      if (this.layers.grid) this.drawGrid();
      const payload = this.payload;
      if (payload) {
        if (this.isOblique() && this.layers.floorPlanes) this.drawFloorPlanes(payload);
        const players = this.samplePlayers(payload, tSeconds);
        if (this.isOblique() && this.layers.dropLines) this.drawDropLines(payload, players);
        if (this.layers.trails) this.drawTrails(payload, players, tSeconds);
        if (this.layers.viewCones) this.drawViewCones(players);
        if (this.layers.pulses) this.preparePulses(players, tSeconds, foreground);
        this.drawSortedScene(payload, players, tSeconds);
      }
      if (this.ruler) this.prepareRuler(this.ruler, foreground);
      this.labelFrame = undefined;
      if (frame?.anchors.length) this.drawNames(frame.anchors, frame.obstacles);
      for (const draw of foreground) draw();
    } finally {
      this.labelFrame = undefined;
      ctx.restore();
    }
  }

  private drawUnderlay(): void {
    const u = this.underlay;
    if (!u.enabled || !u.image) return;
    const rect = u.worldRect ?? this.payload?.world.map_underlay.world_rect ?? null;
    if (!rect) return;
    const w = u.imageWidth ?? u.image.width ?? 0;
    const h = u.imageHeight ?? u.image.height ?? 0;
    if (!(w > 0 && h > 0)) return;
    const m = computeUnderlayAffine(rect, w, h, this.camera, this.viewport, {
      rotationQuadrants: u.rotationQuadrants ?? 0,
      flipX: !!u.flipX,
      flipZ: !!u.flipZ,
    });
    const ctx = this.ctx;
    ctx.save();
    try {
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      if (u.backing) {
        ctx.fillStyle = u.backing;
        ctx.fillRect(0, 0, w, h);
      }
      const opacity = clamp(u.opacity ?? DEFAULT_UNDERLAY_OPACITY, 0, 1);
      ctx.globalAlpha = opacity;
      const tone = u.tone;
      if (tone && typeof ctx.filter === 'string') {
        const { brightness = 1, contrast = 1, saturation = 1 } = tone;
        ctx.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`;
        try {
          ctx.drawImage(u.image, 0, 0, w, h);
        } finally {
          ctx.filter = 'none';
        }
      } else {
        ctx.drawImage(u.image, 0, 0, w, h);
        if (tone && typeof ctx.globalCompositeOperation === 'string') {
          const { brightness = 1, contrast = 1 } = tone;
          try {
            const screenAlpha = clamp((brightness - 1) * 0.5, 0, 0.35);
            if (screenAlpha > 0) {
              ctx.globalCompositeOperation = 'screen';
              if (ctx.globalCompositeOperation === 'screen') {
                ctx.fillStyle = `rgba(255,240,215,${screenAlpha})`;
                ctx.fillRect(0, 0, w, h);
              }
            }
            const contrastAlpha = clamp((contrast - 1) * 0.5, 0, 0.25);
            if (contrastAlpha > 0) {
              ctx.globalCompositeOperation = 'soft-light';
              if (ctx.globalCompositeOperation === 'soft-light') {
                ctx.fillStyle = `rgba(216,179,106,${contrastAlpha})`;
                ctx.fillRect(0, 0, w, h);
              }
            }
          } finally {
            ctx.globalCompositeOperation = 'source-over';
          }
        }
      }
    } finally {
      ctx.restore();
    }
  }

  private worldRect(): WorldRect | null {
    const p = this.payload;
    if (p) return { min_x: p.world.bounds.min_x, max_x: p.world.bounds.max_x, min_z: p.world.bounds.min_z, max_z: p.world.bounds.max_z };
    return this.underlay.worldRect;
  }

  private drawGrid(): void {
    const rect = this.worldRect();
    if (!rect) return;
    const span = Math.max(rect.max_x - rect.min_x, rect.max_z - rect.min_z, 1);
    const targetPx = 60;
    const rawStep = targetPx / this.camera.zoom;
    const steps = [10, 25, 50, 100, 200, 250, 500, 1000, 2000];
    let step = steps.find((s) => s >= rawStep) ?? steps[steps.length - 1] as number;
    while (span / step > 120) step *= 2;
    const ctx = this.ctx;
    ctx.save();
    const grid = this.preset?.grid;
    ctx.lineWidth = 1;
    ctx.globalAlpha = grid ? 1 : 0.35;
    const drawLines = (major: boolean): void => {
      ctx.strokeStyle = grid ? (major ? grid.major : grid.minor) : this.palette.line;
      ctx.beginPath();
      for (let i = Math.ceil(rect.min_x / step); i * step <= rect.max_x + 1e-9; i++) {
        if (grid && (i % grid.majorEvery === 0) !== major) continue;
        const a = this.project([i * step, 0, rect.min_z]);
        const b = this.project([i * step, 0, rect.max_z]);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      for (let i = Math.ceil(rect.min_z / step); i * step <= rect.max_z + 1e-9; i++) {
        if (grid && (i % grid.majorEvery === 0) !== major) continue;
        const a = this.project([rect.min_x, 0, i * step]);
        const b = this.project([rect.max_x, 0, i * step]);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    };
    drawLines(false);
    if (grid) drawLines(true);
    ctx.restore();
  }

  private floorPlaneY(payload: Replay2DPayload, floor: FloorId): number {
    const f = payload.world.floors?.[floor];
    return f && Number.isFinite(f.y_plane) ? f.y_plane : DEFAULT_FLOOR_PLANES[floor];
  }

  private drawFloorPlanes(payload: Replay2DPayload): void {
    const rect = this.worldRect();
    if (!rect) return;
    const planes: Array<{ floor: FloorId; y: number; depth: number }> = [];
    for (const floor of FLOOR_IDS) {
      const alpha = this.floorAlpha(floor);
      if (alpha <= 0) continue;
      const info = payload.world.floors?.[floor];
      if (floor !== '1F' && info && !info.has_entities) continue;
      const y = this.floorPlaneY(payload, floor);
      const c = this.project([(rect.min_x + rect.max_x) / 2, y, (rect.min_z + rect.max_z) / 2]);
      planes.push({ floor, y, depth: c.depth });
    }
    planes.sort((a, b) => a.depth - b.depth);
    const ctx = this.ctx;
    for (const pl of planes) {
      const corners: Vec3[] = [
        [rect.min_x, pl.y, rect.min_z],
        [rect.max_x, pl.y, rect.min_z],
        [rect.max_x, pl.y, rect.max_z],
        [rect.min_x, pl.y, rect.max_z],
      ];
      const pts = corners.map((c) => this.project(c));
      const alpha = this.floorAlpha(pl.floor);
      const color = pl.floor === 'B1' ? this.palette.red : pl.floor === '2F' ? this.palette.blue : this.palette.gold;
      ctx.save();
      ctx.globalAlpha = 0.08 * alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.45 * alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 0.8 * alpha;
      ctx.fillStyle = color;
      ctx.font = `11px ${this.opts.font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      const p0 = pts[0] as ScreenPoint;
      const label = `${pl.floor} · y=${pl.y.toFixed(0)}`;
      this.reserveText(label, p0.x + 4, p0.y - 4, 0);
      ctx.fillText(label, p0.x + 4, p0.y - 4);
      ctx.restore();
    }
  }

  private samplePlayers(payload: Replay2DPayload, t: number): Array<{ player: ReplayPlayer; sample: PlayerSample; floor: FloorId }> {
    const out: Array<{ player: ReplayPlayer; sample: PlayerSample; floor: FloorId }> = [];
    for (const player of payload.players ?? []) {
      const sample = samplePlayerAtTime(payload.trajectories?.[String(player.uid)], t);
      if (!sample) continue;
      out.push({ player, sample, floor: classifyFloor(sample.pos[1]) });
    }
    return out;
  }

  private staticEntityFloor(e: StaticSceneEntity): FloorId {
    return e.floor ?? classifyFloor(e.pos[1]);
  }

  /** All visible static entities (layer toggles + floor filter applied). */
  private visibleStatics(payload: Replay2DPayload): Array<{ kind: StaticPickKind; entity: StaticSceneEntity; floor: FloorId }> {
    const out: Array<{ kind: StaticPickKind; entity: StaticSceneEntity; floor: FloorId }> = [];
    const L = this.layers;
    const push = (kind: StaticPickKind, list: readonly StaticSceneEntity[] | null | undefined, on: boolean): void => {
      if (!on || !list) return;
      for (const entity of list) {
        const floor = this.staticEntityFloor(entity);
        if (this.floorAlpha(floor) <= 0) continue;
        out.push({ kind, entity, floor });
      }
    };
    const ents = payload.entities;
    push('cipher', ents.ciphers, L.ciphers);
    push('pallet', ents.pallets, L.pallets);
    push('window', ents.windows, L.windows);
    push('chair', ents.chairs, L.chairs);
    push('gate', ents.exit_gates, L.gates);
    push('chest', ents.chests, L.chests);
    push('hatch', ents.hatch ? [ents.hatch] : [], L.hatch);
    return out;
  }

  private drawDropLines(payload: Replay2DPayload, players: Array<{ sample: PlayerSample; floor: FloorId }>): void {
    const points: Array<{ pos: Vec3; floor: FloorId }> = [];
    for (const s of this.visibleStatics(payload)) points.push({ pos: s.entity.pos, floor: s.floor });
    for (const p of players) if (this.floorAlpha(p.floor) > 0) points.push({ pos: p.sample.pos, floor: p.floor });
    const ctx = this.ctx;
    for (const { pos, floor } of points) {
      if (Math.abs(pos[1]) <= DROP_LINE_MIN_ABS_Y) continue;
      const top = this.project(pos);
      const ground = this.project([pos[0], 0, pos[2]]);
      const alpha = this.floorAlpha(floor);
      ctx.save();
      ctx.globalAlpha = 0.55 * alpha;
      ctx.strokeStyle = this.palette.muted;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(ground.x, ground.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = this.palette.dim;
      ctx.beginPath();
      ctx.arc(ground.x, ground.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private campColor(camp: 1 | 2): string {
    return camp === 1 ? this.palette.redL : this.palette.blue;
  }

  private drawTrails(payload: Replay2DPayload, players: Array<{ player: ReplayPlayer; floor: FloorId }>, t: number): void {
    const ctx = this.ctx;
    for (const { player, floor } of players) {
      const trail = extractPlayerTrail(payload.trajectories?.[String(player.uid)], t, this.opts.trailSeconds);
      if (trail.length < 2) continue;
      const color = this.campColor(player.camp);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1]!;
        const b = trail[i]!;
        if (b.breakBefore) continue;
        const segFloor = classifyFloor(b.pos[1]);
        const alpha = Math.min(this.floorAlpha(segFloor), this.floorAlpha(floor) > 0 ? 1 : 0);
        if (alpha <= 0) continue;
        const pa = this.project(a.pos);
        const pb = this.project(b.pos);
        ctx.globalAlpha = 0.85 * (1 - b.age) * alpha + 0.05;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** World-space et=304 view cone points on the player's horizontal plane Y = player.y. */
  computeViewConePolygon(pos: Vec3, camYawDeg: number, segments = 12): ScreenPoint[] {
    const r = this.opts.viewConeRadiusU;
    const half = (this.opts.viewConeHalfAngleDeg * Math.PI) / 180;
    const yaw = (camYawDeg * Math.PI) / 180;
    const pts: ScreenPoint[] = [this.project(pos)];
    for (let i = 0; i <= segments; i++) {
      const a = yaw - half + (2 * half * i) / segments;
      pts.push(this.project([pos[0] + Math.sin(a) * r, pos[1], pos[2] + Math.cos(a) * r]));
    }
    return pts;
  }

  private drawViewCones(players: Array<{ player: ReplayPlayer; sample: PlayerSample; floor: FloorId }>): void {
    const ctx = this.ctx;
    for (const { player, sample, floor } of players) {
      if (sample.camYawDeg === null || sample.fearState >= 4) continue;
      const alpha = this.floorAlpha(floor);
      if (alpha <= 0) continue;
      const pts = this.computeViewConePolygon(sample.pos, sample.camYawDeg);
      ctx.save();
      ctx.globalAlpha = 0.14 * alpha;
      ctx.fillStyle = player.camp === 1 ? this.palette.red : this.palette.blue;
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  private drawSortedScene(
    payload: Replay2DPayload,
    players: Array<{ player: ReplayPlayer; sample: PlayerSample; floor: FloorId }>,
    t: number,
  ): void {
    const drawables: Drawable[] = [];
    let order = 0;
    for (const s of this.visibleStatics(payload)) {
      const sp = this.project(s.entity.pos);
      const alpha = this.floorAlpha(s.floor);
      const e = s.entity;
      let draw: () => void;
      switch (s.kind) {
        case 'cipher':
          draw = () => this.drawCipher(e as Replay2DPayload['entities']['ciphers'][number], sp, alpha, t);
          break;
        case 'pallet':
          draw = () => this.drawPallet(e as Replay2DPayload['entities']['pallets'][number], alpha, t);
          break;
        case 'window':
          draw = () => this.drawWindowFrame(e, alpha, t);
          break;
        case 'chair':
          draw = () => this.drawChair(e as Replay2DPayload['entities']['chairs'][number], sp, alpha, t);
          break;
        case 'gate':
          draw = () => this.drawGate(e as Replay2DPayload['entities']['exit_gates'][number], sp, alpha, t);
          break;
        case 'chest':
          draw = () => this.drawChest(sp, alpha);
          break;
        default:
          draw = () => this.drawHatch(sp, alpha);
      }
      drawables.push({ depth: sp.depth, order: order++, draw });
    }
    // Replay data has chair coordinates, so use each basement's chair centroid as an estimate.
    if (this.layers.chairs && this.floorAlpha('1F') > 0) {
      const basements = new Map<number | null, { x: number; z: number; count: number }>();
      for (const chair of payload.entities.chairs ?? []) {
        if (!chair.is_basement) continue;
        const group = basements.get(chair.basement_idx) ?? { x: 0, z: 0, count: 0 };
        group.x += chair.pos[0];
        group.z += chair.pos[2];
        group.count++;
        basements.set(chair.basement_idx, group);
      }
      for (const group of basements.values()) {
        const sp = this.project([group.x / group.count, this.floorPlaneY(payload, '1F'), group.z / group.count]);
        drawables.push({ depth: sp.depth, order: order++, draw: () => this.drawBasement(sp, this.floorAlpha('1F')) });
      }
    }
    for (const p of players) {
      const alpha = this.floorAlpha(p.floor);
      if (alpha <= 0) continue;
      const sp = this.project(p.sample.pos);
      // Players draw above static props sharing the same depth.
      drawables.push({ depth: sp.depth + 1e-6, order: 1e9 + order++, draw: () => this.drawPlayer(p.player, p.sample, sp, alpha, t) });
    }
    drawables.sort((a, b) => a.depth - b.depth || a.order - b.order);
    for (const d of drawables) d.draw();
  }

  /** Painter's draw order used by render() (exposed for tests/inspection). */
  computeDrawOrder(t: number): Array<{ kind: PickEntityKind; uid: number; depth: number }> {
    const payload = this.payload;
    if (!payload) return [];
    const items: Array<{ kind: PickEntityKind; uid: number; depth: number; order: number }> = [];
    let order = 0;
    for (const s of this.visibleStatics(payload)) items.push({ kind: s.kind, uid: s.entity.uid, depth: this.project(s.entity.pos).depth, order: order++ });
    for (const p of this.samplePlayers(payload, t)) {
      if (this.floorAlpha(p.floor) <= 0) continue;
      items.push({ kind: 'player', uid: p.player.uid, depth: this.project(p.sample.pos).depth + 1e-6, order: 1e9 + order++ });
    }
    items.sort((a, b) => a.depth - b.depth || a.order - b.order);
    return items.map(({ kind, uid, depth }) => ({ kind, uid, depth }));
  }

  private screenDir(pos: Vec3, dx: number, dz: number): [number, number] {
    const a = this.project(pos);
    const b = this.project([pos[0] + dx, pos[1], pos[2] + dz]);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(len > 1e-9)) return [0, -1];
    return [(b.x - a.x) / len, (b.y - a.y) / len];
  }

  /** Scale a legacy screen-space dimension, with a clarity minimum where specified. */
  private glyph(size: number, clarityMinimum = 0): number {
    return Math.max(size * this.opts.glyphScale, this.clarity ? clarityMinimum : 0);
  }

  private cipherRadiusPx(): number {
    const zoomScale = this.clarity ? clamp(this.camera.zoom, 0.85, 1.6) : 1;
    return this.glyph(9 * zoomScale, 10);
  }

  private playerRadiusPx(isHunter: boolean): number {
    return this.glyph(isHunter ? 9 : 8, 10);
  }

  private chairRadiusPx(): number {
    return this.glyph(7, 10);
  }

  private gateSizePx(): { w: number; h: number } {
    return { w: this.glyph(16, 26), h: this.glyph(9, 16) };
  }

  private chestSizePx(): { w: number; h: number } {
    return { w: this.glyph(8, 20), h: this.glyph(6, 16) };
  }

  private hatchRadiusPx(): number {
    return this.glyph(7, 11);
  }

  /** Draw the current path with a continuous dark outline, then its foreground stroke. */
  private strokeGlyph(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha *= HALO_ALPHA;
    ctx.strokeStyle = HALO_COLOR;
    ctx.lineWidth += 3;
    if (typeof ctx.shadowBlur === 'number') ctx.shadowBlur = 0;
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.restore();
    ctx.stroke();
  }

  private reserveText(text: string, x: number, y: number, padding: number): void {
    if (!this.labelFrame) return;
    const size = Number(/([\d.]+)px/.exec(this.ctx.font)?.[1] ?? 12);
    const ink = expand(textBounds(this.ctx, text, size), padding);
    this.labelFrame.obstacles.push(box(x + ink.left, y + ink.top, ink.right - ink.left, ink.bottom - ink.top));
  }

  private drawOutlinedText(text: string, x: number, y: number): void {
    this.reserveText(text, x, y, this.ctx.strokeText ? 1.5 : 1);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha *= HALO_ALPHA;
    ctx.lineJoin = 'round';
    if (typeof ctx.strokeText === 'function') {
      ctx.strokeStyle = HALO_COLOR;
      ctx.lineWidth = 3;
      ctx.strokeText(text, x, y);
    } else {
      ctx.fillStyle = HALO_COLOR;
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          if (dx !== 0 || dy !== 0) ctx.fillText(text, x + dx, y + dy);
        }
      }
    }
    ctx.restore();
    ctx.fillText(text, x, y);
  }

  private drawBasement(sp: ScreenPoint, alpha: number): void {
    const ctx = this.ctx;
    const size = this.glyph(16, 20);
    const y = sp.y - size - 23;
    const x = sp.x - size / 2;
    const tread = size / 3;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = this.palette.gold;
    ctx.fillStyle = this.palette.bg3;
    ctx.beginPath();
    ctx.rect(x - 3, y - 3, size + 6, size + 6);
    ctx.fill();
    this.strokeGlyph();
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let i = 1; i <= 3; i++) {
      ctx.lineTo(x + i * tread, y + (i - 1) * tread);
      ctx.lineTo(x + i * tread, y + i * tread);
    }
    this.strokeGlyph();
    ctx.font = `bold ${this.glyph(9, 12)}px ${this.opts.font}`;
    ctx.fillStyle = this.palette.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    this.drawOutlinedText('地下室', sp.x, y - 5);
    ctx.restore();
  }

  private drawCipher(c: Replay2DPayload['entities']['ciphers'][number], sp: ScreenPoint, alpha: number, t: number): void {
    const ctx = this.ctx;
    const st = sampleCipherAtTime(c, t);
    const r = this.cipherRadiusPx();
    this.labelFrame?.obstacles.push(expand(box(sp.x - r, sp.y - r, 2 * r, 2 * r), 3.25));
    ctx.save();
    ctx.globalAlpha = alpha;
    if (st.activeFixerCount > 0 && !st.isCompleted) {
      ctx.globalAlpha = (this.clarity ? 0.28 + Math.sin(t * 5) * 0.1 : 0.35) * alpha;
      ctx.fillStyle = this.palette.gold;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r + 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha;
    }
    ctx.fillStyle = st.isCompleted ? this.palette.gold : this.clarity ? this.palette.text : this.palette.bg3;
    ctx.strokeStyle = this.clarity ? this.palette.gold : this.palette.goldD;
    ctx.lineWidth = this.clarity ? 2 : 1.5;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    ctx.fill();
    this.strokeGlyph();
    if (!st.isCompleted && st.progressPct > 0) {
      ctx.strokeStyle = this.palette.gold;
      ctx.lineWidth = this.clarity ? 3.5 : 3;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r + 2.5, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * st.progressPct) / 100);
      this.strokeGlyph();
    }
    ctx.font = `bold ${this.glyph(9, 12)}px ${this.opts.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = st.isCompleted || this.clarity ? this.palette.bg : this.palette.gold;
    this.drawOutlinedText(st.isCompleted ? '✓' : `${Math.round(st.progressPct)}`, sp.x, sp.y);
    ctx.restore();
  }

  private palletSegment(p: StaticSceneEntity, m: ScreenPoint): ScreenSegment {
    const dir = normalizeXZ(p.dir[0], p.dir[2]);
    const [dx, dy] = this.screenDir(p.pos, dir[0], dir[1]);
    const edge = this.project([p.pos[0] + dir[0] * 6, p.pos[1], p.pos[2] + dir[1] * 6]);
    const half = this.glyph(Math.hypot(edge.x - m.x, edge.y - m.y), 10);
    const a = { x: m.x - dx * half, y: m.y - dy * half };
    const b = { x: m.x + dx * half, y: m.y + dy * half };
    return [a, b];
  }

  private drawPallet(p: Replay2DPayload['entities']['pallets'][number], alpha: number, t: number): void {
    const ctx = this.ctx;
    const state = samplePalletAtTime(p, t);
    const m = this.project(p.pos);
    ctx.save();
    ctx.lineCap = 'round';
    if (state === 'upright') {
      const [a, b] = this.palletSegment(p, m);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = this.clarity ? this.palette.goldD : this.palette.gold;
      ctx.lineWidth = this.clarity ? 3.5 : 3;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      this.strokeGlyph();
    } else if (state === 'dropped') {
      const [a, b] = this.palletSegment(p, m);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = this.palette.redL;
      ctx.lineWidth = this.clarity ? 5 : 4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if (!this.clarity) {
        ctx.strokeStyle = this.palette.goldD;
        ctx.lineWidth = 7;
        ctx.stroke();
        ctx.strokeStyle = this.palette.redL;
        ctx.lineWidth = 4;
      }
      this.strokeGlyph();
    } else {
      ctx.globalAlpha = (this.clarity ? 1 : 0.35) * alpha;
      ctx.strokeStyle = this.palette.dim;
      ctx.lineWidth = 2;
      const s = this.glyph(5, 10);
      ctx.beginPath();
      ctx.moveTo(m.x - s, m.y - s);
      ctx.lineTo(m.x + s, m.y + s);
      ctx.moveTo(m.x + s, m.y - s);
      ctx.lineTo(m.x - s, m.y + s);
      this.strokeGlyph();
    }
    ctx.restore();
  }

  private windowFrameCorner(w: StaticSceneEntity) {
    const d = normalizeXZ(w.dir[0], w.dir[2]);
    const n: [number, number] = [-d[1], d[0]];
    const center = this.project(w.pos);
    const edge = this.project([w.pos[0] + d[0] * 5, w.pos[1], w.pos[2] + d[1] * 5]);
    const half = Math.hypot(edge.x - center.x, edge.y - center.y);
    const along = 5 * this.glyph(half, 10) / Math.max(1e-6, half);
    const across = this.glyph(1.5);
    return (sa: number, sb: number): ScreenPoint =>
      this.project([w.pos[0] + d[0] * along * sa + n[0] * across * sb, w.pos[1], w.pos[2] + d[1] * along * sa + n[1] * across * sb]);
  }

  private drawWindowFrame(w: StaticSceneEntity, alpha: number, t: number): void {
    const ctx = this.ctx;
    const corner = this.windowFrameCorner(w);
    const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = this.clarity ? this.palette.ice : this.palette.muted;
    ctx.lineWidth = this.clarity ? 2 : 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    this.strokeGlyph();
    if (isWindowSealedAtTime(this.sortedEvents, w.uid, t)) {
      const c = this.project(w.pos);
      ctx.fillStyle = this.palette.red;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = this.palette.redL;
      ctx.lineWidth = 1;
      this.strokeGlyph();
    }
    ctx.restore();
  }

  private drawChair(c: Replay2DPayload['entities']['chairs'][number], sp: ScreenPoint, alpha: number, t: number): void {
    const ctx = this.ctx;
    const st = sampleChairAtTime(c, t);
    const s = this.chairRadiusPx();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = st.isOccupied ? this.palette.red : this.palette.bg3;
    ctx.strokeStyle = c.is_basement ? this.palette.redL : this.palette.goldD;
    ctx.lineWidth = c.is_basement ? 2 : 1.5;
    if (c.is_basement) ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y - s);
    ctx.lineTo(sp.x + s, sp.y + s * 0.7);
    ctx.lineTo(sp.x - s, sp.y + s * 0.7);
    ctx.closePath();
    ctx.fill();
    this.strokeGlyph();
    ctx.setLineDash([]);
    if (c.is_basement) {
      ctx.font = `${this.glyph(9, 12)}px ${this.opts.font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = this.palette.redL;
      this.drawOutlinedText('B1', sp.x + s + 2, sp.y);
    }
    if (st.isOccupied) {
      const bw = this.glyph(28, 32);
      const bh = this.glyph(4, 5);
      const bx = sp.x - bw / 2;
      const by = sp.y - s - 9;
      ctx.fillStyle = this.palette.bg3;
      this.labelFrame?.obstacles.push(expand(box(bx, by, bw, bh), 3.5));
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = this.palette.redL;
      ctx.fillRect(bx, by, (bw * st.eliminationPct) / 100, bh);
      // 50% half-threshold tick
      ctx.strokeStyle = this.palette.text;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx + bw / 2, by - 1.5);
      ctx.lineTo(bx + bw / 2, by + bh + 1.5);
      this.strokeGlyph();
    }
    ctx.restore();
  }

  private drawGate(g: Replay2DPayload['entities']['exit_gates'][number], sp: ScreenPoint, alpha: number, t: number): void {
    const ctx = this.ctx;
    const st = sampleGateAtTime(g, t);
    const { w, h } = this.gateSizePx();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.5;
    if (st === 'unpowered') {
      ctx.fillStyle = this.palette.bg3;
      ctx.strokeStyle = this.palette.dim;
    } else if (st === 'powered') {
      ctx.fillStyle = this.palette.bg3;
      ctx.strokeStyle = this.palette.gold;
    } else {
      ctx.fillStyle = this.palette.gold;
      ctx.strokeStyle = this.palette.gold;
    }
    this.labelFrame?.obstacles.push(expand(box(sp.x - w / 2, sp.y - h / 2, w, h), 2.25));
    ctx.beginPath();
    ctx.rect(sp.x - w / 2, sp.y - h / 2, w, h);
    ctx.fill();
    ctx.save();
    if (this.clarity && st === 'powered' && typeof ctx.shadowColor === 'string' && typeof ctx.shadowBlur === 'number') {
      ctx.shadowColor = this.palette.gold;
      ctx.shadowBlur = 8;
    }
    this.strokeGlyph();
    ctx.restore();
    ctx.font = `bold ${this.glyph(8, 12)}px ${this.opts.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = st === 'opened' ? this.palette.bg : st === 'powered' ? this.palette.gold : this.palette.dim;
    this.drawOutlinedText(st === 'opened' ? '开' : '门', sp.x, sp.y);
    ctx.restore();
  }

  private drawChest(sp: ScreenPoint, alpha: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.8 * alpha;
    ctx.fillStyle = this.palette.bg3;
    ctx.strokeStyle = this.palette.goldD;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const { w, h } = this.chestSizePx();
    ctx.rect(sp.x - w / 2, sp.y - h / 2, w, h);
    ctx.fill();
    this.strokeGlyph();
    ctx.restore();
  }

  private drawHatch(sp: ScreenPoint, alpha: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = this.palette.ice;
    ctx.lineWidth = 1.5;
    if (!this.clarity) ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, this.hatchRadiusPx(), 0, Math.PI * 2);
    if (this.clarity) {
      ctx.fillStyle = '#10202e';
      ctx.fill();
    }
    this.strokeGlyph();
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawPlayer(player: ReplayPlayer, sample: PlayerSample, sp: ScreenPoint, alpha: number, t: number): void {
    const ctx = this.ctx;
    const P = this.palette;
    const isHunter = player.camp === 1;
    const fs = sample.fearState;
    const gone = fs === 4 || fs === 5;
    const a = gone ? 0.45 * alpha : alpha;
    const r = this.playerRadiusPx(isHunter);
    ctx.save();
    ctx.globalAlpha = a;

    const chasing = !isHunter && !gone && isChaseActiveAtTime(this.sortedEvents, player.uid, t, this.chaseSegments);
    const selected = this.selectedUid === player.uid;
    const extent = r + Math.max(selected ? 11 : 0, chasing ? 8.25 : 0, isHunter ? 5.5 : 2.5);
    let token = box(sp.x - extent, sp.y - extent, 2 * extent, 2 * extent);
    // strokeGlyph paints a solid halo 3px wider, including beneath chase dashes.
    let visible = this.labelFrame && (viewportDistanceSq(sp, this.viewport) <= r ** 2 ||
      ringVisible(sp, r, 2.5, this.viewport) || (isHunter && ringVisible(sp, r + 3, 2.5, this.viewport)) ||
      (chasing && ringVisible(sp, r + 6, 2.25, this.viewport)) || (selected && ringVisible(sp, r + 9, 2, this.viewport)) ||
      this.labelFrame.pulseOwners.has(player.uid));
    // Chase highlight ring (survivors under pursuit)
    if (chasing) {
      ctx.strokeStyle = P.redL;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r + 6, 0, Math.PI * 2);
      this.strokeGlyph();
      ctx.setLineDash([]);
    }

    // Body fill tinted by fear_state
    let fill = P.bg3;
    if (!isHunter) {
      if (fs === 1) fill = P.redL;
      else if (fs === 2) fill = P.red;
      else if (fs === 3) fill = P.goldD;
      else if (fs === 4) fill = P.dim;
      else if (fs === 5) fill = P.gold;
    }
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    ctx.fill();

    // Token rings: crimson double-ring hunter, slate-blue ring survivor
    if (isHunter) {
      ctx.strokeStyle = P.red;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r + 3, 0, Math.PI * 2);
      this.strokeGlyph();
      ctx.strokeStyle = P.redL;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      this.strokeGlyph();
    } else {
      ctx.strokeStyle = P.blue;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      this.strokeGlyph();
    }

    if (this.selectedUid === player.uid) {
      ctx.strokeStyle = P.gold;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r + 9, 0, Math.PI * 2);
      this.strokeGlyph();
    }

    // Body facing dir chevron
    if (this.layers.dirArrows && !gone) {
      const [ux, uy] = this.screenDir(sample.pos, sample.dir[0], sample.dir[1]);
      const tipD = r + 9;
      const tip = { x: sp.x + ux * tipD, y: sp.y + uy * tipD };
      const back = { x: sp.x + ux * (r + 2), y: sp.y + uy * (r + 2) };
      const px = -uy;
      const py = ux;
      const left = { x: back.x + px * 4, y: back.y + py * 4 };
      const right = { x: back.x - px * 4, y: back.y - py * 4 };
      if (this.labelFrame && !visible) visible = headingVisible([tip, left, right], 2, this.viewport);
      token = {
        left: Math.min(token.left, tip.x - 2, back.x - Math.abs(px * 4) - 2),
        right: Math.max(token.right, tip.x + 2, back.x + Math.abs(px * 4) + 2),
        top: Math.min(token.top, tip.y - 2, back.y - Math.abs(py * 4) - 2),
        bottom: Math.max(token.bottom, tip.y + 2, back.y + Math.abs(py * 4) + 2),
      };
      ctx.fillStyle = isHunter ? P.redL : P.blue;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1;
      this.strokeGlyph();
    }

    // fear_state badge
    if (!isHunter && fs > 0) {
      const badge = fs === 1 ? '伤' : fs === 2 ? '倒' : fs === 3 ? '椅' : fs === 4 ? '淘' : '逃';
      ctx.font = `bold ${this.glyph(8, 12)}px ${this.opts.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = P.text;
      this.drawOutlinedText(badge, sp.x, sp.y);
    }

    if (this.labelFrame && visible) {
      this.labelFrame.obstacles.push(token);
      if (player.player_name?.trim()) {
        this.labelFrame.anchors.push({ ...sp, token, uid: player.uid, name: player.player_name, hunter: isHunter, selected });
      }
    }
    ctx.restore();
  }

  private layoutNames(anchors: NameAnchor[], obstacles: CssRect[], size: number): PlacedPlate[] {
    const ctx = this.ctx;
    const board = expand(box(0, 0, this.viewport.width, this.viewport.height), -2);
    const fixed = obstacles.map(r => expand(r, 2)).filter(r => intersects(r, board))
      .sort((a, b) => a.top - b.top || a.left - b.left || a.bottom - b.bottom || a.right - b.right);
    const blocked = [...fixed];
    anchors.sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.hunter) - Number(a.hunter) || a.uid - b.uid);
    const plates = anchors.map(a => measurePlate(ctx, a, [a.name], size));
    const placed: PlacedPlate[] = [];
    for (const plate of plates) {
      const local = localSlots(plate, board, blocked).next().value;
      if (!local) break;
      placed.push(local);
      blocked.push(expand(local.box, 2));
    }
    if (placed.length === plates.length) return placed;

    // Keep the longest feasible priority prefix. A separation proof can
    // prune an impossible suffix without enumerating equivalent slot orders.
    for (let keep = placed.length; keep >= 0; keep--) {
      const prefix = placed.slice(0, keep);
      const obstacles = [...fixed, ...prefix.map(p => expand(p.box, 2))];
      const cluster = plates.slice(keep);
      const witness = feasibleLayout(cluster, board, obstacles);
      if (!witness) continue;
      let retry = retryLayout(cluster, board, obstacles);
      if (!retry) {
        for (const order of placementOrders([...cluster].sort((a, b) => a.anchor.uid - b.anchor.uid))) {
          if (order.every((p, i) => p === cluster[i])) continue;
          retry = retryLayout(order, board, obstacles);
          if (retry) break;
        }
      }
      return prefix.concat(retry ?? witness);
    }
    for (let keep = placed.length; keep >= 0; keep--) {
      const prefix = placed.slice(0, keep);
      const cluster = plates.slice(keep).map(p => p.anchor).sort((a, b) => a.uid - b.uid);
      const numbered = cluster.map((a, i) => measurePlate(ctx, a, [`${i + 1}. ${a.name}`], size));
      const roster = packRoster(numbered, board, [...fixed, ...prefix.map(p => expand(p.box, 2))]);
      if (roster) return prefix.concat(roster);
    }

    // Maximize retained full texts, then single-line names, then identifiable
    // labels. Visit priority order and balanced splits first to break ties.
    const options = plates.map(p => {
      const chars = Array.from(p.anchor.name);
      const splits = chars.slice(1).map((_, i) => i + 1)
        .sort((a, b) => Math.abs(chars.length / 2 - a) - Math.abs(chars.length / 2 - b) || b - a);
      const wraps: NamePlate[] = [];
      for (const at of splits) {
        const wrapped = measurePlate(ctx, p.anchor, [chars.slice(0, at).join(''), chars.slice(at).join('')], size);
        if (!wraps.some(w => w.width <= wrapped.width && w.height <= wrapped.height)) wraps.push(wrapped);
      }
      return { single: p, wraps, id: measurePlate(ctx, p.anchor, [`#${p.anchor.uid}`], size) };
    });
    const base = plates.length + 1;
    let best = -1;
    let result: PlacedPlate[] = [];
    function choose(i: number, chosen: NamePlate[], score: number): void {
      if (score + (plates.length - i) * (base * base + base + 1) <= best) return;
      const fit = feasibleLayout(chosen, board, fixed);
      if (!fit) return;
      if (i === plates.length) {
        best = score;
        result = fit.map(p => ({ ...p, degraded: !plates.some(full => full.anchor === p.anchor && full.lines === p.lines) }));
        return;
      }
      const { single, wraps, id } = options[i];
      choose(i + 1, [...chosen, single], score + base * base + base + 1);
      for (const wrap of wraps) choose(i + 1, [...chosen, wrap], score + base * base + 1);
      choose(i + 1, [...chosen, id], score + 1);
      choose(i + 1, chosen, score);
    }
    choose(0, [], 0);
    return result;
  }

  private drawNames(anchors: NameAnchor[], obstacles: CssRect[]): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const size = Math.max(12, this.glyph(10));
    ctx.font = `${size}px ${this.opts.font}`;
    const placed = this.layoutNames(anchors, obstacles, size);
    this.degradedLabels = anchors.length - placed.filter(p => !p.degraded).length;

    const color = (p: NamePlate) => p.anchor.hunter ? MANOR_CLARITY_PALETTE.redL : MANOR_CLARITY_PALETTE.blue;
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    for (const p of placed) {
      if (!p.leader) continue;
      const a = p.anchor;
      const radius = p.height / 2;
      const cx = clamp(a.x, p.box.left + radius, p.box.right - radius);
      const cy = p.box.top + radius;
      const length = Math.hypot(a.x - cx, a.y - cy);
      const b = { x: cx + (a.x - cx) * radius / length, y: cy + (a.y - cy) * radius / length };
      let start = lineInterval(a, b, a.token)?.[1] ?? 0;
      const gaps = placed.filter(other => other !== p)
        .map(other => lineInterval(a, b, expand(other.box, 1)))
        .filter((interval): interval is [number, number] => !!interval)
        .sort((u, v) => u[0] - v[0]);
      ctx.strokeStyle = color(p);
      ctx.beginPath();
      for (const [end, next] of [...gaps, [1, 1]]) {
        if (end > start) {
          ctx.moveTo(a.x + (b.x - a.x) * start, a.y + (b.y - a.y) * start);
          ctx.lineTo(a.x + (b.x - a.x) * end, a.y + (b.y - a.y) * end);
        }
        start = Math.max(start, next);
      }
      ctx.stroke();
    }
    for (const p of placed) {
      const cap = p.height / 2;
      ctx.lineCap = 'round';
      ctx.lineWidth = p.height;
      ctx.strokeStyle = HALO_COLOR;
      ctx.beginPath();
      ctx.moveTo(p.box.left + cap, p.box.top + cap);
      ctx.lineTo(p.box.right - cap, p.box.top + cap);
      ctx.stroke();
      ctx.fillStyle = color(p);
      for (const line of p.lines) this.drawOutlinedText(line.text, p.box.left + line.x, p.box.top + line.y);
    }
    ctx.restore();
  }

  private preparePulses(players: Array<{ player: ReplayPlayer; sample: PlayerSample; floor: FloorId }>, t: number, foreground: Array<() => void>): void {
    const ctx = this.ctx;
    const pulses = getActivePulsesAtTime(this.sortedEvents, t, this.opts.pulseWindowS);
    for (const pulse of pulses) {
      let pos = pulse.pos;
      if (!pos) {
        const uid = pulse.event.actor_uid ?? pulse.event.target_uid;
        const owner = players.find((p) => p.player.uid === uid);
        pos = owner ? owner.sample.pos : null;
      }
      if (!pos) continue;
      const floor = pulse.event.floor ?? classifyFloor(pos[1]);
      const alpha = this.floorAlpha(floor);
      if (alpha <= 0) continue;
      const sp = this.project(pos);
      const radius = 8 + pulse.progress * 28;
      const fade = (1 - pulse.progress) * alpha;
      if (fade <= 0) continue;
      const owner = pulse.event.actor_uid ?? pulse.event.target_uid;
      if (this.labelFrame && !pulse.pos && owner != null && (ringVisible(sp, radius, 1, this.viewport) ||
          (pulse.kind === 'flywheel' && ringVisible(sp, radius * 0.7, 0.5, this.viewport)))) {
        this.labelFrame.pulseOwners.add(owner);
      }
      this.labelFrame?.obstacles.push(expand(box(sp.x - radius, sp.y - radius, 2 * radius, 2 * radius), 1));
      foreground.push(() => {
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.lineWidth = 2;
        ctx.strokeStyle = pulse.kind === 'hit_attack' ? this.palette.red : pulse.kind === 'skill_cast' ? this.palette.gold : this.palette.ice;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        if (pulse.kind === 'flywheel') {
          ctx.strokeStyle = this.palette.text;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, radius * 0.7, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      });
    }
  }

  private prepareRuler(ruler: RulerState, foreground: Array<() => void>): void {
    const ctx = this.ctx;
    const m = measureTacticalDistance(ruler.a, ruler.b);
    const pa = this.project(ruler.a);
    const pb = this.project(ruler.b);
    const label = formatRulerLabel(m);
    const badge = formatCrossFloorBadge(m);
    const mx = (pa.x + pb.x) / 2;
    const my = (pa.y + pb.y) / 2;
    ctx.save();
    ctx.font = `bold 12px ${this.opts.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.reserveText(label, mx, my - 13, 0);
    const tw = ctx.measureText?.(label).width ?? label.length * 7;
    ctx.font = `bold 10px ${this.opts.font}`;
    if (badge) this.reserveText(badge, mx, my + 9.5, 0);
    const bw = badge ? ctx.measureText?.(badge).width ?? badge.length * 6 : 0;
    ctx.restore();
    if (this.labelFrame) {
      const obstacles = this.labelFrame.obstacles;
      obstacles.push(expand(box(mx - tw / 2 - 6, my - 22, tw + 12, 18), 0.5));
      if (badge) obstacles.push(box(mx - bw / 2 - 5, my + 2, bw + 10, 15));
      for (const p of [pa, pb]) obstacles.push(box(p.x - 5.5, p.y - 5.5, 11, 11));
      // Clip before subdividing, even for very distant off-screen endpoints.
      const visible = lineInterval(pa, pb, expand(box(0, 0, this.viewport.width, this.viewport.height), 2));
      if (visible) {
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const [lo, hi] = visible;
        const steps = Math.max(1, Math.ceil((hi - lo) * Math.max(Math.abs(dx), Math.abs(dy)) / 20));
        for (let i = 0; i < steps; i++) {
          const u = lo + (hi - lo) * i / steps, v = lo + (hi - lo) * (i + 1) / steps;
          obstacles.push(expand(box(pa.x + Math.min(dx * u, dx * v), pa.y + Math.min(dy * u, dy * v),
            Math.abs(dx * (v - u)), Math.abs(dy * (v - u))), 1));
        }
      }
    }
    foreground.push(() => {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.palette.gold;
      ctx.lineWidth = 2;
      ctx.setLineDash(m.crossFloor ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of [pa, pb]) {
        ctx.fillStyle = this.palette.bg;
        ctx.strokeStyle = this.palette.gold;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.font = `bold 12px ${this.opts.font}`;
      ctx.fillStyle = this.palette.bg3;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(mx - tw / 2 - 6, my - 22, tw + 12, 18);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.palette.goldD;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(mx - tw / 2 - 6, my - 22, tw + 12, 18);
      ctx.stroke();
      ctx.fillStyle = this.palette.gold;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mx, my - 13);
      if (badge) {
        ctx.font = `bold 10px ${this.opts.font}`;
        ctx.fillStyle = this.palette.red;
        ctx.fillRect(mx - bw / 2 - 5, my + 2, bw + 10, 15);
        ctx.fillStyle = this.palette.text;
        ctx.fillText(badge, mx, my + 9.5);
      }
      ctx.restore();
    });
  }

  // ------------------------------------------------------------------ picking

  private staticHitRadiusPx(kind: StaticPickKind): number {
    switch (kind) {
      case 'cipher': return this.cipherRadiusPx();
      case 'chair': return this.chairRadiusPx();
      case 'hatch': return this.hatchRadiusPx();
      case 'gate':
      case 'chest': {
        const { w, h } = kind === 'gate' ? this.gateSizePx() : this.chestSizePx();
        return Math.max(w / 2, h / 2);
      }
      case 'pallet':
      case 'window':
        return this.glyph(6, 10);
    }
  }

  /** Nearest visible player/cipher/chair/pallet/window/gate/chest/hatch within the pick radius. */
  pickEntityAtScreen(sx: number, sy: number, currentTimeS: number): PickResult | null {
    const payload = this.payload;
    if (!payload) return null;
    const cands: PickCandidate[] = [];
    for (const p of this.samplePlayers(payload, currentTimeS)) {
      if (this.floorAlpha(p.floor) <= 0) continue;
      cands.push({
        kind: 'player', uid: p.player.uid, pos: p.sample.pos, floor: p.floor, priority: 0,
        hitRadiusPx: this.playerRadiusPx(p.player.camp === 1),
      });
    }
    for (const s of this.visibleStatics(payload)) {
      let segment: ScreenSegment | undefined;
      if (s.kind === 'pallet') {
        const pallet = s.entity as Replay2DPayload['entities']['pallets'][number];
        if (samplePalletAtTime(pallet, currentTimeS) !== 'broken') {
          segment = this.palletSegment(pallet, this.project(pallet.pos));
        }
      } else if (s.kind === 'window') {
        const corner = this.windowFrameCorner(s.entity);
        segment = [corner(-1, 0), corner(1, 0)];
      }
      cands.push({
        kind: s.kind, uid: s.entity.uid, pos: [s.entity.pos[0], s.entity.pos[1], s.entity.pos[2]], floor: s.floor, priority: 1,
        hitRadiusPx: this.staticHitRadiusPx(s.kind), segment,
      });
    }
    let best: PickResult | null = null;
    let bestPriority = Infinity;
    for (const c of cands) {
      const sp = this.project(c.pos);
      const d = c.segment ? pointToSegmentDistance(sx, sy, ...c.segment) : Math.hypot(sp.x - sx, sp.y - sy);
      const effectiveRadius = this.hasExplicitPickRadius
        ? this.opts.pickRadiusPx
        : Math.max(this.opts.pickRadiusPx, c.hitRadiusPx);
      if (d > effectiveRadius) continue;
      if (!best || d < best.distancePx - 1e-9 || (Math.abs(d - best.distancePx) <= 1e-9 && c.priority < bestPriority)) {
        best = { kind: c.kind, uid: c.uid, pos: c.pos, floor: c.floor, screen: { x: sp.x, y: sp.y }, distancePx: d };
        bestPriority = c.priority;
      }
    }
    return best;
  }
}

function normalizeXZ(dx: number, dz: number): [number, number] {
  const len = Math.hypot(dx, dz);
  if (!(len > 1e-9)) return [0, 1];
  return [dx / len, dz / len];
}
