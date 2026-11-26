/**
 * Shared StorageLike persistence, legacy 'idv5_tactic_v1' migration,
 * validated JSON import/export, and active-map pub/sub (zero DOM).
 */
import { readTacticalLink, writeTacticalLink, type TacticalLink } from './link-state';
import { mapsZonesRelative } from './geo';
import { MAPS_DATA, PIL_MAP_COUNT, findPilMapByName, resolvePilMapId } from './maps';
import { measureIdCounters, restoreMeasureReferences } from './measurements';
import type {
  AnimData,
  AnimSpeedEntry,
  DeduceMarksState,
  ImportBoardResult,
  MeasureBuff,
  MeasureLineConfig,
  PilMapId,
  Point2D,
  RegionSelectionState,
  SandboxBoardHandoff,
  StorageLike,
  TacticalBoardState,
  TacticalMeasureLine,
  TacticalPropItem,
  TacticalShape,
  TacticalShapeKind,
  TacticalTextNote,
  TacticalToken,
} from './types';

export function loadTacticalLink(mapId: PilMapId, storage?: StorageLike | null): TacticalLink | null {
  return readTacticalLink(resolveStorage(storage), mapId);
}

export function saveTacticalLink(mapId: PilMapId, value: TacticalLink, explicit = false, storage?: StorageLike | null): boolean {
  return writeTacticalLink(resolveStorage(storage), mapId, value, explicit);
}

export const PIL_STORAGE_KEY = 'idv.pil.v2';
export const PIL_LEGACY_STORAGE_KEY = 'idv5_tactic_v1';

interface PilEnvelopeV2 {
  v: 2;
  activeMapId: PilMapId;
  boards: Record<string, TacticalBoardState>;
  regions: Record<string, RegionSelectionState>;
  dedMarks: Record<string, DeduceMarksState>;
}

const VALID_SHAPE_KINDS = new Set<TacticalShapeKind>([
  'arrow',
  'line',
  'circle',
  'rect',
  'freehand',
]);

let activeMapIdCache: PilMapId | null = null;
const activeMapListeners = new Set<(mapId: PilMapId) => void>();

let pendingSandboxHandoff: SandboxBoardHandoff | null = null;
const sandboxHandoffListeners = new Set<(handoff: SandboxBoardHandoff) => void>();

export function emitSandboxBoardHandoff(
  handoff: Omit<SandboxBoardHandoff, 'timestamp'> & { timestamp?: number },
): SandboxBoardHandoff {
  const full: SandboxBoardHandoff = {
    ...handoff,
    mapId: resolvePilMapId(handoff.mapId),
    timestamp: typeof handoff.timestamp === 'number' && Number.isFinite(handoff.timestamp)
      ? handoff.timestamp
      : Date.now(),
  };
  pendingSandboxHandoff = full;
  for (const listener of sandboxHandoffListeners) {
    listener(full);
  }
  return full;
}

export function consumeSandboxBoardHandoff(): SandboxBoardHandoff | null {
  const cur = pendingSandboxHandoff;
  pendingSandboxHandoff = null;
  return cur;
}

export function peekSandboxBoardHandoff(): SandboxBoardHandoff | null {
  return pendingSandboxHandoff;
}

export function onSandboxBoardHandoff(
  listener: (handoff: SandboxBoardHandoff) => void,
): () => void {
  sandboxHandoffListeners.add(listener);
  return () => {
    sandboxHandoffListeners.delete(listener);
  };
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  const g = globalThis as { localStorage?: unknown };
  if (
    g &&
    typeof g.localStorage === 'object' &&
    g.localStorage !== null &&
    typeof (g.localStorage as StorageLike).getItem === 'function' &&
    typeof (g.localStorage as StorageLike).setItem === 'function'
  ) {
    return g.localStorage as StorageLike;
  }
  return null;
}

