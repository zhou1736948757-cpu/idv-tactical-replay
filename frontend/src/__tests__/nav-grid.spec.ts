import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAPS_DATA,
  NAV_CELL_BLOCKED,
  NAV_CELL_VAULT,
  NAV_CELL_WALKABLE,
  NAV_GRID_MANIFEST,
  PIL_MAP_COUNT,
  buildNavFieldRgba,
  classifyNavGridPixels,
  clearNavGridCache,
  computeCarryField,
  computePath,
  computePathSync,
  computeTideField,
  createCarryProfile,
  createNavGridFromPixels,
  createTideProfile,
  evaluateChairsOnNavGrid,
  gridLineOfSight,
  loadNavGrid,
  navGridAvailable,
  resolveNavEndpoint,
  resolveVisibleNavBand,
  routeBetweenRel,
  smoothPathOnGrid,
  snapToWalkable,
  type DecodedNavPixels,
  type NavGridData,
  type NavGridManifestEntry,
  type PilMapId,
} from '@/tactical';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const NAV_GRID_DIR = path.resolve(__dirname, '../../public/assets/nav-grid');

/** Minimal pure-Node PNG decoder (8-bit grayscale or RGB/RGBA, filters 0..4) using node:zlib. */
function decodePngNode(filePath: string): DecodedNavPixels {
  const raw = fs.readFileSync(filePath);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(raw.subarray(0, 8).equals(sig)).toBe(true);

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (pos + 8 <= raw.length) {
    const length = raw.readUInt32BE(pos);
    const type = raw.subarray(pos + 4, pos + 8).toString('ascii');
    const chunkData = raw.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;

    if (type === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8]!;
      colorType = chunkData[9]!;
    } else if (type === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (type === 'IEND') {
      break;
    }
  }

  expect(bitDepth).toBe(8);
  const bpp = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  expect(bpp).toBeGreaterThan(0);

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * bpp;
  const recon = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const ftype = inflated[y * (stride + 1)]!;
    const srcOff = y * (stride + 1) + 1;
    const dstOff = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = inflated[srcOff + x]!;
      const a = x >= bpp ? recon[dstOff + x - bpp]! : 0;
      const b = y > 0 ? recon[dstOff - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? recon[dstOff - stride + x - bpp]! : 0;
      let val = v;
      if (ftype === 1) val = (v + a) & 0xff;
      else if (ftype === 2) val = (v + b) & 0xff;
      else if (ftype === 3) val = (v + ((a + b) >> 1)) & 0xff;
      else if (ftype === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        val = (v + pr) & 0xff;
      }
      recon[dstOff + x] = val;
    }
  }

  if (bpp === 1) {
    return { width, height, data: recon };
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = recon[i * bpp]!;
    rgba[i * 4 + 1] = recon[i * bpp + 1]!;
    rgba[i * 4 + 2] = recon[i * bpp + 2]!;
    rgba[i * 4 + 3] = bpp === 4 ? recon[i * 4 + 3]! : 255;
  }
  return { width, height, data: rgba };
}

function makeNodeDecoder(counter?: { calls: number }) {
  return (_url: string, meta: NavGridManifestEntry): DecodedNavPixels => {
    if (counter) counter.calls++;
    return decodePngNode(path.join(NAV_GRID_DIR, meta.file));
  };
}

function makeSyntheticGrid(width: number, height: number, pixels: Uint8Array): NavGridData {
  const meta: NavGridManifestEntry = {
    mapId: 0,
    scene: 'synthetic',
    file: 'Synthetic.png',
    url: '/assets/nav-grid/Synthetic.png',
    gridW: width,
    gridH: height,
    cellPx: 1,
    metersPerCell: 1,
    windows: [],
    basements: [{ exit: [10, 10], slopeExtraM: 3.5, center: [5, 5] }],
  };
  const g = createNavGridFromPixels(meta, { width, height, data: pixels });
  if (!g) throw new Error('Failed to create synthetic grid');
  return g;
}

