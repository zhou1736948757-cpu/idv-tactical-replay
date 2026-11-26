/**
 * Pure TypeScript 3D Navigation Mesh Spatial Hash Grid, Multi-Story Floor Sampler,
 * Nearest-Walkable Snapper, and Smooth Wall-Sliding Resolver.
 *
 * Zero DOM dependencies: builds identically from raw `<scene>.nav.glb` binary buffers
 * (in Node/Vitest or browser `fetch`) OR from a loaded Three.js `Object3D` / `Group`.
 */
import type { FloorId } from '@idv/replay-renderer';

export interface Vec3Point {
  x: number;
  y: number;
  z: number;
}

export interface NavBounds3D {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface NavFloorSample {
  y: number;
  normal: [number, number, number];
  triIndex: number;
  floor: FloorId;
}

export interface NavNearestWalkable extends NavFloorSample {
  x: number;
  z: number;
  distanceXZ: number;
}

export interface HorizontalStepOptions {
  maxStepUp?: number;
  maxStepDown?: number;
  maxSubStep?: number;
}

export interface HorizontalStepResult {
  x: number;
  y: number;
  z: number;
  movedXZ: number;
  blocked: boolean;
  slid: boolean;
  floor: FloorId;
  normal: [number, number, number];
}

/** Structural subset of a Three.js Object3D/Mesh so nav3d stays decoupled from WebGL runtime. */
export interface MeshLikeNode {
  isMesh?: boolean;
  geometry?: {
    attributes?: {
      position?: {
        array: ArrayLike<number>;
        count: number;
        itemSize?: number;
      };
    };
    index?: {
      array: ArrayLike<number>;
      count: number;
    } | null;
  };
  matrixWorld?: { elements: ArrayLike<number> };
  updateWorldMatrix?: (updateParents: boolean, updateChildren: boolean) => void;
  traverse?: (cb: (node: MeshLikeNode) => void) => void;
  children?: readonly MeshLikeNode[];
}

export function classifyFloorBand(y: number, medianFloorY = 0): FloorId {
  const relY = y - medianFloorY;
  if (relY < -26) return 'B1';
  if (relY >= 32) return '2F';
  return '1F';
}

const DEFAULT_CELL_SIZE = 64;
const BARY_EPS = 1.5e-4;
const SLIDE_ANGLES_RAD = [
  (25 * Math.PI) / 180,
  (-25 * Math.PI) / 180,
  (45 * Math.PI) / 180,
  (-45 * Math.PI) / 180,
  (65 * Math.PI) / 180,
  (-65 * Math.PI) / 180,
  (82 * Math.PI) / 180,
  (-82 * Math.PI) / 180,
];

function closestPointOnSegmentXZ(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): [number, number, number] {
  const abx = bx - ax;
  const abz = bz - az;
  const denom = abx * abx + abz * abz;
  if (denom <= 1e-12) return [ax, az, 0];
  let t = ((px - ax) * abx + (pz - az) * abz) / denom;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return [ax + abx * t, az + abz * t, t];
}

export class NavMesh3D {
  readonly triangleCount: number;
  readonly bounds: NavBounds3D;
  readonly medianFloorY: number;
  readonly cellSize: number;

  private readonly ax: Float32Array;
  private readonly ay: Float32Array;
  private readonly az: Float32Array;
  private readonly bx: Float32Array;
  private readonly by: Float32Array;
  private readonly bz: Float32Array;
  private readonly cx: Float32Array;
  private readonly cy: Float32Array;
  private readonly cz: Float32Array;
  private readonly nx: Float32Array;
  private readonly ny: Float32Array;
  private readonly nz: Float32Array;
  private readonly invDenom: Float64Array;
  private readonly tMinX: Float32Array;
  private readonly tMaxX: Float32Array;
  private readonly tMinZ: Float32Array;
  private readonly tMaxZ: Float32Array;

  private readonly gridCols: number;
  private readonly gridRows: number;
  private readonly cells: Array<Int32Array | null>;

  /** Raw triangle positions `(triangleCount * 9)` useful for building wireframe debug geometry. */
  readonly rawTrianglePositions: Float32Array;

