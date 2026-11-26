import { describe, expect, it } from 'vitest';
import {
  extractPlayerTrail,
  getActivePulsesAtTime,
  isChaseActiveAtTime,
  isFlywheelEvent,
  isWindowSealedAtTime,
  lerpAngleDeg,
  sampleChairAtTime,
  sampleCipherAtTime,
  sampleGateAtTime,
  samplePalletAtTime,
  samplePlayerAtTime,
  sortEventsByTime,
  upperBoundIndex,
} from '../src/state';
import type { TrajectorySampleTuple } from '../src/types';
import { ev, lineTrajectory, makePayload } from './helpers/fixtures';

describe('AC-6 samplePlayerAtTime', () => {
  const traj: TrajectorySampleTuple[] = [
    [0, 0, 0, 0, 1, 0, 45, 350, 0],
    [1, 45, 0, 0, 0, 1, 45, 10, 1],
    [2, 90, 0, 0, 0, 1, 45, null, 1],
    [3, 500, 0, 500, 0, 1, 0, 20, 2], // teleport (> 60u)
    [4, 510, 0, 500, 1, 0, 10, 30, 2],
  ];

  it('linearly interpolates position/speed and keeps fear_state discrete', () => {
    const s = samplePlayerAtTime(traj, 0.5)!;
    expect(s.pos[0]).toBeCloseTo(22.5, 12);
    expect(s.speed).toBeCloseTo(45, 12);
    expect(s.fearState).toBe(0);
    expect(s.teleported).toBe(false);
    expect(samplePlayerAtTime(traj, 1.0)!.fearState).toBe(1);
  });

  it('interpolates normalized dir and shortest-arc cam yaw (350 -> 10 passes 0)', () => {
    const s = samplePlayerAtTime(traj, 0.5)!;
    expect(Math.hypot(s.dir[0], s.dir[1])).toBeCloseTo(1, 12);
    expect(s.dir[0]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(s.camYawDeg).toBeCloseTo(0, 9);
    expect(lerpAngleDeg(350, 10, 0.25)).toBeCloseTo(355, 9);
    expect(lerpAngleDeg(10, 350, 0.25)).toBeCloseTo(5, 9);
    // null cam yaw falls back to the available neighbour
    expect(samplePlayerAtTime(traj, 1.5)!.camYawDeg).toBe(10);
  });

  it('teleport guard: holds previous sample across > 60u jumps (no lerp)', () => {
    const s = samplePlayerAtTime(traj, 2.5)!;
    expect(s.teleported).toBe(true);
    expect(s.pos).toEqual([90, 0, 0]);
    const after = samplePlayerAtTime(traj, 3.5)!;
    expect(after.teleported).toBe(false);
    expect(after.pos[0]).toBeCloseTo(505, 9);
  });

  it('clamps before first / after last sample and handles empty input', () => {
    expect(samplePlayerAtTime(traj, -5)!.pos).toEqual([0, 0, 0]);
    expect(samplePlayerAtTime(traj, 99)!.pos).toEqual([510, 0, 500]);
    expect(samplePlayerAtTime([], 1)).toBeNull();
    expect(samplePlayerAtTime(undefined, 1)).toBeNull();
  });

  it('binary search agrees with linear scan on a long 10 Hz trajectory', () => {
    const long = lineTrajectory([0, 0, 0], [45, 0], 0, 600);
    for (const t of [0.05, 13.37, 299.99, 450.04, 599.95]) {
      let lin = -1;
      for (let i = 0; i < long.length; i++) if (long[i]![0] <= t) lin = i;
      expect(upperBoundIndex(long, t, (s) => s[0])).toBe(lin);
      expect(samplePlayerAtTime(long, t)!.pos[0]).toBeCloseTo(45 * t, 6);
    }
  });
});

describe('AC-6 extractPlayerTrail', () => {
  it('returns a 5 s polyline oldest -> newest with normalized ages', () => {
    const traj = lineTrajectory([0, 0, 0], [45, 0], 0, 30);
    const trail = extractPlayerTrail(traj, 12.34);
    expect(trail[0]!.t).toBeCloseTo(7.34, 9);
    expect(trail[0]!.age).toBe(1);
    expect(trail[trail.length - 1]!.t).toBe(12.34);
    expect(trail[trail.length - 1]!.age).toBe(0);
    expect(trail[trail.length - 1]!.pos[0]).toBeCloseTo(45 * 12.34, 6);
    for (let i = 1; i < trail.length; i++) {
      expect(trail[i]!.t).toBeGreaterThan(trail[i - 1]!.t);
      expect(trail[i]!.age).toBeLessThanOrEqual(trail[i - 1]!.age);
    }
    expect(trail.length).toBeGreaterThanOrEqual(50);
    expect(extractPlayerTrail(traj, -1)).toEqual([]);
  });

  it('marks teleports as segment breaks', () => {
    const traj: TrajectorySampleTuple[] = [
      [0, 0, 0, 0, 1, 0, 45, 0, 0],
      [1, 45, 0, 0, 1, 0, 45, 0, 0],
      [2, 400, 0, 400, 1, 0, 45, 0, 0],
      [3, 445, 0, 400, 1, 0, 45, 0, 0],
    ];
    const trail = extractPlayerTrail(traj, 3, 5);
    expect(trail.filter((p) => p.breakBefore).length).toBe(1);
    expect(trail.find((p) => p.breakBefore)!.t).toBe(2);
  });
});

describe('AC-6 entity samplers', () => {
  const p = makePayload();

  it('cipher progress rings: interpolate while active, hold when idle, complete at completed_at', () => {
    const c = p.entities.ciphers[0]!;
    expect(sampleCipherAtTime(c, 5)).toEqual({ progressPct: 0, activeFixerCount: 0, isCompleted: false });
    expect(sampleCipherAtTime(c, 20).progressPct).toBeCloseTo(20, 9);
    expect(sampleCipherAtTime(c, 20).activeFixerCount).toBe(1);
    expect(sampleCipherAtTime(c, 40)).toEqual({ progressPct: 40, activeFixerCount: 0, isCompleted: false });
    const s60 = sampleCipherAtTime(c, 60);
    expect(s60.progressPct).toBeCloseTo(65, 9);
    expect(s60.activeFixerCount).toBe(2);
    expect(sampleCipherAtTime(c, 80)).toEqual({ progressPct: 100, activeFixerCount: 0, isCompleted: true });
  });

  it('pallet upright -> dropped -> broken transitions', () => {
    const pal = p.entities.pallets[0]!;
    expect(samplePalletAtTime(pal, 39.9)).toBe('upright');
    expect(samplePalletAtTime(pal, 40)).toBe('dropped');
    expect(samplePalletAtTime(pal, 59.9)).toBe('dropped');
    expect(samplePalletAtTime(pal, 60)).toBe('broken');
    expect(samplePalletAtTime({ ...pal, dropped_at: null, broken_at: null }, 1000)).toBe('upright');
  });

  it('chair countdown: occupancy, victim and elimination percent', () => {
    const chair = p.entities.chairs[0]!;
    expect(sampleChairAtTime(chair, 99)).toEqual({ isOccupied: false, victimUid: null, eliminationPct: 0 });
    const s = sampleChairAtTime(chair, 115);
    expect(s.isOccupied).toBe(true);
    expect(s.victimUid).toBe(3);
    expect(s.eliminationPct).toBeCloseTo(25, 9);
    expect(sampleChairAtTime(chair, 145).eliminationPct).toBeCloseTo(75, 9);
    expect(sampleChairAtTime(chair, 160).isOccupied).toBe(false);
  });

  it('gate unpowered -> powered -> opened', () => {
    const g = p.entities.exit_gates[0]!;
    expect(sampleGateAtTime(g, 100)).toBe('unpowered');
    expect(sampleGateAtTime(g, 120)).toBe('powered');
    expect(sampleGateAtTime(g, 150)).toBe('opened');
  });
});

describe('AC-6 pulses, chase, window seal', () => {
  const events = sortEventsByTime(makePayload().events);

  it('extracts hit_attack / skill_cast pulses inside the 1.2 s window with progress', () => {
    const pulses = getActivePulsesAtTime(events, 21.1);
    const kinds = pulses.map((x) => x.kind).sort();
    expect(kinds).toEqual(['hit_attack', 'skill_cast']);
    const hit = pulses.find((x) => x.kind === 'hit_attack')!;
    expect(hit.progress).toBeCloseTo(1.1 / 1.2, 9);
    expect(hit.pos).toEqual([50, 0, 0]);
  });

  it('extracts Flywheel tag_add pulses and ignores other tags / expired events', () => {
    const pulses = getActivePulsesAtTime(events, 22.6);
    expect(pulses.map((x) => x.kind)).toEqual(['flywheel']);
    expect(pulses[0]!.progress).toBeCloseTo(0.6 / 1.2, 9);
    expect(isFlywheelEvent(ev(9, 1, 'tag_add', { label_zh: '使用飞轮效应' }))).toBe(true);
    expect(isFlywheelEvent(ev(9, 1, 'skill_cast', { meta: { tag: 'Flywheel' } }))).toBe(false);
    expect(getActivePulsesAtTime(events, 25)).toEqual([]);
  });

  it('tracks chase_state on/off and window_block seal within 20 s', () => {
    expect(isChaseActiveAtTime(events, 2, 39)).toBe(false);
    expect(isChaseActiveAtTime(events, 2, 45)).toBe(true);
    expect(isChaseActiveAtTime(events, 2, 60)).toBe(false);
    expect(isChaseActiveAtTime(events, 2, 10, [{ survivor_uid: 2, start_t: 5, end_t: 15 }])).toBe(true);
    expect(isWindowSealedAtTime(events, 500, 45)).toBe(true);
    expect(isWindowSealedAtTime(events, 500, 50.5)).toBe(false);
    expect(isWindowSealedAtTime(events, 501, 31)).toBe(false);
  });
});
