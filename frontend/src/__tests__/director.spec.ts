// @vitest-environment node
import { expect, it } from 'vitest';
import type { MatchAnalyticsPayload, Replay2DPayload } from '@idv/replay-renderer';
import { buildDirectorScript, firstChaseCue, opening60 } from '../tactical/director';

it('partitions playback, follows the chase target and inserts a 1.2s beat', () => {
  const replay = { time: { duration_s: 90 }, markers: [{ t: 12, label_zh: '首挂' }], events: [] } as unknown as Replay2DPayload;
  const analytics = {
    hunter_metrics: { first_chase_t: 10 },
    chase_segments: [{ start_t: 10, end_t: 20, survivor_uid: 22, survivor_name: '先知' }],
  } as unknown as MatchAnalyticsPayload;
  const script = buildDirectorScript(replay, analytics);
  expect(firstChaseCue(replay, analytics)).toBe(7);
  expect(script).toEqual([
    expect.objectContaining({ start: 0, end: 8, mode: 'fast', speed: 4 }),
    expect.objectContaining({ start: 8, end: 12, mode: 'focus', followUid: 22, speed: 1 }),
    expect.objectContaining({ start: 12, end: 12, mode: 'beat', pauseMs: 1200 }),
    expect.objectContaining({ start: 12, end: 22, mode: 'focus', followUid: 22 }),
    expect.objectContaining({ start: 22, end: 90, mode: 'fast' }),
  ]);
  expect(opening60(replay)).toMatchObject({ start: 0, end: 60, mode: 'opening60', speed: 1 });
});