function safeReadJson(storage: StorageLike | null, key: string): Record<string, unknown> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readEnvelopeV2(storage: StorageLike | null): PilEnvelopeV2 {
  const raw = safeReadJson(storage, PIL_STORAGE_KEY);
  const active =
    raw && (typeof raw.activeMapId === 'number' || typeof raw.activeMapId === 'string')
      ? resolvePilMapId(raw.activeMapId)
      : 0;
  return {
    v: 2,
    activeMapId: active,
    boards:
      raw && raw.boards && typeof raw.boards === 'object' && !Array.isArray(raw.boards)
        ? (raw.boards as Record<string, TacticalBoardState>)
        : {},
    regions:
      raw && raw.regions && typeof raw.regions === 'object' && !Array.isArray(raw.regions)
        ? (raw.regions as Record<string, RegionSelectionState>)
        : {},
    dedMarks:
      raw && raw.dedMarks && typeof raw.dedMarks === 'object' && !Array.isArray(raw.dedMarks)
        ? (raw.dedMarks as Record<string, DeduceMarksState>)
        : {},
  };
}

function writeEnvelopeV2(storage: StorageLike | null, env: PilEnvelopeV2): void {
  if (!storage) return;
  try {
    storage.setItem(PIL_STORAGE_KEY, JSON.stringify(env));
  } catch {
    // Ignore storage quota errors in headless/restricted environments
  }
}

function finiteNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function nonNegInt(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;
}

function sanitizePoints(raw: unknown): Point2D[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const pts: Point2D[] = [];
  for (const p of raw) {
    if (p && typeof p === 'object') {
      const rec = p as { x?: unknown; y?: unknown };
      if (typeof rec.x === 'number' && Number.isFinite(rec.x) && typeof rec.y === 'number' && Number.isFinite(rec.y)) {
        pts.push({ x: rec.x, y: rec.y });
      }
    }
  }
  return pts;
}

function sanitizeAnimData(raw: unknown): AnimData | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const points = sanitizePoints(rec.points);
  if (!points) return undefined;
  const mode: AnimData['mode'] = rec.mode === 'time' ? 'time' : 'speed';

  let times: number[] | undefined;
  if (Array.isArray(rec.times)) {
    times = rec.times
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  }

  let speeds: AnimSpeedEntry[] | undefined;
  if (Array.isArray(rec.speeds)) {
    speeds = [];
    for (const entry of rec.speeds) {
      if (!entry || typeof entry !== 'object') continue;
      const s = entry as Record<string, unknown>;
      const sp = typeof s.speed === 'number' && Number.isFinite(s.speed) && s.speed > 0 ? s.speed : 3.8;
      const buffs = Array.isArray(s.buffs)
        ? (structuredClone(s.buffs) as MeasureBuff[])
        : undefined;
      speeds.push({
        name: typeof s.name === 'string' ? s.name : '',
        speed: sp,
        ...(buffs ? { buffs } : {}),
      });
    }
  }

  let paths: Array<Point2D[] | undefined> | undefined;
  if (Array.isArray(rec.paths)) {
    let anyPath = false;
    const cleaned = rec.paths.map((seg) => {
      if (seg == null) return undefined;
      const pts = sanitizePoints(seg);
      if (pts && pts.length >= 2) {
        anyPath = true;
        return pts;
      }
      return undefined;
    });
    if (anyPath) paths = cleaned;
  }

  return {
    mode,
    points,
    ...(times !== undefined ? { times } : {}),
    ...(speeds !== undefined ? { speeds } : {}),
    ...(paths !== undefined ? { paths } : {}),
  };
}

