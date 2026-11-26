import { describe, expect, it } from 'vitest';
import {
  computeUnderlayAffine,
  createDefaultCamera,
  fitCameraToBounds,
  normalizeCamera,
  projectWorldToScreen,
  screenToWorldOnPlane,
  wrapDeg360,
} from '../src/projection';
import type { CameraState, Vec3 } from '../src/types';

const VP = { width: 1280, height: 720, dpr: 2 };

function applyAffine(m: number[], x: number, y: number): [number, number] {
  return [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];
}

describe('AC-2 projection 2D <-> 2.5D', () => {
  it('matches the D2 formula exactly at an oblique camera', () => {
    const cam: CameraState = { centerX: 10, centerZ: -20, zoom: 1.5, yawDeg: 30, pitchDeg: 50, yScale: 2 };
    const [x, y, z] = [110, 40, 60];
    const yaw = (30 * Math.PI) / 180;
    const pitch = (50 * Math.PI) / 180;
    const dx = x - 10;
    const dz = z + 20;
    const rx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const rz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const p = projectWorldToScreen([x, y, z], cam, VP);
    expect(p.x).toBeCloseTo(640 + rx * 1.5, 9);
    expect(p.y).toBeCloseTo(360 + rz * 1.5 * Math.sin(pitch) - y * 2 * 1.5 * Math.cos(pitch), 9);
    expect(p.depth).toBeCloseTo(rz * Math.cos(pitch) + y * 2 * Math.sin(pitch), 9);
  });

  it('degenerates into exact 2D top-down at pitch 90 (Y has no screen effect)', () => {
    const cam = createDefaultCamera({ centerX: 5, centerZ: 7, zoom: 2, yawDeg: 0, pitchDeg: 90, yScale: 3 });
    const a = projectWorldToScreen([105, -85, 57], cam, VP);
    const b = projectWorldToScreen([105, 65, 57], cam, VP);
    expect(a.x).toBe(640 + 200);
    expect(a.y).toBe(360 + 100);
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y);
    expect(b.depth).toBeGreaterThan(a.depth);
  });

  it('round-trips screenToWorldOnPlane with error < 1e-6 across pitch/yaw/zoom/pan/yScale', () => {
    const pitches = [35, 40, 52.5, 60, 75, 89, 90];
    const yaws = [0, 30, 90, 137.5, 180, 225, 270, 315, 359.9];
    const yScales = [1, 1.75, 3];
    const zooms = [0.25, 1, 3.7];
    const centers: Array<[number, number]> = [[0, 0], [1500, 1200], [-640, 333]];
    const points: Vec3[] = [[0, 0, 0], [123.4, -85, -456.7], [-900, 65, 800], [1700, 12.5, 900]];
    let maxErr = 0;
    let count = 0;
    for (const pitchDeg of pitches)
      for (const yawDeg of yaws)
        for (const yScale of yScales)
          for (const zoom of zooms)
            for (const [centerX, centerZ] of centers) {
              const cam = { centerX, centerZ, zoom, yawDeg, pitchDeg, yScale };
              for (const w of points) {
                const s = projectWorldToScreen(w, cam, VP);
                const back = screenToWorldOnPlane(s.x, s.y, w[1], cam, VP);
                maxErr = Math.max(maxErr, Math.abs(back[0] - w[0]), Math.abs(back[1] - w[1]), Math.abs(back[2] - w[2]));
                count++;
              }
            }
    expect(count).toBe(pitches.length * yaws.length * yScales.length * zooms.length * centers.length * points.length);
    expect(maxErr).toBeLessThan(1e-6);
  });

  it('round-trips screen -> world -> screen on arbitrary planes', () => {
    const cam = { centerX: 300, centerZ: -200, zoom: 0.8, yawDeg: 211, pitchDeg: 41, yScale: 2.4 };
    for (const [sx, sy] of [[0, 0], [1280, 720], [17.5, 600.25], [640, 360]] as Array<[number, number]>) {
      for (const yPlane of [-85, 0, 60]) {
        const w = screenToWorldOnPlane(sx, sy, yPlane, cam, VP);
        const s = projectWorldToScreen(w, cam, VP);
        expect(Math.abs(s.x - sx)).toBeLessThan(1e-6);
        expect(Math.abs(s.y - sy)).toBeLessThan(1e-6);
      }
    }
  });

  it('clamps pitch to [35, 90], yScale to [1, 3] and wraps yaw into [0, 360)', () => {
    const c = normalizeCamera({ centerX: 0, centerZ: 0, zoom: -5, yawDeg: -30, pitchDeg: 10, yScale: 9 });
    expect(c.pitchDeg).toBe(35);
    expect(c.yScale).toBe(3);
    expect(c.yawDeg).toBe(330);
    expect(c.zoom).toBeGreaterThan(0);
    expect(normalizeCamera({ ...c, pitchDeg: 120, yScale: 0.2 }).pitchDeg).toBe(90);
    expect(normalizeCamera({ ...c, pitchDeg: 120, yScale: 0.2 }).yScale).toBe(1);
    expect(wrapDeg360(720)).toBe(0);
    expect(wrapDeg360(-0.5)).toBeCloseTo(359.5, 12);
    expect(wrapDeg360(365)).toBe(5);
  });

  it('yaw rotates the scene continuously (yaw 0 vs 360 identical)', () => {
    const base = { centerX: 0, centerZ: 0, zoom: 1, pitchDeg: 60, yScale: 1 };
    const a = projectWorldToScreen([100, 0, 50], { ...base, yawDeg: 0 }, VP);
    const b = projectWorldToScreen([100, 0, 50], { ...base, yawDeg: 360 }, VP);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
  });

  it('fitCameraToBounds centers bounds and keeps them inside the padded viewport', () => {
    const bounds = { min_x: 847, max_x: 2176, min_z: 680, max_z: 2341 };
    const cam = fitCameraToBounds(bounds, VP, 0.08);
    expect(cam.centerX).toBeCloseTo((847 + 2176) / 2, 9);
    expect(cam.centerZ).toBeCloseTo((680 + 2341) / 2, 9);
    expect(cam.pitchDeg).toBe(90);
    for (const [x, z] of [[847, 680], [2176, 2341], [847, 2341], [2176, 680]] as Array<[number, number]>) {
      const p = projectWorldToScreen([x, 0, z], cam, VP);
      expect(p.x).toBeGreaterThanOrEqual(1280 * 0.08 - 1e-6);
      expect(p.x).toBeLessThanOrEqual(1280 * 0.92 + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(720 * 0.08 - 1e-6);
      expect(p.y).toBeLessThanOrEqual(720 * 0.92 + 1e-6);
    }
    // the limiting axis (Z span 1661 over 720*0.84 px) touches the padding edge
    expect(cam.zoom).toBeCloseTo((720 * 0.84) / 1661, 9);
  });
});