  constructor(triPositions: Float32Array, cellSize = DEFAULT_CELL_SIZE) {
    const rawCount = Math.floor(triPositions.length / 9);
    const validIndices: number[] = [];

    for (let i = 0; i < rawCount; i++) {
      const o = i * 9;
      const ax = triPositions[o];
      const ay = triPositions[o + 1];
      const az = triPositions[o + 2];
      const bx = triPositions[o + 3];
      const by = triPositions[o + 4];
      const bz = triPositions[o + 5];
      const cx = triPositions[o + 6];
      const cy = triPositions[o + 7];
      const cz = triPositions[o + 8];

      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;

      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const nLen = Math.hypot(nx, ny, nz);
      const denomXZ = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (nLen > 1e-6 && Math.abs(ny / nLen) >= 0.25 && Math.abs(denomXZ) > 1e-5) {
        validIndices.push(i);
      }
    }

    const n = validIndices.length;
    this.triangleCount = n;
    this.cellSize = Math.max(8, cellSize);

    this.ax = new Float32Array(n);
    this.ay = new Float32Array(n);
    this.az = new Float32Array(n);
    this.bx = new Float32Array(n);
    this.by = new Float32Array(n);
    this.bz = new Float32Array(n);
    this.cx = new Float32Array(n);
    this.cy = new Float32Array(n);
    this.cz = new Float32Array(n);
    this.nx = new Float32Array(n);
    this.ny = new Float32Array(n);
    this.nz = new Float32Array(n);
    this.invDenom = new Float64Array(n);
    this.tMinX = new Float32Array(n);
    this.tMaxX = new Float32Array(n);
    this.tMinZ = new Float32Array(n);
    this.tMaxZ = new Float32Array(n);
    this.rawTrianglePositions = new Float32Array(n * 9);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    const weightedY: Array<{ y: number; area: number }> = [];

    for (let k = 0; k < n; k++) {
      const o = validIndices[k] * 9;
      const ax = triPositions[o];
      const ay = triPositions[o + 1];
      const az = triPositions[o + 2];
      const bx = triPositions[o + 3];
      const by = triPositions[o + 4];
      const bz = triPositions[o + 5];
      const cx = triPositions[o + 6];
      const cy = triPositions[o + 7];
      const cz = triPositions[o + 8];

      this.ax[k] = ax;
      this.ay[k] = ay;
      this.az[k] = az;
      this.bx[k] = bx;
      this.by[k] = by;
      this.bz[k] = bz;
      this.cx[k] = cx;
      this.cy[k] = cy;
      this.cz[k] = cz;

      const ro = k * 9;
      this.rawTrianglePositions[ro] = ax;
      this.rawTrianglePositions[ro + 1] = ay;
      this.rawTrianglePositions[ro + 2] = az;
      this.rawTrianglePositions[ro + 3] = bx;
      this.rawTrianglePositions[ro + 4] = by;
      this.rawTrianglePositions[ro + 5] = bz;
      this.rawTrianglePositions[ro + 6] = cx;
      this.rawTrianglePositions[ro + 7] = cy;
      this.rawTrianglePositions[ro + 8] = cz;

      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      this.nx[k] = nx / nLen;
      this.ny[k] = ny / nLen;
      this.nz[k] = nz / nLen;

      const denomXZ = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      this.invDenom[k] = 1.0 / denomXZ;

      const lx = Math.min(ax, bx, cx);
      const hx = Math.max(ax, bx, cx);
      const ly = Math.min(ay, by, cy);
      const hy = Math.max(ay, by, cy);
      const lz = Math.min(az, bz, cz);
      const hz = Math.max(az, bz, cz);

      this.tMinX[k] = lx;
      this.tMaxX[k] = hx;
      this.tMinZ[k] = lz;
      this.tMaxZ[k] = hz;

      if (lx < minX) minX = lx;
      if (hx > maxX) maxX = hx;
      if (ly < minY) minY = ly;
      if (hy > maxY) maxY = hy;
      if (lz < minZ) minZ = lz;
      if (hz > maxZ) maxZ = hz;

      weightedY.push({
        y: (ay + by + cy) / 3,
        area: 0.5 * Math.abs(denomXZ),
      });
    }

    if (n === 0) {
      this.bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
      this.medianFloorY = 0;
      this.gridCols = 1;
      this.gridRows = 1;
      this.cells = [null];
      return;
    }

    this.bounds = { minX, maxX, minY, maxY, minZ, maxZ };

    weightedY.sort((a, b) => a.y - b.y);
    const totalArea = weightedY.reduce((s, item) => s + item.area, 0);
    let acc = 0;
    let medY = weightedY[Math.floor(weightedY.length / 2)].y;
    for (const item of weightedY) {
      acc += item.area;
      if (acc >= totalArea * 0.5) {
        medY = item.y;
        break;
      }
    }
    this.medianFloorY = medY;

    this.gridCols = Math.max(1, Math.ceil((maxX - minX) / this.cellSize) + 1);
    this.gridRows = Math.max(1, Math.ceil((maxZ - minZ) / this.cellSize) + 1);
    const buckets: Array<number[] | undefined> = new Array(this.gridCols * this.gridRows);

    for (let k = 0; k < n; k++) {
      const c0 = this.colOf(this.tMinX[k]);
      const c1 = this.colOf(this.tMaxX[k]);
      const r0 = this.rowOf(this.tMinZ[k]);
      const r1 = this.rowOf(this.tMaxZ[k]);
      for (let r = r0; r <= r1; r++) {
        const rowOff = r * this.gridCols;
        for (let c = c0; c <= c1; c++) {
          const idx = rowOff + c;
          let bucket = buckets[idx];
          if (!bucket) {
            bucket = [];
            buckets[idx] = bucket;
          }
          bucket.push(k);
        }
      }
    }

    this.cells = new Array(this.gridCols * this.gridRows).fill(null);
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (b && b.length > 0) {
        this.cells[i] = Int32Array.from(b);
      }
    }
  }