function sanitizeBoardState(
  raw: Record<string, unknown>,
  legacyExtras?: {
    dungeon?: number;
    chairSet?: number;
    chairBasement?: number;
    boxBasement?: number;
    spawn?: number;
  },
): TacticalBoardState {
  const empty = createEmptyBoardState();
  let tokenSeq = nonNegInt(raw.tokenSeq, 0);
  let itemSeq = nonNegInt(raw.itemSeq, 0);
  let shapeSeq = nonNegInt(raw.shapeSeq, 0);
  let textSeq = nonNegInt(raw.textSeq, 0);
  let measureSeq = nonNegInt(raw.measureSeq, 0);

  // Tokens (array or legacy object keyed by role)
  const rawTokens: unknown[] = [];
  const legacyMirrorByRole: Record<string, Record<string, unknown>> = {};
  if (Array.isArray(raw.tokens)) {
    rawTokens.push(...raw.tokens);
  } else if (raw.tokens && typeof raw.tokens === 'object') {
    for (const [role, val] of Object.entries(raw.tokens as Record<string, unknown>)) {
      if (val && typeof val === 'object') {
        rawTokens.push({ tid: ++tokenSeq, role, ...(val as Record<string, unknown>) });
      }
    }
  }

  const tokens: TacticalToken[] = [];
  for (const entry of rawTokens) {
    if (!entry || typeof entry !== 'object') continue;
    const t = { ...(entry as Record<string, unknown>) };
    let role = typeof t.role === 'string' && t.role ? t.role : 'luckyGuy';
    if (role === 'Naiad') role = 'naiad';
    const tid = nonNegInt(t.tid, 0) || ++tokenSeq;
    if (tid > tokenSeq) tokenSeq = tid;

    // Extract legacy bloodyQueen mirror state to migrate onto aquaMirror prop
    if (
      role === 'bloodyQueen' &&
      (t.showMirror || t.showMirrorLink === false || t.fixedMirror || t.mirrorAxis)
    ) {
      legacyMirrorByRole.bloodyQueen = {
        tid,
        showMirror: t.showMirror,
        showMirrorLink: t.showMirrorLink,
        fixedMirror: t.fixedMirror,
        mirrorAxis: t.mirrorAxis,
      };
      delete t.showMirror;
      delete t.showMirrorLink;
      delete t.fixedMirror;
      delete t.mirrorAxis;
    }

    const anim = sanitizeAnimData(t.anim);
    delete t.anim;

    tokens.push({
      ...(t as Partial<TacticalToken>),
      tid,
      role,
      x: finiteNum(t.x, 0.5),
      y: finiteNum(t.y, 0.5),
      ...(anim !== undefined ? { anim } : {}),
    });
  }

  // Items
  const items: TacticalPropItem[] = [];
  if (Array.isArray(raw.items)) {
    for (const entry of raw.items) {
      if (!entry || typeof entry !== 'object') continue;
      const it = { ...(entry as Record<string, unknown>) };
      const iid = nonNegInt(it.iid, 0) || ++itemSeq;
      if (iid > itemSeq) itemSeq = iid;
      let role = typeof it.role === 'string' ? it.role : undefined;
      if (role === 'Naiad') role = 'naiad';
      const kind = typeof it.kind === 'string' && it.kind ? it.kind : 'customCipherMachine';
      const anim = sanitizeAnimData(it.anim);
      delete it.anim;
      const prop: TacticalPropItem = {
        ...(it as Partial<TacticalPropItem>),
        iid,
        kind,
        x: finiteNum(it.x, 0.5),
        y: finiteNum(it.y, 0.5),
        ...(role !== undefined ? { role } : {}),
        ...(anim !== undefined ? { anim } : {}),
      };
      items.push(prop);
    }
  }

  // Migrate Bloody Queen mirror flags onto aquaMirror item if present
  const aqIt = items.find((it) => it.kind === 'aquaMirror');
  if (aqIt) {
    const bqMeta = legacyMirrorByRole.bloodyQueen;
    if (bqMeta) {
      if (bqMeta.showMirror) aqIt.showMirror = true;
      if (bqMeta.showMirrorLink === false) aqIt.linkShow = false;
      if (bqMeta.fixedMirror) aqIt.fixedMirror = true;
      if (bqMeta.mirrorAxis && typeof bqMeta.mirrorAxis === 'object') {
        aqIt.mirrorAxis = bqMeta.mirrorAxis as TacticalPropItem['mirrorAxis'];
      }
    }
    const anyBq = tokens.find((t) => t.role === 'bloodyQueen');
    if (anyBq && aqIt.linkTid == null) aqIt.linkTid = anyBq.tid;
  }

  // Shapes (v2 shapes or legacy v1 arrows)
  const rawShapes = Array.isArray(raw.shapes)
    ? raw.shapes
    : Array.isArray(raw.arrows)
      ? raw.arrows
      : [];
  const shapes: TacticalShape[] = [];
  for (const entry of rawShapes) {
    if (!entry || typeof entry !== 'object') continue;
    const s = entry as Record<string, unknown>;
    const kind: TacticalShapeKind =
      typeof s.kind === 'string' && VALID_SHAPE_KINDS.has(s.kind as TacticalShapeKind)
        ? (s.kind as TacticalShapeKind)
        : 'arrow';
    const id = nonNegInt(s.id, 0) || ++shapeSeq;
    if (id > shapeSeq) shapeSeq = id;
    const pts = sanitizePoints(s.points);
    shapes.push({
      id,
      kind,
      x1: finiteNum(s.x1, pts?.[0]?.x ?? 0),
      y1: finiteNum(s.y1, pts?.[0]?.y ?? 0),
      x2: finiteNum(s.x2, pts?.[pts.length - 1]?.x ?? 0),
      y2: finiteNum(s.y2, pts?.[pts.length - 1]?.y ?? 0),
      ...(pts ? { points: pts } : {}),
      color: typeof s.color === 'string' && s.color ? s.color : '#c9a25f',
      width: Math.max(1, finiteNum(s.width, 2)),
      ...(typeof s.dashed === 'boolean' ? { dashed: s.dashed } : {}),
    });
  }

  // Text notes
  const texts: TacticalTextNote[] = [];
  if (Array.isArray(raw.texts)) {
    for (const entry of raw.texts) {
      if (!entry || typeof entry !== 'object') continue;
      const tn = entry as Record<string, unknown>;
      const id = nonNegInt(tn.id, 0) || ++textSeq;
      if (id > textSeq) textSeq = id;
      texts.push({
        id,
        x: finiteNum(tn.x, 0.5),
        y: finiteNum(tn.y, 0.5),
        text: typeof tn.text === 'string' ? tn.text : '',
        color: typeof tn.color === 'string' && tn.color ? tn.color : '#ddd3bd',
        fontSize: Math.max(10, finiteNum(tn.fontSize, 14)),
      });
    }
  }

  // Measures
  const measures: TacticalMeasureLine[] = [];
  if (Array.isArray(raw.measures)) {
    for (const entry of raw.measures) {
      if (!entry || typeof entry !== 'object') continue;
      const m = entry as Record<string, unknown>;
      const id = nonNegInt(m.id, 0) || ++measureSeq;
      if (id > measureSeq) measureSeq = id;
      const path = sanitizePoints(m.path);
      measures.push({
        id,
        x1: finiteNum(m.x1, 0),
        y1: finiteNum(m.y1, 0),
        x2: finiteNum(m.x2, 0),
        y2: finiteNum(m.y2, 0),
        ...(path && path.length >= 2 ? { path } : {}),
        chain: typeof m.chain === 'number' && Number.isFinite(m.chain) ? m.chain : null,
        lc:
          m.lc && typeof m.lc === 'object'
            ? (structuredClone(m.lc) as MeasureLineConfig)
            : null,
        ...(typeof m.color === 'string' ? { color: m.color } : {}),
        ...(typeof m.width === 'number' && Number.isFinite(m.width) ? { width: m.width } : {}),
      });
    }
  }

  const boardRecord = { _: { measures } };
  restoreMeasureReferences(boardRecord);
  const counters = measureIdCounters(boardRecord);

  return {
    ...empty,
    tokens,
    items,
    shapes,
    texts,
    measures,
    tokenSeq,
    itemSeq,
    shapeSeq,
    textSeq,
    measureSeq: Math.max(measureSeq, counters.route),
    lcSeq: Math.max(nonNegInt(raw.lcSeq, 0), counters.config),
    buffSeq: Math.max(nonNegInt(raw.buffSeq, 0), counters.buff),
    dungeonIndex: nonNegInt(raw.dungeonIndex, legacyExtras?.dungeon ?? 0),
    spawnIndex: nonNegInt(raw.spawnIndex, legacyExtras?.spawn ?? 0),
    chairIndex: nonNegInt(raw.chairIndex, legacyExtras?.chairSet ?? 0),
    chairBasementIndex: nonNegInt(raw.chairBasementIndex, legacyExtras?.chairBasement ?? 0),
    boxBasementIndex: nonNegInt(raw.boxBasementIndex, legacyExtras?.boxBasement ?? 0),
  };
}