describe('AC-5 affine Y=0 map underlay', () => {
  const rect = { min_x: -750, max_x: 780, min_z: -600, max_z: 640 };
  const W = 2048;
  const H = 1660;

  it('maps image corners (0,0),(W,0),(0,H),(W,H) onto projected world corners at arbitrary yaw/pitch', () => {
    for (const cam of [
      { centerX: 0, centerZ: 0, zoom: 0.5, yawDeg: 0, pitchDeg: 90, yScale: 1 },
      { centerX: 120, centerZ: -40, zoom: 0.7, yawDeg: 63, pitchDeg: 47, yScale: 2.2 },
      { centerX: -300, centerZ: 210, zoom: 1.3, yawDeg: 301.5, pitchDeg: 35, yScale: 3 },
    ]) {
      const m = computeUnderlayAffine(rect, W, H, cam, VP);
      const checks: Array<[number, number, Vec3]> = [
        [0, 0, [rect.min_x, 0, rect.min_z]],
        [W, 0, [rect.max_x, 0, rect.min_z]],
        [0, H, [rect.min_x, 0, rect.max_z]],
        [W, H, [rect.max_x, 0, rect.max_z]],
      ];
      for (const [ix, iy, w] of checks) {
        const [sx, sy] = applyAffine(m, ix, iy);
        const p = projectWorldToScreen(w, cam, VP);
        expect(Math.abs(sx - p.x)).toBeLessThan(1e-6);
        expect(Math.abs(sy - p.y)).toBeLessThan(1e-6);
      }
    }
  });

  it('supports rotation quadrants and X/Z flips as corner permutations', () => {
    const cam = { centerX: 0, centerZ: 0, zoom: 0.5, yawDeg: 20, pitchDeg: 60, yScale: 1 };
    const p = (x: number, z: number) => projectWorldToScreen([x, 0, z], cam, VP);
    const close = (a: [number, number], b: { x: number; y: number }) => {
      expect(Math.abs(a[0] - b.x)).toBeLessThan(1e-6);
      expect(Math.abs(a[1] - b.y)).toBeLessThan(1e-6);
    };
    const r2 = computeUnderlayAffine(rect, W, H, cam, VP, { rotationQuadrants: 2 });
    close(applyAffine(r2, 0, 0), p(rect.max_x, rect.max_z));
    close(applyAffine(r2, W, H), p(rect.min_x, rect.min_z));
    const fx = computeUnderlayAffine(rect, W, H, cam, VP, { flipX: true });
    close(applyAffine(fx, 0, 0), p(rect.max_x, rect.min_z));
    close(applyAffine(fx, W, 0), p(rect.min_x, rect.min_z));
    const fz = computeUnderlayAffine(rect, W, H, cam, VP, { flipZ: true });
    close(applyAffine(fz, 0, 0), p(rect.min_x, rect.max_z));
    const r1 = computeUnderlayAffine(rect, W, H, cam, VP, { rotationQuadrants: 1 });
    // all four image corners still land on the four distinct world corners
    const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => applyAffine(r1, x!, y!));
    const world = [p(rect.min_x, rect.min_z), p(rect.max_x, rect.min_z), p(rect.min_x, rect.max_z), p(rect.max_x, rect.max_z)];
    for (const c of corners) expect(world.some((w) => Math.abs(w.x - c[0]) < 1e-6 && Math.abs(w.y - c[1]) < 1e-6)).toBe(true);
  });
});
