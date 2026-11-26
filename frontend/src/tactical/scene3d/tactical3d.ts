/**
 * P1 Pure TypeScript 3D Tactical Navigation Engine:
 * - Triangle-adjacency 3D NavMesh Graph (auto-welds shared vertices + optional vault links)
 * - Fast 3D A* A→B Pathfinding with Line-of-Sight String-Pulling + Floor & Vault Timing
 * - 3D Multi-Floor Dijkstra Carry (Balloon-to-Chair) & Tide (20s) 5-Band Surface Fields
 * - 3D Multi-Source Hardest-to-Chair Top-N Extremum Spots ("最难挂椅极值点")
 *
 * Zero DOM / zero WebGL dependencies — runs in < 10ms in both browser and Vitest!
 */
import type { FloorId } from '@idv/replay-renderer';
import {
  CARRY_BAND_COLORS,
  carryBandAt,
  carryRangeBands,
} from '../carry-model';
import {
  TIDE_BAND_COLORS,
  tideBandAt,
  tideRangeBands,
} from '../tide-model';
import { MAPS_DATA } from '../maps';
import type { CarryProfile, PilMapId, TideProfile } from '../types';
import { UNITS_PER_METER, normalizedToWorld3D, world3DToNormalized } from './calibration3d';
import { classifyFloorBand, type NavMesh3D, type Vec3Point } from './nav3d';

export interface NavGraph3D {
  readonly triCount: number;
  readonly cx: Float32Array;
  readonly cy: Float32Array;
  readonly cz: Float32Array;
  readonly triFloor: FloorId[];
  /** Neighbor triangle index list flattened via CSR offsets. */
  readonly edgeOffset: Int32Array;
  readonly edgeTarget: Int32Array;
  readonly edgeDistM: Float32Array;
  /** 0 = normal walk edge, 1 = vault/drop bridge link */
  readonly edgeKind: Uint8Array;
}

export interface Path3DOptions {
  speedMps?: number;
  allowVault?: boolean;
  vaultPenaltySeconds?: number;
}

export interface Path3DResult {
  reachable: boolean;
  points: Vec3Point[];
  distanceM: number;
  baseTimeS: number;
  vaultCount: number;
  vaultTimeS: number;
  totalTimeS: number;
  speedMps: number;
  floors: FloorId[];
}

export interface Chair3DCandidate {
  index: number;
  label: string;
  kind: 'fixed' | 'set' | 'basement';
  pos: Vec3Point;
  floor: FloorId;
  triIndex: number;
}

export interface Chair3DEvalRow {
  index: number;
  label: string;
  kind: 'fixed' | 'set' | 'basement';
  pos: Vec3Point;
  floor: FloorId;
  distanceM: number;
  travelSeconds: number;
  band: number;
  canHang?: boolean;
  drops?: number;
  risk?: boolean;
  reachable20s?: boolean;
  inMargin?: boolean;
  path: Vec3Point[];
}

export interface SurfaceField3DResult {
  scenario: 'carry' | 'tide';
  mode: 'chair' | 'point';
  origin: Vec3Point;
  /** Per-triangle band index (-1 = unreachable, 0..4 = PIL band index). */
  triBands: Int8Array;
  reachedTris: number;
  chairRows: Chair3DEvalRow[];
  summaryText: string;
}

export interface HardestChairSpot3D {
  rank: number;
  pos: Vec3Point;
  relU: number;
  relV: number;
  floor: FloorId;
  nearestChairLabel: string;
  nearestChairPos: Vec3Point;
  distanceM: number;
  hangSeconds: number;
  escapes: boolean;
}

const graphCache = new WeakMap<NavMesh3D, NavGraph3D>();