export function createEmptyBoardState(_mapId?: number): TacticalBoardState {
  return {
    tokens: [],
    items: [],
    shapes: [],
    texts: [],
    measures: [],
    tokenSeq: 0,
    itemSeq: 0,
    shapeSeq: 0,
    textSeq: 0,
    measureSeq: 0,
    lcSeq: 0,
    buffSeq: 0,
    dungeonIndex: 0,
    spawnIndex: 0,
    chairIndex: 0,
    chairBasementIndex: 0,
    boxBasementIndex: 0,
  };
}

export function getActiveMapId(storage?: StorageLike | null): PilMapId {
  if (storage === undefined && activeMapIdCache !== null) {
    return activeMapIdCache;
  }
  const st = resolveStorage(storage);
  const v2 = safeReadJson(st, PIL_STORAGE_KEY);
  if (v2 && (typeof v2.activeMapId === 'number' || typeof v2.activeMapId === 'string')) {
    const id = resolvePilMapId(v2.activeMapId);
    if (storage === undefined) activeMapIdCache = id;
    return id;
  }
  const legacy = safeReadJson(st, PIL_LEGACY_STORAGE_KEY);
  if (legacy && (typeof legacy.map === 'number' || typeof legacy.map === 'string')) {
    const id = resolvePilMapId(legacy.map);
    if (storage === undefined) activeMapIdCache = id;
    return id;
  }
  return activeMapIdCache ?? 0;
}

