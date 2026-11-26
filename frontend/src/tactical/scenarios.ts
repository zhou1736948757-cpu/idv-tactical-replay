/**
 * P0 Opening & Endgame Tactical Deduction Scenario Engine (zero-DOM pure TypeScript).
 *
 * Generates realistic, immediately playable multi-character tactical setups
 * directly from PIL's verified per-map spawn groups, cipher combinations,
 * rocket chairs, and escape doors — complete with synchronized multi-track
 * movement animations and per-cipher progress states.
 */
import { cipherOf } from './geo';
import { MAPS_DATA } from './maps';
import { TAC_ROLES } from './roles';
import type {
  AnimData,
  PilMapId,
  Point2D,
  TacticalBoardState,
  TacticalToken,
} from './types';

export type EndgameScenarioKind = 'prime-pop' | 'chair-rescue' | 'gate-war';

export interface OpeningScenarioOptions {
  spawnGroupIndex?: number;
  cipherGroupIndex?: number;
  hunterRole?: string;
  survivorRoles?: readonly string[];
  withAnim?: boolean;
}

export interface EndgameScenarioOptions {
  cipherGroupIndex?: number;
  chairIndex?: number;
  hunterRole?: string;
  survivorRoles?: readonly string[];
  withAnim?: boolean;
}

export interface ScenarioPopulateResult {
  label: string;
  summary: string;
  tokensPlaced: number;
  recommendedChairRel?: Point2D | null;
  recommendedChairLabel?: string | null;
}

export const DEFAULT_OPENING_HUNTER = 'operaSinger';
export const DEFAULT_OPENING_SURVIVORS: readonly string[] = Object.freeze([
  'mercenary',
  'seer',
  'antiquarian',
  'priestess',
]);

export const OPENING_HUNTER_PRESETS: ReadonlyArray<{ role: string; label: string }> = Object.freeze([
  { role: 'operaSinger', label: '歌剧演员' },
  { role: 'bloodyQueen', label: '红夫人' },
  { role: 'dreamWitch', label: '梦之女巫' },
  { role: 'geisha', label: '红蝶' },
  { role: 'naiad', label: '渔女' },
  { role: 'guard26', label: '26号守卫' },
  { role: 'hellEmber', label: '厂长' },
]);

function clamp01(v: number, pad = 0.015): number {
  return Math.min(1 - pad, Math.max(pad, v));
}