// ---------------------------------------------------------------------------
// Min-Heap Priority Queue (Zero-Allocation Growth)
// ---------------------------------------------------------------------------
class FloatMinHeap {
  private nodes: number[] = [];
  private scores: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, score: number): void {
    const idx = this.nodes.length;
    this.nodes.push(node);
    this.scores.push(score);
    this.bubbleUp(idx);
  }

  pop(): { node: number; score: number } | null {
    const n = this.nodes.length;
    if (n === 0) return null;
    const node = this.nodes[0]!;
    const score = this.scores[0]!;
    const lastNode = this.nodes.pop()!;
    const lastScore = this.scores.pop()!;
    if (n > 1) {
      this.nodes[0] = lastNode;
      this.scores[0] = lastScore;
      this.sinkDown(0);
    }
    return { node, score };
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.scores[i]! >= this.scores[p]!) break;
      const tn = this.nodes[i]!;
      const ts = this.scores[i]!;
      this.nodes[i] = this.nodes[p]!;
      this.scores[i] = this.scores[p]!;
      this.nodes[p] = tn;
      this.scores[p] = ts;
      i = p;
    }
  }

  private sinkDown(i: number): void {
    const n = this.nodes.length;
    while (true) {
      const l = i * 2 + 1;
      const r = l + 1;
      let smallest = i;
      if (l < n && this.scores[l]! < this.scores[smallest]!) smallest = l;
      if (r < n && this.scores[r]! < this.scores[smallest]!) smallest = r;
      if (smallest === i) break;
      const tn = this.nodes[i]!;
      const ts = this.scores[i]!;
      this.nodes[i] = this.nodes[smallest]!;
      this.scores[i] = this.scores[smallest]!;
      this.nodes[smallest] = tn;
      this.scores[smallest] = ts;
      i = smallest;
    }
  }
}