export function setActiveMapId(mapId: number | string, storage?: StorageLike | null): PilMapId {
  const prev = getActiveMapId(storage);
  const next = resolvePilMapId(mapId);
  activeMapIdCache = next;
  const st = resolveStorage(storage);
  if (st) {
    const env = readEnvelopeV2(st);
    env.activeMapId = next;
    writeEnvelopeV2(st, env);
  }
  if (next !== prev) {
    for (const listener of activeMapListeners) {
      listener(next);
    }
  }
  return next;
}

export function syncActiveMapByName(
  mapName: string | null | undefined,
  storage?: StorageLike | null,
): PilMapId | null {
  const found = findPilMapByName(mapName);
  if (!found) return null;
  return setActiveMapId(found.mapId, storage);
}

export function onActiveMapChange(listener: (mapId: PilMapId) => void): () => void {
  activeMapListeners.add(listener);
  return () => {
    activeMapListeners.delete(listener);
  };
}

export function loadBoardState(
  mapIdInput: number | string,
  storage?: StorageLike | null,
): TacticalBoardState {
  const mapId = resolvePilMapId(mapIdInput);
  const key = String(mapId);
  const st = resolveStorage(storage);
  const env = readEnvelopeV2(st);
  const v2Board = env.boards[key];
  if (v2Board && typeof v2Board === 'object') {
    return sanitizeBoardState(v2Board as unknown as Record<string, unknown>);
  }

  const legacy = safeReadJson(st, PIL_LEGACY_STORAGE_KEY);
  if (legacy) {
    const lBoards =
      legacy.boards && typeof legacy.boards === 'object'
        ? (legacy.boards as Record<string, unknown>)
        : {};
    const lBoard = lBoards[key];
    const lDungeon = (legacy.dungeon as Record<string, unknown> | undefined)?.[key];
    const lChairs = (legacy.chairs as Record<string, Record<string, unknown>> | undefined)?.[key];
    const lBoxes = (legacy.boxes as Record<string, Record<string, unknown>> | undefined)?.[key];
    const lSpawns = (legacy.spawns as Record<string, unknown> | undefined)?.[key];

    if (
      (lBoard && typeof lBoard === 'object') ||
      lDungeon !== undefined ||
      lChairs !== undefined ||
      lBoxes !== undefined ||
      lSpawns !== undefined
    ) {
      return sanitizeBoardState(
        lBoard && typeof lBoard === 'object' ? (lBoard as Record<string, unknown>) : {},
        {
          dungeon: nonNegInt(lDungeon, 0),
          chairSet: nonNegInt(lChairs?.set, 0),
          chairBasement: nonNegInt(lChairs?.basement, 0),
          boxBasement: nonNegInt(lBoxes?.basement, 0),
          spawn: nonNegInt(lSpawns, 0),
        },
      );
    }
  }

  return createEmptyBoardState(mapId);
}