  private colOf(x: number): number {
    const c = Math.floor((x - this.bounds.minX) / this.cellSize);
    return c < 0 ? 0 : c >= this.gridCols ? this.gridCols - 1 : c;
  }

  private rowOf(z: number): number {
    const r = Math.floor((z - this.bounds.minZ) / this.cellSize);
    return r < 0 ? 0 : r >= this.gridRows ? this.gridRows - 1 : r;
  }

  /**
   * Samples walkable floor directly at `(x, z)` using XZ barycentric coordinates.
   * When `refY` is provided, selects the floor closest to `refY` within `[-maxStepDown, +maxStepUp]`.
   */
  sampleFloor(
    x: number,
    z: number,
    refY?: number,
    maxStepUp = 26,
    maxStepDown = 70,
  ): NavFloorSample | null {
    if (this.triangleCount === 0) return null;
    if (
      x < this.bounds.minX - 0.05 ||
      x > this.bounds.maxX + 0.05 ||
      z < this.bounds.minZ - 0.05 ||
      z > this.bounds.maxZ + 0.05
    ) {
      return null;
    }

    const c = this.colOf(x);
    const r = this.rowOf(z);
    const list = this.cells[r * this.gridCols + c];
    if (!list) return null;

    const hasRef = refY !== undefined && Number.isFinite(refY);
    const targetY = hasRef ? (refY as number) : this.medianFloorY;

    let bestTri = -1;
    let bestY = 0;
    let bestDist = Infinity;

    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (
        x < this.tMinX[k] - 0.02 ||
        x > this.tMaxX[k] + 0.02 ||
        z < this.tMinZ[k] - 0.02 ||
        z > this.tMaxZ[k] + 0.02
      ) {
        continue;
      }

      const cx = this.cx[k];
      const cz = this.cz[k];
      const bz = this.bz[k];
      const bx = this.bx[k];
      const ax = this.ax[k];
      const az = this.az[k];
      const inv = this.invDenom[k];

      const dx = x - cx;
      const dz = z - cz;
      const u = ((bz - cz) * dx + (cx - bx) * dz) * inv;
      if (u < -BARY_EPS || u > 1 + BARY_EPS) continue;
      const v = ((cz - az) * dx + (ax - cx) * dz) * inv;
      if (v < -BARY_EPS || v > 1 + BARY_EPS) continue;
      const w = 1 - u - v;
      if (w < -BARY_EPS || w > 1 + BARY_EPS) continue;

      const cu = u < 0 ? 0 : u > 1 ? 1 : u;
      const cv = v < 0 ? 0 : v > 1 ? 1 : v;
      const cw = w < 0 ? 0 : w > 1 ? 1 : w;
      const sum = cu + cv + cw || 1;
      const y = (cu * this.ay[k] + cv * this.by[k] + cw * this.cy[k]) / sum;

      if (hasRef) {
        const dy = y - targetY;
        if (dy > maxStepUp || dy < -maxStepDown) continue;
      }

      const dist = Math.abs(y - targetY);
      if (dist < bestDist) {
        bestDist = dist;
        bestY = y;
        bestTri = k;
      }
    }

