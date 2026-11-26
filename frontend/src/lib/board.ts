/**
 * Shared UI state types, coordinate projection helpers, tactical board utilities,
 * and PIL range/link/measurement helpers for Stage 2 (02 战术沙盘).
 */
import type { FloorId, Replay2DPayload, Vec3, WorldRect } from '@idv/replay-renderer';
import {
  CARRY_DEFAULTS,
  MAPS_DATA,
  METERS_PER_WORLD_UNIT,
  TAC_DISPLAY_DEFAULT,
  TAC_HUNTER_ROLES,
  TAC_ITEM_TYPES,
  TAC_MOVEMENT_SURVIVOR,
  TAC_ROLES,
  TAC_TALENT_TYPES,
  WORLD_UNITS_PER_METER,
  computeCarryRadialBandsM,
  computeTideRadialBandsM,
  createCarryProfile,
  createTideProfile,
  evaluateChairsForCarry,
  evaluateChairsForTide,
  evaluateChairsOnNavGrid,
  measureSegmentDistanceM,
  restoreMeasureReferences,
  simulateMovement,
  tZh,
  type AnimGeom,
  type CarryChairEval,
  type CarryProfile,
  type CarryRadialBandM,
  type CarryRangeBand,
  type CarrySurvivorId,
  type ItemDefinition,
  type MeasureBase,
  type MeasureBuff,
  type MeasureLineConfig,
  type MeasureSimResult,
  type NavFieldResult,
  type NavGridData,
  type PilMapData,
  type PilMapId,
  type Point2D,
  type RoleDefinition,
  type RoleRangeOption,
  type RoleRangesConfig,
  type TacticalBoardState,
  type TacticalMeasureLine,
  type TacticalPropItem,
  type TacticalShape,
  type TacticalShapeKind,
  type TacticalTextNote,
  type TacticalToken,
  type TideChairEval,
  type TideProfile,
  type TideRadialBandM,
  type TideRangeBand,
} from '@/tactical';

export interface UnderlayUiState {
  enabled: boolean;
  opacity: number;
  rotationQuadrants: 0 | 1 | 2 | 3;
  flipX: boolean;
  flipZ: boolean;
}

export type BoardToolId = 'inspect' | 'place' | 'draw' | 'measure' | 'range' | 'anim';
export type RightTabId = 'status' | 'tools' | 'events';
export type DrawShapeKind = TacticalShapeKind | 'text';

export type MeasureModeId = 'single' | 'chain' | 'route';

export interface SnapTargets {
  cipher: boolean;
  door: boolean;
  dungeon: boolean;
  chair: boolean;
  locker: boolean;
  box: boolean;
  phoneBooth: boolean;
  spawn: boolean;
  endpoint: boolean;
}

export interface LandmarkSizes {
  cipher: number;
  door: number;
  dungeon: number;
  spawn: number;
  chair: number;
  locker: number;
  box: number;
  phoneBooth: number;
}

export interface LandmarkVisibility {
  zones: boolean;
  ciphers: boolean;
  chairs: boolean;
  basement: boolean;
  basementChest: boolean;
  gates: boolean;
  hatch: boolean;
  chests: boolean;
  lockers: boolean;
  phoneBooths: boolean;
  spawns: boolean;
  fixedSpawns: boolean;
  fixedSpawnDir: boolean;
  fixedSpawnScreen: 'off' | 'pc' | 'ios';
  escapeDoorLock: boolean;
  hideEndpoints: boolean;
  hideAnimPath: boolean;
  hideAnimDots: boolean;
  snapLandmarks: boolean;
  snapTargets: SnapTargets;
  sizes: LandmarkSizes;
  showCoords: boolean;
  selGlow: boolean;
}

export function createDefaultSnapTargets(): SnapTargets {
  return {
    cipher: true,
    door: true,
    dungeon: true,
    chair: true,
    locker: true,
    box: true,
    phoneBooth: true,
    spawn: true,
    endpoint: true,
  };
}

export function createDefaultLandmarkSizes(): LandmarkSizes {
  return {
    cipher: TAC_DISPLAY_DEFAULT.cipherSize,
    door: TAC_DISPLAY_DEFAULT.escapeDoorSize,
    dungeon: TAC_DISPLAY_DEFAULT.dungeonSize,
    spawn: TAC_DISPLAY_DEFAULT.spawnSize,
    chair: TAC_DISPLAY_DEFAULT.rocketChairSize,
    locker: TAC_DISPLAY_DEFAULT.lockerSize,
    box: TAC_DISPLAY_DEFAULT.boxSize,
    phoneBooth: TAC_DISPLAY_DEFAULT.phoneBoothSize,
  };
}

export function createDefaultLandmarks(): LandmarkVisibility {
  return {
    zones: false,
    ciphers: true,
    chairs: true,
    basement: true,
    basementChest: false,
    gates: true,
    hatch: true,
    chests: false,
    lockers: false,
    phoneBooths: false,
    spawns: false,
    fixedSpawns: false,
    fixedSpawnDir: true,
    fixedSpawnScreen: 'off',
    escapeDoorLock: false,
    hideEndpoints: false,
    hideAnimPath: false,
    hideAnimDots: false,
    snapLandmarks: true,
    snapTargets: createDefaultSnapTargets(),
    sizes: createDefaultLandmarkSizes(),
    showCoords: false,
    selGlow: false,
  };
}