export function saveBoardState(
  mapIdInput: number | string,
  state: TacticalBoardState,
  storage?: StorageLike | null,
): void {
  const mapId = resolvePilMapId(mapIdInput);
  const st = resolveStorage(storage);
  if (!st) return;
  const env = readEnvelopeV2(st);
  env.boards[String(mapId)] = sanitizeBoardState(state as unknown as Record<string, unknown>);
  writeEnvelopeV2(st, env);
}

export function exportBoardJson(mapIdInput: number | string, state: TacticalBoardState): string {
  const mapId = resolvePilMapId(mapIdInput);
  const map = MAPS_DATA[mapId]!;
  const sanitized = sanitizeBoardState(state as unknown as Record<string, unknown>);
  return JSON.stringify(
    {
      format: 'idv-pil-board',
      version: 2,
      mapId,
      mapName: map.mapName,
      exportedAt: new Date().toISOString(),
      board: sanitized,
    },
    null,
    2,
  );
}

function isValidExplicitMapId(v: unknown): boolean {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v < PIL_MAP_COUNT;
  if (typeof v === 'string') return /^[0-8]$/.test(v.trim()) || findPilMapByName(v) !== null;
  return false;
}

export function importBoardJson(rawJson: string): ImportBoardResult {
  if (typeof rawJson !== 'string' || !rawJson.trim()) {
    return { ok: false, error: '导入失败：文件内容为空' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, error: '导入失败：JSON 解析错误，文件格式无效' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '导入失败：存档顶层结构必须为 JSON 对象' };
  }

  const obj = parsed as Record<string, unknown>;
  let rawBoard: Record<string, unknown> | null = null;
  let mapId: PilMapId = 0;

  if (obj.format !== undefined && obj.format !== 'idv-pil-board') {
    return { ok: false, error: '导入失败：不支持的战术板存档格式标识' };
  }

  if (obj.board !== undefined) {
    if (!obj.board || typeof obj.board !== 'object' || Array.isArray(obj.board)) {
      return { ok: false, error: '导入失败：存档缺少有效的 board 对象' };
    }
    rawBoard = obj.board as Record<string, unknown>;
    if (obj.mapId !== undefined) {
      if (!isValidExplicitMapId(obj.mapId)) {
        return { ok: false, error: '导入失败：无效的地图编号' };
      }
      mapId = resolvePilMapId(obj.mapId as number | string);
    } else if (typeof obj.mapName === 'string') {
      const found = findPilMapByName(obj.mapName);
      if (!found) return { ok: false, error: '导入失败：无法识别地图名称' };
      mapId = found.mapId;
    }
  } else if (obj.boards && typeof obj.boards === 'object' && !Array.isArray(obj.boards)) {
    const boardsMap = obj.boards as Record<string, unknown>;
    const preferredKey =
      obj.map !== undefined && isValidExplicitMapId(obj.map)
        ? String(resolvePilMapId(obj.map as number | string))
        : Object.keys(boardsMap)[0];
    if (!preferredKey || !boardsMap[preferredKey] || typeof boardsMap[preferredKey] !== 'object') {
      return { ok: false, error: '导入失败：存档中没有可用的地图战术板数据' };
    }
    if (!isValidExplicitMapId(preferredKey)) {
      return { ok: false, error: '导入失败：存档中的地图编号超出范围' };
    }
    mapId = resolvePilMapId(preferredKey);
    rawBoard = boardsMap[preferredKey] as Record<string, unknown>;
  } else {
    const hasBoardArrays = ['tokens', 'items', 'shapes', 'arrows', 'texts', 'measures'].some(
      (k) => k in obj,
    );
    if (!hasBoardArrays) {
      return { ok: false, error: '导入失败：未检测到战术板字段（tokens / items / shapes / texts / measures）' };
    }
    if (obj.mapId !== undefined) {
      if (!isValidExplicitMapId(obj.mapId)) {
        return { ok: false, error: '导入失败：无效的地图编号' };
      }
      mapId = resolvePilMapId(obj.mapId as number | string);
    }
    rawBoard = obj;
  }

  for (const arrField of ['items', 'shapes', 'arrows', 'texts', 'measures'] as const) {
    if (rawBoard[arrField] !== undefined && !Array.isArray(rawBoard[arrField])) {
      return { ok: false, error: `导入失败：字段 ${arrField} 格式错误，应为数组` };
    }
  }
  if (
    rawBoard.tokens !== undefined &&
    !Array.isArray(rawBoard.tokens) &&
    typeof rawBoard.tokens !== 'object'
  ) {
    return { ok: false, error: '导入失败：字段 tokens 格式错误' };
  }

  return {
    ok: true,
    mapId,
    state: sanitizeBoardState(rawBoard),
  };
}

