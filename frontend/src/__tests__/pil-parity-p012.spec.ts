import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createCarryProfile,
  createEmptyBoardState,
  createTideProfile,
  populateEndgameScenario,
  populateOpeningScenario,
} from '@/tactical';
import {
  buildNavGraph3D,
  buildNavMeshFromGlbBinary,
  computeCarryField3D,
  computeHardestChairExtrema3D,
  computeTideField3D,
  findPath3D,
  normalizedToWorld3D,
} from '@/tactical/scene3d';
import {
  attachHittingPointToChain,
  closeHittingPointChain,
  removeHittingPoint,
  resolvePropRangeCircles,
  setHittingPointAllowLink,
  setHittingPointShowLink,
  syncSharedRoleManageState,
  type BoardProp,
  type BoardToken,
} from '@/lib/board';

describe('P0: Opening & Endgame Scenario Engine + Cipher Progress', () => {
  it('populates 1 Hunter + 4 Survivors on real map spawn points with animated trajectories', () => {
    const board = createEmptyBoardState();
    const res = populateOpeningScenario(board, 0, {
      spawnGroupIndex: 1,
      cipherGroupIndex: 0,
      hunterRole: 'bloodyQueen',
      withAnim: true,
    });
    expect(res.tokensPlaced).toBe(5);
    expect(board.tokens).toHaveLength(5);
    expect(board.spawnIndex).toBe(1);
    const hunters = board.tokens.filter((t) => t.camp === 'hunter');
    const survs = board.tokens.filter((t) => t.camp === 'survivor');
    expect(hunters).toHaveLength(1);
    expect(hunters[0]!.role).toBe('bloodyQueen');
    expect(hunters[0]!.anim?.points.length).toBeGreaterThanOrEqual(2);
    expect(survs).toHaveLength(4);
    expect(survs.every((s) => (s.anim?.points.length ?? 0) >= 2)).toBe(true);
  });

  it('populates prime-pop, chair-rescue, and gate-war endgame presets with cipher progress', () => {
    const b1 = createEmptyBoardState();
    populateEndgameScenario(b1, 0, 'prime-pop', { cipherGroupIndex: 0 });
    expect(b1.cipherProgressEnabled).toBe(true);
    const vals1 = Object.values(b1.cipherProgress ?? {});
    expect(vals1.filter((v) => v === 100)).toHaveLength(4);
    expect(vals1.filter((v) => v === 99)).toHaveLength(1);
    expect(b1.tokens).toHaveLength(5);

    const b2 = createEmptyBoardState();
    const res2 = populateEndgameScenario(b2, 0, 'chair-rescue', { cipherGroupIndex: 0 });
    expect(b2.cipherProgressEnabled).toBe(true);
    expect(res2.recommendedChairRel).toBeTruthy();
    expect(b2.tokens).toHaveLength(5);

    const b3 = createEmptyBoardState();
    populateEndgameScenario(b3, 7, 'gate-war', { cipherGroupIndex: 0 });
    expect(Object.values(b3.cipherProgress ?? {}).filter((v) => v === 100)).toHaveLength(5);
    expect(b3.tokens).toHaveLength(5);
  });
});

describe('P1: 3D NavMesh A->B Routing, Carry/Tide 5-Band Surface Fields & Hardest-Chair Extrema', () => {
  const curDir = path.dirname(fileURLToPath(import.meta.url));
  const navGlbPath = path.resolve(curDir, '../../public/assets/maps-3d/ordnance_factory1.nav.glb');
  const buf = readFileSync(navGlbPath);
  const navMesh = buildNavMeshFromGlbBinary(new Uint8Array(buf));

  it('builds a connected 3D nav graph and solves A->B pathfinding across Arms Factory', () => {
    const graph = buildNavGraph3D(navMesh);
    expect(graph.triCount).toBeGreaterThan(1000);

    const wa = normalizedToWorld3D(0, 0.25, 0.35);
    const wb = normalizedToWorld3D(0, 0.72, 0.68);
    const path = findPath3D(
      navMesh,
      { x: wa.x, y: navMesh.medianFloorY, z: wa.z },
      { x: wb.x, y: navMesh.medianFloorY, z: wb.z },
      { speedMps: 3.8, allowVault: true, vaultPenaltySeconds: 1.0 },
    );

    expect(path.reachable).toBe(true);
    expect(path.points.length).toBeGreaterThanOrEqual(2);
    expect(path.distanceM).toBeGreaterThan(20);
    expect(path.totalTimeS).toBeGreaterThan(5);
    expect(path.floors.length).toBeGreaterThanOrEqual(1);
  });

  it('computes 3D Carry & Tide 5-band surface fields and ranked chair rows', () => {
    const center = normalizedToWorld3D(0, 0.5, 0.5);
    const origin = { x: center.x, y: navMesh.medianFloorY, z: center.z };

    const carryProfile = createCarryProfile();
    const carryField = computeCarryField3D(navMesh, 0, origin, 'point', carryProfile);
    expect(carryField.reachedTris).toBeGreaterThan(50);
    expect(carryField.chairRows.length).toBeGreaterThan(5);
    expect(carryField.chairRows.some((r) => r.canHang)).toBe(true);

    const tideProfile = createTideProfile({ baseSpeed: 3.8 });
    const tideField = computeTideField3D(navMesh, 0, origin, 'point', tideProfile);
    expect(tideField.reachedTris).toBeGreaterThan(100);
    expect(tideField.chairRows.some((r) => r.reachable20s)).toBe(true);
  });

  it('finds Top-5 well-separated hardest-to-chair extremum spots in 3D', () => {
    const carryProfile = createCarryProfile();
    const spots = computeHardestChairExtrema3D(navMesh, 0, carryProfile, { topN: 5 });
    expect(spots.length).toBeGreaterThanOrEqual(3);
    expect(spots[0]!.distanceM).toBeGreaterThanOrEqual(spots[spots.length - 1]!.distanceM);
    expect(spots[0]!.hangSeconds).toBeGreaterThan(2);
  });
});

