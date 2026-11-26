/**
 * Pure-TS obstacle-aware 2D navigation-grid pathfinding and Carry/Tide Dijkstra field engine.
 * Zero unconditional browser globals at import time; pixel decoding is injectable for Node/Vitest.
 */
import {
  CARRY_BAND_COLORS,
  CARRY_BAND_OPACITY,
  carryBandAt,
  carryDropBudget,
  carryRangeBands,
} from './carry-model';
import {
  NAV_GRID_MANIFEST,
  type NavGridBasementMeta,
  type NavGridManifestEntry,
} from './nav-grid-manifest';
import { withBaseUrl } from '@/lib/assetUrl';
import {
  TIDE_BAND_COLORS,
  TIDE_BAND_OPACITY,
  createTideProfile,
  tideBandAt,
  tideRangeBands,
} from './tide-model';
import type {
  CarryChairEval,
  CarryProfile,
  CarryRangeBand,
  PilMapId,
  Point2D,
  RelPointInput,
  TideChairEval,
  TideProfile,
  TideRangeBand,
} from './types';

/** Cell classification constants matching PIL 1px baked nav-grid PNG luminance bands. */
export const NAV_CELL_BLOCKED = 0 as const;
export const NAV_CELL_WALKABLE = 1 as const;
export const NAV_CELL_VAULT = 2 as const;

export type NavCellKind = 0 | 1 | 2;

export interface NavCell {
  x: number;
  y: number;
}

export interface DecodedNavPixels {
  width: number;
  height: number;
  /** Either RGBA (width * height * 4) or 8-bit grayscale (width * height). */
  data: Uint8Array | Uint8ClampedArray;
}

export type NavGridPixelDecoder = (
  url: string,
  meta: NavGridManifestEntry,
) => Promise<DecodedNavPixels | null> | DecodedNavPixels | null;

export interface NavGridData extends NavGridManifestEntry {
  /** 0 = blocked (< 96), 1 = walkable (>= 192), 2 = vaultable (96..191). */
  readonly cells: Uint8Array;
  /** 1 = walkable (>= 192), 0 = otherwise. */
  readonly grid: Uint8Array;
  /** 1 = vaultable (96..191), 0 = otherwise. */
  readonly win: Uint8Array;
}

export interface NavSpeedProfile {
  speedAt(seconds: number): number;
  remainingSeconds?: number;
  timedBreakpoints?: number[];
}

export interface NavEndpointFix {
  from: Point2D;
  to: Point2D;
}

export interface NavResolvedEndpoint {
  cell: NavCell;
  px: [number, number];
  extraMeters: number;
  extraSeconds: number;
  viaBasement: NavGridBasementMeta | null;
  fixed: NavEndpointFix | null;
}

export interface ResolveNavEndpointOptions {
  autoFix?: boolean;
  allowBasement?: boolean;
  forceBasement?: boolean;
  speedMps?: number;
  strictSnapPx?: number;
  basementRadiusPx?: number;
  wideSnapPx?: number;
}

export interface NavPathOptions {
  initialSeconds?: number;
  vault?: boolean;
  onProgress?: (progress: number) => void;
  chunkSize?: number;
}

export interface NavPathResult {
  seconds: number;
  distM: number;
  path: NavCell[];
  reached: number;
  cancelled: boolean;
  unreachable: boolean;
}

export interface CancellableNavJob<T> {
  promise: Promise<T>;
  cancel(): void;
}

export interface NavRouteOptions {
  vault?: boolean;
  autoFix?: boolean;
  allowBasement?: boolean;
  speedMps?: number;
  profile?: NavSpeedProfile;
  sync?: boolean;
  onProgress?: (progress: number) => void;
}

export interface NavRouteResult {
  points: Point2D[];
  distanceM: number;
  durationS: number;
  rawCells: NavCell[];
  smoothedCells: NavCell[];
  fixedA?: NavEndpointFix;
  fixedB?: NavEndpointFix;
  basementA?: NavGridBasementMeta;
  basementB?: NavGridBasementMeta;
}

export interface NavFieldOptions {
  initialSeconds?: number;
  onProgress?: (progress: number) => void;
  chunkSize?: number;
  sync?: boolean;
}

export interface NavFieldResult<TBand extends CarryRangeBand | TideRangeBand = CarryRangeBand | TideRangeBand> {
  timeSeconds: Float32Array;
  bandOf: Int8Array;
  bands: TBand[];
  budget: number;
  reached: number;
  cancelled: boolean;
}

export type NavChairInput =
  | RelPointInput
  | {
      relPos: [number, number];
      index?: number;
      label?: string;
      kind?: string;
      floor?: string;
    };

// ---------------------------------------------------------------------------
// Pixel Decoding & Caching
// ---------------------------------------------------------------------------

interface CachedGridEntry {
  decoder: NavGridPixelDecoder | null;
  promise: Promise<NavGridData | null>;
}

const gridCache = new Map<string, CachedGridEntry>();
let defaultPixelDecoder: NavGridPixelDecoder | null = null;

export function setDefaultNavGridDecoder(decoder: NavGridPixelDecoder | null): void {
  defaultPixelDecoder = decoder;
}

export function clearNavGridCache(): void {
  gridCache.clear();
}

export function navGridAvailable(mapId: number | string): boolean {
  return Object.prototype.hasOwnProperty.call(NAV_GRID_MANIFEST, String(mapId));
}