export type BoardToken = TacticalToken & {
  size?: number;
  hideIcon?: boolean;
  glow?: boolean;
  linkAuto?: boolean;
  linkShow?: boolean;
  showFixedSpawns?: boolean;
  showSpawnDir?: boolean;
  fixedSpawnDevice?: 'pc' | 'ios';
  rangeM?: number;
  rangeGear?: number;
  fearH?: string;
  fearS?: string;
};

export type BoardProp = TacticalPropItem & {
  linkIid?: number | null;
  linkAuto?: boolean;
  hideIcon?: boolean;
  glow?: boolean;
  angle?: number;
  iconSize?: number;
  aqIid?: number;
  rangeM?: number;
  rangeGear?: number;
  rangeBox?: {
    subs?: number[];
    fill?: boolean;
    talents?: Record<string, boolean | number>;
  };
};

export type BoardSelection =
  | { type: 'token'; tid: number }
  | { type: 'prop'; iid: number }
  | { type: 'text'; id: number }
  | { type: 'shape'; id: number }
  | { type: 'measure'; id: number }
  | null;

export type PlacePending =
  | { kind: 'role'; role: string }
  | { kind: 'prop'; role: string; propKind: string }
  | { kind: 'text' }
  | null;

export interface BoardGeoContext {
  isStandalone: boolean;
  mapId: PilMapId;
  mapData: PilMapData;
  refRect: WorldRect;
  yPlane: number;
  effectiveWidthM: number;
  relToWorld: (u: number, v: number, y?: number) => Vec3;
  worldToRel: (x: number, z: number) => Point2D;
  distMeters: (a: Point2D, b: Point2D) => number;
  metersToWorld: (meters: number) => number;
  animGeom: AnimGeom;
}

export const TAC_DRAW_COLORS: readonly string[] = Object.freeze([
  '#c9a25f', // Manor Gold
  '#b04a58', // Manor Crimson
  '#6f8fb8', // Manor Slate Blue
  '#20d6a0', // Emerald
  '#ef4444', // Alert Red
  '#eab308', // Amber
  '#a855f7', // Violet
  '#f8fafc', // Ivory
]);

export const TAC_TACTICAL_TALENTS_BY_CAMP: Readonly<{
  survivor: readonly string[];
  hunter: readonly string[];
}> = Object.freeze({
  survivor: ['fearRadius', 'webersLaw', 'sneak'],
  hunter: [
    'tinnitus',
    'fearRadius',
    'addiction',
    'nostalgic',
    'skittish',
    'deerHunt',
    'streetSweeper',
    'wither',
    'obsession',
    'famine',
  ],
});

export function buildBoardGeoContext(
  payload: Replay2DPayload | null,
  mapId: PilMapId,
  yPlane = 0,
): BoardGeoContext {
  const mapData = MAPS_DATA[mapId]!;
  const isStandalone = !payload || payload.match.match_id.startsWith('pil-map-');
  let refRect: WorldRect;
  if (payload) {
    if (isStandalone) {
      refRect = {
        min_x: payload.world.bounds.min_x,
        max_x: payload.world.bounds.max_x,
        min_z: payload.world.bounds.min_z,
        max_z: payload.world.bounds.max_z,
      };
    } else {
      const wr = payload.world.map_underlay.world_rect;
      refRect =
        wr && wr.max_x > wr.min_x && wr.max_z > wr.min_z
          ? wr
          : {
              min_x: payload.world.bounds.min_x,
              max_x: payload.world.bounds.max_x,
              min_z: payload.world.bounds.min_z,
              max_z: payload.world.bounds.max_z,
            };
    }
  } else {
    const uPerPx = (mapData.widthM / mapData.mapSize[0]) * WORLD_UNITS_PER_METER;
    refRect = {
      min_x: 0,
      max_x: mapData.mapSize[0] * uPerPx,
      min_z: 0,
      max_z: mapData.mapSize[1] * uPerPx,
    };
  }

  const spanX = Math.max(1e-4, refRect.max_x - refRect.min_x);
  const spanZ = Math.max(1e-4, refRect.max_z - refRect.min_z);
  const effectiveWidthM = isStandalone ? mapData.widthM : spanX * METERS_PER_WORLD_UNIT;

  const relToWorld = (u: number, v: number, y = yPlane): Vec3 => [
    refRect.min_x + u * spanX,
    y,
    refRect.min_z + v * spanZ,
  ];

  const worldToRel = (x: number, z: number): Point2D => ({
    x: Math.min(1.05, Math.max(-0.05, (x - refRect.min_x) / spanX)),
    y: Math.min(1.05, Math.max(-0.05, (z - refRect.min_z) / spanZ)),
  });

  const distMeters = (a: Point2D, b: Point2D): number => {
    const wa = relToWorld(a.x, a.y, 0);
    const wb = relToWorld(b.x, b.y, 0);
    return Math.hypot(wb[0] - wa[0], wb[2] - wa[2]) * METERS_PER_WORLD_UNIT;
  };

  const metersToWorld = (meters: number): number => meters * WORLD_UNITS_PER_METER;

  const animGeom: AnimGeom = isStandalone
    ? { dw: mapData.mapSize[0], dh: mapData.mapSize[1], widthM: mapData.widthM }
    : { dw: spanX, dh: spanZ, widthM: spanX * METERS_PER_WORLD_UNIT };

  return {
    isStandalone,
    mapId,
    mapData,
    refRect,
    yPlane,
    effectiveWidthM,
    relToWorld,
    worldToRel,
    distMeters,
    metersToWorld,
    animGeom,
  };
}

export function cloneBoardState(state: TacticalBoardState): TacticalBoardState {
  const raw = JSON.parse(JSON.stringify(state)) as TacticalBoardState;
  restoreMeasureReferences({ _: raw });
  return raw;
}

