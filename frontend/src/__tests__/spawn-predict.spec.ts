import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAPS_DATA,
  PIL_MAP_COUNT,
  PREDICT_HUNTER_ROLE_KEYS,
  SPAWN_PREDICT_DATA,
  TAC_HUNTER_ROLES,
  applySpawnPredictionToBoard,
  calculateZoneCenters,
  cellIdToPilZone,
  consumeSandboxBoardHandoff,
  emitSandboxBoardHandoff,
  findPredictHunterIndex,
  formatCellCoord,
  getActiveMapId,
  loadBoardState,
  mapsZonesRelative,
  onSandboxBoardHandoff,
  pickRandomRealRecord,
  pilZoneToCellId,
  predictHunterPortraitUrl,
  predictHunterSpawn,
  predictHunterToTacRoleKey,
  saveBoardState,
  topSurvivorLayouts,
  createEmptyBoardState,
  type PilMapId,
  type SandboxBoardHandoff,
  type StorageLike,
} from '@/tactical';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_ASSETS_DIR = path.resolve(__dirname, '../../public/assets');
const JSON_PATH = path.resolve(__dirname, '../tactical/spawn-predictions.json');

function makeMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/** Independent reference implementation matching zhou1736948757-cpu/notes/template.html. */
function referencePredict(mapId: number, hunterIdx: number, survCells: number[]) {
  const keyOf = (s: readonly number[]) => [...s].sort((a, b) => a - b).join('-');
  const pool = SPAWN_PREDICT_DATA.records.filter(
    (r) => r[0] === mapId && (hunterIdx < 0 || r[1] === hunterIdx),
  );
  const inputKey = keyOf(survCells);
  const exact = pool.filter((r) => keyOf([r[2], r[3], r[4], r[5]]) === inputKey);
  const score: Record<number, number> = {};
  const hCount: Record<number, number> = {};
  let mode: 'exact' | 'fuzzy';

  if (exact.length >= 3) {
    mode = 'exact';
    for (const r of exact) {
      score[r[6]] = (score[r[6]] || 0) + 1;
      hCount[r[6]] = (hCount[r[6]] || 0) + 1;
    }
  } else {
    mode = 'fuzzy';
    for (const r of pool) {
      const s = [r[2], r[3], r[4], r[5]];
      const ov = s.filter((v) => survCells.includes(v)).length;
      if (!ov) continue;
      score[r[6]] = (score[r[6]] || 0) + ov * ov;
      hCount[r[6]] = (hCount[r[6]] || 0) + 1;
    }
  }
  for (const k of survCells) delete score[k];
  const tot = Object.values(score).reduce((a, b) => a + b, 0) || 1;
  for (const k of Object.keys(score)) score[Number(k)] = score[Number(k)]! / tot;
  return { mode, exactCount: exact.length, score, hCount };
}