export function classifyNavGridPixels(
  data: Uint8Array | Uint8ClampedArray,
  gridW: number,
  gridH: number,
): { cells: Uint8Array; grid: Uint8Array; win: Uint8Array } {
  const total = gridW * gridH;
  const cells = new Uint8Array(total);
  const grid = new Uint8Array(total);
  const win = new Uint8Array(total);
  const stride = data.length >= total * 4 ? 4 : 1;
  const count = Math.min(total, Math.floor(data.length / stride));

  for (let i = 0; i < count; i++) {
    const v = data[i * stride] ?? 0;
    if (v >= 192) {
      cells[i] = NAV_CELL_WALKABLE;
      grid[i] = 1;
    } else if (v >= 96) {
      cells[i] = NAV_CELL_VAULT;
      win[i] = 1;
    } else {
      cells[i] = NAV_CELL_BLOCKED;
    }
  }
  return { cells, grid, win };
}

export function createNavGridFromPixels(
  meta: NavGridManifestEntry,
  pixels: DecodedNavPixels,
): NavGridData | null {
  if (pixels.width !== meta.gridW || pixels.height !== meta.gridH) {
    return null;
  }
  const { cells, grid, win } = classifyNavGridPixels(pixels.data, meta.gridW, meta.gridH);
  return {
    ...meta,
    cells,
    grid,
    win,
  };
}

async function decodeNavPixelsViaWebApis(
  url: string,
  meta: NavGridManifestEntry,
): Promise<DecodedNavPixels | null> {
  const g = globalThis as {
    fetch?: typeof fetch;
    createImageBitmap?: (blob: Blob) => Promise<{ width: number; height: number; close?: () => void }>;
    OffscreenCanvas?: new (w: number, h: number) => {
      getContext(
        id: '2d',
        opts?: { willReadFrequently?: boolean },
      ): {
        drawImage(src: unknown, dx: number, dy: number, dw?: number, dh?: number): void;
        getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray };
      } | null;
    };
  };

  if (
    typeof g.fetch !== 'function' ||
    typeof g.createImageBitmap !== 'function' ||
    typeof g.OffscreenCanvas !== 'function'
  ) {
    return null;
  }

  try {
    const res = await g.fetch(withBaseUrl(url));
    if (!res.ok) return null;
    const blob = await res.blob();
    const bmp = await g.createImageBitmap(blob);
    try {
      const canvas = new g.OffscreenCanvas(meta.gridW, meta.gridH);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0, meta.gridW, meta.gridH);
      const imageData = ctx.getImageData(0, 0, meta.gridW, meta.gridH);
      return { width: meta.gridW, height: meta.gridH, data: imageData.data };
    } finally {
      bmp.close?.();
    }
  } catch {
    return null;
  }
}

export function loadNavGrid(
  mapId: PilMapId | number | string,
  decodeFn?: NavGridPixelDecoder,
): Promise<NavGridData | null> {
  const key = String(mapId);
  if (!navGridAvailable(key)) return Promise.resolve(null);
  const meta = NAV_GRID_MANIFEST[Number(key) as PilMapId];
  if (!meta) return Promise.resolve(null);

  const effectiveDecoder = decodeFn ?? defaultPixelDecoder;
  const cached = gridCache.get(key);
  if (cached && (decodeFn === undefined || cached.decoder === decodeFn)) {
    return cached.promise;
  }

  let promise!: Promise<NavGridData | null>;
  promise = (async () => {
    try {
      const pixels = effectiveDecoder
        ? await effectiveDecoder(meta.url, meta)
        : await decodeNavPixelsViaWebApis(meta.url, meta);
      if (!pixels) {
        if (gridCache.get(key)?.promise === promise) gridCache.delete(key);
        return null;
      }
      const navGrid = createNavGridFromPixels(meta, pixels);
      if (!navGrid && gridCache.get(key)?.promise === promise) {
        gridCache.delete(key);
      }
      return navGrid;
    } catch {
      if (gridCache.get(key)?.promise === promise) gridCache.delete(key);
      return null;
    }
  })();

  gridCache.set(key, { decoder: decodeFn ?? null, promise });
  return promise;
}

// ---------------------------------------------------------------------------
// Snapping & Endpoint Resolution
// ---------------------------------------------------------------------------

export function cellToMapPx(grid: Pick<NavGridManifestEntry, 'cellPx'>, cell: NavCell): [number, number] {
  return [(cell.x + 0.5) * grid.cellPx, (cell.y + 0.5) * grid.cellPx];
}

export function mapPxToCell(grid: Pick<NavGridManifestEntry, 'cellPx'>, mapPxX: number, mapPxY: number): NavCell {
  return {
    x: Math.round(mapPxX / grid.cellPx - 0.5),
    y: Math.round(mapPxY / grid.cellPx - 0.5),
  };
}

export function findNearestBasement(
  grid: Pick<NavGridManifestEntry, 'basements'>,
  mapPxX: number,
  mapPxY: number,
): { basement: NavGridBasementMeta; distToCenter: number; distToExit: number } | null {
  if (!grid.basements || grid.basements.length === 0) return null;
  let best: NavGridBasementMeta | null = null;
  let bestCenterD = Infinity;
  let bestExitD = Infinity;
  for (const b of grid.basements) {
    const dc = Math.hypot(b.center[0] - mapPxX, b.center[1] - mapPxY);
    if (dc < bestCenterD) {
      bestCenterD = dc;
      bestExitD = Math.hypot(b.exit[0] - mapPxX, b.exit[1] - mapPxY);
      best = b;
    }
  }
  return best ? { basement: best, distToCenter: bestCenterD, distToExit: bestExitD } : null;
}