function createDefaultRegionState(): RegionSelectionState {
  return {
    side: 1,
    cipherGroupIndex: 0,
    survivorZones: [],
    hunterZones: [],
    selectedCipherIndex: -1,
    showDoors: false,
    roleSize: 50,
    cipherSize: 5.2,
    doorSize: 6,
  };
}

function sanitizeRegionState(
  mapId: PilMapId,
  raw: Record<string, unknown>,
): RegionSelectionState {
  const def = createDefaultRegionState();
  const zoneCount = mapsZonesRelative[mapId]?.length ?? 9;
  const comboCount = MAPS_DATA[mapId]?.cipherCombinations.length ?? 1;

  const side: 1 | -1 = raw.side === -1 ? -1 : 1;
  const rawGroup = finiteNum(raw.cipherGroupIndex);
  const cipherGroupIndex = ((Math.floor(rawGroup) % comboCount) + comboCount) % comboCount;

  const survSet = new Set<number>();
  if (Array.isArray(raw.survivorZones)) {
    for (const z of raw.survivorZones) {
      if (typeof z === 'number' && Number.isInteger(z) && z >= 0 && z < zoneCount) {
        survSet.add(z);
        if (survSet.size >= 4) break;
      }
    }
  }

  const huntList: number[] = [];
  if (Array.isArray(raw.hunterZones)) {
    for (const z of raw.hunterZones) {
      if (
        typeof z === 'number' &&
        Number.isInteger(z) &&
        z >= 0 &&
        z < zoneCount &&
        !survSet.has(z)
      ) {
        huntList.push(z);
        break;
      }
    }
  }

  const selCipher =
    typeof raw.selectedCipherIndex === 'number' && Number.isInteger(raw.selectedCipherIndex)
      ? raw.selectedCipherIndex
      : -1;

  return {
    side,
    cipherGroupIndex,
    survivorZones: Array.from(survSet),
    hunterZones: huntList,
    selectedCipherIndex: selCipher >= -1 && selCipher < 7 ? selCipher : -1,
    showDoors: Boolean(raw.showDoors),
    roleSize: finiteNum(raw.roleSize, def.roleSize),
    cipherSize: finiteNum(raw.cipherSize, def.cipherSize),
    doorSize: finiteNum(raw.doorSize, def.doorSize),
  };
}