    if (bestTri === -1) return null;
    return {
      y: bestY,
      normal: [this.nx[bestTri], this.ny[bestTri], this.nz[bestTri]],
      triIndex: bestTri,
      floor: classifyFloorBand(bestY, this.medianFloorY),
    };
  }

  /**
   * Snaps an arbitrary `(x, z)` spawn or click point to the nearest walkable navmesh point
   * within `maxRadius`, biasing toward `refY` (or `medianFloorY` when `refY` is omitted).
   */
  findNearestWalkable(
    x: number,
    z: number,
    refY?: number,
    maxRadius = 280,
  ): NavNearestWalkable | null {
    if (this.triangleCount === 0) return null;

    const direct =
      refY !== undefined
        ? this.sampleFloor(x, z, refY, 80, 120) ?? this.sampleFloor(x, z)
        : this.sampleFloor(x, z);
    if (direct) {
      return {
        x,
        y: direct.y,
        z,
        normal: direct.normal,
        triIndex: direct.triIndex,
        floor: direct.floor,
        distanceXZ: 0,
      };
    }

    const hasRef = refY !== undefined && Number.isFinite(refY);
    const targetY = hasRef ? (refY as number) : this.medianFloorY;
    const yWeight = hasRef ? 0.35 : 0.12;

    const cCenter = Math.floor((x - this.bounds.minX) / this.cellSize);
    const rCenter = Math.floor((z - this.bounds.minZ) / this.cellSize);
    const maxRing = Math.ceil(maxRadius / this.cellSize) + 1;

    const seen = new Uint8Array(this.triangleCount);
    let bestTri = -1;
    let bestX = x;
    let bestY = targetY;
    let bestZ = z;
    let bestDistXZ = Infinity;
    let bestScore = Infinity;

    for (let ring = 0; ring <= maxRing; ring++) {
      // Early exit once the minimum possible distance in this ring exceeds bestScore
      const minRingDist = Math.max(0, (ring - 1) * this.cellSize);
      if (bestTri !== -1 && minRingDist > bestScore) break;

      const r0 = Math.max(0, rCenter - ring);
      const r1 = Math.min(this.gridRows - 1, rCenter + ring);
      const c0 = Math.max(0, cCenter - ring);
      const c1 = Math.min(this.gridCols - 1, cCenter + ring);

      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (
            ring > 0 &&
            r > rCenter - ring &&
            r < rCenter + ring &&
            c > cCenter - ring &&
            c < cCenter + ring
          ) {
            continue;
          }
          const list = this.cells[r * this.gridCols + c];
          if (!list) continue;

          for (let i = 0; i < list.length; i++) {
            const k = list[i];
            if (seen[k]) continue;
            seen[k] = 1;

            const ax = this.ax[k];
            const ay = this.ay[k];
            const az = this.az[k];
            const bx = this.bx[k];
            const by = this.by[k];
            const bz = this.bz[k];
            const cx = this.cx[k];
            const cy = this.cy[k];
            const cz = this.cz[k];

            // Closest point among the 3 edges (since direct interior hit was already checked)
            const [p0x, p0z, t0] = closestPointOnSegmentXZ(x, z, ax, az, bx, bz);
            const d0 = Math.hypot(x - p0x, z - p0z);
            let px = p0x;
            let pz = p0z;
            let py = ay + (by - ay) * t0;
            let dMin = d0;

            const [p1x, p1z, t1] = closestPointOnSegmentXZ(x, z, bx, bz, cx, cz);
            const d1 = Math.hypot(x - p1x, z - p1z);
            if (d1 < dMin) {
              dMin = d1;
              px = p1x;
              pz = p1z;
              py = by + (cy - by) * t1;
            }

            const [p2x, p2z, t2] = closestPointOnSegmentXZ(x, z, cx, cz, ax, az);
            const d2 = Math.hypot(x - p2x, z - p2z);
            if (d2 < dMin) {
              dMin = d2;
              px = p2x;
              pz = p2z;
              py = cy + (ay - cy) * t2;
            }

            if (dMin > maxRadius) continue;

            // Nudge 4% toward the triangle centroid so subsequent sampleFloor(px, pz) lands cleanly inside
            const centX = (ax + bx + cx) / 3;
            const centY = (ay + by + cy) / 3;
            const centZ = (az + bz + cz) / 3;
            const nxPos = px + (centX - px) * 0.04;
            const nyPos = py + (centY - py) * 0.04;
            const nzPos = pz + (centZ - pz) * 0.04;

            const score = dMin + Math.abs(nyPos - targetY) * yWeight;
            if (score < bestScore) {
              bestScore = score;
              bestTri = k;
              bestX = nxPos;
              bestY = nyPos;
              bestZ = nzPos;
              bestDistXZ = Math.hypot(x - nxPos, z - nzPos);
            }
          }
        }
      }
    }

    if (bestTri === -1) return null;
    const exact = this.sampleFloor(bestX, bestZ, bestY, 40, 40);
    const finalY = exact ? exact.y : bestY;
    return {
      x: bestX,
      y: finalY,
      z: bestZ,
      normal: exact ? exact.normal : [this.nx[bestTri], this.ny[bestTri], this.nz[bestTri]],
      triIndex: exact ? exact.triIndex : bestTri,
      floor: classifyFloorBand(finalY, this.medianFloorY),
      distanceXZ: bestDistXZ,
    };
  }

  /**
   * Advances `pos` horizontally by `(dx, dz)` along the walkable navmesh, climbing stairs/ramps
   * within `[maxStepDown, maxStepUp]` and smoothly sliding along wall/obstacle boundaries.
   */
  resolveHorizontalStep(
    pos: Vec3Point,
    dx: number,
    dz: number,
    opts: HorizontalStepOptions = {},
  ): HorizontalStepResult {
    const maxStepUp = opts.maxStepUp ?? 26;
    const maxStepDown = opts.maxStepDown ?? 70;
    const maxSubStep = opts.maxSubStep ?? 8;

    let curX = pos.x;
    let curY = pos.y;
    let curZ = pos.z;
    let curNormal: [number, number, number] = [0, 1, 0];

    const startFloor = this.sampleFloor(curX, curZ, curY, maxStepUp, maxStepDown);
    if (startFloor) {
      curY = startFloor.y;
      curNormal = startFloor.normal;
    }

    const totalLen = Math.hypot(dx, dz);
    if (totalLen < 1e-7 || this.triangleCount === 0) {
      return {
        x: curX,
        y: curY,
        z: curZ,
        movedXZ: 0,
        blocked: false,
        slid: false,
        floor: classifyFloorBand(curY, this.medianFloorY),
        normal: curNormal,
      };
    }

    const steps = Math.max(1, Math.ceil(totalLen / maxSubStep));
    const subDx = dx / steps;
    const subDz = dz / steps;

    let blockedAny = false;
    let slidAny = false;

    const tryStep = (tx: number, tz: number, checkMid: boolean): NavFloorSample | null => {
      if (checkMid) {
        const mid = this.sampleFloor(
          (curX + tx) * 0.5,
          (curZ + tz) * 0.5,
          curY,
          maxStepUp,
          maxStepDown,
        );
        if (!mid) return null;
      }
      return this.sampleFloor(tx, tz, curY, maxStepUp, maxStepDown);
    };

    for (let s = 0; s < steps; s++) {
      const stepLen = Math.hypot(subDx, subDz);
      const checkMid = stepLen > 3.5;

      // 1. Full vector attempt
      const fullHit = tryStep(curX + subDx, curZ + subDz, checkMid);
      if (fullHit) {
        curX += subDx;
        curZ += subDz;
        curY = fullHit.y;
        curNormal = fullHit.normal;
        continue;
      }

      blockedAny = true;

      // 2. Wall-sliding candidates: X-only, Z-only, and angled tangent projections
      let bestHit: NavFloorSample | null = null;
      let bestCandX = curX;
      let bestCandZ = curZ;
      let bestProj = 0;

      const considerCandidate = (candDx: number, candDz: number) => {
        const proj = (candDx * subDx + candDz * subDz) / stepLen;
        if (proj <= bestProj + 1e-6) return;
        const hit = tryStep(curX + candDx, curZ + candDz, Math.hypot(candDx, candDz) > 3.5);
        if (hit) {
          bestProj = proj;
          bestHit = hit;
          bestCandX = curX + candDx;
          bestCandZ = curZ + candDz;
        }
      };

      if (Math.abs(subDx) > 1e-6) considerCandidate(subDx, 0);
      if (Math.abs(subDz) > 1e-6) considerCandidate(0, subDz);

      const baseAngle = Math.atan2(subDz, subDx);
      for (let a = 0; a < SLIDE_ANGLES_RAD.length; a++) {
        const offset = SLIDE_ANGLES_RAD[a];
        const scale = Math.cos(offset);
        if (scale <= 0.05) continue;
        const ang = baseAngle + offset;
        const mag = stepLen * scale;
        considerCandidate(Math.cos(ang) * mag, Math.sin(ang) * mag);
      }

      if (bestHit) {
        curX = bestCandX;
        curZ = bestCandZ;
        curY = (bestHit as NavFloorSample).y;
        curNormal = (bestHit as NavFloorSample).normal;
        slidAny = true;
        continue;
      }

      // 3. Fractional approach right up to a perpendicular wall edge
      let approached = false;
      for (const frac of [0.5, 0.25]) {
        const fHit = tryStep(curX + subDx * frac, curZ + subDz * frac, false);
        if (fHit) {
          curX += subDx * frac;
          curZ += subDz * frac;
          curY = fHit.y;
          curNormal = fHit.normal;
          approached = true;
          break;
        }
      }
      if (!approached) break;
    }

    const movedXZ = Math.hypot(curX - pos.x, curZ - pos.z);
    return {
      x: curX,
      y: curY,
      z: curZ,
      movedXZ,
      blocked: blockedAny,
      slid: slidAny,
      floor: classifyFloorBand(curY, this.medianFloorY),
      normal: curNormal,
    };
  }
}