export function boardHasContent(state: TacticalBoardState): boolean {
  return (
    state.tokens.length > 0 ||
    state.items.length > 0 ||
    state.shapes.length > 0 ||
    state.texts.length > 0 ||
    state.measures.length > 0
  );
}

export function clamp01(v: number, pad = 0.004): number {
  return Math.min(1 - pad, Math.max(pad, v));
}

export function tokenDisplayName(token: TacticalToken): string {
  if (token.label) return token.label;
  return TAC_ROLES[token.role]?.name ?? token.role;
}

export function propDisplayName(prop: TacticalPropItem): string {
  if (prop.label) return prop.label;
  return TAC_ITEM_TYPES[prop.kind]?.name ?? prop.kind;
}

export function tokenCamp(token: TacticalToken): 'survivor' | 'hunter' {
  if (token.camp) return token.camp;
  return TAC_ROLES[token.role]?.camp === 'hunter' ? 'hunter' : 'survivor';
}

export function tokenColor(token: TacticalToken): string {
  if (token.color) return token.color;
  return tokenCamp(token) === 'hunter' ? '#b04a58' : '#6f8fb8';
}

export function propColor(prop: TacticalPropItem): string {
  if (prop.color) return prop.color;
  return TAC_ITEM_TYPES[prop.kind]?.color ?? '#c9a25f';
}

export interface ResolvedRangeCircle {
  key: string;
  label: string;
  radiusM: number;
  innerRadiusM?: number;
  crossWidthM?: number;
  fill: boolean;
  color: string;
}

function evalOptionMeters(
  opt: RoleRangeOption,
  cfg: RoleRangesConfig | undefined,
  gearIdx: number,
  sliderM: number | undefined,
  fearH: string | undefined,
  fearS: string | undefined,
  mapWidthM: number,
): number | null {
  const s = opt.size_m;
  let base: number | null = null;
  if (typeof s === 'number') {
    base = s;
  } else if (Array.isArray(s)) {
    const idx = Math.max(0, Math.min(s.length - 1, gearIdx));
    base = s[idx] ?? null;
  } else if (s && typeof s === 'object') {
    const dynMax = s.max ?? (mapWidthM || 100);
    base = sliderM ?? dynMax;
  }
  if (base === null || !(base > 0)) return null;
  if (cfg?.fearMods) {
    const pick = (opts: Array<[string, string, number]>, v: string | undefined) =>
      (opts.find((o) => o[0] === v) ?? opts[0])?.[2] ?? 1;
    base *= pick(cfg.fearMods.hunter, fearH) * pick(cfg.fearMods.survivor, fearS);
  }
  return base;
}

export function resolveTokenRangeCircles(
  token: BoardToken,
  mapWidthM: number,
): ResolvedRangeCircle[] {
  const def: RoleDefinition | undefined = TAC_ROLES[token.role];
  const camp = tokenCamp(token);
  const out: ResolvedRangeCircle[] = [];
  const rb = token.rangeBox;
  const fill = rb?.fill ?? false;

  if (def?.ranges && rb?.subs?.length) {
    for (const idx of rb.subs) {
      const opt = def.ranges.options[idx];
      if (!opt) continue;
      const meters = evalOptionMeters(
        opt,
        def.ranges,
        token.rangeGear ?? 0,
        token.rangeM,
        token.fearH,
        token.fearS,
        mapWidthM,
      );
      if (meters === null) continue;
      out.push({
        key: `role-${idx}`,
        label: opt.label,
        radiusM: meters,
        innerRadiusM: opt.ringInner,
        crossWidthM: opt.crossWidth,
        fill,
        color: camp === 'hunter' ? '#b04a58' : '#6f8fb8',
      });
    }
  }

  // Talent ranges (fearRadius, tinnitus, webersLaw, sneak, etc.)
  const talents = rb?.talents ?? {};
  const talentKeys = TAC_TACTICAL_TALENTS_BY_CAMP[camp];
  for (const tk of talentKeys) {
    const active = talents[tk];
    if (!active && !(tk === 'fearRadius' && token.showFearRadius)) continue;
    const tdef = TAC_TALENT_TYPES[tk];
    const opt = tdef?.ranges?.options?.[0];
    if (!tdef || !opt) continue;

    if (tk === 'fearRadius') {
      const baseM = typeof opt.size_m === 'number' ? opt.size_m : 32.07;
      const fr = def?.fearRadius;
      let mult = 1;
      let suffix = '';
      if (camp === 'hunter' && fr?.forms?.length) {
        const idx = typeof active === 'number' ? active : 0;
        const form =
          fr.forms.find((f) => f.key === token.fearFormKey) ??
          fr.forms[Math.max(0, Math.min(fr.forms.length - 1, idx))] ??
          fr.forms[0]!;
        mult = form.mult;
        suffix = `·${form.name}`;
      } else if (camp === 'survivor' && fr?.mult) {
        mult = fr.mult;
      }
      out.push({
        key: `talent-${tk}`,
        label: `${tdef.name}${suffix}`,
        radiusM: baseM * mult,
        fill,
        color: camp === 'hunter' ? '#ef4444' : '#6f8fb8',
      });
      continue;
    }

    const gear = typeof active === 'number' ? active : 0;
    const meters = evalOptionMeters(opt, tdef.ranges, gear, undefined, undefined, undefined, mapWidthM);
    if (meters === null) continue;
    out.push({
      key: `talent-${tk}`,
      label: tdef.name,
      radiusM: meters,
      fill,
      color: camp === 'hunter' ? '#f97316' : '#6f8fb8',
    });
  }

  return out;
}