/**
 * Spiral search from a map-pixel point for the nearest purely walkable cell (`R >= 192`).
 */
export function snapToWalkable(
  grid: Pick<NavGridData, 'grid' | 'gridW' | 'gridH' | 'cellPx'>,
  mapPxX: number,
  mapPxY: number,
  maxRadiusPx = 40,
): NavCell | null {
  const { grid: walkMask, gridW, gridH, cellPx } = grid;
  const cx = Math.round(mapPxX / cellPx - 0.5);
  const cy = Math.round(mapPxY / cellPx - 0.5);
  const maxRadiusCells = Math.max(0, Math.round(maxRadiusPx / cellPx));

  for (let r = 0; r <= maxRadiusCells; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && y >= 0 && x < gridW && y < gridH && walkMask[y * gridW + x]) {
          return { x, y };
        }
      }
    }
  }
  return null;
}

function buildBasementEndpoint(
  grid: NavGridData,
  basement: NavGridBasementMeta,
  mapPxX: number,
  mapPxY: number,
  speedMps: number,
): NavResolvedEndpoint | null {
  const exitCell = snapToWalkable(grid, basement.exit[0], basement.exit[1], 40);
  if (!exitCell) return null;
  const metersPerPx = grid.metersPerCell / grid.cellPx;
  const extraMeters =
    Math.hypot(basement.exit[0] - mapPxX, basement.exit[1] - mapPxY) * metersPerPx +
    basement.slopeExtraM;
  const safeSpeed = speedMps > 0 ? speedMps : 3.8;
  return {
    cell: exitCell,
    px: cellToMapPx(grid, exitCell),
    extraMeters,
    extraSeconds: extraMeters / safeSpeed,
    viaBasement: basement,
    fixed: null,
  };
}

/**
 * Resolve a map-pixel endpoint to a walkable cell, optionally detecting basement
 * entrances within 40px (applying `exit` + `slopeExtraM`) and wide-snapping blocked
 * wall clicks up to 150px when `autoFix` is true.
 */
export function resolveNavEndpoint(
  grid: NavGridData,
  mapPxX: number,
  mapPxY: number,
  opts: ResolveNavEndpointOptions = {},
): NavResolvedEndpoint | null {
  const autoFix = opts.autoFix ?? false;
  const allowBasement = opts.allowBasement ?? true;
  const forceBasement = opts.forceBasement ?? false;
  const speedMps = opts.speedMps ?? 3.8;
  const strictSnapPx = opts.strictSnapPx ?? 25;
  const basementRadiusPx = opts.basementRadiusPx ?? 40;
  const wideSnapPx = opts.wideSnapPx ?? 150;

  if (forceBasement && allowBasement) {
    const nearest = findNearestBasement(grid, mapPxX, mapPxY);
    if (nearest) {
      const resolved = buildBasementEndpoint(grid, nearest.basement, mapPxX, mapPxY, speedMps);
      if (resolved) return resolved;
    }
  }

  // Fast path: pixel itself is directly walkable
  const exact = mapPxToCell(grid, mapPxX, mapPxY);
  if (
    exact.x >= 0 &&
    exact.y >= 0 &&
    exact.x < grid.gridW &&
    exact.y < grid.gridH &&
    grid.grid[exact.y * grid.gridW + exact.x]
  ) {
    return {
      cell: exact,
      px: cellToMapPx(grid, exact),
      extraMeters: 0,
      extraSeconds: 0,
      viaBasement: null,
      fixed: null,
    };
  }

  // Blocked pixel near a basement entrance/center (<= 40px) -> route via staircase exit
  if (allowBasement && grid.basements.length > 0) {
    let best: NavGridBasementMeta | null = null;
    let bestD = Infinity;
    for (const b of grid.basements) {
      const dc = Math.hypot(b.center[0] - mapPxX, b.center[1] - mapPxY);
      const de = Math.hypot(b.exit[0] - mapPxX, b.exit[1] - mapPxY);
      const d = Math.min(dc, de);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best && bestD <= basementRadiusPx) {
      const resolved = buildBasementEndpoint(grid, best, mapPxX, mapPxY, speedMps);
      if (resolved) return resolved;
    }
  }

  // Local tolerance snap (<= strictSnapPx, e.g. landmark footprint)
  const strict = snapToWalkable(grid, mapPxX, mapPxY, strictSnapPx);
  if (strict) {
    return {
      cell: strict,
      px: cellToMapPx(grid, strict),
      extraMeters: 0,
      extraSeconds: 0,
      viaBasement: null,
      fixed: null,
    };
  }

  // Wide auto-fix snap out of thick obstacles / map borders (<= 150px)
  if (autoFix) {
    const wide = snapToWalkable(grid, mapPxX, mapPxY, wideSnapPx);
    if (wide) {
      const px = cellToMapPx(grid, wide);
      return {
        cell: wide,
        px,
        extraMeters: 0,
        extraSeconds: 0,
        viaBasement: null,
        fixed: {
          from: { x: mapPxX, y: mapPxY },
          to: { x: px[0], y: px[1] },
        },
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Min-Heap Priority Queue (key = arrival seconds or f-score)
// ---------------------------------------------------------------------------

interface MinHeap {
  push(k: number, v: number): void;
  pop(): number;
  topKey(): number;
  readonly size: number;
}

function makeMinHeap(): MinHeap {
  const keys: number[] = [];
  const vals: number[] = [];

  const up = (i: number): void => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= keys[i]!) break;
      const tk = keys[p]!;
      keys[p] = keys[i]!;
      keys[i] = tk;
      const tv = vals[p]!;
      vals[p] = vals[i]!;
      vals[i] = tv;
      i = p;
    }
  };

  const down = (i: number): void => {
    const len = keys.length;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < len && keys[l]! < keys[m]!) m = l;
      if (r < len && keys[r]! < keys[m]!) m = r;
      if (m === i) break;
      const tk = keys[m]!;
      keys[m] = keys[i]!;
      keys[i] = tk;
      const tv = vals[m]!;
      vals[m] = vals[i]!;
      vals[i] = tv;
      i = m;
    }
  };

  return {
    push(k: number, v: number): void {
      keys.push(k);
      vals.push(v);
      up(keys.length - 1);
    },
    pop(): number {
      const top = vals[0]!;
      const lastK = keys.pop()!;
      const lastV = vals.pop()!;
      if (keys.length > 0) {
        keys[0] = lastK;
        vals[0] = lastV;
        down(0);
      }
      return top;
    },
    topKey(): number {
      return keys[0]!;
    },
    get size(): number {
      return keys.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Supercover Line-of-Sight & Greedy Path Smoothing
// ---------------------------------------------------------------------------

/**
 * Supercover Bresenham line-of-sight on grid coordinates (forbids diagonal corner cutting).
 */
export function gridLineOfSight(
  grid: Pick<NavGridData, 'grid' | 'win' | 'gridW' | 'gridH'>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  vault = false,
): boolean {
  const { grid: walkMask, win, gridW, gridH } = grid;
  const canWalk = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= gridW || y >= gridH) return false;
    const i = y * gridW + x;
    return walkMask[i] === 1 || (vault && win[i] === 1);
  };

  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  for (;;) {
    if (!canWalk(x, y)) return false;
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      if (!canWalk(x + sx, y)) return false;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      if (!canWalk(x, y + sy)) return false;
      y += sy;
    }
  }
}