describe('Offline PIL Nav-Grid Assets & Pixel Decoding', () => {
  beforeEach(() => {
    clearNavGridCache();
  });

  it('ships all 9 local nav-grid PNGs matching NAV_GRID_MANIFEST and MAPS_DATA dimensions', async () => {
    expect(navGridAvailable(0)).toBe(true);
    expect(navGridAvailable(8)).toBe(true);
    expect(navGridAvailable(9)).toBe(false);
    expect(navGridAvailable(-1)).toBe(false);

    const decoder = makeNodeDecoder();
    for (let id = 0; id < PIL_MAP_COUNT; id++) {
      const mapId = id as PilMapId;
      const meta = NAV_GRID_MANIFEST[mapId];
      expect(meta.url).toBe(`/assets/nav-grid/${meta.file}`);
      expect(meta.gridW).toBe(MAPS_DATA[mapId]!.mapSize[0]);
      expect(meta.gridH).toBe(MAPS_DATA[mapId]!.mapSize[1]);
      expect(meta.basements.length).toBeGreaterThanOrEqual(2);
      expect(meta.windows.length).toBeGreaterThan(0);

      const pngPath = path.join(NAV_GRID_DIR, meta.file);
      expect(fs.existsSync(pngPath), `Missing ${meta.file}`).toBe(true);

      const grid = await loadNavGrid(mapId, decoder);
      expect(grid).not.toBeNull();
      expect(grid!.gridW).toBe(meta.gridW);
      expect(grid!.gridH).toBe(meta.gridH);

      let walkCount = 0;
      let vaultCount = 0;
      let blockedCount = 0;
      for (let i = 0; i < grid!.cells.length; i++) {
        const c = grid!.cells[i]!;
        if (c === NAV_CELL_WALKABLE) walkCount++;
        else if (c === NAV_CELL_VAULT) vaultCount++;
        else if (c === NAV_CELL_BLOCKED) blockedCount++;
      }
      expect(walkCount).toBeGreaterThan(100000);
      expect(vaultCount).toBeGreaterThan(50);
      expect(blockedCount).toBeGreaterThan(50000);
    }
  });

  it('classifies luminance thresholds accurately and caches decoded grids until cleared', async () => {
    const gray = new Uint8Array([0, 95, 96, 128, 191, 192, 255]);
    const res = classifyNavGridPixels(gray, 7, 1);
    expect(Array.from(res.cells)).toEqual([0, 0, 2, 2, 2, 1, 1]);
    expect(Array.from(res.grid)).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(Array.from(res.win)).toEqual([0, 0, 1, 1, 1, 0, 0]);

    const rgba = new Uint8Array([
      40, 0, 0, 255,
      128, 128, 128, 255,
      250, 250, 250, 255,
    ]);
    expect(Array.from(classifyNavGridPixels(rgba, 3, 1).cells)).toEqual([0, 2, 1]);

    const counter = { calls: 0 };
    const dec = makeNodeDecoder(counter);
    const g1 = await loadNavGrid(0, dec);
    const g2 = await loadNavGrid(0, dec);
    expect(g1).toBe(g2);
    expect(counter.calls).toBe(1);

    clearNavGridCache();
    await loadNavGrid(0, dec);
    expect(counter.calls).toBe(2);
  });
});