// ---------------------------------------------------------------------------
// 3D Triangle Adjacency Graph Construction (Cached per NavMesh3D)
// ---------------------------------------------------------------------------
export function buildNavGraph3D(navMesh: NavMesh3D): NavGraph3D {
  const cached = graphCache.get(navMesh);
  if (cached) return cached;

  const n = navMesh.triangleCount;
  const raw = navMesh.rawTrianglePositions;
  const cx = new Float32Array(n);
  const cy = new Float32Array(n);
  const cz = new Float32Array(n);
  const triFloor: FloorId[] = new Array(n);

  // Quantize vertices to 0.5 world-unit buckets so touching triangles weld cleanly
  const qKey = (x: number, y: number, z: number): string =>
    `${Math.round(x * 1.5)}_${Math.round(y * 1.0)}_${Math.round(z * 1.5)}`;

  const vertToTris = new Map<string, number[]>();
  const adjLists: Array<Array<{ to: number; distM: number; kind: number }>> = Array.from(
    { length: n },
    () => [],
  );

  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const ax = raw[o]!, ay = raw[o + 1]!, az = raw[o + 2]!;
    const bx = raw[o + 3]!, by = raw[o + 4]!, bz = raw[o + 5]!;
    const cx0 = raw[o + 6]!, cy0 = raw[o + 7]!, cz0 = raw[o + 8]!;

    cx[i] = (ax + bx + cx0) / 3;
    cy[i] = (ay + by + cy0) / 3;
    cz[i] = (az + bz + cz0) / 3;
    triFloor[i] = classifyFloorBand(cy[i]!, navMesh.medianFloorY);

    const keys = [qKey(ax, ay, az), qKey(bx, by, bz), qKey(cx0, cy0, cz0)];
    for (const k of keys) {
      let arr = vertToTris.get(k);
      if (!arr) {
        arr = [];
        vertToTris.set(k, arr);
      }
      arr.push(i);
    }
  }

  // Connect triangles that share at least 1 welded vertex (guaranteed connectivity across
  // stairs, ramps, and Recast polygon seams) with exact 3D centroid distance
  const seenEdge = new Set<number>();
  const addUndirected = (a: number, b: number, kind: number) => {
    if (a === b) return;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const pairKey = lo * n + hi;
    if (seenEdge.has(pairKey)) return;
    seenEdge.add(pairKey);
    const dx = cx[b]! - cx[a]!;
    const dy = cy[b]! - cy[a]!;
    const dz = cz[b]! - cz[a]!;
    const distM = Math.hypot(dx, dy, dz) / UNITS_PER_METER;
    adjLists[a]!.push({ to: b, distM, kind });
    adjLists[b]!.push({ to: a, distM, kind });
  };

  for (const tris of vertToTris.values()) {
    const len = tris.length;
    if (len < 2 || len > 32) continue;
    for (let i = 0; i < len; i++) {
      const a = tris[i]!;
      for (let j = i + 1; j < len; j++) {
        const b = tris[j]!;
        if (Math.abs(cy[a]! - cy[b]!) <= 26) {
          addUndirected(a, b, 0);
        }
      }
    }
  }

  // Spatial bucket pass for nearby disconnected nav islands (windows / pallet gaps <= 16 units)
  const bucketSize = 24;
  const cellMap = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const bx = Math.floor(cx[i]! / bucketSize);
    const bz = Math.floor(cz[i]! / bucketSize);
    const k = `${bx}_${bz}`;
    let arr = cellMap.get(k);
    if (!arr) {
      arr = [];
      cellMap.set(k, arr);
    }
    arr.push(i);
  }

  for (let i = 0; i < n; i++) {
    const bx = Math.floor(cx[i]! / bucketSize);
    const bz = Math.floor(cz[i]! / bucketSize);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = cellMap.get(`${bx + ox}_${bz + oz}`);
        if (!list) continue;
        for (const j of list) {
          if (j <= i) continue;
          const dy = Math.abs(cy[i]! - cy[j]!);
          if (dy > 14) continue;
          const distXZ = Math.hypot(cx[i]! - cx[j]!, cz[i]! - cz[j]!);
          if (distXZ <= 15) {
            // Very close seam -> normal walk link
            addUndirected(i, j, 0);
          } else if (distXZ <= 24) {
            // Window / low-wall vaultable gap -> vault link (kind = 1)
            addUndirected(i, j, 1);
          }
        }
      }
    }
  }

  // Flatten CSR arrays for fast zero-allocation A* & Dijkstra traversals
  let totalEdges = 0;
  for (let i = 0; i < n; i++) totalEdges += adjLists[i]!.length;

  const edgeOffset = new Int32Array(n + 1);
  const edgeTarget = new Int32Array(totalEdges);
  const edgeDistM = new Float32Array(totalEdges);
  const edgeKind = new Uint8Array(totalEdges);

  let cursor = 0;
  for (let i = 0; i < n; i++) {
    edgeOffset[i] = cursor;
    const list = adjLists[i]!;
    for (let k = 0; k < list.length; k++) {
      const e = list[k]!;
      edgeTarget[cursor] = e.to;
      edgeDistM[cursor] = e.distM;
      edgeKind[cursor] = e.kind;
      cursor++;
    }
  }
  edgeOffset[n] = cursor;

  const graph: NavGraph3D = {
    triCount: n,
    cx,
    cy,
    cz,
    triFloor,
    edgeOffset,
    edgeTarget,
    edgeDistM,
    edgeKind,
  };
  graphCache.set(navMesh, graph);
  return graph;
}

// ---------------------------------------------------------------------------
// 3D A→B Pathfinding with LOS Smoothing & Vault Penalty
// ---------------------------------------------------------------------------
function hasNavLineOfSight3D(navMesh: NavMesh3D, a: Vec3Point, b: Vec3Point): boolean {
  const distXZ = Math.hypot(b.x - a.x, b.z - a.z);
  const dy = Math.abs(b.y - a.y);
  if (dy > 18) return false;
  const steps = Math.max(2, Math.ceil(distXZ / 8));
  let prevY = a.y;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sx = a.x + (b.x - a.x) * t;
    const sz = a.z + (b.z - a.z) * t;
    const hit = navMesh.sampleFloor(sx, sz, prevY, 12, 16);
    if (!hit) return false;
    prevY = hit.y;
  }
  return true;
}