/**
 * Greedy farthest-visible-waypoint smoothing on grid coordinates.
 */
export function smoothPathOnGrid(
  grid: Pick<NavGridData, 'grid' | 'win' | 'gridW' | 'gridH'>,
  path: readonly NavCell[],
  vault = false,
): NavCell[] {
  if (!path || path.length < 3) return path ? path.map((p) => ({ x: p.x, y: p.y })) : [];
  const out: NavCell[] = [{ x: path[0]!.x, y: path[0]!.y }];
  let anchor = 0;
  for (let i = 2; i < path.length; i++) {
    const a = path[anchor]!;
    const b = path[i]!;
    if (!gridLineOfSight(grid, a.x, a.y, b.x, b.y, vault)) {
      const prev = path[i - 1]!;
      out.push({ x: prev.x, y: prev.y });
      anchor = i - 1;
    }
  }
  const last = path[path.length - 1]!;
  out.push({ x: last.x, y: last.y });
  return out;
}

// ---------------------------------------------------------------------------
// 8-Neighbor A* Pathfinding (Chunked/Cancellable + Sync + Relative Route)
// ---------------------------------------------------------------------------

function estimateMaxSpeed(profile: NavSpeedProfile): number {
  let maxSpeed = 0;
  const probes = [0, 5, 30, 130, 300, 1e9, ...(profile.timedBreakpoints ?? [])];
  for (const t of probes) {
    const v = profile.speedAt(t);
    if (Number.isFinite(v) && v > maxSpeed) maxSpeed = v;
  }
  return maxSpeed > 0 ? maxSpeed : 1;
}

function integrateTimeForMeters(
  profile: NavSpeedProfile,
  distM: number,
  initialSeconds = 0,
): number {
  if (!(distM > 0)) return 0;
  const breaks = (profile.timedBreakpoints ?? [])
    .filter((d) => Number.isFinite(d) && d > initialSeconds)
    .sort((a, b) => a - b);
  let t = initialSeconds;
  let rem = distM;
  let bi = 0;
  while (rem > 1e-9) {
    const v = Math.max(profile.speedAt(t), 1e-6);
    while (bi < breaks.length && breaks[bi]! <= t + 1e-9) bi++;
    const next = bi < breaks.length ? breaks[bi]! : Infinity;
    if (!Number.isFinite(next)) return t - initialSeconds + rem / v;
    const cover = v * (next - t);
    if (cover >= rem) return t - initialSeconds + rem / v;
    rem -= cover;
    t = next;
  }
  return t - initialSeconds;
}

interface PathSolverState {
  gridW: number;
  gridH: number;
  walkMask: Uint8Array;
  win: Uint8Array;
  vault: boolean;
  orth: number;
  diag: number;
  endX: number;
  endY: number;
  endIdx: number;
  initialSeconds: number;
  maxSpeed: number;
  metersPerCell: number;
  profile: NavSpeedProfile;
  time: Float64Array;
  distM: Float64Array;
  parent: Int32Array;
  heap: MinHeap;
  settled: number;
}

