import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Replay2DPayload } from '@idv/replay-renderer';
import { MAPS_DATA } from '../tactical/maps';
import { computeReplayLink, projectReplayPoint, unprojectReplayPoint } from '../tactical/replay-link';

describe('replay registration', () => {
  it('registers the seven read-only cached replays', () => {
    const cache = '../backend/data/cache/';
    const fixtures = readdirSync(cache).filter((id) => /^[0-9a-f]{24}$/.test(id)).sort().map((id) => {
      const replay = JSON.parse(readFileSync(cache + id + '/replay_2d.json', 'utf8')) as Replay2DPayload;
      const link = computeReplayLink(replay);
      return {
        matchId: id, mapName: replay.match.map_name,
        positions: replay.entities.ciphers.map(({ pos_id, pos }) => ({ index: pos_id === null ? null : pos_id % 100, pos })),
        confidence: link?.confidence ?? 0, groupIndex: link?.groupIndex ?? null,
        groupMatch: link?.groupMatch ?? 'none', matchedCipherIds: link?.matchedCipherIds ?? [],
      };
    });
    const fixturePath = 'src/tactical/replay-link.fixtures.json';
    if (process.env.IDV_REFRESH_LINK_FIXTURES === '1') writeFileSync(fixturePath, JSON.stringify(fixtures, null, 2) + '\n');
    expect(fixtures).toHaveLength(7);
    expect(fixtures.filter((row) => row.confidence >= 0.8 && row.groupMatch === 'exact').length).toBeGreaterThanOrEqual(6);
    expect(fixtures).toEqual(JSON.parse(readFileSync(fixturePath, 'utf8')));
    const posIdByMap = new Map<string, string>();
    fixtures.forEach((row) => {
      expect(new Set(row.matchedCipherIds).size).toBe(row.matchedCipherIds.length);
      if (row.groupMatch !== 'exact') return;
      const group = MAPS_DATA.find((map) => map.mapName === row.mapName)!.cipherCombinations[row.groupIndex!]!;
      expect(new Set(row.matchedCipherIds)).toEqual(new Set(group));
      row.positions.forEach(({ index }, i) => {
        if (index === null) return;
        const key = row.mapName + '/' + index;
        const cipher = row.matchedCipherIds[i]!;
        const prior = posIdByMap.get(key);
        if (prior !== undefined) expect(cipher).toBe(prior);
        else posIdByMap.set(key, cipher);
      });
    });
  });

  it('inverts all eight fitted rotations and reflections for draft overlays', () => {
    for (let dihedral = 0; dihedral < 8; dihedral++) {
      const transform = { s: 0.41, dihedral, tx: -32, ty: 57 };
      const [x, z] = unprojectReplayPoint(projectReplayPoint([287, -118], transform), transform);
      expect(x).toBeCloseTo(287);
      expect(z).toBeCloseTo(-118);
    }
  });

  it('keeps the tactical engines independent of browser APIs', () => {
    for (const engine of ['replay-link', 'practice', 'director', 'link-state']) {
      const source = readFileSync('src/tactical/' + engine + '.ts', 'utf8');
      expect(source).not.toMatch(/\b(?:document|window|mapTone|HTMLElement|HTMLCanvasElement)\b/);
    }
  });
});