describe('Obstacle Pathfinding, Vaulting, Smoothing & Endpoint Snapping', () => {
  beforeEach(() => {
    clearNavGridCache();
  });

  it('respects solid obstacles vs vaultable bands (vault: false vs true) and smooths jagged paths', async () => {
    // 40x25 grid with a vertical wall at x=20 from y=0..21 (open corridor at y=22..24)
    // and a 3px vaultable slit (pixel value 128) at x=20, y=10..12
    const W = 40;
    const H = 25;
    const px = new Uint8Array(W * H).fill(255);
    for (let y = 0; y <= 21; y++) px[y * W + 20] = 0;
    for (let y = 10; y <= 12; y++) px[y * W + 20] = 128;

    const grid = makeSyntheticGrid(W, H, px);
    const profile = { speedAt: () => 4.0 };
    const start = { x: 5, y: 11 };
    const goal = { x: 35, y: 11 };

    // Line of sight across the slit: blocked when vault=false, clear when vault=true
    expect(gridLineOfSight(grid, start.x, start.y, goal.x, goal.y, false)).toBe(false);
    expect(gridLineOfSight(grid, start.x, start.y, goal.x, goal.y, true)).toBe(true);

    // Path without vault must detour down to y>=22
    const noVault = computePathSync(grid, start, goal, profile, { vault: false });
    expect(noVault.unreachable).toBe(false);
    expect(noVault.path.some((c) => c.y >= 22)).toBe(true);
    expect(noVault.path.every((c) => grid.cells[c.y * W + c.x] === NAV_CELL_WALKABLE)).toBe(true);

    // Path with vault cuts straight through the 128 vault slit (30m vs ~39.1m detour)
    const withVault = computePathSync(grid, start, goal, profile, { vault: true });
    expect(withVault.unreachable).toBe(false);
    expect(withVault.distM).toBeLessThan(noVault.distM - 5);
    expect(withVault.path.some((c) => grid.cells[c.y * W + c.x] === NAV_CELL_VAULT)).toBe(true);

    // Smoothing collapses the straight vaulted path to 2 points and tightens the detoured path
    const smoothVault = smoothPathOnGrid(grid, withVault.path, true);
    expect(smoothVault).toEqual([start, goal]);
    const smoothDetour = smoothPathOnGrid(grid, noVault.path, false);
    expect(smoothDetour.length).toBeLessThan(noVault.path.length);
    expect(smoothDetour[0]).toEqual(start);
    expect(smoothDetour[smoothDetour.length - 1]).toEqual(goal);

    // Chunked async computePath matches sync and supports cancellation
    const asyncJob = computePath(grid, start, goal, profile, { vault: false, chunkSize: 100 });
    const asyncRes = await asyncJob.promise;
    expect(asyncRes.unreachable).toBe(false);
    expect(asyncRes.distM).toBeCloseTo(noVault.distM, 6);

    const cancelJob = computePath(grid, start, goal, profile, { vault: false, chunkSize: 100 });
    cancelJob.cancel();
    const cancelRes = await cancelJob.promise;
    expect(cancelRes.cancelled).toBe(true);
  });

  it('routes around real obstacles on Arms Factory PNG and resolves blocked/basement endpoints', async () => {
    const grid = (await loadNavGrid(0, makeNodeDecoder()))!;
    const map = MAPS_DATA[0]!;
    const [mw, mh] = map.mapSize;

    // Pick two walkable points on opposite sides of the main factory building on Arms Factory
    // Factory interior obstacle lies around x=520..590, y=460..540
    const fromRel = { x: 460 / mw, y: 500 / mh };
    const toRel = { x: 640 / mw, y: 500 / mh };
    const straightM = Math.hypot((toRel.x - fromRel.x) * mw, (toRel.y - fromRel.y) * mh) * grid.metersPerCell;

    const routedNoVault = await routeBetweenRel(grid, map.mapSize, fromRel, toRel, {
      vault: false,
      autoFix: true,
      sync: true,
    });
    expect(routedNoVault).not.toBeNull();
    expect(routedNoVault!.points.length).toBeGreaterThanOrEqual(2);
    expect(routedNoVault!.distanceM).toBeGreaterThan(straightM);
    expect(routedNoVault!.smoothedCells.length).toBeLessThan(routedNoVault!.rawCells.length);

    // Verify every raw path cell is strictly walkable (no wall traversal)
    for (const c of routedNoVault!.rawCells) {
      expect(grid.grid[c.y * grid.gridW + c.x]).toBe(1);
    }

    // Find a deep blocked point (>25px from nearest walkable pixel, <=150px wide snap) on real Red Church PNG
    const churchGrid = (await loadNavGrid(2, makeNodeDecoder()))!;
    let deepBlocked: [number, number] | null = null;
    for (let y = 20; y < churchGrid.gridH - 20 && !deepBlocked; y += 12) {
      for (let x = 20; x < churchGrid.gridW - 20 && !deepBlocked; x += 12) {
        if (churchGrid.grid[y * churchGrid.gridW + x] !== 0) continue;
        if (snapToWalkable(churchGrid, x, y, 25) === null && snapToWalkable(churchGrid, x, y, 150) !== null) {
          deepBlocked = [x, y];
        }
      }
    }
    expect(deepBlocked).not.toBeNull();
    const [bx, by] = deepBlocked!;
    expect(resolveNavEndpoint(churchGrid, bx, by, { autoFix: false, allowBasement: false })).toBeNull();
    const fixedEp = resolveNavEndpoint(churchGrid, bx, by, { autoFix: true, allowBasement: false });
    expect(fixedEp).not.toBeNull();
    expect(fixedEp!.fixed).not.toBeNull();
    expect(fixedEp!.fixed!.from).toEqual({ x: bx, y: by });
    expect(churchGrid.grid[fixedEp!.cell.y * churchGrid.gridW + fixedEp!.cell.x]).toBe(1);

    // Test basement entrance resolution (40px detection + exit + slopeExtraM)
    const b0 = grid.basements[0]!;
    const baseEp = resolveNavEndpoint(grid, b0.exit[0], b0.exit[1], {
      allowBasement: true,
      speedMps: 4.64,
    });
    expect(baseEp).not.toBeNull();
    expect(baseEp!.viaBasement).toBe(b0);
    expect(baseEp!.extraMeters).toBeCloseTo(b0.slopeExtraM, 3);
    expect(baseEp!.extraSeconds).toBeCloseTo(b0.slopeExtraM / 4.64, 3);

    // Test explicit forceBasement from basement chair coordinate
    const bChair = map.basements.basement_1!.rocketChairs[0]!;
    const chairEp = resolveNavEndpoint(grid, bChair[0], bChair[2], {
      forceBasement: true,
      speedMps: 4.64,
    });
    expect(chairEp).not.toBeNull();
    expect(chairEp!.viaBasement).toBe(b0);
    expect(chairEp!.extraMeters).toBeGreaterThan(b0.slopeExtraM);
  });
});