function createPathSolverState(
  grid: NavGridData,
  start: NavCell,
  goal: NavCell,
  profile: NavSpeedProfile,
  initialSeconds: number,
  vault: boolean,
): PathSolverState | null {
  const { grid: walkMask, win, gridW, gridH, metersPerCell } = grid;
  const canWalk = (i: number): boolean => walkMask[i] === 1 || (vault && win[i] === 1);
  if (
    start.x < 0 ||
    start.y < 0 ||
    start.x >= gridW ||
    start.y >= gridH ||
    goal.x < 0 ||
    goal.y < 0 ||
    goal.x >= gridW ||
    goal.y >= gridH
  ) {
    return null;
  }
  const startIdx = start.y * gridW + start.x;
  const endIdx = goal.y * gridW + goal.x;
  if (!canWalk(startIdx) || !canWalk(endIdx)) return null;

  const total = gridW * gridH;
  const time = new Float64Array(total).fill(Infinity);
  const distM = new Float64Array(total).fill(Infinity);
  const parent = new Int32Array(total).fill(-1);
  time[startIdx] = initialSeconds;
  distM[startIdx] = 0;

  const maxSpeed = estimateMaxSpeed(profile);
  const heap = makeMinHeap();
  const h0 = (Math.hypot(start.x - goal.x, start.y - goal.y) * metersPerCell) / maxSpeed;
  heap.push(initialSeconds + h0, startIdx);

  return {
    gridW,
    gridH,
    walkMask,
    win,
    vault,
    orth: metersPerCell,
    diag: metersPerCell * Math.SQRT2,
    endX: goal.x,
    endY: goal.y,
    endIdx,
    initialSeconds,
    maxSpeed,
    metersPerCell,
    profile,
    time,
    distM,
    parent,
    heap,
    settled: 0,
  };
}

function stepPathSolver(st: PathSolverState, maxSteps: number): 'running' | 'found' | 'unreachable' {
  const {
    gridW,
    gridH,
    walkMask,
    win,
    vault,
    orth,
    diag,
    endX,
    endY,
    endIdx,
    maxSpeed,
    metersPerCell,
    profile,
    time,
    distM,
    parent,
    heap,
  } = st;

  const canWalk = (i: number): boolean => walkMask[i] === 1 || (vault && win[i] === 1);
  const hOf = (x: number, y: number): number =>
    (Math.hypot(x - endX, y - endY) * metersPerCell) / maxSpeed;

  let n = 0;
  while (heap.size > 0 && n < maxSteps) {
    const key = heap.topKey();
    const idx = heap.pop();
    const x = idx % gridW;
    const y = (idx / gridW) | 0;
    const t = key - hOf(x, y);
    if (t > time[idx]! + 1e-12) continue;

    n++;
    st.settled++;
    if (idx === endIdx) return 'found';

    const speed = Math.max(profile.speedAt(t), 1e-6);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
        const ni = ny * gridW + nx;
        if (!canWalk(ni)) continue;
        if (dx && dy && (!canWalk(y * gridW + nx) || !canWalk(ny * gridW + x))) continue;
        const edgeM = dx && dy ? diag : orth;
        const nt = t + edgeM / speed;
        if (nt + 1e-12 < time[ni]!) {
          time[ni] = nt;
          distM[ni] = distM[idx]! + edgeM;
          parent[ni] = idx;
          heap.push(nt + hOf(nx, ny), ni);
        }
      }
    }
  }

  return heap.size > 0 ? 'running' : 'unreachable';
}

function buildFoundPathResult(st: PathSolverState): NavPathResult {
  const path: NavCell[] = [];
  for (let i = st.endIdx; i !== -1; i = st.parent[i]!) {
    path.push({ x: i % st.gridW, y: (i / st.gridW) | 0 });
  }
  path.reverse();
  return {
    seconds: st.time[st.endIdx]! - st.initialSeconds,
    distM: st.distM[st.endIdx]!,
    path,
    reached: st.settled,
    cancelled: false,
    unreachable: false,
  };
}

/**
 * Synchronous 8-neighbor A* pathfinder (ideal for unit tests and quick interactive routes).
 */
export function computePathSync(
  grid: NavGridData,
  start: NavCell,
  goal: NavCell,
  profile: NavSpeedProfile,
  opts: Omit<NavPathOptions, 'onProgress' | 'chunkSize'> = {},
): NavPathResult {
  const initialSeconds = opts.initialSeconds ?? 0;
  const vault = opts.vault ?? false;
  const st = createPathSolverState(grid, start, goal, profile, initialSeconds, vault);
  if (!st) {
    return {
      seconds: Infinity,
      distM: Infinity,
      path: [],
      reached: 0,
      cancelled: false,
      unreachable: true,
    };
  }
  const status = stepPathSolver(st, Number.MAX_SAFE_INTEGER);
  if (status === 'found') return buildFoundPathResult(st);
  return {
    seconds: Infinity,
    distM: Infinity,
    path: [],
    reached: st.settled,
    cancelled: false,
    unreachable: true,
  };
}

/**
 * Chunked & cancellable 8-neighbor A* pathfinder (20,000 settled cells per yield by default).
 */
export function computePath(
  grid: NavGridData,
  start: NavCell,
  goal: NavCell,
  profile: NavSpeedProfile,
  opts: NavPathOptions = {},
): CancellableNavJob<NavPathResult> {
  const initialSeconds = opts.initialSeconds ?? 0;
  const vault = opts.vault ?? false;
  const chunkSize = Math.max(100, opts.chunkSize ?? 20000);
  const st = createPathSolverState(grid, start, goal, profile, initialSeconds, vault);

  if (!st) {
    return {
      promise: Promise.resolve({
        seconds: Infinity,
        distM: Infinity,
        path: [],
        reached: 0,
        cancelled: false,
        unreachable: true,
      }),
      cancel() {},
    };
  }

  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
  };

  const promise = new Promise<NavPathResult>((resolve) => {
    const tick = (): void => {
      if (cancelled) {
        resolve({
          seconds: Infinity,
          distM: Infinity,
          path: [],
          reached: st.settled,
          cancelled: true,
          unreachable: false,
        });
        return;
      }
      const status = stepPathSolver(st, chunkSize);
      if (status === 'found') {
        opts.onProgress?.(1);
        resolve(buildFoundPathResult(st));
        return;
      }
      if (status === 'unreachable') {
        opts.onProgress?.(1);
        resolve({
          seconds: Infinity,
          distM: Infinity,
          path: [],
          reached: st.settled,
          cancelled: false,
          unreachable: true,
        });
        return;
      }
      opts.onProgress?.(Math.min(0.99, st.settled / Math.max(st.settled + st.heap.size, 1)));
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  });

  return { promise, cancel };
}

