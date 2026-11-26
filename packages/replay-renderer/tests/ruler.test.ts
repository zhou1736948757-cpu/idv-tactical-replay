import { describe, expect, it } from 'vitest';
import { classifyFloor, formatCrossFloorBadge, formatRulerLabel, measureTacticalDistance } from '../src/ruler';

describe('AC-3 classifyFloor', () => {
  it('uses B1 < -20, 1F [-20, 25), 2F >= 25', () => {
    expect(classifyFloor(-85)).toBe('B1');
    expect(classifyFloor(-20.0001)).toBe('B1');
    expect(classifyFloor(-20)).toBe('1F');
    expect(classifyFloor(0)).toBe('1F');
    expect(classifyFloor(15)).toBe('1F');
    expect(classifyFloor(24.9999)).toBe('1F');
    expect(classifyFloor(25)).toBe('2F');
    expect(classifyFloor(65)).toBe('2F');
  });
});

describe('AC-4 floor-aware distance + 45 u/s ETA', () => {
  it('same floor: 90u -> 2.0s, no stair penalty', () => {
    const m = measureTacticalDistance([0, 0, 0], [90, 0, 0]);
    expect(m.planarDistanceU).toBe(90);
    expect(m.verticalDeltaU).toBe(0);
    expect(m.euclidean3dU).toBe(90);
    expect(m.crossFloor).toBe(false);
    expect(m.effectiveDistanceU).toBe(90);
    expect(m.survivorSprintEtaS).toBe(2.0);
    expect(formatRulerLabel(m)).toBe('90.0u · 2.0s');
    expect(formatCrossFloorBadge(m)).toBeNull();
  });

  it('same floor diagonal with small elevation stays on 1F', () => {
    const m = measureTacticalDistance([0, 0, 0], [81, 12, 108]);
    expect(m.planarDistanceU).toBeCloseTo(135, 9);
    expect(m.verticalDeltaU).toBe(12);
    expect(m.euclidean3dU).toBeCloseTo(Math.hypot(135, 12), 9);
    expect(m.floorA).toBe('1F');
    expect(m.floorB).toBe('1F');
    expect(m.effectiveDistanceU).toBeCloseTo(Math.hypot(135, 12), 9);
  });

  it('cross floor B1 -> 1F adds +90u stair penalty and 3D delta', () => {
    const m = measureTacticalDistance([90, -85, 0], [0, 0, 0]);
    expect(m.floorA).toBe('B1');
    expect(m.floorB).toBe('1F');
    expect(m.crossFloor).toBe(true);
    expect(m.planarDistanceU).toBe(90);
    expect(m.verticalDeltaU).toBe(85);
    expect(m.euclidean3dU).toBeCloseTo(Math.hypot(90, 85), 9);
    expect(m.stairPenaltyU).toBe(90);
    expect(m.effectiveDistanceU).toBeCloseTo(Math.hypot(90, 85) + 90, 9);
    expect(m.survivorSprintEtaS).toBeCloseTo((Math.hypot(90, 85) + 90) / 45, 9);
    expect(formatCrossFloorBadge(m)).toBe('B1→1F +90u');
  });

  it('honors custom stair penalty and sprint speed options', () => {
    const m = measureTacticalDistance([0, 0, 0], [0, 65, 0], { stairPenaltyU: 30, sprintSpeedUPerS: 50 });
    expect(m.crossFloor).toBe(true);
    expect(m.effectiveDistanceU).toBe(95);
    expect(m.survivorSprintEtaS).toBeCloseTo(1.9, 12);
  });
});