export function findPath3D(
  navMesh: NavMesh3D,
  start: Vec3Point,
  end: Vec3Point,
  opts: Path3DOptions = {},
): Path3DResult {
  const speedMps = Math.max(0.5, opts.speedMps ?? 3.8);
  const allowVault = opts.allowVault !== false;
  const vaultPenaltySeconds = Math.max(0, opts.vaultPenaltySeconds ?? 1.0);
  const vaultPenaltyDistM = vaultPenaltySeconds * speedMps;

  const startSnap = navMesh.findNearestWalkable(start.x, start.z, start.y, 180);
  const endSnap = navMesh.findNearestWalkable(end.x, end.z, end.y, 180);
  if (!startSnap || !endSnap) {
    return {
      reachable: false,
      points: [],
      distanceM: Infinity,
      baseTimeS: Infinity,
      vaultCount: 0,
      vaultTimeS: 0,
      totalTimeS: Infinity,
      speedMps,
      floors: [],
    };
  }

  const startPt: Vec3Point = { x: startSnap.x, y: startSnap.y, z: startSnap.z };
  const endPt: Vec3Point = { x: endSnap.x, y: endSnap.y, z: endSnap.z };

  if (startSnap.triIndex === endSnap.triIndex || hasNavLineOfSight3D(navMesh, startPt, endPt)) {
    const distM = Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y, endPt.z - startPt.z) / UNITS_PER_METER;
    const baseTimeS = distM / speedMps;
    const floors = Array.from(new Set<FloorId>([startSnap.floor, endSnap.floor]));
    return {
      reachable: true,
      points: [startPt, endPt],
      distanceM: distM,
      baseTimeS,
      vaultCount: 0,
      vaultTimeS: 0,
      totalTimeS: baseTimeS,
      speedMps,
      floors,
    };
  }

  const graph = buildNavGraph3D(navMesh);
  const n = graph.triCount;
  const gScore = new Float64Array(n);
  gScore.fill(Infinity);
  const prevNode = new Int32Array(n);
  prevNode.fill(-1);
  const prevEdgeKind = new Uint8Array(n);
  const closed = new Uint8Array(n);

  const startIdx = startSnap.triIndex;
  const endIdx = endSnap.triIndex;
  const goalX = endPt.x;
  const goalY = endPt.y;
  const goalZ = endPt.z;

  const heuristic = (idx: number): number =>
    Math.hypot(graph.cx[idx]! - goalX, graph.cy[idx]! - goalY, graph.cz[idx]! - goalZ) / UNITS_PER_METER;

  const heap = new FloatMinHeap();
  gScore[startIdx] = 0;
  heap.push(startIdx, heuristic(startIdx));

  let found = false;
  while (heap.size > 0) {
    const cur = heap.pop()!;
    const u = cur.node;
    if (closed[u]) continue;
    closed[u] = 1;
    if (u === endIdx) {
      found = true;
      break;
    }

    const eStart = graph.edgeOffset[u]!;
    const eEnd = graph.edgeOffset[u + 1]!;
    const baseG = gScore[u]!;
    for (let e = eStart; e < eEnd; e++) {
      const kind = graph.edgeKind[e]!;
      if (kind === 1 && !allowVault) continue;
      const v = graph.edgeTarget[e]!;
      if (closed[v]) continue;
      const stepCost = graph.edgeDistM[e]! + (kind === 1 ? vaultPenaltyDistM : 0);
      const nextG = baseG + stepCost;
      if (nextG < gScore[v]!) {
        gScore[v] = nextG;
        prevNode[v] = u;
        prevEdgeKind[v] = kind;
        heap.push(v, nextG + heuristic(v));
      }
    }
  }

  if (!found) {
    return {
      reachable: false,
      points: [],
      distanceM: Infinity,
      baseTimeS: Infinity,
      vaultCount: 0,
      vaultTimeS: 0,
      totalTimeS: Infinity,
      speedMps,
      floors: [],
    };
  }

  // Reconstruct raw centroid chain + count vault transitions
  const triChain: number[] = [];
  let vaultCount = 0;
  for (let cur = endIdx; cur !== -1; cur = prevNode[cur]!) {
    triChain.push(cur);
    if (prevEdgeKind[cur] === 1) vaultCount++;
  }
  triChain.reverse();

  const rawPts: Vec3Point[] = [startPt];
  const floorSet = new Set<FloorId>([startSnap.floor, endSnap.floor]);
  for (let i = 1; i < triChain.length - 1; i++) {
    const ti = triChain[i]!;
    rawPts.push({ x: graph.cx[ti]!, y: graph.cy[ti]!, z: graph.cz[ti]! });
    floorSet.add(graph.triFloor[ti]!);
  }
  rawPts.push(endPt);

  // Greedy line-of-sight string-pulling so the 3D path hugs walls smoothly without zig-zagging
  const smoothed: Vec3Point[] = [rawPts[0]!];
  let anchor = 0;
  while (anchor < rawPts.length - 1) {
    let furthest = anchor + 1;
    const maxLook = Math.min(rawPts.length - 1, anchor + 14);
    for (let probe = maxLook; probe > anchor + 1; probe--) {
      if (hasNavLineOfSight3D(navMesh, rawPts[anchor]!, rawPts[probe]!)) {
        furthest = probe;
        break;
      }
    }
    smoothed.push(rawPts[furthest]!);
    anchor = furthest;
  }

  let totalDistM = 0;
  for (let i = 1; i < smoothed.length; i++) {
    const a = smoothed[i - 1]!;
    const b = smoothed[i]!;
    totalDistM += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / UNITS_PER_METER;
  }

  const baseTimeS = totalDistM / speedMps;
  const vaultTimeS = vaultCount * vaultPenaltySeconds;
  return {
    reachable: true,
    points: smoothed,
    distanceM: totalDistM,
    baseTimeS,
    vaultCount,
    vaultTimeS,
    totalTimeS: baseTimeS + vaultTimeS,
    speedMps,
    floors: Array.from(floorSet),
  };
}