// ---------------------------------------------------------------------------
// Builders: from Three.js Group/Object3D OR raw `.nav.glb` binary buffer
// ---------------------------------------------------------------------------

function applyMat4Point(
  m: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

const IDENTITY_MAT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

function multiplyMat4(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    const bo = col * 4;
    const b0 = b[bo];
    const b1 = b[bo + 1];
    const b2 = b[bo + 2];
    const b3 = b[bo + 3];
    out[bo] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[bo + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[bo + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[bo + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

function trsToMat4(
  t?: readonly number[],
  r?: readonly number[],
  s?: readonly number[],
): Float64Array {
  const tx = t?.[0] ?? 0;
  const ty = t?.[1] ?? 0;
  const tz = t?.[2] ?? 0;
  const qx = r?.[0] ?? 0;
  const qy = r?.[1] ?? 0;
  const qz = r?.[2] ?? 0;
  const qw = r?.[3] ?? 1;
  const sx = s?.[0] ?? 1;
  const sy = s?.[1] ?? 1;
  const sz = s?.[2] ?? 1;

  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  const out = new Float64Array(16);
  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = tx;
  out[13] = ty;
  out[14] = tz;
  out[15] = 1;
  return out;
}

/**
 * Builds a `NavMesh3D` from a loaded Three.js `Group` / `Object3D` hierarchy.
 */
export function buildNavMeshFromObject3D(root: MeshLikeNode, cellSize = DEFAULT_CELL_SIZE): NavMesh3D {
  root.updateWorldMatrix?.(true, true);
  const chunks: Float32Array[] = [];
  let totalFloats = 0;

  const visit = (node: MeshLikeNode) => {
    if (node.isMesh && node.geometry?.attributes?.position) {
      const posAttr = node.geometry.attributes.position;
      const posArr = posAttr.array;
      const itemSize = posAttr.itemSize ?? 3;
      const idxAttr = node.geometry.index;
      const mat = node.matrixWorld?.elements ?? IDENTITY_MAT4;

      if (idxAttr && idxAttr.count >= 3) {
        const idxArr = idxAttr.array;
        const triCount = Math.floor(idxAttr.count / 3);
        const buf = new Float32Array(triCount * 9);
        for (let t = 0; t < triCount; t++) {
          const io = t * 3;
          const bo = t * 9;
          for (let v = 0; v < 3; v++) {
            const vi = idxArr[io + v] * itemSize;
            const [wx, wy, wz] = applyMat4Point(mat, posArr[vi], posArr[vi + 1], posArr[vi + 2]);
            buf[bo + v * 3] = wx;
            buf[bo + v * 3 + 1] = wy;
            buf[bo + v * 3 + 2] = wz;
          }
        }
        chunks.push(buf);
        totalFloats += buf.length;
      } else if (posAttr.count >= 3) {
        const triCount = Math.floor(posAttr.count / 3);
        const buf = new Float32Array(triCount * 9);
        for (let t = 0; t < triCount; t++) {
          const bo = t * 9;
          for (let v = 0; v < 3; v++) {
            const vi = (t * 3 + v) * itemSize;
            const [wx, wy, wz] = applyMat4Point(mat, posArr[vi], posArr[vi + 1], posArr[vi + 2]);
            buf[bo + v * 3] = wx;
            buf[bo + v * 3 + 1] = wy;
            buf[bo + v * 3 + 2] = wz;
          }
        }
        chunks.push(buf);
        totalFloats += buf.length;
      }
    }
  };

  if (typeof root.traverse === 'function') {
    root.traverse(visit);
  } else {
    const stack: MeshLikeNode[] = [root];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      visit(cur);
      if (cur.children) {
        for (let i = cur.children.length - 1; i >= 0; i--) stack.push(cur.children[i]);
      }
    }
  }

  const merged = new Float32Array(totalFloats);
  let offset = 0;
  for (const ch of chunks) {
    merged.set(ch, offset);
    offset += ch.length;
  }
  return new NavMesh3D(merged, cellSize);
}

interface GltfJsonSubset {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: Array<{
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }>;
  meshes?: Array<{
    primitives?: Array<{
      mode?: number;
      attributes: { POSITION?: number };
      indices?: number;
    }>;
  }>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }>;
  bufferViews?: Array<{
    buffer?: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }>;
}

/**
 * Parses a standard glTF 2.0 binary `.nav.glb` directly in pure TypeScript (zero DOM / WebGL needed).
 */
export function buildNavMeshFromGlbBinary(
  input: ArrayBuffer | ArrayBufferView,
  cellSize = DEFAULT_CELL_SIZE,
): NavMesh3D {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

  if (bytes.byteLength < 20) {
    throw new Error('Invalid .nav.glb: buffer shorter than 20-byte GLB header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  if (magic !== 0x46546c67 || version !== 2) {
    throw new Error(`Invalid .nav.glb header (magic=0x${magic.toString(16)}, version=${version})`);
  }

  let jsonChunk: Uint8Array | null = null;
  let binChunk: Uint8Array | null = null;
  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const chunkLen = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = Math.min(bytes.byteLength, start + chunkLen);
    if (chunkType === 0x4e4f534a) {
      jsonChunk = bytes.subarray(start, end);
    } else if (chunkType === 0x004e4942) {
      binChunk = bytes.subarray(start, end);
    }
    offset = start + chunkLen;
  }

  if (!jsonChunk || !binChunk) {
    throw new Error('Invalid .nav.glb: missing JSON or BIN chunk');
  }

  const jsonText = new TextDecoder('utf-8').decode(jsonChunk);
  const gltf = JSON.parse(jsonText) as GltfJsonSubset;
  const binView = new DataView(binChunk.buffer, binChunk.byteOffset, binChunk.byteLength);

  const readVec3Float = (accessorIdx: number, index: number): [number, number, number] => {
    const acc = gltf.accessors?.[accessorIdx];
    if (!acc || acc.bufferView === undefined) throw new Error('Missing POSITION accessor');
    const bv = gltf.bufferViews?.[acc.bufferView];
    if (!bv) throw new Error('Missing POSITION bufferView');
    const stride = bv.byteStride || 12;
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0) + index * stride;
    if (acc.componentType === 5126) {
      return [
        binView.getFloat32(base, true),
        binView.getFloat32(base + 4, true),
        binView.getFloat32(base + 8, true),
      ];
    }
    throw new Error(`Unsupported POSITION componentType ${acc.componentType}`);
  };

  const readScalarIndex = (accessorIdx: number, index: number): number => {
    const acc = gltf.accessors?.[accessorIdx];
    if (!acc || acc.bufferView === undefined) throw new Error('Missing indices accessor');
    const bv = gltf.bufferViews?.[acc.bufferView];
    if (!bv) throw new Error('Missing indices bufferView');
    const elemBytes = acc.componentType === 5125 ? 4 : acc.componentType === 5123 ? 2 : 1;
    const stride = bv.byteStride || elemBytes;
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0) + index * stride;
    if (acc.componentType === 5125) return binView.getUint32(base, true);
    if (acc.componentType === 5123) return binView.getUint16(base, true);
    if (acc.componentType === 5121) return binView.getUint8(base);
    throw new Error(`Unsupported index componentType ${acc.componentType}`);
  };

  const chunks: Float32Array[] = [];
  let totalFloats = 0;

  const appendMesh = (meshIdx: number, worldMat: ArrayLike<number>) => {
    const mesh = gltf.meshes?.[meshIdx];
    if (!mesh?.primitives) return;
    for (const prim of mesh.primitives) {
      if (prim.mode !== undefined && prim.mode !== 4) continue;
      const posIdx = prim.attributes.POSITION;
      if (posIdx === undefined) continue;
      const posAcc = gltf.accessors?.[posIdx];
      if (!posAcc) continue;

      if (prim.indices !== undefined) {
        const idxAcc = gltf.accessors?.[prim.indices];
        if (!idxAcc || idxAcc.count < 3) continue;
        const triCount = Math.floor(idxAcc.count / 3);
        const buf = new Float32Array(triCount * 9);
        for (let t = 0; t < triCount; t++) {
          const io = t * 3;
          const bo = t * 9;
          for (let v = 0; v < 3; v++) {
            const vi = readScalarIndex(prim.indices, io + v);
            const [px, py, pz] = readVec3Float(posIdx, vi);
            const [wx, wy, wz] = applyMat4Point(worldMat, px, py, pz);
            buf[bo + v * 3] = wx;
            buf[bo + v * 3 + 1] = wy;
            buf[bo + v * 3 + 2] = wz;
          }
        }
        chunks.push(buf);
        totalFloats += buf.length;
      } else if (posAcc.count >= 3) {
        const triCount = Math.floor(posAcc.count / 3);
        const buf = new Float32Array(triCount * 9);
        for (let t = 0; t < triCount; t++) {
          const bo = t * 9;
          for (let v = 0; v < 3; v++) {
            const [px, py, pz] = readVec3Float(posIdx, t * 3 + v);
            const [wx, wy, wz] = applyMat4Point(worldMat, px, py, pz);
            buf[bo + v * 3] = wx;
            buf[bo + v * 3 + 1] = wy;
            buf[bo + v * 3 + 2] = wz;
          }
        }
        chunks.push(buf);
        totalFloats += buf.length;
      }
    }
  };

  const visitNode = (nodeIdx: number, parentMat: ArrayLike<number>) => {
    const node = gltf.nodes?.[nodeIdx];
    if (!node) return;
    const localMat = node.matrix
      ? node.matrix
      : node.translation || node.rotation || node.scale
        ? trsToMat4(node.translation, node.rotation, node.scale)
        : IDENTITY_MAT4;
    const worldMat =
      localMat === IDENTITY_MAT4 ? parentMat : multiplyMat4(parentMat, localMat);
    if (node.mesh !== undefined) {
      appendMesh(node.mesh, worldMat);
    }
    if (node.children) {
      for (const childIdx of node.children) visitNode(childIdx, worldMat);
    }
  };

  const rootNodes =
    gltf.scenes?.[gltf.scene ?? 0]?.nodes ??
    (gltf.nodes ? gltf.nodes.map((_, idx) => idx) : []);
  if (gltf.scenes && gltf.scenes.length > 0) {
    for (const nIdx of rootNodes) visitNode(nIdx, IDENTITY_MAT4);
  } else if (gltf.meshes) {
    for (let m = 0; m < gltf.meshes.length; m++) appendMesh(m, IDENTITY_MAT4);
  }

  const merged = new Float32Array(totalFloats);
  let outOff = 0;
  for (const ch of chunks) {
    merged.set(ch, outOff);
    outOff += ch.length;
  }
  return new NavMesh3D(merged, cellSize);
}
