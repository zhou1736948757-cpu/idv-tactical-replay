/**
 * Pure-TS Opening Spawn Predictor Engine, universal cell <-> PIL zone bijection,
 * and Stage 04 -> Stage 02 Sandbox board handoff (zero DOM, zero external URLs).
 */
import { calculateZoneCenters, mapsZonesRelative } from './geo';
import { MAPS_DATA, resolvePilMapId } from './maps';
import { withBaseUrl } from '@/lib/assetUrl';
import {
  consumeSandboxBoardHandoff,
  emitSandboxBoardHandoff,
  loadBoardState,
  onSandboxBoardHandoff,
  peekSandboxBoardHandoff,
  saveBoardState,
  setActiveMapId,
} from './persist';
import { TAC_HUNTER_ROLES } from './roles';
import rawDataset from './spawn-predictions.json';
import type {
  PilMapId,
  SandboxBoardHandoff,
  StorageLike,
  TacticalBoardState,
  TacticalToken,
} from './types';

export {
  consumeSandboxBoardHandoff,
  emitSandboxBoardHandoff,
  onSandboxBoardHandoff,
  peekSandboxBoardHandoff,
};

/** Compact record tuple: [mapIdx, hunterIdx, s1, s2, s3, s4, hc, flags, filename]. */
export type SpawnPredictRawRecord = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  string,
];

export interface SpawnPredictGeoMap {
  readonly ar: number;
  readonly cells: Readonly<Record<string, readonly [number, number, number, number]>>;
}

export interface SpawnPredictMeta {
  readonly raw: number;
  readonly kept: number;
  readonly dropped: Readonly<Record<string, number>>;
  readonly reviewed: number;
  readonly solo: number;
}

export interface SpawnPredictDataset {
  readonly maps: readonly string[];
  readonly hunters: readonly string[];
  readonly cols: Readonly<Record<string, number>>;
  readonly cells: Readonly<Record<string, readonly number[]>>;
  readonly geo: Readonly<Record<string, SpawnPredictGeoMap>>;
  readonly records: readonly SpawnPredictRawRecord[];
  readonly meta: SpawnPredictMeta;
}

export const SPAWN_PREDICT_DATA: SpawnPredictDataset = rawDataset as unknown as SpawnPredictDataset;

/** 1-to-1 mapping from SPAWN_PREDICT_DATA.hunters[0..34] to TAC_HUNTER_ROLES keys. */
export const PREDICT_HUNTER_ROLE_KEYS: readonly string[] = Object.freeze([
  'hellEmber',        // 0  厂长
  'smileyFace',       // 1  小丑
  'gameKeeper',       // 2  鹿头
  'theRipper',        // 3  杰克
  'soulWeaver',       // 4  蜘蛛
  'geisha',           // 5  红蝶
  'theFeaster',       // 6  黄衣之主
  'wuchang',          // 7  宿伞之魂
  'photographer',     // 8  摄影师
  'madEyes',          // 9  疯眼
  'dreamWitch',       // 10 梦之女巫
  'axeBoy',           // 11 爱哭鬼
  'evilReptilian',    // 12 孽蜥
  'bloodyQueen',      // 13 红夫人
  'guard26',          // 14 26号守卫
  'disciple',         // 15 使徒
  'violinist',        // 16 小提琴家
  'sculptor',         // 17 雕刻家
  'undead',           // 18 博士
  'theBreakingWheel', // 19 破轮
  'naiad',            // 20 渔女
  'waxArtist',        // 21 蜡像师
  'nightmare',        // 22 噩梦
  'clerk',            // 23 记录员
  'hermit',           // 24 隐士
  'nightWatch',       // 25 守夜人
  'operaSinger',      // 26 歌剧演员
  'foolsGold',        // 27 愚人金
  'theShadow',        // 28 时空之影
  'goatman',          // 29 跛脚羊
  'hullabaloo',       // 30 喧嚣
  'peddler',          // 31 杂货商
  'cueist',           // 32 台球手
  'queenBee',         // 33 女王蜂
  'dentist',          // 34 牙医
]);

const HUNTER_NAME_ALIASES: Readonly<Record<string, number>> = Object.freeze({
  宿伞: 7,
  伞: 7,
  黑白: 7,
  约瑟夫: 8,
  女巫: 10,
  邦邦: 14,
  小提琴: 16,
  黄衣: 6,
  歌剧: 26,
  杂货: 31,
  台球: 32,
  iv: 28,
  艾维: 28,
  伊塔库亚: 25,
  安: 15,
  珀西: 18,
  蜡像: 21,
  雕刻: 17,
});