/**
 * High-level relative-coordinate obstacle route planner (`[0, 1]` -> smoothed `Point2D[]` + meters).
 */
export async function routeBetweenRel(
  grid: NavGridData,
  mapSize: readonly [number, number],
  fromRel: Point2D,
  toRel: Point2D,
  opts: NavRouteOptions = {},
): Promise<NavRouteResult | null> {
  const [dw, dh] = mapSize;
  if (!(dw > 0) || !(dh > 0)) return null;

  const vault = opts.vault ?? false;
  const autoFix = opts.autoFix ?? true;
  const allowBasement = opts.allowBasement ?? true;
  const profile: NavSpeedProfile =
    opts.profile ?? createTideProfile({ baseSpeed: opts.speedMps ?? 3.8, buffs: [] });
  const baseSpeed = profile.speedAt(0);

  const sA = resolveNavEndpoint(grid, fromRel.x * dw, fromRel.y * dh, {
    autoFix,
    allowBasement,
    speedMps: baseSpeed,
  });
  if (!sA) return null;

  const sB = resolveNavEndpoint(grid, toRel.x * dw, toRel.y * dh, {
    autoFix,
    allowBasement,
    speedMps: baseSpeed,
  });
  if (!sB) return null;

  const raw = opts.sync
    ? computePathSync(grid, sA.cell, sB.cell, profile, {
        initialSeconds: sA.extraSeconds,
        vault,
      })
    : await computePath(grid, sA.cell, sB.cell, profile, {
        initialSeconds: sA.extraSeconds,
        vault,
        onProgress: opts.onProgress,
      }).promise;

  if (raw.cancelled || raw.unreachable || raw.path.length === 0) return null;

  const smoothedCells = raw.path.length > 2 ? smoothPathOnGrid(grid, raw.path, vault) : raw.path.slice();
  const points: Point2D[] = smoothedCells.map((c) => ({
    x: ((c.x + 0.5) * grid.cellPx) / dw,
    y: ((c.y + 0.5) * grid.cellPx) / dh,
  }));

  // Guarantee at least 2 points when start === goal so polyline renderers never degenerate
  if (points.length === 1) {
    points.push({ x: points[0]!.x, y: points[0]!.y });
  }

  const metersPerPx = grid.metersPerCell / grid.cellPx;
  let pathMeters = 0;
  for (let i = 1; i < smoothedCells.length; i++) {
    const a = smoothedCells[i - 1]!;
    const b = smoothedCells[i]!;
    pathMeters += Math.hypot((b.x - a.x) * grid.cellPx, (b.y - a.y) * grid.cellPx) * metersPerPx;
  }

  const distanceM = pathMeters + sA.extraMeters + sB.extraMeters;
  const pathDurationS = integrateTimeForMeters(profile, pathMeters, sA.extraSeconds);
  const durationS = sA.extraSeconds + pathDurationS + sB.extraSeconds;

  return {
    points,
    distanceM,
    durationS,
    rawCells: raw.path,
    smoothedCells,
    ...(sA.fixed ? { fixedA: sA.fixed } : {}),
    ...(sB.fixed ? { fixedB: sB.fixed } : {}),
    ...(sA.viaBasement ? { basementA: sA.viaBasement } : {}),
    ...(sB.viaBasement ? { basementB: sB.viaBasement } : {}),
  };
}

// ---------------------------------------------------------------------------
// Chunked / Cancellable 8-Neighbor Dijkstra Field (Carry & Tide)
// ---------------------------------------------------------------------------

