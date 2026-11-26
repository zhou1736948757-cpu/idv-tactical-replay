// @vitest-environment node
import { expect, it } from 'vitest';
import { appendPracticeHistory, evaluatePractice, readPracticeHistory } from '../tactical/practice';
import type { ReplayLinkResult } from '../tactical/replay-link';

const truth: ReplayLinkResult = {
  mapId: 0, matchId: '1'.repeat(24), confidence: 1, groupIndex: 0, groupMatch: 'exact',
  transform: { s: 1, dihedral: 0, tx: 0, ty: 0 }, matchedCipherIds: ['M_4', 'M_1'],
  truthMarks: {}, lockCipherId: 'M_4', spawn: { survivorZones: [0, 1, 2, 3], hunterZone: 4, perPlayer: [] },
};
it('scores unique survivor hits, hunter, cipher set and lock independently', () => {
  const perfect = evaluatePractice({ survivorZones: [0, 1, 2, 3], hunterZone: 4, groupIndex: 0, lockCipherId: 'M_4' }, truth);
  expect(perfect).toMatchObject({ totalScore: 100, survivorHits: 4, hunterHit: true, lockCipherMatch: true, cipherHitCount: null });
  const partial = evaluatePractice({ survivorZones: [0, 0, 8], hunterZone: 6, groupIndex: 1, lockCipherId: null, cipherIds: ['M_4', 'M_4'] }, truth);
  expect(partial).toMatchObject({ totalScore: 12, survivorHits: 1, hunterHit: false, lockCipherMatch: false, cipherHitCount: 1 });
});
it('keeps 200 sanitized history records', () => {
  let raw = '[{"matchId":"bad","totalScore":900}]';
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  expect(readPracticeHistory(storage)).toEqual([]);
  for (let at = 0; at <= 200; at++) appendPracticeHistory(storage, {
    matchId: truth.matchId, mapId: 0, at, totalScore: 40, survivorHits: 4, hunterHit: false, lockCipherMatch: false,
  });
  const history = readPracticeHistory(storage);
  expect(history).toHaveLength(200);
  expect(history[0]?.at).toBe(1);
});