describe('P2: Role Specialty Cards (Hitting-Point 4-35m Chain, Goatman 3-Gear Cage, Manage-Share)', () => {
  it('links hitting-points in order, clamps 4-35m, auto-closes at 4th point, dissolves and removes cleanly', () => {
    const board = createEmptyBoardState();
    const addHp = (x: number, y: number): BoardProp => {
      const p: BoardProp = { iid: ++board.itemSeq, kind: 'contactPoint', role: 'cueist', x, y };
      board.items.push(p);
      attachHittingPointToChain(board, p, 160, 1);
      return p;
    };

    const p1 = addHp(0.2, 0.2);
    const p2 = addHp(0.85, 0.2); // 104m away -> must clamp to 35m (dx ~ 35/160 = 0.21875)
    expect(Math.hypot(p2.x - p1.x, p2.y - p1.y) * 160).toBeCloseTo(35, 1);
    expect(p2.chainId).toBe(p1.chainId);
    expect(p2.chainClosed).toBe(false);

    const p3 = addHp(p2.x, p2.y + 0.12);
    expect(p3.chainClosed).toBe(false);

    // Share linkShow across component
    setHittingPointShowLink(board, p2, false);
    expect(p1.linkShow).toBe(false);
    expect(p3.linkShow).toBe(false);
    setHittingPointShowLink(board, p1, true);

    // 4th point auto-closes
    const p4 = addHp(p1.x, p3.y);
    expect(p1.chainClosed).toBe(true);
    expect(p4.chainClosed).toBe(true);

    // Deleting a closed point removes the entire closed polygon
    removeHittingPoint(board, p2);
    expect(board.items).toHaveLength(0);

    // Early close at 3 points + dissolve on unchecking allowLink
    const a = addHp(0.3, 0.3);
    const b = addHp(0.4, 0.3);
    const c = addHp(0.35, 0.4);
    expect(closeHittingPointChain(board, c)).toBe(true);
    expect(a.chainClosed).toBe(true);
    setHittingPointAllowLink(board, b, false);
    expect(a.allowLink).toBe(false);
    expect(c.chainId).toBeNull();
  });

  it('supports Goatman 9/12/15m 3-gear cage switching and Guard 26 blast cross width', () => {
    const cage: BoardProp = {
      iid: 1,
      kind: 'cage',
      role: 'goatman',
      x: 0.5,
      y: 0.5,
      showRange: true,
      rangeGear: 0,
    };
    expect(resolvePropRangeCircles(cage, 160)[0]?.radiusM).toBe(9);
    cage.rangeGear = 1;
    expect(resolvePropRangeCircles(cage, 160)[0]?.radiusM).toBe(12);
    cage.rangeGear = 2;
    expect(resolvePropRangeCircles(cage, 160)[0]?.radiusM).toBe(15);

    const bomb: BoardProp = {
      iid: 2,
      kind: 'timeBomb',
      role: 'guard26',
      x: 0.5,
      y: 0.5,
      rangeBox: { subs: [0, 1], fill: true },
    };
    const circles = resolvePropRangeCircles(bomb, 160);
    expect(circles).toHaveLength(2);
    expect(circles[0]?.radiusM).toBe(10.5);
    expect(circles[1]?.radiusM).toBe(13);
    expect(circles[0]?.crossWidthM).toBe(2.53);
  });

  it('shares fixed-spawn manage state across Photographer/Professor tokens only', () => {
    const board = createEmptyBoardState();
    const ph1: BoardToken = { tid: 1, role: 'photographer', x: 0.3, y: 0.3 };
    const ph2: BoardToken = { tid: 2, role: 'photographer', x: 0.6, y: 0.6 };
    const ex1: BoardToken = { tid: 3, role: 'explorer', x: 0.4, y: 0.4 };
    board.tokens.push(ph1, ph2, ex1);

    syncSharedRoleManageState(board, ph1, { showFixedSpawns: true, showSpawnDir: false });
    expect(ph2.showFixedSpawns).toBe(true);
    expect(ph2.showSpawnDir).toBe(false);
    expect(ex1.showFixedSpawns).toBeUndefined();
  });
});