export function loadRegionState(
  mapIdInput: number | string,
  storage?: StorageLike | null,
): RegionSelectionState {
  const mapId = resolvePilMapId(mapIdInput);
  const key = String(mapId);
  const st = resolveStorage(storage);
  const env = readEnvelopeV2(st);
  const v2Reg = env.regions[key];
  if (v2Reg && typeof v2Reg === 'object') {
    return sanitizeRegionState(mapId, v2Reg as unknown as Record<string, unknown>);
  }

  const legacy = safeReadJson(st, PIL_LEGACY_STORAGE_KEY);
  const lReg = (legacy?.regions as Record<string, Record<string, unknown>> | undefined)?.[key];
  const lDisp = legacy?.selDisplay as Record<string, unknown> | undefined;
  if (lReg && typeof lReg === 'object') {
    const survivorZones: number[] = [];
    if (Array.isArray(lReg.surv)) {
      lReg.surv.forEach((v, idx) => {
        if (typeof v === 'number' && v > 0) survivorZones.push(idx);
      });
    }
    const hunterZones: number[] = [];
    if (Array.isArray(lReg.hunt)) {
      lReg.hunt.forEach((v, idx) => {
        if (typeof v === 'number' && v < 0) hunterZones.push(idx);
      });
    }
    return sanitizeRegionState(mapId, {
      side: lReg.side,
      cipherGroupIndex: typeof lReg.cipher === 'number' ? lReg.cipher : 0,
      survivorZones,
      hunterZones,
      selectedCipherIndex: typeof lReg.sel === 'number' ? lReg.sel : -1,
      showDoors: Boolean(lDisp?.doors),
      roleSize: lDisp?.roleSize,
      cipherSize: lDisp?.cipherSize,
      doorSize: lDisp?.doorSize,
    });
  }

  return createDefaultRegionState();
}

export function saveRegionState(
  mapIdInput: number | string,
  state: RegionSelectionState,
  storage?: StorageLike | null,
): void {
  const mapId = resolvePilMapId(mapIdInput);
  const st = resolveStorage(storage);
  if (!st) return;
  const env = readEnvelopeV2(st);
  env.regions[String(mapId)] = sanitizeRegionState(
    mapId,
    state as unknown as Record<string, unknown>,
  );
  writeEnvelopeV2(st, env);
}

function sanitizeDeduceMarks(mapId: PilMapId, raw: unknown): DeduceMarksState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const ciphers = MAPS_DATA[mapId]!.ciphers;
  const out: DeduceMarksState = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(k);
    if (
      Number.isInteger(id) &&
      id >= 0 &&
      id < ciphers.length &&
      !ciphers[id]!.locked &&
      (v === 'yes' || v === 'no')
    ) {
      out[id] = v;
    }
  }
  return out;
}

export function loadDeduceMarks(
  mapIdInput: number | string,
  storage?: StorageLike | null,
): DeduceMarksState {
  const mapId = resolvePilMapId(mapIdInput);
  const key = String(mapId);
  const st = resolveStorage(storage);
  const env = readEnvelopeV2(st);
  if (env.dedMarks[key] && typeof env.dedMarks[key] === 'object') {
    return sanitizeDeduceMarks(mapId, env.dedMarks[key]);
  }
  const legacy = safeReadJson(st, PIL_LEGACY_STORAGE_KEY);
  const lMarks = (legacy?.dedMarks as Record<string, unknown> | undefined)?.[key];
  if (lMarks && typeof lMarks === 'object') {
    return sanitizeDeduceMarks(mapId, lMarks);
  }
  return {};
}

export function saveDeduceMarks(
  mapIdInput: number | string,
  marks: DeduceMarksState,
  storage?: StorageLike | null,
): void {
  const mapId = resolvePilMapId(mapIdInput);
  const st = resolveStorage(storage);
  if (!st) return;
  const env = readEnvelopeV2(st);
  env.dedMarks[String(mapId)] = sanitizeDeduceMarks(mapId, marks);
  writeEnvelopeV2(st, env);
}