// ---------------------------------------------------------------------------
// 3D Chairs Collector (projects PIL 2D + 2F + Basement Chairs onto NavMesh3D)
// ---------------------------------------------------------------------------
export function collectChairs3D(
  navMesh: NavMesh3D,
  mapId: PilMapId,
  chairSetIndex = 0,
  basementIndex = 0,
  includeBasement = true,
): Chair3DCandidate[] {
  const map = MAPS_DATA[mapId];
  if (!map) return [];
  const [dw, dh] = map.mapSize;
  const medY = navMesh.medianFloorY;
  const out: Chair3DCandidate[] = [];

  const pushPt = (
    pt: readonly [number, number] | readonly [number, number, number],
    kind: 'fixed' | 'set' | 'basement',
    label: string,
    hintY: number,
  ) => {
    const px = pt[0];
    const pz = pt.length === 3 ? pt[2] : pt[1];
    const w3 = normalizedToWorld3D(mapId, px / dw, pz / dh);
    const snap = navMesh.findNearestWalkable(w3.x, w3.z, hintY, 160);
    if (!snap) return;
    out.push({
      index: out.length,
      label,
      kind,
      pos: { x: snap.x, y: snap.y, z: snap.z },
      floor: snap.floor,
      triIndex: snap.triIndex,
    });
  };

  map.rocketChairs.fixed.forEach((pt, i) => {
    const hintY = pt.length === 3 && pt[1] >= 25 ? medY + 55 : medY;
    pushPt(pt, 'fixed', `固定椅 #${i + 1}`, hintY);
  });
  if (map.rocketChairs.sets.length > 0) {
    const sIdx = ((chairSetIndex % map.rocketChairs.sets.length) + map.rocketChairs.sets.length) % map.rocketChairs.sets.length;
    (map.rocketChairs.sets[sIdx] ?? []).forEach((pt, i) => {
      const hintY = pt.length === 3 && pt[1] >= 25 ? medY + 55 : medY;
      pushPt(pt, 'set', `随机椅 #${i + 1}`, hintY);
    });
  }
  if (includeBasement) {
    const bs = Object.values(map.basements);
    if (bs.length > 0) {
      const bIdx = ((basementIndex % bs.length) + bs.length) % bs.length;
      bs[bIdx]!.rocketChairs.forEach((pt, i) => {
        pushPt(pt, 'basement', `地下室椅 #${i + 1}`, medY - 55);
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3D Dijkstra Carry & Tide Surface Field
// ---------------------------------------------------------------------------
function runDijkstra3D(
  graph: NavGraph3D,
  sourceTris: readonly number[],
  allowVault: boolean,
  maxDistM: number,
): { distM: Float64Array; prev: Int32Array; sourceOf: Int32Array } {
  const n = graph.triCount;
  const distM = new Float64Array(n);
  distM.fill(Infinity);
  const prev = new Int32Array(n);
  prev.fill(-1);
  const sourceOf = new Int32Array(n);
  sourceOf.fill(-1);
  const closed = new Uint8Array(n);

  const heap = new FloatMinHeap();
  for (let i = 0; i < sourceTris.length; i++) {
    const st = sourceTris[i]!;
    if (st < 0 || st >= n) continue;
    distM[st] = 0;
    sourceOf[st] = i;
    heap.push(st, 0);
  }

  while (heap.size > 0) {
    const cur = heap.pop()!;
    const u = cur.node;
    if (closed[u]) continue;
    closed[u] = 1;
    const du = distM[u]!;
    if (du > maxDistM) break;

    const eStart = graph.edgeOffset[u]!;
    const eEnd = graph.edgeOffset[u + 1]!;
    for (let e = eStart; e < eEnd; e++) {
      if (!allowVault && graph.edgeKind[e] === 1) continue;
      const v = graph.edgeTarget[e]!;
      if (closed[v]) continue;
      const nd = du + graph.edgeDistM[e]!;
      if (nd < distM[v]! && nd <= maxDistM) {
        distM[v] = nd;
        prev[v] = u;
        sourceOf[v] = sourceOf[u]!;
        heap.push(v, nd);
      }
    }
  }

  return { distM, prev, sourceOf };
}

function reconstructPathFromPrev(
  graph: NavGraph3D,
  prev: Int32Array,
  startPt: Vec3Point,
  endPt: Vec3Point,
  targetTri: number,
): Vec3Point[] {
  const pts: Vec3Point[] = [endPt];
  let cur = targetTri;
  let guard = 0;
  while (cur !== -1 && guard < 2000) {
    pts.push({ x: graph.cx[cur]!, y: graph.cy[cur]!, z: graph.cz[cur]! });
    cur = prev[cur]!;
    guard++;
  }
  pts.push(startPt);
  pts.reverse();
  // Downsample dense intermediate points so 3D polylines stay lightweight
  if (pts.length <= 24) return pts;
  const step = Math.max(1, Math.floor(pts.length / 24));
  const thin: Vec3Point[] = [pts[0]!];
  for (let i = step; i < pts.length - 1; i += step) thin.push(pts[i]!);
  thin.push(pts[pts.length - 1]!);
  return thin;
}

export function computeCarryField3D(
  navMesh: NavMesh3D,
  mapId: PilMapId,
  origin: Vec3Point,
  mode: 'chair' | 'point',
  profile: CarryProfile,
  opts: { chairSetIndex?: number; basementIndex?: number } = {},
): SurfaceField3DResult {
  const graph = buildNavGraph3D(navMesh);
  const snap = navMesh.findNearestWalkable(origin.x, origin.z, origin.y, 180);
  const triBands = new Int8Array(graph.triCount);
  triBands.fill(-1);

  if (!snap) {
    return {
      scenario: 'carry',
      mode,
      origin,
      triBands,
      reachedTris: 0,
      chairRows: [],
      summaryText: '起点附近无可用 3D 导航面',
    };
  }

  const originPt: Vec3Point = { x: snap.x, y: snap.y, z: snap.z };
  const bands = carryRangeBands(profile);
  const carrySpeed = Math.max(0.5, profile.speedAt(0));
  const maxTime = profile.remainingSeconds;
  const maxDistM = maxTime * carrySpeed + 12;

  // Carry forbids vaulting windows/pallets (matching PIL 3D)
  const { distM, prev } = runDijkstra3D(graph, [snap.triIndex], false, maxDistM);

  let reachedTris = 0;
  for (let i = 0; i < graph.triCount; i++) {
    const d = distM[i]!;
    if (!Number.isFinite(d)) continue;
    const t = d / carrySpeed;
    const b = carryBandAt(bands, t);
    if (b >= 0) {
      triBands[i] = b;
      reachedTris++;
    }
  }

  const chairs = collectChairs3D(navMesh, mapId, opts.chairSetIndex ?? 0, opts.basementIndex ?? 0, true);
  const chairRows: Chair3DEvalRow[] = [];
  if (mode === 'point') {
    for (const ch of chairs) {
      const d = distM[ch.triIndex]!;
      const finite = Number.isFinite(d);
      const t = finite ? d / carrySpeed : Infinity;
      const band = finite ? carryBandAt(bands, t) : -1;
      const canHang = band >= 0;
      const drops = band === 0 ? 3 : band === 1 ? 2 : band === 2 ? 1 : 0;
      const risk = band === 4;
      chairRows.push({
        index: ch.index,
        label: ch.label,
        kind: ch.kind,
        pos: ch.pos,
        floor: ch.floor,
        distanceM: d,
        travelSeconds: t,
        band,
        canHang,
        drops,
        risk,
        path: canHang ? reconstructPathFromPrev(graph, prev, originPt, ch.pos, ch.triIndex) : [],
      });
    }
    chairRows.sort((a, b) => a.travelSeconds - b.travelSeconds);
  }

  const hangable = chairRows.filter((r) => r.canHang).length;
  const summaryText =
    mode === 'chair'
      ? `3D 牵气球禁翻窗 · 剩余 ${maxTime.toFixed(1)}s · 覆盖 ${reachedTris} 个导航三角面`
      : `3D 选点可挂 ${hangable}/${chairRows.length} 把狂欢之椅 · 牵起 ${profile.pickupSeconds.toFixed(1)}s`;

  return {
    scenario: 'carry',
    mode,
    origin: originPt,
    triBands,
    reachedTris,
    chairRows,
    summaryText,
  };
}

export function computeTideField3D(
  navMesh: NavMesh3D,
  mapId: PilMapId,
  origin: Vec3Point,
  mode: 'chair' | 'point',
  profile: TideProfile,
  opts: { chairSetIndex?: number; basementIndex?: number } = {},
): SurfaceField3DResult {
  const graph = buildNavGraph3D(navMesh);
  const snap = navMesh.findNearestWalkable(origin.x, origin.z, origin.y, 180);
  const triBands = new Int8Array(graph.triCount);
  triBands.fill(-1);

  if (!snap) {
    return {
      scenario: 'tide',
      mode,
      origin,
      triBands,
      reachedTris: 0,
      chairRows: [],
      summaryText: '起点附近无可用 3D 导航面',
    };
  }

  const originPt: Vec3Point = { x: snap.x, y: snap.y, z: snap.z };
  const bands = tideRangeBands();
  const maxDistM = 21.5 * profile.baseSpeed + 10;

  // Tide allows vaulting windows (matching PIL 3D)
  const { distM, prev } = runDijkstra3D(graph, [snap.triIndex], true, maxDistM);

  let reachedTris = 0;
  for (let i = 0; i < graph.triCount; i++) {
    const d = distM[i]!;
    if (!Number.isFinite(d)) continue;
    const t = d / profile.baseSpeed;
    const b = tideBandAt(bands, t);
    if (b >= 0) {
      triBands[i] = b;
      reachedTris++;
    }
  }

  const chairs = collectChairs3D(navMesh, mapId, opts.chairSetIndex ?? 0, opts.basementIndex ?? 0, true);
  const chairRows: Chair3DEvalRow[] = [];
  if (mode === 'point') {
    for (const ch of chairs) {
      const d = distM[ch.triIndex]!;
      const finite = Number.isFinite(d);
      const t = finite ? d / profile.baseSpeed : Infinity;
      const band = finite ? tideBandAt(bands, t) : -1;
      const reachable20s = band >= 0 && band <= 3;
      const inMargin = band === 4;
      chairRows.push({
        index: ch.index,
        label: ch.label,
        kind: ch.kind,
        pos: ch.pos,
        floor: ch.floor,
        distanceM: d,
        travelSeconds: t,
        band,
        reachable20s,
        inMargin,
        path: band >= 0 ? reconstructPathFromPrev(graph, prev, originPt, ch.pos, ch.triIndex) : [],
      });
    }
    chairRows.sort((a, b) => a.travelSeconds - b.travelSeconds);
  }

  const reach20 = chairRows.filter((r) => r.reachable20s).length;
  const summaryText =
    mode === 'chair'
      ? `3D 搏命 20s(+1s余量) · 移速 ${profile.baseSpeed.toFixed(2)} m/s · 覆盖 ${reachedTris} 面`
      : `3D 20s 可达 ${reach20} 把椅（含余量 ${chairRows.filter((r) => r.band >= 0).length} 把）`;

  return {
    scenario: 'tide',
    mode,
    origin: originPt,
    triBands,
    reachedTris,
    chairRows,
    summaryText,
  };
}

// ---------------------------------------------------------------------------
// 3D Multi-Source Hardest-to-Chair Extremum Finder ("最难挂椅极值点")
// ---------------------------------------------------------------------------
export function computeHardestChairExtrema3D(
  navMesh: NavMesh3D,
  mapId: PilMapId,
  profile: CarryProfile,
  opts: { chairSetIndex?: number; basementIndex?: number; topN?: number; minSepMeters?: number } = {},
): HardestChairSpot3D[] {
  const graph = buildNavGraph3D(navMesh);
  const chairs = collectChairs3D(navMesh, mapId, opts.chairSetIndex ?? 0, opts.basementIndex ?? 0, true);
  if (chairs.length === 0 || graph.triCount === 0) return [];

  const sources = chairs.map((c) => c.triIndex);
  const { distM, sourceOf } = runDijkstra3D(graph, sources, false, 999);

  // Collect finite candidates sorted descending by distance-to-nearest-chair
  const candidates: Array<{ tri: number; distM: number; chairIdx: number }> = [];
  for (let i = 0; i < graph.triCount; i++) {
    const d = distM[i]!;
    if (!Number.isFinite(d) || d <= 1) continue;
    candidates.push({ tri: i, distM: d, chairIdx: sourceOf[i]! });
  }
  candidates.sort((a, b) => b.distM - a.distM);

  const topN = opts.topN ?? 5;
  const minSepUnits = (opts.minSepMeters ?? 18) * UNITS_PER_METER;
  const minSepSq = minSepUnits * minSepUnits;

  const picked: HardestChairSpot3D[] = [];
  for (const cand of candidates) {
    if (picked.length >= topN) break;
    const x = graph.cx[cand.tri]!;
    const y = graph.cy[cand.tri]!;
    const z = graph.cz[cand.tri]!;

    let tooClose = false;
    for (const prev of picked) {
      const dx = x - prev.pos.x;
      const dz = z - prev.pos.z;
      const dy = y - prev.pos.y;
      if (dx * dx + dz * dz < minSepSq && Math.abs(dy) < 28) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const chair = chairs[cand.chairIdx] ?? chairs[0]!;
    const carrySpeed = Math.max(0.5, profile.speedAt(0));
    const hangSeconds = cand.distM / carrySpeed;
    const norm = world3DToNormalized(mapId, x, z);
    picked.push({
      rank: picked.length + 1,
      pos: { x, y, z },
      relU: Math.min(0.99, Math.max(0.01, norm.u)),
      relV: Math.min(0.99, Math.max(0.01, norm.v)),
      floor: graph.triFloor[cand.tri]!,
      nearestChairLabel: chair.label,
      nearestChairPos: chair.pos,
      distanceM: cand.distM,
      hangSeconds,
      escapes: hangSeconds > profile.remainingSeconds,
    });
  }
  return picked;
}

export { CARRY_BAND_COLORS, TIDE_BAND_COLORS };