function cleanHunterToken(input: string): string {
  return input.replace(/["'“”‘’「」『』\s]/g, '').trim();
}

const HUNTER_LOOKUP_MAP: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  SPAWN_PREDICT_DATA.hunters.forEach((name, idx) => {
    map.set(cleanHunterToken(name).toLowerCase(), idx);
  });
  PREDICT_HUNTER_ROLE_KEYS.forEach((roleKey, idx) => {
    map.set(roleKey.toLowerCase(), idx);
    const roleDef = TAC_HUNTER_ROLES[roleKey];
    if (roleDef?.name) {
      map.set(cleanHunterToken(roleDef.name).toLowerCase(), idx);
    }
  });
  for (const [alias, idx] of Object.entries(HUNTER_NAME_ALIASES)) {
    map.set(cleanHunterToken(alias).toLowerCase(), idx);
  }
  return map;
})();

/**
 * Resolve a hunter display name (including quote-wrapped game names like `"歌剧演员"`),
 * common alias (`宿伞`, `邦邦`, `约瑟夫`, `女巫`), or `TAC_ROLES` key (`operaSinger`, `wuchang`)
 * to its `0..34` index in `SPAWN_PREDICT_DATA.hunters`, or `-1` if unknown / `"不限"`.
 */
export function findPredictHunterIndex(nameOrRole: string | null | undefined): number {
  if (!nameOrRole || typeof nameOrRole !== 'string') return -1;
  const clean = cleanHunterToken(nameOrRole);
  if (!clean || clean === '不限' || clean === 'all') return -1;
  const hit = HUNTER_LOOKUP_MAP.get(clean.toLowerCase());
  return hit !== undefined ? hit : -1;
}

/**
 * Map a `0..34` predictor hunter index to its `TAC_HUNTER_ROLES` key (or `null` for `-1` / out of range).
 */
export function predictHunterToTacRoleKey(hunterIdx: number): string | null {
  if (!Number.isInteger(hunterIdx) || hunterIdx < 0 || hunterIdx >= PREDICT_HUNTER_ROLE_KEYS.length) {
    return null;
  }
  return PREDICT_HUNTER_ROLE_KEYS[hunterIdx] ?? null;
}

/**
 * Local portrait path for a predictor hunter index (`-1` -> `/assets/seal.jpg`).
 */
export function predictHunterPortraitUrl(hunterIdx: number): string {
  if (!Number.isInteger(hunterIdx) || hunterIdx < 0 || hunterIdx >= SPAWN_PREDICT_DATA.hunters.length) {
    return withBaseUrl('/assets/seal.jpg');
  }
  return withBaseUrl(encodeURI(`/assets/hunters/${SPAWN_PREDICT_DATA.hunters[hunterIdx]!}.png`));
}

// ---------------------------------------------------------------------------
// Universal Cell <-> PIL Zone Bijection
// ---------------------------------------------------------------------------

export function formatCellCoord(cellId: number): string {
  return `(${Math.floor(cellId / 10)},${cellId % 10})`;
}

export function getMapValidCells(mapId: PilMapId | number | string): readonly number[] {
  const id = resolvePilMapId(mapId);
  const mapName = SPAWN_PREDICT_DATA.maps[id] ?? MAPS_DATA[id]!.mapName;
  return SPAWN_PREDICT_DATA.cells[mapName] ?? [];
}

/**
 * Universal bijection from dataset cell ID `r*10 + c` to PIL `mapsZonesRelative[mapId]` index.
 * Holds identically across 3x3 maps, 3x4 Lakeside/Moonlit (`14,24,34 -> 9,10,11`),
 * and 90°-CW-rotated Eversleeping Town (`14 -> 9`).
 */
export function cellIdToPilZone(mapId: PilMapId | number | string, cellId: number): number {
  if (!Number.isInteger(cellId)) return -1;
  const id = resolvePilMapId(mapId);
  const valid = getMapValidCells(id);
  if (!valid.includes(cellId)) return -1;
  const r = Math.floor(cellId / 10);
  const c = cellId % 10;
  const zoneIdx = (c - 1) * 3 + (r - 1);
  const zoneCount = mapsZonesRelative[id]?.length ?? 0;
  return zoneIdx >= 0 && zoneIdx < zoneCount ? zoneIdx : -1;
}

/**
 * Inverse bijection from PIL `mapsZonesRelative[mapId]` index to dataset cell ID `r*10 + c`.
 */