describe('Carry & Tide Dijkstra Fields and Chair Evaluation on Real Nav-Grid', () => {
  beforeEach(() => {
    clearNavGridCache();
  });

  it('computes obstacle-bounded Carry & Tide fields, applies basement initialSeconds penalty, and evaluates chairs', async () => {
    const grid = (await loadNavGrid(0, makeNodeDecoder()))!;
    const map = MAPS_DATA[0]!;
    const [mw, mh] = map.mapSize;

    const carryProfile = createCarryProfile({ baseSpeed: 4.64 });
    const startCell = snapToWalkable(grid, 430, 320, 40)!;
    expect(startCell).not.toBeNull();

    const field = await computeCarryField(grid, startCell, carryProfile, { sync: true }).promise;
    expect(field.cancelled).toBe(false);
    expect(field.reached).toBeGreaterThan(5000);
    expect(field.timeSeconds).toBeInstanceOf(Float32Array);
    expect(field.bandOf).toBeInstanceOf(Int8Array);

    // Obstacle-respecting reachable area must be strictly smaller than open radial circle
    const maxRadiusCells = (carryProfile.remainingSeconds * carryProfile.speedAt(0)) / grid.metersPerCell;
    const openCircleAreaCells = Math.PI * maxRadiusCells * maxRadiusCells;
    expect(field.reached).toBeLessThan(openCircleAreaCells);

    // Basement initialSeconds penalty (slopeExtraM) strictly shrinks reached cells
    const b0 = grid.basements[0]!;
    const bExitCell = snapToWalkable(grid, b0.exit[0], b0.exit[1], 40)!;
    const noPenalty = await computeCarryField(grid, bExitCell, carryProfile, { sync: true }).promise;
    const withPenalty = await computeCarryField(grid, bExitCell, carryProfile, {
      initialSeconds: b0.slopeExtraM / carryProfile.speedAt(0),
      sync: true,
    }).promise;
    expect(withPenalty.reached).toBeLessThan(noPenalty.reached);

    // RGBA rasterizer & hidden-band promotion
    expect(resolveVisibleNavBand(0, new Set([0, 1]))).toBe(2);
    expect(resolveVisibleNavBand(4, new Set([4]))).toBe(-1);
    const rgba = buildNavFieldRgba(field.bandOf, 'carry', [0], 0.7);
    expect(rgba.length).toBe(grid.gridW * grid.gridH * 4);
    const startIdx = startCell.y * grid.gridW + startCell.x;
    expect(rgba[startIdx * 4 + 3]).toBeGreaterThan(0);

    // Evaluate ground + basement chairs for Carry
    const chairs = [
      ...map.rocketChairs.fixed.map((pt, i) => ({
        relPos: [pt[0] / mw, pt[1] / mh] as [number, number],
        index: i,
        kind: 'fixed',
        label: `固定椅 #${i + 1}`,
      })),
      ...map.basements.basement_1!.rocketChairs.map((pt, i) => ({
        relPos: [pt[0] / mw, pt[2] / mh] as [number, number],
        index: 100 + i,
        kind: 'basement',
        floor: 'B1',
        label: `地下室椅 #${i + 1}`,
      })),
    ];

    const carryRows = evaluateChairsOnNavGrid(grid, field, carryProfile, chairs, map.mapSize, 'carry');
    expect(carryRows).toHaveLength(chairs.length);
    expect(carryRows.some((r) => r.canHang)).toBe(true);
    // Sorted ascending by travelSeconds
    for (let i = 1; i < carryRows.length; i++) {
      expect(carryRows[i]!.travelSeconds).toBeGreaterThanOrEqual(carryRows[i - 1]!.travelSeconds);
    }
    // Basement chairs include slopeExtraM offset beyond exit time
    const bRow = carryRows.find((r) => r.kind === 'basement' && Number.isFinite(r.travelSeconds));
    expect(bRow).toBeDefined();
    const exitTime = field.timeSeconds[bExitCell.y * grid.gridW + bExitCell.x]!;
    expect(bRow!.travelSeconds).toBeGreaterThan(exitTime + b0.slopeExtraM / carryProfile.speedAt(exitTime) - 1e-3);

    // Tide field & chair evaluation (vault: true)
    const tideProfile = createTideProfile({ baseSpeed: 3.8 });
    const tideField = await computeTideField(grid, startCell, tideProfile, { sync: true }).promise;
    expect(tideField.cancelled).toBe(false);
    expect(tideField.reached).toBeGreaterThan(5000);
    const tideRows = evaluateChairsOnNavGrid(grid, tideField, tideProfile, chairs, map.mapSize, 'tide');
    expect(tideRows).toHaveLength(chairs.length);
    expect(tideRows.some((r) => r.reachable20s)).toBe(true);

    // Async field cancellation
    const cancelFieldJob = computeTideField(grid, startCell, tideProfile, { chunkSize: 500 });
    cancelFieldJob.cancel();
    const cancelledField = await cancelFieldJob.promise;
    expect(cancelledField.cancelled).toBe(true);
  });
});