function computeField<TBand extends CarryRangeBand | TideRangeBand>(
  grid: NavGridData,
  start: NavCell,
  profile: NavSpeedProfile & { remainingSeconds: number },
  params: {
    bands: TBand[];
    bandAt: (bands: readonly TBand[], seconds: number) => number;
    vault: boolean;
    initialSeconds?: number;
    onProgress?: (progress: number) => void;
    chunkSize?: number;
    sync?: boolean;
  },
): CancellableNavJob<NavFieldResult<TBand>> {
  const { grid: walkMask, win, gridW, gridH, metersPerCell } = grid;
  const { bands, bandAt, vault } = params;
  const initialSeconds = Math.max(0, params.initialSeconds ?? 0);
  const budget = profile.remainingSeconds;
  const total = gridW * gridH;
  const timeSeconds = new Float32Array(total).fill(Infinity);
  const bandOf = new Int8Array(total).fill(-1);

  const canWalk = (i: number): boolean => walkMask[i] === 1 || (vault && win[i] === 1);
  if (
    start.x < 0 ||
    start.y < 0 ||
    start.x >= gridW ||
    start.y >= gridH ||
    !canWalk(start.y * gridW + start.x) ||
    initialSeconds >= budget
  ) {
    return {
      promise: Promise.resolve({
        timeSeconds,
        bandOf,
        bands,
        budget,
        reached: 0,
        cancelled: false,
      }),
      cancel() {},
    };
  }

  // Use Float64 internal distance accumulator for relaxation accuracy, mirroring to Float32Array output
  const time64 = new Float64Array(total).fill(Infinity);
  const startIdx = start.y * gridW + start.x;
  time64[startIdx] = initialSeconds;
  timeSeconds[startIdx] = initialSeconds;
  bandOf[startIdx] = bandAt(bands, initialSeconds);

  const heap = makeMinHeap();
  heap.push(initialSeconds, startIdx);
  const orth = metersPerCell;
  const diag = metersPerCell * Math.SQRT2;
  let settled = 0;
  let cancelled = false;
  const chunkSize = Math.max(100, params.chunkSize ?? 20000);

  const runChunk = (limit: number): boolean => {
    let n = 0;
    while (heap.size > 0 && n < limit) {
      const t = heap.topKey();
      if (t > budget) {
        heap.pop();
        continue;
      }
      const idx = heap.pop();
      if (t > time64[idx]! + 1e-12) continue;
      n++;
      settled++;
      const x = idx % gridW;
      const y = (idx / gridW) | 0;
      const speed = Math.max(profile.speedAt(t), 1e-6);

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
          const ni = ny * gridW + nx;
          if (!canWalk(ni)) continue;
          if (dx && dy && (!canWalk(y * gridW + nx) || !canWalk(ny * gridW + x))) continue;
          const nt = t + (dx && dy ? diag : orth) / speed;
          if (nt <= budget && nt + 1e-12 < time64[ni]!) {
            time64[ni] = nt;
            timeSeconds[ni] = nt;
            bandOf[ni] = bandAt(bands, nt);
            heap.push(nt, ni);
          }
        }
      }
    }
    return heap.size === 0;
  };

  if (params.sync) {
    runChunk(Number.MAX_SAFE_INTEGER);
    params.onProgress?.(1);
    return {
      promise: Promise.resolve({
        timeSeconds,
        bandOf,
        bands,
        budget,
        reached: settled,
        cancelled: false,
      }),
      cancel() {},
    };
  }

  const cancel = (): void => {
    cancelled = true;
  };

  const promise = new Promise<NavFieldResult<TBand>>((resolve) => {
    const tick = (): void => {
      if (cancelled) {
        resolve({ timeSeconds, bandOf, bands, budget, reached: settled, cancelled: true });
        return;
      }
      const done = runChunk(chunkSize);
      params.onProgress?.(done ? 1 : Math.min(0.99, (heap.topKey() ?? budget) / Math.max(budget, 1e-6)));
      if (done) {
        resolve({ timeSeconds, bandOf, bands, budget, reached: settled, cancelled: false });
      } else {
        setTimeout(tick, 0);
      }
    };
    setTimeout(tick, 0);
  });

  return { promise, cancel };
}

export function computeCarryField(
  grid: NavGridData,
  start: NavCell,
  profile: CarryProfile,
  opts: NavFieldOptions = {},
): CancellableNavJob<NavFieldResult<CarryRangeBand>> {
  return computeField(grid, start, profile, {
    ...opts,
    vault: false,
    bands: carryRangeBands(profile),
    bandAt: carryBandAt,
  });
}

export function computeTideField(
  grid: NavGridData,
  start: NavCell,
  profile: TideProfile,
  opts: NavFieldOptions = {},
): CancellableNavJob<NavFieldResult<TideRangeBand>> {
  return computeField(grid, start, profile, {
    ...opts,
    vault: true,
    bands: tideRangeBands(),
    bandAt: tideBandAt,
  });
}

/**
 * Resolve hidden range bands by promoting hidden inner bands to the nearest visible outer band.
 */
export function resolveVisibleNavBand(
  band: number,
  hiddenBands: ReadonlySet<number> | readonly number[],
  bandCount = 5,
): number {
  if (band < 0 || band >= bandCount) return -1;
  const hidden = Array.isArray(hiddenBands) ? new Set(hiddenBands) : (hiddenBands as ReadonlySet<number>);
  let b = band;
  while (b < bandCount && hidden.has(b)) b++;
  return b < bandCount ? b : -1;
}

/**
 * Pure-TS RGBA rasterizer for a Carry or Tide nav-grid field (`gridW * gridH * 4` bytes).
 * Consumed by Stage 2 Canvas overlay renderer without duplicating color/opacity math.
 */