export function pilZoneToCellId(mapId: PilMapId | number | string, zoneIdx: number): number {
  const id = resolvePilMapId(mapId);
  const zoneCount = mapsZonesRelative[id]?.length ?? 0;
  if (!Number.isInteger(zoneIdx) || zoneIdx < 0 || zoneIdx >= zoneCount) return -1;
  const c = Math.floor(zoneIdx / 3) + 1;
  const r = (zoneIdx % 3) + 1;
  const cellId = r * 10 + c;
  const valid = getMapValidCells(id);
  return valid.includes(cellId) ? cellId : -1;
}

// ---------------------------------------------------------------------------
// Prediction Engine
// ---------------------------------------------------------------------------

export interface SpawnPredictQuery {
  mapId: PilMapId | number | string;
  hunterIdx?: number | null;
  survCells: readonly number[];
  myAltCell?: number | null;
}

export interface SpawnPredictCellRank {
  cellId: number;
  coord: string;
  prob: number;
  pct: number;
  rawCount: number;
  pilZone: number;
  zoneName: string;
}

export interface SpawnPredictAltComparison {
  cellId: number;
  coord: string;
  status: 'pending' | 'match' | 'mismatch';
  isMatch: boolean;
  prob: number;
  pct: number;
  deltaPct: number;
  bestCellId: number | null;
  bestPct: number;
}

export interface SpawnPredictMatchedRecord {
  mapId: PilMapId;
  hunterIdx: number;
  hunterName: string;
  survCells: [number, number, number, number];
  hunterCell: number;
  overlap: number;
  reviewed: boolean;
  sourceType: 'solo' | 'vod';
  filename: string;
}

export interface SpawnPredictResult {
  status: 'need-4' | 'no-data' | 'ok';
  mapId: PilMapId;
  mapName: string;
  hunterIdx: number;
  hunterName: string | null;
  cols: number;
  validCells: readonly number[];
  survCells: number[];
  mode: 'exact' | 'fuzzy' | null;
  exactCount: number;
  usedCount: number;
  totalPool: number;
  best: SpawnPredictCellRank | null;
  alts: SpawnPredictCellRank[];
  ranked: SpawnPredictCellRank[];
  cellProbs: Record<number, number>;
  cellRawCounts: Record<number, number>;
  myAltComparison: SpawnPredictAltComparison | null;
  matchedRecords: SpawnPredictMatchedRecord[];
}

export interface SpawnPredictLayoutPreset {
  key: string;
  cells: [number, number, number, number];
  count: number;
  topHunterCell: number;
  topHunterCount: number;
}

function layoutKey(cells: readonly number[]): string {
  return [...cells].sort((a, b) => a - b).join('-');
}

function toMatchedRecord(rec: SpawnPredictRawRecord, overlap: number): SpawnPredictMatchedRecord {
  const flags = rec[7];
  return {
    mapId: rec[0] as PilMapId,
    hunterIdx: rec[1],
    hunterName: SPAWN_PREDICT_DATA.hunters[rec[1]] ?? '',
    survCells: [rec[2], rec[3], rec[4], rec[5]],
    hunterCell: rec[6],
    overlap,
    reviewed: (flags & 1) !== 0,
    sourceType: (flags & 2) !== 0 ? 'solo' : 'vod',
    filename: rec[8],
  };
}

function filterPool(mapId: PilMapId, hunterIdx: number): SpawnPredictRawRecord[] {
  return SPAWN_PREDICT_DATA.records.filter(
    (r) => r[0] === mapId && (hunterIdx < 0 || r[1] === hunterIdx),
  );
}

/**
 * Predict the most likely Hunter opening spawn cell given 4 Survivor cells.
 * Matches `zhou1736948757-cpu/notes/template.html` exact (`>= 3`) & fuzzy (`overlap²`)
 * scoring with `normFree` occupied-cell exclusion.
 */