export function resolvePropRangeCircles(
  prop: BoardProp,
  mapWidthM: number,
): ResolvedRangeCircle[] {
  const def: ItemDefinition | undefined = TAC_ITEM_TYPES[prop.kind];
  if (!def?.ranges?.options?.length) return [];
  const rb = prop.rangeBox;
  const subs = rb ? rb.subs ?? [] : prop.showRange === false ? [] : [prop.rangeSubIndex ?? 0];
  const fill = rb?.fill ?? Boolean(def.fill);
  const out: ResolvedRangeCircle[] = [];
  for (const idx of subs) {
    const opt = def.ranges.options[idx];
    if (!opt) continue;
    const meters = evalOptionMeters(
      opt,
      def.ranges,
      prop.rangeGear ?? 0,
      prop.rangeM,
      undefined,
      undefined,
      mapWidthM,
    );
    if (meters === null) continue;
    out.push({
      key: `prop-${idx}`,
      label: opt.label,
      radiusM: meters,
      innerRadiusM: opt.ringInner,
      crossWidthM: opt.crossWidth,
      fill,
      color: def.color ?? '#c9a25f',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Measurement Helpers
// ---------------------------------------------------------------------------

export function letterLabel(i: number): string {
  let s = '';
  let k = i + 1;
  while (k > 0) {
    s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
    k = Math.floor((k - 1) / 26);
  }
  return s;
}

export interface MeasureChainGroup {
  id: number | null;
  segs: TacticalMeasureLine[];
  lc: MeasureLineConfig;
  sim: MeasureSimResult;
}

export function defaultMeasureBase(camp: 'survivor' | 'hunter' = 'survivor'): MeasureBase {
  if (camp === 'hunter') {
    const h = TAC_ROLES.hellEmber;
    const sp = typeof h?.speed === 'number' ? h.speed : 4.64;
    return {
      from: 0,
      to: 1,
      name: h?.name ?? '厂长',
      speed: sp,
      camp: 'hunter',
      role: 'hellEmber',
      form: 0,
    };
  }
  return {
    from: 0,
    to: 1,
    name: TAC_MOVEMENT_SURVIVOR.states.run.name,
    speed: TAC_MOVEMENT_SURVIVOR.states.run.speed,
    camp: 'survivor',
    role: null,
    form: 0,
    stKey: 'run',
  };
}

export function createMeasureConfig(
  lid: number,
  segCount: number,
  base: MeasureBase,
  buffs: readonly MeasureBuff[],
): MeasureLineConfig {
  return {
    lid,
    bases: [{ ...base, from: 0, to: Math.max(1, segCount) }],
    buffs: buffs.map((b) => ({ ...b, from: 0, to: Math.max(1, segCount) })),
  };
}

export function groupMeasureLines(
  measures: readonly TacticalMeasureLine[],
  geo: BoardGeoContext,
): MeasureChainGroup[] {
  const groups: Array<{ id: number | null; segs: TacticalMeasureLine[] }> = [];
  const byChain = new Map<number, TacticalMeasureLine[]>();
  for (const m of measures) {
    if (m.chain === null || m.chain === undefined) {
      groups.push({ id: null, segs: [m] });
    } else {
      let arr = byChain.get(m.chain);
      if (!arr) {
        arr = [];
        byChain.set(m.chain, arr);
        groups.push({ id: m.chain, segs: arr });
      }
      arr.push(m);
    }
  }
  const mapSize: [number, number] = geo.isStandalone
    ? geo.mapData.mapSize
    : [Math.max(1, geo.refRect.max_x - geo.refRect.min_x), Math.max(1, geo.refRect.max_z - geo.refRect.min_z)];
  return groups.map((g) => {
    const lc: MeasureLineConfig =
      g.segs[0]?.lc ?? createMeasureConfig(1, g.segs.length, defaultMeasureBase(), []);
    const dists = g.segs.map((m) => measureSegmentDistanceM(m, mapSize, geo.effectiveWidthM));
    const sim = simulateMovement(dists, lc);
    return { id: g.id, segs: g.segs, lc, sim };
  });
}

// ---------------------------------------------------------------------------
// Animation Speed Presets
// ---------------------------------------------------------------------------

export interface AnimSpeedPreset {
  key: string;
  camp: 'survivor' | 'hunter';
  group: string;
  name: string;
  speed: number;
}

export function buildAnimSpeedPresets(): AnimSpeedPreset[] {
  const out: AnimSpeedPreset[] = [];
  for (const [k, st] of Object.entries(TAC_MOVEMENT_SURVIVOR.states)) {
    out.push({
      key: `surv:state:${k}`,
      camp: 'survivor',
      group: '求生者基础状态',
      name: `求生者·${st.name}`,
      speed: st.speed,
    });
  }
  for (const [k, rg] of Object.entries(TAC_MOVEMENT_SURVIVOR.roles)) {
    if (k === 'survivor') continue;
    out.push({
      key: `surv:role:${k}`,
      camp: 'survivor',
      group: '求生者角色移速',
      name: rg.name,
      speed: rg.speed,
    });
  }
  for (const [k, fg] of Object.entries(TAC_MOVEMENT_SURVIVOR.fixed)) {
    out.push({
      key: `surv:fixed:${k}`,
      camp: 'survivor',
      group: '求生者固定移速',
      name: fg.name,
      speed: fg.speed,
    });
  }
  for (const h of Object.values(TAC_HUNTER_ROLES)) {
    if (h.speed == null) continue;
    if (typeof h.speed === 'number') {
      out.push({
        key: `hunt:${h.key}:0`,
        camp: 'hunter',
        group: '监管者形态移速',
        name: h.name,
        speed: h.speed,
      });
    } else {
      Object.entries(h.speed).forEach(([formName, sp], idx) => {
        out.push({
          key: `hunt:${h.key}:${idx}`,
          camp: 'hunter',
          group: '监管者形态移速',
          name: formName === h.name ? h.name : `${h.name}·${formName}`,
          speed: sp,
        });
      });
    }
  }
  return out;
}

export const ANIM_SPEED_PRESETS: readonly AnimSpeedPreset[] = Object.freeze(buildAnimSpeedPresets());

// ---------------------------------------------------------------------------
// Range (Carry / Tide) Overlay State & Evaluator
// ---------------------------------------------------------------------------

export interface BoardChairCandidate {
  index: number;
  relPos: [number, number];
  label: string;
  kind: 'fixed' | 'set' | 'basement' | 'replay';
  floor: FloorId;
}

export interface RangeNavFieldOverlay {
  mapId: PilMapId;
  scenario: 'carry' | 'tide';
  gridW: number;
  gridH: number;
  bandOf: Int8Array;
  bands: Array<CarryRangeBand | TideRangeBand>;
  reached: number;
  originKey: string;
}

export interface RangeOverlayState {
  scenario: 'carry' | 'tide';
  mode: 'chair' | 'point';
  armed: boolean;
  origin: {
    kind: 'chair' | 'point';
    x: number;
    y: number;
    label: string;
    floor?: FloorId;
    isBasement?: boolean;
    basementIdx?: number;
  } | null;
  survivorId: CarrySurvivorId;
  hunterKey: string;
  hunterFormIdx: number;
  carryBaseSpeed: number;
  initialProgress: number;
  pickupSeconds: number;
  carryBuffs: Array<{ id: number; key: string; level: number }>;
  tideBase: MeasureBase;
  tideBuffs: MeasureBuff[];
  hiddenBands: number[];
  opacity: number;
  hideRing: boolean;
  hideRingLabel: boolean;
  detailMarkIndex: number | null;
}

export function createDefaultRangeState(): RangeOverlayState {
  return {
    scenario: 'carry',
    mode: 'chair',
    armed: true,
    origin: null,
    survivorId: CARRY_DEFAULTS.survivorId,
    hunterKey: 'hellEmber',
    hunterFormIdx: 0,
    carryBaseSpeed: CARRY_DEFAULTS.baseSpeed,
    initialProgress: CARRY_DEFAULTS.initialProgress,
    pickupSeconds: CARRY_DEFAULTS.pickupSeconds,
    carryBuffs: [],
    tideBase: defaultMeasureBase('survivor'),
    tideBuffs: [],
    hiddenBands: [],
    opacity: 0.72,
    hideRing: false,
    hideRingLabel: false,
    detailMarkIndex: null,
  };
}

export interface RangeEvaluation {
  scenario: 'carry' | 'tide';
  mode: 'chair' | 'point';
  radialBands: Array<CarryRadialBandM | TideRadialBandM>;
  chairRows: Array<CarryChairEval | TideChairEval>;
  summaryText: string;
  usedNavGrid: boolean;
  navField: RangeNavFieldOverlay | null;
}

export function buildCarryProfileFromRange(range: RangeOverlayState): CarryProfile {
  return createCarryProfile({
    survivorId: range.survivorId,
    baseSpeed: range.carryBaseSpeed,
    initialProgress: range.initialProgress,
    pickupSeconds: range.pickupSeconds,
    buffs: range.carryBuffs.map(({ key, level }) => ({ key, level })),
  });
}

export function buildTideProfileFromRange(range: RangeOverlayState): TideProfile {
  return createTideProfile({
    baseSpeed: range.tideBase.speed,
    buffs: range.tideBuffs.map((b) => ({
      mult: b.mult ?? 1,
      postMult: b.postMult,
      duration: b.duration,
    })),
  });
}

export function collectBoardChairs(
  payload: Replay2DPayload | null,
  geo: BoardGeoContext,
  chairIndex: number,
  basementIndex: number,
  includeBasement: boolean,
): BoardChairCandidate[] {
  const out: BoardChairCandidate[] = [];
  if (!geo.isStandalone && payload) {
    payload.entities.chairs.forEach((ch, idx) => {
      const rel = geo.worldToRel(ch.pos[0], ch.pos[2]);
      out.push({
        index: idx,
        relPos: [rel.x, rel.y],
        label: ch.is_basement ? `地下室椅 #${ch.uid}` : `狂欢之椅 #${ch.uid}`,
        kind: 'replay',
        floor: ch.floor,
      });
    });
    return out;
  }
  const map = geo.mapData;
  const [dw, dh] = map.mapSize;
  const pushPt = (pt: readonly [number, number] | readonly [number, number, number], kind: 'fixed' | 'set' | 'basement', label: string, floor: FloorId) => {
    const px = pt[0];
    const pz = pt.length === 3 ? pt[2] : pt[1];
    const f: FloorId = pt.length === 3 && pt[1] >= 25 ? '2F' : floor;
    out.push({
      index: out.length,
      relPos: [px / dw, pz / dh],
      label,
      kind,
      floor: f,
    });
  };
  map.rocketChairs.fixed.forEach((pt, i) => pushPt(pt, 'fixed', `固定椅 #${i + 1}`, '1F'));
  if (map.rocketChairs.sets.length > 0) {
    const sIdx = ((chairIndex % map.rocketChairs.sets.length) + map.rocketChairs.sets.length) % map.rocketChairs.sets.length;
    (map.rocketChairs.sets[sIdx] ?? []).forEach((pt, i) => pushPt(pt, 'set', `随机椅 #${i + 1}`, '1F'));
  }
  if (includeBasement) {
    const bs = Object.values(map.basements);
    if (bs.length > 0) {
      const bIdx = ((basementIndex % bs.length) + bs.length) % bs.length;
      bs[bIdx]!.rocketChairs.forEach((pt, i) => pushPt(pt, 'basement', `地下室椅 #${i + 1}`, 'B1'));
    }
  }
  return out;
}

export function computeRangeEvaluation(
  range: RangeOverlayState,
  chairs: readonly BoardChairCandidate[],
  geo: BoardGeoContext,
  navGrid: NavGridData | null = null,
  navFieldResult: NavFieldResult<CarryRangeBand> | NavFieldResult<TideRangeBand> | null = null,
  navFieldOverlay: RangeNavFieldOverlay | null = null,
): RangeEvaluation | null {
  const origin = range.origin;
  if (!origin) return null;

  const mapSize: [number, number] = geo.isStandalone
    ? geo.mapData.mapSize
    : [Math.max(1, geo.refRect.max_x - geo.refRect.min_x), Math.max(1, geo.refRect.max_z - geo.refRect.min_z)];
  const widthM = geo.effectiveWidthM;
  const navReady = Boolean(
    navGrid &&
      navFieldResult &&
      navFieldOverlay &&
      navFieldOverlay.mapId === geo.mapId &&
      navFieldOverlay.scenario === range.scenario &&
      !navFieldResult.cancelled,
  );

  if (range.scenario === 'carry') {
    const profile = buildCarryProfileFromRange(range);
    const radialBands = computeCarryRadialBandsM(profile);
    const chairRows = navReady
      ? evaluateChairsOnNavGrid(
          navGrid!,
          navFieldResult as NavFieldResult<CarryRangeBand>,
          profile,
          chairs.map((c) => ({ relPos: c.relPos, label: c.label, kind: c.kind, index: c.index, floor: c.floor })),
          geo.mapData.mapSize,
          'carry',
        )
      : evaluateChairsForCarry(
          profile,
          [origin.x, origin.y],
          chairs.map((c) => ({ relPos: c.relPos, label: c.label, kind: c.kind, index: c.index })),
          mapSize,
          widthM,
        );
    const hangable = chairRows.filter((r) => r.canHang).length;
    const maxR = radialBands.at(-1)?.maxRadiusM ?? 0;
    const modeTag = navReady ? '绕障导航' : '直线估算';
    const summaryText =
      range.mode === 'chair'
        ? `${modeTag} · 剩余挣扎 ${profile.remainingSeconds.toFixed(1)}s · 牵起 ${profile.pickupSeconds.toFixed(1)}s · 最大 ${maxR.toFixed(1)}m`
        : `${modeTag} · 可挂狂欢之椅 ${hangable}/${chairRows.length} 把 · 挣扎总时长 ${profile.remainingSeconds.toFixed(1)}s`;
    return {
      scenario: 'carry',
      mode: range.mode,
      radialBands,
      chairRows,
      summaryText,
      usedNavGrid: navReady,
      navField: navReady ? navFieldOverlay : null,
    };
  }

  const profile = buildTideProfileFromRange(range);
  const radialBands = computeTideRadialBandsM(profile);
  const chairRows = navReady
    ? evaluateChairsOnNavGrid(
        navGrid!,
        navFieldResult as NavFieldResult<TideRangeBand>,
        profile,
        chairs.map((c) => ({ relPos: c.relPos, label: c.label, kind: c.kind, index: c.index, floor: c.floor })),
        geo.mapData.mapSize,
        'tide',
      )
    : evaluateChairsForTide(
        profile,
        [origin.x, origin.y],
        chairs.map((c) => ({ relPos: c.relPos, label: c.label, kind: c.kind, index: c.index })),
        mapSize,
        widthM,
      );
  const reach20 = chairRows.filter((r) => r.reachable20s).length;
  const maxR = radialBands.at(-1)?.maxRadiusM ?? 0;
  const modeTag = navReady ? '绕障导航' : '直线估算';
  const summaryText =
    range.mode === 'chair'
      ? `${modeTag} · 化险为夷 20s(+1s余量) · 移速 ${profile.baseSpeed.toFixed(2)} m/s · 最大 ${maxR.toFixed(1)}m`
      : `${modeTag} · 20s内可达 ${reach20} 把狂欢之椅（含21s余量共 ${chairRows.filter((r) => r.reachable).length} 把）`;
  return {
    scenario: 'tide',
    mode: range.mode,
    radialBands,
    chairRows,
    summaryText,
    usedNavGrid: navReady,
    navField: navReady ? navFieldOverlay : null,
  };
}

// ---------------------------------------------------------------------------
// Bloody Queen Mirror + Link Helpers
// ---------------------------------------------------------------------------

export function syncBloodyQueenMirror(
  board: TacticalBoardState,
  moved: 'bq' | 'aq' | 'mi' | null,
  targetAq?: BoardProp,
): void {
  const items = board.items as BoardProp[];
  const aq = targetAq ?? items.find((it) => it.kind === 'aquaMirror');
  if (!aq || aq.linkTid == null) return;
  const bq = board.tokens.find((t) => t.tid === aq.linkTid);
  if (!bq) return;
  let miIdx = items.findIndex((it) => it.kind === 'mirrorImage' && (it.aqIid == null || it.aqIid === aq.iid));
  if (!aq.showMirror) {
    if (miIdx >= 0) items.splice(miIdx, 1);
    delete aq.mirrorAxis;
    return;
  }
  if (miIdx < 0) {
    items.push({
      iid: ++board.itemSeq,
      role: 'bloodyQueen',
      kind: 'mirrorImage',
      aqIid: aq.iid,
      x: clamp01(2 * aq.x - bq.x),
      y: clamp01(2 * aq.y - bq.y),
    });
    return;
  }
  const mi = items[miIdx]!;
  if (aq.fixedMirror) {
    if (!aq.mirrorAxis) {
      const dx = bq.x - aq.x;
      const dy = bq.y - aq.y;
      const len = Math.hypot(dx, dy) || 1;
      // Store unit normal in mirrorAxis (x2, y2 encode nx, ny relative to x1, y1)
      aq.mirrorAxis = { x1: aq.x, y1: aq.y, x2: dx / len, y2: dy / len };
    }
    const ax = aq.mirrorAxis.x1;
    const ay = aq.mirrorAxis.y1;
    const nx = aq.mirrorAxis.x2;
    const ny = aq.mirrorAxis.y2;
    const reflect = (pt: Point2D): Point2D => {
      const dot = (pt.x - ax) * nx + (pt.y - ay) * ny;
      return { x: clamp01(pt.x - 2 * dot * nx), y: clamp01(pt.y - 2 * dot * ny) };
    };
    if (moved === 'bq') {
      const r = reflect(bq);
      mi.x = r.x;
      mi.y = r.y;
    } else if (moved === 'mi') {
      const r = reflect(mi);
      bq.x = r.x;
      bq.y = r.y;
    }
    return;
  }
  delete aq.mirrorAxis;
  if (moved === 'mi') {
    aq.x = clamp01((bq.x + mi.x) / 2);
    aq.y = clamp01((bq.y + mi.y) / 2);
  } else {
    mi.x = clamp01(2 * aq.x - bq.x);
    mi.y = clamp01(2 * aq.y - bq.y);
  }
}

export function autoLinkCreatedItem(board: TacticalBoardState, item: BoardProp): void {
  const def = TAC_ITEM_TYPES[item.kind];
  if (!def) return;
  const items = board.items as BoardProp[];
  if (def.render === 'link') {
    const mate = items.find(
      (o) => o.iid !== item.iid && o.kind === item.kind && o.linkIid == null && o.linkAuto !== false,
    );
    if (mate) {
      item.linkIid = mate.iid;
      mate.linkIid = item.iid;
      const show = item.linkShow !== false || mate.linkShow !== false;
      item.linkShow = show;
      mate.linkShow = show;
    }
  } else if (def.linkToRole) {
    const mate = (board.tokens as BoardToken[]).find(
      (t) =>
        t.role === def.linkToRole &&
        t.linkAuto !== false &&
        !items.some((it) => it.linkTid === t.tid),
    );
    if (mate) {
      item.linkTid = mate.tid;
      const show = item.linkShow !== false || mate.linkShow !== false;
      item.linkShow = show;
      mate.linkShow = show;
    }
  }
}

export function autoLinkCreatedToken(board: TacticalBoardState, token: BoardToken): void {
  const items = board.items as BoardProp[];
  const mate = items.find((it) => {
    const def = TAC_ITEM_TYPES[it.kind];
    return def && def.linkToRole === token.role && it.linkTid == null && it.linkAuto !== false;
  });
  if (mate) {
    mate.linkTid = token.tid;
    const show = mate.linkShow !== false || token.linkShow !== false;
    mate.linkShow = show;
    token.linkShow = show;
  }
}

export function labelForTalentKey(key: string): string {
  return TAC_TALENT_TYPES[key]?.name ?? tZh(`talent.hunter.${key}`) ?? key;
}

// ---------------------------------------------------------------------------
// P2: Hitting-Point / Surging-Tides Chain Linking (4m - 35m, 4th auto-close)
// ---------------------------------------------------------------------------

export const CHAIN_LINKABLE_KINDS: ReadonlySet<string> = new Set([
  'contactPoint',
  'surgingTides',
]);

export const HITTING_POINT_MIN_M = 4;
export const HITTING_POINT_MAX_M = 35;

export function isChainLinkableProp(kind: string): boolean {
  return CHAIN_LINKABLE_KINDS.has(kind);
}

/**
 * Clamp a newly created or dragged hitting-point relative to its previous chain neighbor
 * to PIL's 4m–35m constraint when linkable.
 */
export function clampHittingPointToChain(
  board: TacticalBoardState,
  item: BoardProp,
  mapWidthM: number,
  mapAspect = 1,
): void {
  if (!isChainLinkableProp(item.kind) || item.allowLink === false || item.chainId == null) return;
  const members = (board.items as BoardProp[])
    .filter((o) => o.kind === item.kind && o.chainId === item.chainId && o.allowLink !== false)
    .sort((a, b) => (a.chainOrder ?? a.iid) - (b.chainOrder ?? b.iid));
  const idx = members.findIndex((o) => o.iid === item.iid);
  if (idx <= 0) return;
  const prev = members[idx - 1]!;
  const dx = item.x - prev.x;
  const dy = (item.y - prev.y) * mapAspect;
  const distM = Math.hypot(dx, dy) * mapWidthM;
  if (distM >= HITTING_POINT_MIN_M && distM <= HITTING_POINT_MAX_M) return;
  const targetM = distM < HITTING_POINT_MIN_M ? HITTING_POINT_MIN_M : HITTING_POINT_MAX_M;
  const ux = distM > 1e-6 ? dx / (distM / mapWidthM) : 1;
  const uy = distM > 1e-6 ? dy / (distM / mapWidthM) : 0;
  const stepRel = targetM / Math.max(1, mapWidthM);
  item.x = clamp01(prev.x + ux * stepRel);
  item.y = clamp01(prev.y + (uy * stepRel) / Math.max(0.1, mapAspect));
}

/**
 * Attach a newly placed hitting-point / abyss node into the active open chain of the same kind.
 * PIL rules:
 * - Chains link in join/creation order
 * - 4th open point automatically closes the component back to the earliest point
 * - `linkShow` is shared within each chain component
 */
export function attachHittingPointToChain(
  board: TacticalBoardState,
  item: BoardProp,
  mapWidthM = 160,
  mapAspect = 1,
): void {
  if (!isChainLinkableProp(item.kind)) return;
  item.allowLink = item.allowLink !== false;
  if (!item.allowLink) {
    item.chainId = null;
    item.chainClosed = false;
    return;
  }
  const items = board.items as BoardProp[];
  // Find latest open chain of the same kind
  const openChainMembers = items
    .filter(
      (o) =>
        o.iid !== item.iid &&
        o.kind === item.kind &&
        o.allowLink !== false &&
        o.chainId != null &&
        !o.chainClosed,
    )
    .sort((a, b) => (a.chainOrder ?? a.iid) - (b.chainOrder ?? b.iid));

  const targetChainId = openChainMembers.length > 0 ? openChainMembers[0]!.chainId! : item.iid;
  const sameChain = openChainMembers.filter((o) => o.chainId === targetChainId);
  const maxOrder = sameChain.reduce((m, o) => Math.max(m, o.chainOrder ?? o.iid), 0);
  item.chainId = targetChainId;
  item.chainOrder = maxOrder + 1;
  item.chainClosed = false;
  item.linkShow = sameChain.length > 0 ? sameChain[0]!.linkShow !== false : true;

  if (sameChain.length > 0) {
    clampHittingPointToChain(board, item, mapWidthM, mapAspect);
  }

  const allInChain = [...sameChain, item];
  if (allInChain.length >= 4) {
    for (const m of allInChain) {
      m.chainClosed = true;
    }
  }
}

export function closeHittingPointChain(board: TacticalBoardState, item: BoardProp): boolean {
  if (!isChainLinkableProp(item.kind) || item.chainId == null) return false;
  const members = (board.items as BoardProp[]).filter(
    (o) => o.kind === item.kind && o.chainId === item.chainId && o.allowLink !== false,
  );
  if (members.length < 3) return false;
  const nextClosed = !members.every((m) => m.chainClosed);
  for (const m of members) m.chainClosed = nextClosed;
  return nextClosed;
}

export function setHittingPointShowLink(board: TacticalBoardState, item: BoardProp, show: boolean): void {
  if (!isChainLinkableProp(item.kind) || item.chainId == null) {
    item.linkShow = show;
    return;
  }
  for (const o of board.items as BoardProp[]) {
    if (o.kind === item.kind && o.chainId === item.chainId) {
      o.linkShow = show;
    }
  }
}

export function setHittingPointAllowLink(
  board: TacticalBoardState,
  item: BoardProp,
  allow: boolean,
  mapWidthM = 160,
  mapAspect = 1,
): void {
  if (!isChainLinkableProp(item.kind)) return;
  if (!allow) {
    // PIL rule: unchecking allow-link dissolves the entire component cleanly
    const cid = item.chainId;
    item.allowLink = false;
    item.chainId = null;
    item.chainClosed = false;
    if (cid != null) {
      for (const o of board.items as BoardProp[]) {
        if (o.kind === item.kind && o.chainId === cid) {
          o.allowLink = false;
          o.chainId = null;
          o.chainClosed = false;
        }
      }
    }
  } else {
    item.allowLink = true;
    attachHittingPointToChain(board, item, mapWidthM, mapAspect);
  }
}

export function removeHittingPoint(board: TacticalBoardState, item: BoardProp): void {
  const cid = item.chainId;
  const wasClosed = Boolean(item.chainClosed);
  if (wasClosed && cid != null) {
    // PIL rule: deleting a point from a closed hitting-point polygon removes the entire closed shape
    board.items = board.items.filter((o) => !(o.kind === item.kind && (o as BoardProp).chainId === cid));
  } else {
    board.items = board.items.filter((o) => o.iid !== item.iid);
  }
}

// ---------------------------------------------------------------------------
// P2: Shared Role Manage State (Photographer cameras / Professor scales / SmileyFace parts)
// ---------------------------------------------------------------------------
export const SHARED_MANAGE_ROLES: ReadonlySet<string> = new Set([
  'photographer',
  'professor',
  'smileyFace',
]);

export function syncSharedRoleManageState(
  board: TacticalBoardState,
  source: BoardToken,
  patch: Partial<Pick<BoardToken, 'showFixedSpawns' | 'showSpawnDir' | 'showFixedSpawnRange' | 'fixedSpawnDevice'>>,
): void {
  Object.assign(source, patch);
  if (!SHARED_MANAGE_ROLES.has(source.role)) return;
  for (const tk of board.tokens as BoardToken[]) {
    if (tk.role === source.role && tk.tid !== source.tid) {
      Object.assign(tk, patch);
    }
  }
}