describe('Offline Spawn-Predictions Dataset Integrity (spawn-predictions.json)', () => {
  it('contains exact build_data.py counts, 9 maps, 35 hunters, GEO rects, and zero external URLs', () => {
    const rawText = fs.readFileSync(JSON_PATH, 'utf8');
    expect(rawText).not.toMatch(/https?:\/\//i);

    expect(SPAWN_PREDICT_DATA.meta.raw).toBe(1357);
    expect(SPAWN_PREDICT_DATA.meta.kept).toBe(1353);
    expect(SPAWN_PREDICT_DATA.meta.reviewed).toBe(324);
    expect(SPAWN_PREDICT_DATA.meta.solo).toBe(523);
    expect(SPAWN_PREDICT_DATA.records).toHaveLength(1353);

    expect(SPAWN_PREDICT_DATA.maps).toHaveLength(PIL_MAP_COUNT);
    for (let id = 0; id < PIL_MAP_COUNT; id++) {
      const mapName = SPAWN_PREDICT_DATA.maps[id]!;
      expect(mapName).toBe(MAPS_DATA[id]!.mapName);
      const geo = SPAWN_PREDICT_DATA.geo[mapName];
      expect(geo).toBeDefined();
      expect(geo!.ar).toBeGreaterThan(0.5);
      const validCells = SPAWN_PREDICT_DATA.cells[mapName]!;
      expect(Object.keys(geo!.cells).map(Number).sort((a, b) => a - b)).toEqual([...validCells]);
    }

    expect(SPAWN_PREDICT_DATA.hunters).toHaveLength(35);
    expect(PREDICT_HUNTER_ROLE_KEYS).toHaveLength(35);

    // Every portrait URL resolves to a shipped local asset
    const sealRel = decodeURI(predictHunterPortraitUrl(-1)).replace(/^\/assets\//, '');
    expect(fs.existsSync(path.join(PUBLIC_ASSETS_DIR, sealRel))).toBe(true);
    for (let i = 0; i < 35; i++) {
      const url = predictHunterPortraitUrl(i);
      expect(url.startsWith('/assets/hunters/')).toBe(true);
      const rel = decodeURI(url).replace(/^\/assets\//, '');
      expect(fs.existsSync(path.join(PUBLIC_ASSETS_DIR, rel)), `Missing ${rel}`).toBe(true);
    }
  });
});

describe('Hunter Resolution & Universal Cell <-> PIL Zone Bijection', () => {
  it('maps all 35 hunters bijectively to TAC_HUNTER_ROLES and handles quote-wrapped names & aliases', () => {
    for (let i = 0; i < SPAWN_PREDICT_DATA.hunters.length; i++) {
      const name = SPAWN_PREDICT_DATA.hunters[i]!;
      expect(findPredictHunterIndex(name)).toBe(i);
      const roleKey = predictHunterToTacRoleKey(i);
      expect(roleKey).not.toBeNull();
      expect(TAC_HUNTER_ROLES[roleKey!]).toBeDefined();
      expect(findPredictHunterIndex(roleKey!)).toBe(i);
    }

    expect(findPredictHunterIndex('"歌剧演员"')).toBe(findPredictHunterIndex('operaSinger'));
    expect(findPredictHunterIndex('“记录员”')).toBe(findPredictHunterIndex('clerk'));
    expect(findPredictHunterIndex('"跛脚羊"')).toBe(findPredictHunterIndex('goatman'));
    expect(findPredictHunterIndex('"台球手"')).toBe(findPredictHunterIndex('cueist'));
    expect(findPredictHunterIndex('"牙医"')).toBe(findPredictHunterIndex('dentist'));
    expect(findPredictHunterIndex('宿伞')).toBe(findPredictHunterIndex('宿伞之魂'));
    expect(findPredictHunterIndex('伞')).toBe(findPredictHunterIndex('wuchang'));
    expect(findPredictHunterIndex('邦邦')).toBe(findPredictHunterIndex('guard26'));
    expect(findPredictHunterIndex('约瑟夫')).toBe(findPredictHunterIndex('photographer'));
    expect(findPredictHunterIndex('女巫')).toBe(findPredictHunterIndex('dreamWitch'));
    expect(findPredictHunterIndex('不限')).toBe(-1);
    expect(findPredictHunterIndex('unknown-hunter')).toBe(-1);
    expect(predictHunterToTacRoleKey(-1)).toBeNull();
    expect(predictHunterToTacRoleKey(99)).toBeNull();
  });

  it('bijects cellId <-> pilZone identically across all 9 maps (3x3, 3x4, and rotated Eversleeping)', () => {
    for (let id = 0; id < PIL_MAP_COUNT; id++) {
      const mapId = id as PilMapId;
      const mapName = SPAWN_PREDICT_DATA.maps[mapId]!;
      const validCells = SPAWN_PREDICT_DATA.cells[mapName]!;
      const zones = mapsZonesRelative[mapId]!;
      expect(validCells).toHaveLength(zones.length);

      const seenZones = new Set<number>();
      for (const cid of validCells) {
        const z = cellIdToPilZone(mapId, cid);
        expect(z).toBeGreaterThanOrEqual(0);
        expect(z).toBeLessThan(zones.length);
        seenZones.add(z);
        expect(pilZoneToCellId(mapId, z)).toBe(cid);
      }
      expect(seenZones.size).toBe(zones.length);
    }

    // Eversleeping Town (6): cemetery (1,4) <-> zoneIdx 9; (2,4)/(3,4) are invalid
    expect(cellIdToPilZone(6, 14)).toBe(9);
    expect(pilZoneToCellId(6, 9)).toBe(14);
    expect(cellIdToPilZone(6, 24)).toBe(-1);
    expect(cellIdToPilZone(6, 34)).toBe(-1);

    // Lakeside Village (3) & Moonlit River Park (4): 4th column 14,24,34 <-> 9,10,11
    for (const id of [3, 4] as const) {
      expect(cellIdToPilZone(id, 14)).toBe(9);
      expect(cellIdToPilZone(id, 24)).toBe(10);
      expect(cellIdToPilZone(id, 34)).toBe(11);
      expect(pilZoneToCellId(id, 9)).toBe(14);
      expect(pilZoneToCellId(id, 10)).toBe(24);
      expect(pilZoneToCellId(id, 11)).toBe(34);
    }
    expect(formatCellCoord(14)).toBe('(1,4)');
  });
});

describe('Opening Spawn Predictor Algorithm & Top Layouts', () => {
  it('handles need-4, exact (>=3) parity, fuzzy (overlap^2) parity, normFree, myAltComparison & Top-20 records', () => {
    const need4 = predictHunterSpawn({ mapId: 0, hunterIdx: -1, survCells: [11, 12, 23], myAltCell: 33 });
    expect(need4.status).toBe('need-4');
    expect(need4.best).toBeNull();
    expect(need4.myAltComparison?.status).toBe('pending');

    // Exact mode: use Top-1 layout on Arms Factory (0) across all hunters (guaranteed >= 3 records)
    const layouts0 = topSurvivorLayouts(0, -1, 6);
    expect(layouts0).toHaveLength(6);
    expect(layouts0[0]!.count).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < layouts0.length; i++) {
      expect(layouts0[i - 1]!.count).toBeGreaterThanOrEqual(layouts0[i]!.count);
    }

    const exactCells = layouts0[0]!.cells;
    const exactRef = referencePredict(0, -1, exactCells);
    expect(exactRef.mode).toBe('exact');

    const exactRes = predictHunterSpawn({
      mapId: 0,
      hunterIdx: -1,
      survCells: exactCells,
      myAltCell: layouts0[0]!.topHunterCell,
    });
    expect(exactRes.status).toBe('ok');
    expect(exactRes.mode).toBe('exact');
    expect(exactRes.exactCount).toBe(exactRef.exactCount);
    expect(exactRes.best).not.toBeNull();
    expect(exactRes.matchedRecords.length).toBeLessThanOrEqual(20);
    expect(exactRes.matchedRecords.length).toBeGreaterThan(0);

    // Every occupied survivor cell has 0 probability (normFree) and free probabilities sum to 1
    for (const s of exactCells) {
      expect(exactRes.cellProbs[s]).toBe(0);
    }
    const probSum = Object.values(exactRes.cellProbs).reduce((a, b) => a + b, 0);
    expect(probSum).toBeCloseTo(1, 9);
    for (const [k, v] of Object.entries(exactRef.score)) {
      expect(exactRes.cellProbs[Number(k)]).toBeCloseTo(v, 10);
    }
    expect(exactRes.alts.length).toBeLessThanOrEqual(2);
    for (const alt of exactRes.alts) {
      expect(alt.prob).toBeGreaterThan(0.03);
    }

    // myAltComparison match vs mismatch
    expect(exactRes.myAltComparison?.status).toBe('match');
    expect(exactRes.myAltComparison?.deltaPct).toBe(0);
    const otherCell = exactRes.validCells.find((c) => c !== exactRes.best!.cellId && !exactCells.includes(c))!;
    const mismatchRes = predictHunterSpawn({
      mapId: 0,
      hunterIdx: -1,
      survCells: exactCells,
      myAltCell: otherCell,
    });
    expect(mismatchRes.myAltComparison?.status).toBe('mismatch');
    expect(mismatchRes.myAltComparison!.deltaPct).toBeLessThanOrEqual(0);

    // Fuzzy mode: find a rare specific hunter + layout with < 3 exact matches
    const fuzzyQueryCells = [11, 12, 13, 21];
    const operaIdx = findPredictHunterIndex('歌剧演员');
    const fuzzyRef = referencePredict(6, operaIdx, fuzzyQueryCells);
    expect(fuzzyRef.mode).toBe('fuzzy');

    const fuzzyRes = predictHunterSpawn({
      mapId: 6,
      hunterIdx: operaIdx,
      survCells: fuzzyQueryCells,
    });
    expect(fuzzyRes.status).toBe('ok');
    expect(fuzzyRes.mode).toBe('fuzzy');
    for (const s of fuzzyQueryCells) {
      expect(fuzzyRes.cellProbs[s]).toBe(0);
    }
    for (const [k, v] of Object.entries(fuzzyRef.score)) {
      expect(fuzzyRes.cellProbs[Number(k)]).toBeCloseTo(v, 10);
    }

    // Verify sourceType ('solo' | 'vod') and reviewed flags reflect real records
    const allRecs = predictHunterSpawn({ mapId: 1, hunterIdx: -1, survCells: [11, 13, 31, 33] }).matchedRecords;
    expect(allRecs.length).toBeGreaterThan(0);
    for (const r of allRecs) {
      expect(['solo', 'vod']).toContain(r.sourceType);
      expect(typeof r.reviewed).toBe('boolean');
    }

    // Deterministic random pick
    const picked0 = pickRandomRealRecord(0, -1, () => 0);
    const pickedLast = pickRandomRealRecord(0, -1, () => 0.9999);
    expect(picked0).not.toBeNull();
    expect(pickedLast).not.toBeNull();
    expect(picked0!.mapId).toBe(0);
    expect(picked0!.survCells).toHaveLength(4);
  });
});

describe('Stage 04 -> Stage 02 Sandbox Board Handoff Contract', () => {
  it('places 4 survivor + 1 glowing hunter tokens, replaces prior previews, and delivers pub/sub + pending handoff', () => {
    const st = makeMemoryStorage();
    // Seed an existing non-preview user token that must be preserved
    const existing = createEmptyBoardState(6);
    existing.tokens.push({ tid: 1, role: 'mercenary', x: 0.2, y: 0.2 });
    existing.tokenSeq = 1;
    saveBoardState(6, existing, st);

    const events: SandboxBoardHandoff[] = [];
    const unsub = onSandboxBoardHandoff((h) => events.push(h));

    const operaIdx = findPredictHunterIndex('歌剧演员');
    const res1 = applySpawnPredictionToBoard(
      6,
      { survCells: [11, 21, 32, 33], hunterCell: 14, hunterIdx: operaIdx },
      st,
    );

    expect(res1.mapId).toBe(6);
    expect(res1.survivorZones).toEqual([0, 1, 5, 8]);
    expect(res1.hunterZone).toBe(9);
    expect(res1.survivorTids).toHaveLength(4);
    expect(res1.hunterTid).not.toBeNull();
    expect(getActiveMapId(st)).toBe(6);

    const loaded = loadBoardState(6, st);
    // 1 preserved user token + 4 preview survivors + 1 preview hunter = 6
    expect(loaded.tokens).toHaveLength(6);
    expect(loaded.tokens.some((t) => t.role === 'mercenary' && !t.spawnPreview)).toBe(true);
    const hunterTok = loaded.tokens.find((t) => t.tid === res1.hunterTid)!;
    expect(hunterTok.role).toBe('operaSinger');
    expect(hunterTok.glow).toBe(true);
    expect(hunterTok.spawnPreview).toBe(true);
    const centers6 = calculateZoneCenters(mapsZonesRelative[6]!);
    expect(hunterTok.x).toBeCloseTo(centers6[9]!.x, 9);
    expect(hunterTok.y).toBeCloseTo(centers6[9]!.y, 9);

    // Live listener and one-shot consume both received the handoff
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe('spawn-predict');
    expect(events[0]!.enableZones).toBe(true);
    expect(events[0]!.whiteboard).toBe(true);
    expect(consumeSandboxBoardHandoff()?.highlightTid).toBe(res1.hunterTid);
    expect(consumeSandboxBoardHandoff()).toBeNull();

    // Second apply replaces prior spawnPreview tokens rather than duplicating them
    const res2 = applySpawnPredictionToBoard(
      6,
      { survCells: [12, 22, 31, 14], hunterCell: 33, hunterIdx: -1 },
      st,
    );
    const loaded2 = loadBoardState(6, st);
    expect(loaded2.tokens).toHaveLength(6);
    expect(loaded2.tokens.find((t) => t.tid === res2.hunterTid)?.camp).toBe('hunter');
    expect(events).toHaveLength(2);

    // Explicit emitSandboxBoardHandoff + unsubscribe check
    unsub();
    emitSandboxBoardHandoff({ mapId: 3, source: 'manual', enableZones: false });
    expect(events).toHaveLength(2);
    expect(consumeSandboxBoardHandoff()?.mapId).toBe(3);
  });
});