export function predictHunterSpawn(query: SpawnPredictQuery): SpawnPredictResult {
  const mapId = resolvePilMapId(query.mapId);
  const mapName = SPAWN_PREDICT_DATA.maps[mapId] ?? MAPS_DATA[mapId]!.mapName;
  const validCells = getMapValidCells(mapId);
  const validSet = new Set(validCells);
  const cols = SPAWN_PREDICT_DATA.cols[mapName] ?? 3;
  const hunterIdx =
    typeof query.hunterIdx === 'number' &&
    Number.isInteger(query.hunterIdx) &&
    query.hunterIdx >= 0 &&
    query.hunterIdx < SPAWN_PREDICT_DATA.hunters.length
      ? query.hunterIdx
      : -1;
  const hunterName = hunterIdx >= 0 ? SPAWN_PREDICT_DATA.hunters[hunterIdx]! : null;

  const dedupedSurv: number[] = [];
  for (const c of query.survCells) {
    if (validSet.has(c) && !dedupedSurv.includes(c)) {
      dedupedSurv.push(c);
      if (dedupedSurv.length === 4) break;
    }
  }

  const myAltValid =
    typeof query.myAltCell === 'number' && validSet.has(query.myAltCell) ? query.myAltCell : null;

  const pool = filterPool(mapId, hunterIdx);
  const zeroProbs: Record<number, number> = {};
  const zeroCounts: Record<number, number> = {};
  for (const c of validCells) {
    zeroProbs[c] = 0;
    zeroCounts[c] = 0;
  }

  if (dedupedSurv.length < 4) {
    return {
      status: 'need-4',
      mapId,
      mapName,
      hunterIdx,
      hunterName,
      cols,
      validCells,
      survCells: dedupedSurv,
      mode: null,
      exactCount: 0,
      usedCount: 0,
      totalPool: pool.length,
      best: null,
      alts: [],
      ranked: [],
      cellProbs: zeroProbs,
      cellRawCounts: zeroCounts,
      myAltComparison:
        myAltValid !== null
          ? {
              cellId: myAltValid,
              coord: formatCellCoord(myAltValid),
              status: 'pending',
              isMatch: false,
              prob: 0,
              pct: 0,
              deltaPct: 0,
              bestCellId: null,
              bestPct: 0,
            }
          : null,
      matchedRecords: [],
    };
  }

  const inputKey = layoutKey(dedupedSurv);
  const inputSet = new Set(dedupedSurv);
  const exact = pool.filter((r) => layoutKey([r[2], r[3], r[4], r[5]]) === inputKey);

  const score = new Map<number, number>();
  const hCount = new Map<number, number>();
  let mode: 'exact' | 'fuzzy';
  let usedWithOverlap: Array<{ rec: SpawnPredictRawRecord; overlap: number }>;

  if (exact.length >= 3) {
    mode = 'exact';
    usedWithOverlap = exact.map((rec) => ({ rec, overlap: 4 }));
    for (const r of exact) {
      const hc = r[6];
      score.set(hc, (score.get(hc) ?? 0) + 1);
      hCount.set(hc, (hCount.get(hc) ?? 0) + 1);
    }
  } else {
    mode = 'fuzzy';
    usedWithOverlap = [];
    for (const r of pool) {
      let overlap = 0;
      if (inputSet.has(r[2])) overlap++;
      if (inputSet.has(r[3])) overlap++;
      if (inputSet.has(r[4])) overlap++;
      if (inputSet.has(r[5])) overlap++;
      if (overlap === 0) continue;
      const w = overlap * overlap;
      const hc = r[6];
      score.set(hc, (score.get(hc) ?? 0) + w);
      hCount.set(hc, (hCount.get(hc) ?? 0) + 1);
      usedWithOverlap.push({ rec: r, overlap });
    }
    usedWithOverlap.sort((a, b) => b.overlap - a.overlap);
  }

  // normFree: strip survivor-occupied cells and normalize remaining free cells
  for (const s of dedupedSurv) {
    score.delete(s);
  }
  let totalWeight = 0;
  for (const w of score.values()) totalWeight += w;

  if (score.size === 0 || !(totalWeight > 0)) {
    return {
      status: 'no-data',
      mapId,
      mapName,
      hunterIdx,
      hunterName,
      cols,
      validCells,
      survCells: dedupedSurv,
      mode,
      exactCount: exact.length,
      usedCount: usedWithOverlap.length,
      totalPool: pool.length,
      best: null,
      alts: [],
      ranked: [],
      cellProbs: zeroProbs,
      cellRawCounts: zeroCounts,
      myAltComparison:
        myAltValid !== null
          ? {
              cellId: myAltValid,
              coord: formatCellCoord(myAltValid),
              status: 'pending',
              isMatch: false,
              prob: 0,
              pct: 0,
              deltaPct: 0,
              bestCellId: null,
              bestPct: 0,
            }
          : null,
      matchedRecords: usedWithOverlap.slice(0, 20).map((x) => toMatchedRecord(x.rec, x.overlap)),
    };
  }

  const cellProbs: Record<number, number> = { ...zeroProbs };
  const cellRawCounts: Record<number, number> = { ...zeroCounts };
  for (const c of validCells) {
    cellRawCounts[c] = hCount.get(c) ?? 0;
    const w = score.get(c);
    if (w !== undefined) {
      cellProbs[c] = w / totalWeight;
    }
  }

  const zoneNames = MAPS_DATA[mapId]?.zoneNames ?? [];
  const ranked: SpawnPredictCellRank[] = Array.from(score.entries())
    .map(([cellId, w]) => {
      const prob = w / totalWeight;
      const pilZone = cellIdToPilZone(mapId, cellId);
      return {
        cellId,
        coord: formatCellCoord(cellId),
        prob,
        pct: Math.round(prob * 1000) / 10,
        rawCount: hCount.get(cellId) ?? 0,
        pilZone,
        zoneName: pilZone >= 0 ? (zoneNames[pilZone] ?? formatCellCoord(cellId)) : formatCellCoord(cellId),
      };
    })
    .sort((a, b) => b.prob - a.prob || a.cellId - b.cellId);

  const best = ranked[0] ?? null;
  const alts = ranked
    .slice(1)
    .filter((entry) => entry.prob > 0.03)
    .slice(0, 2);

  let myAltComparison: SpawnPredictAltComparison | null = null;
  if (myAltValid !== null && best) {
    const prob = cellProbs[myAltValid] ?? 0;
    const pct = Math.round(prob * 1000) / 10;
    const isMatch = myAltValid === best.cellId;
    myAltComparison = {
      cellId: myAltValid,
      coord: formatCellCoord(myAltValid),
      status: isMatch ? 'match' : 'mismatch',
      isMatch,
      prob,
      pct,
      deltaPct: Math.round((prob - best.prob) * 1000) / 10,
      bestCellId: best.cellId,
      bestPct: best.pct,
    };
  }

  return {
    status: 'ok',
    mapId,
    mapName,
    hunterIdx,
    hunterName,
    cols,
    validCells,
    survCells: dedupedSurv,
    mode,
    exactCount: exact.length,
    usedCount: usedWithOverlap.length,
    totalPool: pool.length,
    best,
    alts,
    ranked,
    cellProbs,
    cellRawCounts,
    myAltComparison,
    matchedRecords: usedWithOverlap.slice(0, 20).map((x) => toMatchedRecord(x.rec, x.overlap)),
  };
}