export function buildNavFieldRgba(
  bandOf: Int8Array,
  scenario: 'carry' | 'tide',
  hiddenBands: ReadonlySet<number> | readonly number[] = [],
  opacityFactor = 0.72,
): Uint8ClampedArray {
  const colors = scenario === 'carry' ? CARRY_BAND_COLORS : TIDE_BAND_COLORS;
  const opacities = scenario === 'carry' ? CARRY_BAND_OPACITY : TIDE_BAND_OPACITY;
  const hidden = Array.isArray(hiddenBands) ? new Set(hiddenBands) : (hiddenBands as ReadonlySet<number>);
  const rgb: Array<[number, number, number, number]> = colors.map((hex, i) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    Math.round((opacities[i] ?? 0.45) * opacityFactor * 255),
  ]);

  const out = new Uint8ClampedArray(bandOf.length * 4);
  for (let i = 0; i < bandOf.length; i++) {
    const rawBand = bandOf[i]!;
    if (rawBand < 0) continue;
    const band = resolveVisibleNavBand(rawBand, hidden, colors.length);
    if (band < 0) continue;
    const c = rgb[band]!;
    const off = i * 4;
    out[off] = c[0];
    out[off + 1] = c[1];
    out[off + 2] = c[2];
    out[off + 3] = c[3];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chair Evaluation on Nav-Grid (Ground + Basement slopeExtraM)
// ---------------------------------------------------------------------------

function extractChair(
  input: NavChairInput,
  fallbackIndex: number,
): { x: number; y: number; index: number; label?: string; kind?: string; floor?: string } {
  if (Array.isArray(input)) {
    return { x: input[0], y: input[1], index: fallbackIndex };
  }
  if ('relPos' in input) {
    return {
      x: input.relPos[0],
      y: input.relPos[1],
      index: input.index ?? fallbackIndex,
      label: input.label,
      kind: input.kind,
      floor: 'floor' in input ? input.floor : undefined,
    };
  }
  return { x: input.x, y: input.y, index: fallbackIndex };
}

function sampleFieldTimeAtPx(
  grid: NavGridData,
  timeSeconds: Float32Array,
  px: number,
  py: number,
  snapRadiusPx = 12,
): number {
  const c = mapPxToCell(grid, px, py);
  if (c.x >= 0 && c.y >= 0 && c.x < grid.gridW && c.y < grid.gridH) {
    const direct = timeSeconds[c.y * grid.gridW + c.x]!;
    if (Number.isFinite(direct)) return direct;
  }
  const snapped = snapToWalkable(grid, px, py, snapRadiusPx);
  if (!snapped) return Infinity;
  return timeSeconds[snapped.y * grid.gridW + snapped.x]!;
}

export function evaluateChairsOnNavGrid(
  grid: NavGridData,
  field: NavFieldResult<CarryRangeBand>,
  profile: CarryProfile,
  chairs: readonly NavChairInput[],
  mapSize: readonly [number, number],
  scenario: 'carry',
): CarryChairEval[];
export function evaluateChairsOnNavGrid(
  grid: NavGridData,
  field: NavFieldResult<TideRangeBand>,
  profile: TideProfile,
  chairs: readonly NavChairInput[],
  mapSize: readonly [number, number],
  scenario: 'tide',
): TideChairEval[];
export function evaluateChairsOnNavGrid(
  grid: NavGridData,
  field: NavFieldResult<CarryRangeBand> | NavFieldResult<TideRangeBand>,
  profile: CarryProfile | TideProfile,
  chairs: readonly NavChairInput[],
  mapSize: readonly [number, number],
  scenario: 'carry' | 'tide',
): Array<CarryChairEval | TideChairEval> {
  const [dw, dh] = mapSize;
  const metersPerPx = grid.metersPerCell / grid.cellPx;

  const evals = chairs.map((raw, i) => {
    const ch = extractChair(raw, i);
    const px = ch.x * dw;
    const py = ch.y * dh;
    const isBasement = ch.kind === 'basement' || ch.floor === 'B1';

    let travelSeconds = Infinity;
    let extraM = 0;

    if (isBasement && grid.basements.length > 0) {
      const nearest = findNearestBasement(grid, px, py);
      if (nearest) {
        const b = nearest.basement;
        const tExit = sampleFieldTimeAtPx(grid, field.timeSeconds, b.exit[0], b.exit[1], 25);
        if (Number.isFinite(tExit)) {
          extraM = Math.hypot(b.exit[0] - px, b.exit[1] - py) * metersPerPx + b.slopeExtraM;
          const vExit = Math.max(profile.speedAt(tExit), 1e-6);
          travelSeconds = tExit + extraM / vExit;
        }
      }
    } else {
      travelSeconds = sampleFieldTimeAtPx(grid, field.timeSeconds, px, py, 12);
    }

    const distanceM = Number.isFinite(travelSeconds)
      ? travelSeconds * profile.speedAt(0)
      : Infinity;

    if (scenario === 'carry') {
      const cProfile = profile as CarryProfile;
      const cBands = field.bands as CarryRangeBand[];
      const band = carryBandAt(cBands, travelSeconds);
      const budget = Number.isFinite(travelSeconds)
        ? carryDropBudget(cProfile, travelSeconds)
        : { progressPercent: 100, drops: null, canHang: false, risk: false };
      return {
        index: ch.index,
        x: ch.x,
        y: ch.y,
        distanceM,
        travelSeconds,
        band,
        drops: budget.drops,
        canHang: budget.canHang,
        risk: budget.risk,
        progressPercent: budget.progressPercent,
        ...(ch.label !== undefined ? { label: ch.label } : {}),
        ...(ch.kind !== undefined ? { kind: ch.kind } : {}),
      } satisfies CarryChairEval;
    }

    const tBands = field.bands as TideRangeBand[];
    const band = tideBandAt(tBands, travelSeconds);
    return {
      index: ch.index,
      x: ch.x,
      y: ch.y,
      distanceM,
      travelSeconds,
      band,
      reachable20s: band >= 0 && band <= 3,
      inMargin: band === 4,
      reachable: band >= 0,
      ...(ch.label !== undefined ? { label: ch.label } : {}),
      ...(ch.kind !== undefined ? { kind: ch.kind } : {}),
    } satisfies TideChairEval;
  });

  evals.sort((a, b) => a.travelSeconds - b.travelSeconds || a.distanceM - b.distanceM || a.index - b.index);
  return evals;
}