function distSq(a: Point2D, b: Point2D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function lerpPt(a: Point2D, b: Point2D, t: number): Point2D {
  return {
    x: clamp01(a.x + (b.x - a.x) * t),
    y: clamp01(a.y + (b.y - a.y) * t),
  };
}

function roleSpeed(roleKey: string, camp: 'hunter' | 'survivor'): number {
  const def = TAC_ROLES[roleKey];
  if (def && typeof def.speed === 'number' && def.speed > 0) return def.speed;
  if (def && def.speed && typeof def.speed === 'object') {
    const first = Object.values(def.speed)[0];
    if (typeof first === 'number' && first > 0) return first;
  }
  return camp === 'hunter' ? 4.64 : 3.8;
}

function makeSpeedAnim(points: Point2D[], speed: number, name: string): AnimData {
  const speeds = [];
  for (let i = 1; i < points.length; i++) {
    speeds.push({ name, speed });
  }
  return {
    mode: 'speed',
    points,
    speeds,
  };
}

function getActiveCipherPts(mapId: PilMapId, cipherGroupIndex: number): Array<{ id: string; name: string; pt: Point2D }> {
  const map = MAPS_DATA[mapId];
  if (!map) return [];
  const [dw, dh] = map.mapSize;
  const gCount = Math.max(1, map.cipherCombinations.length);
  const gIdx = ((cipherGroupIndex % gCount) + gCount) % gCount;
  const ids = map.cipherCombinations[gIdx] ?? [];
  const out: Array<{ id: string; name: string; pt: Point2D }> = [];
  for (const id of ids) {
    const c = cipherOf(mapId, id);
    if (!c) continue;
    out.push({
      id: c.id,
      name: c.name,
      pt: { x: clamp01(c.location[0] / dw), y: clamp01(c.location[1] / dh) },
    });
  }
  return out;
}

/**
 * Populate an Opening Deduction scenario on `board` (mutates `board` in-place so
 * callers can wrap inside `mutateBoard()` for full Undo support):
 * - Places 1 Hunter + 4 Survivors directly on the selected spawn group
 * - Builds synchronized chase & cipher-rotation animation paths
 * - Initializes all active ciphers to 0% progress
 */
export function populateOpeningScenario(
  board: TacticalBoardState,
  mapId: PilMapId,
  opts: OpeningScenarioOptions = {},
): ScenarioPopulateResult {
  const map = MAPS_DATA[mapId];
  if (!map || map.spawnPoints.length === 0) {
    return { label: '开局推演', summary: '当前地图无刷点数据', tokensPlaced: 0 };
  }

  const [dw, dh] = map.mapSize;
  const sCount = map.spawnPoints.length;
  const spawnIdx = (((opts.spawnGroupIndex ?? board.spawnIndex) % sCount) + sCount) % sCount;
  const cipherIdx = opts.cipherGroupIndex ?? 0;
  const group = map.spawnPoints[spawnIdx]!;
  const hunterRole = TAC_ROLES[opts.hunterRole ?? DEFAULT_OPENING_HUNTER]
    ? (opts.hunterRole ?? DEFAULT_OPENING_HUNTER)
    : DEFAULT_OPENING_HUNTER;
  const survRoles = (opts.survivorRoles?.length ? opts.survivorRoles : DEFAULT_OPENING_SURVIVORS).slice(0, 4);
  const withAnim = opts.withAnim !== false;

  board.spawnIndex = spawnIdx;
  board.tokens = [];
  board.items = [];
  board.cipherProgressEnabled = false;
  board.cipherProgress = {};

  const hPt: Point2D = { x: clamp01(group.hunter[0] / dw), y: clamp01(group.hunter[1] / dh) };
  const sPts: Point2D[] = group.survivor.slice(0, 4).map((p) => ({
    x: clamp01(p[0] / dw),
    y: clamp01(p[1] / dh),
  }));
  const ciphers = getActiveCipherPts(mapId, cipherIdx);

  // Determine the survivor closest to hunter as likely first-chase target
  let targetIdx = 0;
  let bestD = Infinity;
  sPts.forEach((sp, i) => {
    const d = distSq(hPt, sp);
    if (d < bestD) {
      bestD = d;
      targetIdx = i;
    }
  });

  // Hunter token + opening chase path toward target survivor & mid-kite intercept
  const hDef = TAC_ROLES[hunterRole];
  const hSpeed = roleSpeed(hunterRole, 'hunter');
  const hToken: TacticalToken = {
    tid: ++board.tokenSeq,
    role: hunterRole,
    camp: 'hunter',
    x: hPt.x,
    y: hPt.y,
    label: hDef?.name ?? '监管者',
    color: hDef?.color ?? '#b04a58',
    showFearRadius: true,
    rangeBox: { subs: [], talents: { fearRadius: true }, fill: false },
  };

  const targetPt = sPts[targetIdx] ?? { x: 0.5, y: 0.5 };
  // Kite destination: pull away from hunter toward map center / opposite quadrant
  const awayVecX = targetPt.x - hPt.x;
  const awayVecY = targetPt.y - hPt.y;
  const awayLen = Math.hypot(awayVecX, awayVecY) || 1;
  const kiteEnd: Point2D = {
    x: clamp01(targetPt.x + (awayVecX / awayLen) * 0.16),
    y: clamp01(targetPt.y + (awayVecY / awayLen) * 0.16),
  };

  if (withAnim) {
    const midChase = lerpPt(hPt, targetPt, 0.72);
    hToken.anim = makeSpeedAnim([hPt, midChase, lerpPt(targetPt, kiteEnd, 0.55)], hSpeed, hToken.label ?? '监管');
  }
  board.tokens.push(hToken);

  // Place 4 survivors + assign cipher rotation / kiting tracks
  const claimedCipherIds = new Set<string>();
  sPts.forEach((sp, idx) => {
    const rKey = survRoles[idx] ?? DEFAULT_OPENING_SURVIVORS[idx % DEFAULT_OPENING_SURVIVORS.length]!;
    const sDef = TAC_ROLES[rKey];
    const sSpeed = roleSpeed(rKey, 'survivor');
    const tok: TacticalToken = {
      tid: ++board.tokenSeq,
      role: rKey,
      camp: 'survivor',
      x: sp.x,
      y: sp.y,
      label: `${idx + 1}号·${sDef?.name ?? '求生者'}`,
      color: sDef?.color ?? '#6f8fb8',
      rangeBox: { subs: [], talents: {}, fill: false },
    };

    if (withAnim) {
      if (idx === targetIdx) {
        // First-chase survivor kites away from hunter
        const midKite = lerpPt(sp, kiteEnd, 0.52);
        tok.anim = makeSpeedAnim([sp, midKite, kiteEnd], sSpeed, '拉点牵制');
      } else {
        // Other 3 survivors rotate to nearest unclaimed cipher
        let nearest: { id: string; pt: Point2D } | null = null;
        let nd = Infinity;
        for (const c of ciphers) {
          if (claimedCipherIds.has(c.id)) continue;
          const d = distSq(sp, c.pt);
          if (d < nd) {
            nd = d;
            nearest = c;
          }
        }
        if (nearest) {
          claimedCipherIds.add(nearest.id);
          const approach = lerpPt(sp, nearest.pt, 0.94);
          tok.anim = makeSpeedAnim([sp, approach], sSpeed, '就近修机');
        }
      }
    }
    board.tokens.push(tok);
  });

  return {
    label: `开局推演 · 刷点第 ${spawnIdx + 1} 组`,
    summary: `已按第 ${spawnIdx + 1}/${sCount} 组刷点落子 1 监管 + ${sPts.length} 求生，并生成首追拉点与就近修机轨迹`,
    tokensPlaced: board.tokens.length,
  };
}

/**
 * Populate an Endgame Deduction scenario (`prime-pop` 压机 | `chair-rescue` 救人挂椅 | `gate-war` 开门战).
 */
export function populateEndgameScenario(
  board: TacticalBoardState,
  mapId: PilMapId,
  variant: EndgameScenarioKind,
  opts: EndgameScenarioOptions = {},
): ScenarioPopulateResult {
  const map = MAPS_DATA[mapId];
  if (!map) {
    return { label: '残局推演', summary: '地图数据缺失', tokensPlaced: 0 };
  }

  const [dw, dh] = map.mapSize;
  const cipherIdx = opts.cipherGroupIndex ?? 0;
  const ciphers = getActiveCipherPts(mapId, cipherIdx);
  const hunterRole = TAC_ROLES[opts.hunterRole ?? DEFAULT_OPENING_HUNTER]
    ? (opts.hunterRole ?? DEFAULT_OPENING_HUNTER)
    : DEFAULT_OPENING_HUNTER;
  const survRoles = (opts.survivorRoles?.length ? opts.survivorRoles : DEFAULT_OPENING_SURVIVORS).slice(0, 4);
  const withAnim = opts.withAnim !== false;

  board.tokens = [];
  board.items = [];
  board.cipherProgressEnabled = true;
  const progress: Record<string, number> = {};

  const gates: Point2D[] = map.escapeDoors.slice(0, 2).map((g) => ({
    x: clamp01(g[0] / dw),
    y: clamp01(g[1] / dh),
  }));
  const gateA = gates[0] ?? { x: 0.14, y: 0.5 };
  const gateB = gates[1] ?? { x: 0.86, y: 0.5 };

  const chairs: Array<{ pt: Point2D; label: string }> = map.rocketChairs.fixed.map((pt, i) => ({
    pt: {
      x: clamp01(pt[0] / dw),
      y: clamp01((pt.length === 3 ? pt[2] : pt[1]) / dh),
    },
    label: `固定椅 #${i + 1}`,
  }));

  const hDef = TAC_ROLES[hunterRole];
  const hSpeed = roleSpeed(hunterRole, 'hunter');

  if (variant === 'prime-pop') {
    // 4 completed, 1 primed at 99%, rest 0%
    ciphers.forEach((c, i) => {
      if (i < 4) progress[c.id] = 100;
      else if (i === 4) progress[c.id] = 99;
      else progress[c.id] = 0;
    });
    board.cipherProgress = progress;

    const primeCipher = ciphers[4] ?? ciphers[0] ?? { id: 'c', name: '遗产机', pt: { x: 0.5, y: 0.5 } };
    const kiterStart = lerpPt(primeCipher.pt, gateB, 0.45);
    const hunterStart = lerpPt(kiterStart, { x: 0.5, y: 0.5 }, 0.25);

    const hTok: TacticalToken = {
      tid: ++board.tokenSeq,
      role: hunterRole,
      camp: 'hunter',
      x: hunterStart.x,
      y: hunterStart.y,
      label: hDef?.name ?? '监管者',
      color: hDef?.color ?? '#b04a58',
      showFearRadius: true,
      rangeBox: { subs: [], talents: { fearRadius: true }, fill: false },
    };
    if (withAnim) {
      hTok.anim = makeSpeedAnim([hunterStart, kiterStart, lerpPt(kiterStart, gateB, 0.65)], hSpeed, '追击压机');
    }
    board.tokens.push(hTok);

    const placements: Array<{ pt: Point2D; dest: Point2D; tag: string }> = [
      { pt: lerpPt(primeCipher.pt, { x: 0.5, y: 0.5 }, 0.08), dest: gateA, tag: '压机99%' },
      { pt: kiterStart, dest: gateB, tag: '牵制冲门' },
      { pt: lerpPt(gateA, { x: 0.5, y: 0.5 }, 0.24), dest: gateA, tag: '预贴门' },
      { pt: lerpPt(primeCipher.pt, gateB, 0.28), dest: gateB, tag: '补位转点' },
    ];

    placements.forEach((pl, idx) => {
      const rKey = survRoles[idx] ?? DEFAULT_OPENING_SURVIVORS[idx]!;
      const sDef = TAC_ROLES[rKey];
      const tok: TacticalToken = {
        tid: ++board.tokenSeq,
        role: rKey,
        camp: 'survivor',
        x: pl.pt.x,
        y: pl.pt.y,
        label: `${pl.tag}·${sDef?.name ?? '求生'}`,
        color: sDef?.color ?? '#6f8fb8',
        rangeBox: { subs: [], talents: {}, fill: false },
      };
      if (withAnim) {
        tok.anim = makeSpeedAnim([pl.pt, pl.dest], roleSpeed(rKey, 'survivor'), pl.tag);
      }
      board.tokens.push(tok);
    });

    return {
      label: '残局推演 · 压机亮机',
      summary: `已布置 4 台完成 +「${primeCipher.name}」99% 压机，并生成亮机冲门与监管追击时间轴`,
      tokensPlaced: board.tokens.length,
    };
  }

  if (variant === 'chair-rescue') {
    // 3 completed, 1 at 80%, 1 at 55%, rest 0%
    ciphers.forEach((c, i) => {
      if (i < 3) progress[c.id] = 100;
      else if (i === 3) progress[c.id] = 80;
      else if (i === 4) progress[c.id] = 55;
      else progress[c.id] = 0;
    });
    board.cipherProgress = progress;

    // Pick a central chair for high-value rescue/intercept modeling
    let bestChair = chairs[0] ?? { pt: { x: 0.5, y: 0.5 }, label: '固定椅 #1' };
    let bestDist = Infinity;
    for (const ch of chairs) {
      const d = distSq(ch.pt, { x: 0.5, y: 0.5 });
      if (d < bestDist) {
        bestDist = d;
        bestChair = ch;
      }
    }

    const rescuerStart = lerpPt(bestChair.pt, gateA, 0.55);
    const interceptPt = lerpPt(bestChair.pt, rescuerStart, 0.32);
    const cipher3 = ciphers[3]?.pt ?? { x: 0.72, y: 0.3 };
    const cipher4 = ciphers[4]?.pt ?? { x: 0.28, y: 0.72 };

    const hTok: TacticalToken = {
      tid: ++board.tokenSeq,
      role: hunterRole,
      camp: 'hunter',
      x: lerpPt(bestChair.pt, rescuerStart, 0.14).x,
      y: lerpPt(bestChair.pt, rescuerStart, 0.14).y,
      label: `守椅·${hDef?.name ?? '监管'}`,
      color: hDef?.color ?? '#b04a58',
      showFearRadius: true,
      rangeBox: { subs: [], talents: { fearRadius: true, tinnitus: true }, fill: false },
    };
    if (withAnim) {
      hTok.anim = makeSpeedAnim([
        { x: hTok.x, y: hTok.y },
        interceptPt,
        bestChair.pt,
      ], hSpeed, '外围拦截回椅');
    }
    board.tokens.push(hTok);

    const chairPlacements: Array<{ pt: Point2D; path?: Point2D[]; tag: string }> = [
      { pt: rescuerStart, path: [rescuerStart, lerpPt(rescuerStart, bestChair.pt, 0.55), bestChair.pt], tag: '救人位' },
      { pt: bestChair.pt, path: [bestChair.pt, lerpPt(bestChair.pt, gateB, 0.42)], tag: '上椅位(下椅转点)' },
      { pt: lerpPt(cipher3, { x: 0.5, y: 0.5 }, 0.06), tag: '抢机80%' },
      { pt: lerpPt(cipher4, { x: 0.5, y: 0.5 }, 0.06), tag: '补机55%' },
    ];

    chairPlacements.forEach((pl, idx) => {
      const rKey = survRoles[idx] ?? DEFAULT_OPENING_SURVIVORS[idx]!;
      const sDef = TAC_ROLES[rKey];
      const tok: TacticalToken = {
        tid: ++board.tokenSeq,
        role: rKey,
        camp: 'survivor',
        x: pl.pt.x,
        y: pl.pt.y,
        label: `${pl.tag}·${sDef?.name ?? '求生'}`,
        color: sDef?.color ?? '#6f8fb8',
        rangeBox: { subs: [], talents: {}, fill: false },
      };
      if (withAnim && pl.path && pl.path.length >= 2) {
        tok.anim = makeSpeedAnim(pl.path, roleSpeed(rKey, 'survivor'), pl.tag);
      }
      board.tokens.push(tok);
    });

    return {
      label: '残局推演 · 守椅救人',
      summary: `已锁定「${bestChair.label}」布置救人位/守椅拦截与抢机进度（已同步联动范围推算）`,
      tokensPlaced: board.tokens.length,
      recommendedChairRel: bestChair.pt,
      recommendedChairLabel: bestChair.label,
    };
  }

  // variant === 'gate-war': all 5 ciphers powered (100%), split gate push + dungeon play
  ciphers.forEach((c, i) => {
    progress[c.id] = i < 5 ? 100 : 0;
  });
  board.cipherProgress = progress;

  const mid: Point2D = { x: 0.5, y: 0.5 };
  const dungeonPt: Point2D = map.dungeons[0]
    ? { x: clamp01(map.dungeons[0][0] / dw), y: clamp01(map.dungeons[0][1] / dh) }
    : { x: 0.52, y: 0.48 };

  const hTok: TacticalToken = {
    tid: ++board.tokenSeq,
    role: hunterRole,
    camp: 'hunter',
    x: mid.x,
    y: mid.y,
    label: `控门·${hDef?.name ?? '监管'}`,
    color: hDef?.color ?? '#b04a58',
    showFearRadius: true,
    rangeBox: { subs: [], talents: { fearRadius: true }, fill: false },
  };
  if (withAnim) {
    hTok.anim = makeSpeedAnim([mid, lerpPt(mid, gateA, 0.72), lerpPt(mid, gateB, 0.78)], hSpeed, '双门巡控');
  }
  board.tokens.push(hTok);

  const gatePlacements: Array<{ pt: Point2D; dest: Point2D; tag: string }> = [
    { pt: lerpPt(mid, gateA, 0.65), dest: gateA, tag: '正门贴门' },
    { pt: lerpPt(mid, gateB, 0.62), dest: gateB, tag: '小门贴门' },
    { pt: lerpPt(mid, dungeonPt, 0.55), dest: dungeonPt, tag: '卡地窖' },
    { pt: lerpPt(gateA, gateB, 0.35), dest: gateB, tag: '转门接应' },
  ];

  gatePlacements.forEach((pl, idx) => {
    const rKey = survRoles[idx] ?? DEFAULT_OPENING_SURVIVORS[idx]!;
    const sDef = TAC_ROLES[rKey];
    const tok: TacticalToken = {
      tid: ++board.tokenSeq,
      role: rKey,
      camp: 'survivor',
      x: pl.pt.x,
      y: pl.pt.y,
      label: `${pl.tag}·${sDef?.name ?? '求生'}`,
      color: sDef?.color ?? '#6f8fb8',
      rangeBox: { subs: [], talents: {}, fill: false },
    };
    if (withAnim) {
      tok.anim = makeSpeedAnim([pl.pt, pl.dest], roleSpeed(rKey, 'survivor'), pl.tag);
    }
    board.tokens.push(tok);
  });

  return {
    label: '残局推演 · 开门战',
    summary: '已点亮 5 台密码机并布置双大门贴门 + 地窖博弈 + 监管控门时间轴',
    tokensPlaced: board.tokens.length,
  };
}