/**
 * Top-N most frequent 4-Survivor layouts for `(mapId, hunterIdx)` matching `notes/template.html`.
 */
export function topSurvivorLayouts(
  mapIdInput: PilMapId | number | string,
  hunterIdx = -1,
  limit = 6,
): SpawnPredictLayoutPreset[] {
  const mapId = resolvePilMapId(mapIdInput);
  const hIdx =
    Number.isInteger(hunterIdx) && hunterIdx >= 0 && hunterIdx < SPAWN_PREDICT_DATA.hunters.length
      ? hunterIdx
      : -1;
  const pool = filterPool(mapId, hIdx);

  const groups = new Map<
    string,
    { cells: [number, number, number, number]; count: number; hCounts: Map<number, number> }
  >();

  for (const r of pool) {
    const cells: [number, number, number, number] = [r[2], r[3], r[4], r[5]];
    const key = layoutKey(cells);
    let grp = groups.get(key);
    if (!grp) {
      grp = { cells, count: 0, hCounts: new Map<number, number>() };
      groups.set(key, grp);
    }
    grp.count++;
    grp.hCounts.set(r[6], (grp.hCounts.get(r[6]) ?? 0) + 1);
  }

  return Array.from(groups.entries())
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([key, grp]) => {
      const topH = Array.from(grp.hCounts.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      return {
        key,
        cells: grp.cells,
        count: grp.count,
        topHunterCell: topH ? topH[0] : -1,
        topHunterCount: topH ? topH[1] : 0,
      };
    });
}

/**
 * Pick a real historical opening record from `(mapId, hunterIdx)`.
 */
export function pickRandomRealRecord(
  mapIdInput: PilMapId | number | string,
  hunterIdx = -1,
  rng: () => number = Math.random,
): SpawnPredictMatchedRecord | null {
  const mapId = resolvePilMapId(mapIdInput);
  const hIdx =
    Number.isInteger(hunterIdx) && hunterIdx >= 0 && hunterIdx < SPAWN_PREDICT_DATA.hunters.length
      ? hunterIdx
      : -1;
  const pool = filterPool(mapId, hIdx);
  if (pool.length === 0) return null;
  const raw = rng();
  const clamped = Number.isFinite(raw) ? Math.min(0.999999999, Math.max(0, raw)) : 0;
  const idx = Math.floor(clamped * pool.length);
  return toMatchedRecord(pool[idx]!, 4);
}

// ---------------------------------------------------------------------------
// Stage 04 -> Stage 02 Sandbox Board Handoff
// ---------------------------------------------------------------------------

export interface ApplySpawnPredictionInput {
  survCells: readonly number[];
  hunterCell: number;
  hunterIdx?: number | null;
  hunterRole?: string | null;
}

export interface ApplySpawnPredictionResult {
  mapId: PilMapId;
  board: TacticalBoardState;
  survivorTids: number[];
  hunterTid: number | null;
  survivorZones: number[];
  hunterZone: number | null;
  handoff: SandboxBoardHandoff;
}

/**
 * Place 4 predicted Survivor tokens + 1 glowing Hunter token onto the map's
 * `TacticalBoardState` (replacing any prior `spawnPreview` tokens), persist via
 * `saveBoardState` + `setActiveMapId`, and emit a `SandboxBoardHandoff` event.
 */
export function applySpawnPredictionToBoard(
  mapIdInput: PilMapId | number | string,
  payload: ApplySpawnPredictionInput,
  storage?: StorageLike | null,
): ApplySpawnPredictionResult {
  const mapId = resolvePilMapId(mapIdInput);
  const board = loadBoardState(mapId, storage);
  const zones = mapsZonesRelative[mapId] ?? [];
  const centers = calculateZoneCenters(zones);

  // Remove any previously placed spawn-preview tokens while keeping user drawings/tokens
  const keptTokens = board.tokens.filter((t) => !t.spawnPreview);
  let tokenSeq = board.tokenSeq;
  const survivorTids: number[] = [];
  const survivorZones: number[] = [];

  for (const cellId of payload.survCells.slice(0, 4)) {
    const zIdx = cellIdToPilZone(mapId, cellId);
    if (zIdx < 0 || !centers[zIdx]) continue;
    const center = centers[zIdx]!;
    const tid = ++tokenSeq;
    survivorZones.push(zIdx);
    survivorTids.push(tid);
    const tok: TacticalToken = {
      tid,
      role: 'luckyGuy',
      camp: 'survivor',
      label: `求生 ${survivorZones.length}`,
      x: center.x,
      y: center.y,
      spawnPreview: true,
    };
    keptTokens.push(tok);
  }

  let hunterTid: number | null = null;
  let hunterZone: number | null = null;
  let resolvedHunterRole: string | null = null;

  const hZone = cellIdToPilZone(mapId, payload.hunterCell);
  if (hZone >= 0 && centers[hZone]) {
    hunterZone = hZone;
    const hCenter = centers[hZone]!;
    const hIdx = payload.hunterIdx ?? -1;
    const roleKey =
      (payload.hunterRole && TAC_HUNTER_ROLES[payload.hunterRole] ? payload.hunterRole : null) ??
      (hIdx >= 0 ? predictHunterToTacRoleKey(hIdx) : null) ??
      'custom';
    resolvedHunterRole = roleKey;
    const roleDef = TAC_HUNTER_ROLES[roleKey];
    const tid = ++tokenSeq;
    hunterTid = tid;
    const hunterTok: TacticalToken = {
      tid,
      role: roleKey,
      camp: 'hunter',
      label: roleDef?.name ?? (hIdx >= 0 ? SPAWN_PREDICT_DATA.hunters[hIdx] : undefined) ?? '监管者(预测)',
      x: hCenter.x,
      y: hCenter.y,
      showFearRadius: true,
      glow: true,
      spawnPreview: true,
    };
    keptTokens.push(hunterTok);
  }

  const nextBoard: TacticalBoardState = {
    ...board,
    tokens: keptTokens,
    tokenSeq,
  };

  saveBoardState(mapId, nextBoard, storage);
  setActiveMapId(mapId, storage);

  const handoff = emitSandboxBoardHandoff({
    mapId,
    source: 'spawn-predict',
    whiteboard: true,
    enableZones: true,
    highlightTid: hunterTid,
    hunterRole: resolvedHunterRole,
    survivorZones,
    hunterZone,
  });

  return {
    mapId,
    board: nextBoard,
    survivorTids,
    hunterTid,
    survivorZones,
    hunterZone,
    handoff,
  };
}
