/**
 * Zero-DOM pure TypeScript types for the PIL Tactical Data & Calculation Core.
 */
import type { Replay2DPayload } from '@idv/replay-renderer';

export type PilMapId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface GridPlacement {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  rotationQuadrants: 0 | 1 | 2 | 3;
  aspectRatio: number;
}

export interface CipherPoint {
  id: string;
  name: string;
  location: [number, number];
  feature: string;
  locked?: boolean;
}

export interface RocketChairsData {
  fixed: Array<[number, number] | [number, number, number]>;
  sets: Array<Array<[number, number] | [number, number, number]>>;
}

export interface ChestsData {
  fixed: Array<[number, number] | [number, number, number]>;
}

export interface BasementInfo {
  rocketChairs: Array<[number, number, number]>;
  chest: Array<[number, number, number]>;
}

export interface SpawnGroup {
  survivor: Array<[number, number]>;
  hunter: [number, number];
}

export interface FixedSpawnPoint {
  p: [number, number];
  d?: [number, number];
}

export interface FixedSpawnItem {
  icon: string;
  flag_orientation?: boolean;
  rangeM?: number;
  rangeScreenM?: { pc: [number, number]; ios: [number, number] };
  points: FixedSpawnPoint[] | Array<[number, number]>;
}

export interface FixedSpawnGroup {
  label: string;
  item: FixedSpawnItem | FixedSpawnItem[];
}

export type DeductionRuleKind =
  | 'fixed'
  | 'region'
  | 'exactly'
  | 'same'
  | 'implies'
  | 'atLeast1'
  | 'atMost1'
  | 'chain'
  | 'chainThree'
  | 'allAbsent'
  | 'link';

export interface DeductionScope {
  kind: 'circle' | 'chain' | 'chainThree';
  positions: number[];
  cyclic?: boolean;
}

export interface DeductionRule {
  kind: DeductionRuleKind;
  name: string;
  text: string | null;
  list: string | null;
  positions: number[];
  n: number | null;
  min: number | null;
  max: number | null;
  mode: 'yes' | 'no' | null;
  cyclic: boolean | null;
  pres: number[];
  cons: number[];
  targets: number[];
  region: number[];
  marker: number | null;
  positive: boolean | null;
}

export interface DeductionRuleBookItem {
  title: string;
  text: string | null;
}

export interface DeductionData {
  mapImage: string;
  mapSize: [number, number];
  ciphers: CipherPoint[];
  configs: number[][];
  rules: DeductionRule[];
  hints?: string[];
  ruleBook: DeductionRuleBookItem[];
  emptyHint: string;
}

export interface PilMapData {
  mapId: PilMapId;
  mapName: string;
  mapNameEn: string;
  mapImage: string;
  mapSize: [number, number];
  widthM: number;
  gridPlacement: GridPlacement;
  zonesInfo: [number, number, number, number, number, number];
  zoneNames: string[];
  ciphers: CipherPoint[];
  cipherCombinations: string[][];
  fixedHint: string;
  hints: string[];
  escapeDoors: Array<[number, number]>;
  dungeons: Array<[number, number]>;
  rocketChairs: RocketChairsData;
  lockers: Array<[number, number]>;
  chests: ChestsData;
  phoneBooths?: Array<[number, number]>;
  basements: Record<string, BasementInfo>;
  spawnPoints: SpawnGroup[];
  fixedSpawns: Record<string, FixedSpawnGroup>;
  deduction: DeductionData;
}

export interface StandaloneMapPayloadOptions {
  cipherGroupIndex?: number | 'all';
  chairSetIndex?: number | null;
  basementIndex?: number | 'all' | null;
  dungeonIndex?: number | null;
  escapeDoorLock?: boolean;
  includeCiphers?: boolean;
  includeChairs?: boolean;
  includeBasementChairs?: boolean;
  includeGates?: boolean;
  includeChests?: boolean;
  includeHatch?: boolean;
}

export type StandalonePayload = Replay2DPayload;

export interface ZoneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface RegionCipherRow {
  idx: number;
  id: string;
  name: string;
  feature: string;
  location: [number, number];
  relPos: [number, number];
  pixelDist: number;
  distanceM: number;
  isLocked: boolean;
  isFarthest: boolean;
}

export interface RegionAnalysisResult {
  mapId: PilMapId;
  cipherGroupIndex: number;
  hunterZoneIdx: number;
  hunterZoneName: string | null;
  hunterPixelCoords: [number, number] | null;
  lockIndex: number;
  lockCipherName: string | null;
  lockDistanceM: number | null;
  rows: RegionCipherRow[];
}

// ---------------------------------------------------------------------------
// Roles, Talents, Items, Movement
// ---------------------------------------------------------------------------

export type RoleCamp = 'survivor' | 'hunter' | 'other';

export interface SpeedFormEntry {
  form: number;
  group: 'role' | 'fixed';
  name: string;
  speed: number;
}

export interface RoleSpeedGroup {
  name: string;
  speed: number;
  role: string | null;
  form?: number;
}

export interface BuffSpeedSpec {
  aim: 'survivor' | 'hunter';
  mult?: number;
  levels?: number[];
  duration?: number;
  postMult?: boolean;
  carry?: boolean;
  states?: string[];
  forms?: number[];
  roles?: string[];
  extra?: {
    talent: string;
    level: number;
    mult: number;
  };
}

export interface RoleTraitEntry {
  name: string;
  speedBuff?: BuffSpeedSpec;
  struggleBuff?: { aim: 'survivor' | 'hunter'; levels: number[] };
}

export interface RoleRangeSizeBounds {
  min: number;
  max: number | null;
}

export interface RoleRangeOption {
  size_m: number | number[] | RoleRangeSizeBounds;
  ringInner?: number;
  crossWidth?: number;
  label: string;
}

export interface RoleRangesConfig {
  key: 'showTrait' | 'showItem' | 'show';
  fearMods?: {
    hunter: Array<[string, string, number]>;
    survivor: Array<[string, string, number]>;
  };
  options: RoleRangeOption[];
}

export interface FearRadiusForm {
  key: string;
  name: string;
  mult: number;
}

export interface RoleDefinition {
  key: string;
  name: string;
  camp: RoleCamp;
  glyph: string;
  color: string;
  portraitUrl: string | null;
  speed?: number | Record<string, number>;
  speeds?: SpeedFormEntry[];
  traits?: Record<string, RoleTraitEntry>;
  fearRadius?: {
    mult?: number;
    forms?: FearRadiusForm[];
  };
  ranges?: RoleRangesConfig;
  items: string[];
}

export interface TalentBuffSpec {
  speedBuff?: BuffSpeedSpec;
  struggleBuff?: { aim: 'survivor' | 'hunter'; levels: number[] };
  dropBuff?: { aim: 'survivor' | 'hunter'; levels: number[] };
  pickupBuff?: { aim: 'survivor' | 'hunter'; levels: number[] };
}

export interface TalentDefinition {
  key: string;
  name: string;
  camp: 'survivor' | 'hunter';
  glyph: string;
  buff?: TalentBuffSpec;
  ranges?: RoleRangesConfig;
}

export interface MovementTalentSpeedBuff {
  name: string;
  camp: 'survivor' | 'hunter';
  mult?: number;
  levels?: number[];
  duration?: number;
  postMult?: boolean;
  carry?: boolean;
  states?: string[];
  forms?: number[];
  roles?: string[];
  extra?: {
    name: string;
    mult: number;
    camp: 'survivor' | 'hunter';
  };
}

export interface MovementTraitSpeedBuff {
  key: string;
  role: string;
  name: string;
  mult?: number;
  levels?: number[];
  duration?: number;
  postMult?: boolean;
  states?: string[];
  forms?: number[];
  roles?: string[];
}

export interface MovementOtherSpeedBuff {
  key: string;
  name: string;
  mult?: number;
  levels?: number[];
  duration?: number;
  postMult?: boolean;
  states?: string[];
}

export type ItemRenderKind = 'circle' | 'link' | 'hittingPoint' | 'point';

export interface ItemDefinition {
  key: string;
  name: string;
  glyph: string;
  render?: ItemRenderKind;
  color?: string;
  fill?: string;
  glow?: string;
  linkColor?: string;
  linkWidth?: number;
  linkToRole?: string;
  linkMaxM?: number;
  pushes?: boolean;
  iconSize?: number;
  ranges?: RoleRangesConfig;
  camp?: 'survivor' | 'hunter';
  buff?: TalentBuffSpec;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

export interface MeasureBase {
  from: number;
  to: number;
  speed: number;
  name?: string;
  camp?: 'survivor' | 'hunter' | 'other';
  role?: string | null;
  form?: number;
  stKey?: string;
  fixed?: boolean;
}

export interface MeasureBuff {
  id?: number;
  linkId?: number | null;
  type?: 'trait' | 'talent' | 'other' | 'custom';
  key?: string;
  name?: string;
  from?: number | null;
  to?: number | null;
  mult?: number;
  duration?: number;
  postMult?: boolean;
}

export interface MeasureLineConfig {
  lid?: number;
  bases: MeasureBase[];
  buffs: MeasureBuff[];
}

export interface MeasureSimPart {
  dist: number;
  t: number;
  v: number;
  pct: number;
}

export interface MeasureSimSegment {
  dist: number;
  t: number;
  t0: number;
  parts: MeasureSimPart[];
}

export interface MeasureSimResult {
  total: number;
  t0: number;
  dist: number;
  arrival: number[];
  segs: MeasureSimSegment[];
}

export interface MeasureEntryLike {
  chain?: number | null;
  lc?: MeasureLineConfig | null;
}

export interface MeasureBoardLike {
  measures?: MeasureEntryLike[];
}

// ---------------------------------------------------------------------------
// Carry & Tide Models
// ---------------------------------------------------------------------------

export type CarrySurvivorId = 'ordinary' | 'forward';

export interface CarryTalentDef {
  group: 'survivor' | 'hunterStruggle' | 'hunterSpeed';
  kind: 'struggle' | 'pickup' | 'speed';
  levels: number[];
  dropProgress?: number[];
  duration?: number;
}

export interface CarryBuffSelection {
  key: string;
  level: number;
}

export interface CarrySelectionInput {
  survivorId?: string;
  baseSpeed?: number;
  baseStruggleSeconds?: number;
  initialProgress?: number;
  pickupSeconds?: number;
  buffs?: CarryBuffSelection[];
}

export interface CarrySelection {
  survivorId: CarrySurvivorId;
  baseSpeed: number;
  baseStruggleSeconds: number;
  initialProgress: number;
  pickupSeconds: number;
  buffs: CarryBuffSelection[];
}

export interface CarryProfile {
  version: string;
  selection: CarrySelection;
  struggleRate: number;
  remainingSeconds: number;
  dropProgressPercent: number;
  pickupSeconds: number;
  timedBreakpoints?: number[];
  speedAt(seconds: number): number;
}

export interface CarryDropBudget {
  progressPercent: number;
  drops: number | null;
  canHang: boolean;
  risk: boolean;
}

export interface CarryRangeBand {
  band: number;
  minSeconds: number;
  maxSeconds: number;
  empty: boolean;
}

export interface CarryRadialBandM {
  band: number;
  minSeconds: number;
  maxSeconds: number;
  minRadiusM: number;
  maxRadiusM: number;
  color: string;
  opacity: number;
  labelZh: string;
}

export type RelPointInput =
  | [number, number]
  | { x: number; y: number }
  | { relPos: [number, number]; label?: string; kind?: string; index?: number };

export interface CarryChairEval {
  index: number;
  x: number;
  y: number;
  distanceM: number;
  travelSeconds: number;
  band: number;
  drops: number | null;
  canHang: boolean;
  risk: boolean;
  progressPercent: number;
  label?: string;
  kind?: string;
}

export interface TideBuffInput {
  mult: number;
  postMult?: boolean;
  duration?: number;
}

export interface TideProfile {
  remainingSeconds: number;
  baseSpeed: number;
  timedBreakpoints?: number[];
  speedAt(seconds: number): number;
}

export interface TideRangeBand {
  band: number;
  minSeconds: number;
  maxSeconds: number;
  empty: boolean;
}

export interface TideRadialBandM {
  band: number;
  minSeconds: number;
  maxSeconds: number;
  minRadiusM: number;
  maxRadiusM: number;
  color: string;
  opacity: number;
  labelZh: string;
}

export interface TideChairEval {
  index: number;
  x: number;
  y: number;
  distanceM: number;
  travelSeconds: number;
  band: number;
  reachable20s: boolean;
  inMargin: boolean;
  reachable: boolean;
  label?: string;
  kind?: string;
}

// ---------------------------------------------------------------------------
// Treasure
// ---------------------------------------------------------------------------

export interface TreasureRule {
  rangeM: number;
  ringM: [number, number];
}

export interface TreasureTokenLike {
  x: number;
  y: number;
  showTreasureRange?: boolean;
}

export interface TreasureRing {
  cipherId: string;
  x: number;
  y: number;
  innerRadius: number;
  outerRadius: number;
  excluded: boolean;
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

export type AnimMode = 'time' | 'speed';

export interface AnimSpeedEntry {
  name: string;
  speed: number;
  buffs?: MeasureBuff[];
}

export interface AnimData {
  mode: AnimMode;
  points: Point2D[];
  times?: number[];
  speeds?: AnimSpeedEntry[];
  paths?: Array<Point2D[] | undefined>;
}

export interface AnimGeom {
  dw: number;
  dh: number;
  widthM: number | null | undefined;
}

export interface AnimSegmentInfo {
  t0: number;
  t1: number;
  dur: number;
  lenM: number;
  avgSpeed: number | null;
}

export interface AnimDurationInfo {
  start: number;
  end: number;
  total: number;
}

export interface AnimPositionResult {
  x: number;
  y: number;
  done: boolean;
}

export type AnimSegDurFn = (segIdx: number, lenM: number, baseSpeed: number | undefined) => number;

export interface AnimEntry {
  anim?: AnimData | null;
  segDurFn?: AnimSegDurFn | null;
}

// ---------------------------------------------------------------------------
// Deduction Engine
// ---------------------------------------------------------------------------

export type DeduceMarkValue = 'yes' | 'no';
export type DeduceStateValue = DeduceMarkValue | null;
export type DeduceMarksState = Record<number, DeduceMarkValue>;

export interface DeductionConclusion {
  id: number;
  value: DeduceMarkValue;
  inferred: boolean;
}

export interface DeductionStep {
  rule: string;
  detail: string | null;
  conclusions: DeductionConclusion[];
  scope: DeductionScope;
}

export interface DeductionResult {
  state: DeduceStateValue[];
  marks: DeduceMarksState;
  steps: DeductionStep[];
  contradiction: string | null;
  candidates: number[];
  sources: Array<number | null>;
}

export type MarkKindTuple = [
  kind: 'locked' | 'inf-yes' | 'user-yes' | 'inf-no' | 'user-no' | 'unknown',
  icon: 'lock' | 'bolt' | 'cross' | '',
  stateText: string,
];

// ---------------------------------------------------------------------------
// Persistence & Board State
// ---------------------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface TacticalToken {
  tid: number;
  role: string;
  x: number;
  y: number;
  label?: string;
  camp?: 'survivor' | 'hunter';
  color?: string;
  showRange?: boolean;
  rangeMode?: string;
  rangeSubIndex?: number;
  showFearRadius?: boolean;
  fearFormKey?: string;
  showTreasureRange?: boolean;
  showFixedSpawnRange?: boolean;
  fixedSpawnRole?: string;
  glow?: boolean;
  spawnPreview?: boolean;
  anim?: AnimData;
  rangeBox?: {
    tab?: string;
    subs?: number[];
    talents?: Record<string, boolean | number>;
    fill?: boolean;
  };
}

export interface TacticalPropItem {
  iid: number;
  kind: string;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  role?: string;
  linkTid?: number | null;
  linkShow?: boolean;
  allowLink?: boolean;
  chainId?: number | null;
  chainOrder?: number;
  chainClosed?: boolean;
  showRange?: boolean;
  rangeSubIndex?: number;
  showMirror?: boolean;
  fixedMirror?: boolean;
  mirrorAxis?: { x1: number; y1: number; x2: number; y2: number } | null;
  label?: string;
  color?: string;
  anim?: AnimData;
}

export type TacticalShapeKind = 'arrow' | 'line' | 'circle' | 'rect' | 'freehand';

export interface TacticalShape {
  id: number;
  kind: TacticalShapeKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  points?: Point2D[];
  color: string;
  width: number;
  dashed?: boolean;
}

export interface TacticalTextNote {
  id: number;
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
}

export interface TacticalMeasureLine {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  path?: Point2D[];
  chain: number | null;
  lc: MeasureLineConfig | null;
  color?: string;
  width?: number;
}

export interface TacticalBoardState {
  tokens: TacticalToken[];
  items: TacticalPropItem[];
  shapes: TacticalShape[];
  texts: TacticalTextNote[];
  measures: TacticalMeasureLine[];
  tokenSeq: number;
  itemSeq: number;
  shapeSeq: number;
  textSeq: number;
  measureSeq: number;
  lcSeq: number;
  buffSeq: number;
  dungeonIndex: number;
  spawnIndex: number;
  chairIndex: number;
  chairBasementIndex: number;
  boxBasementIndex: number;
  /** Optional per-cipher progress map (0–100) for P0 endgame deduction. */
  cipherProgressEnabled?: boolean;
  cipherProgress?: Record<string, number>;
}

export interface RegionSelectionState {
  side: 1 | -1;
  cipherGroupIndex: number;
  survivorZones: number[];
  hunterZones: number[];
  selectedCipherIndex: number;
  showDoors: boolean;
  roleSize: number;
  cipherSize: number;
  doorSize: number;
}

export type ImportBoardResult =
  | { ok: true; mapId: PilMapId; state: TacticalBoardState }
  | { ok: false; error: string };

export interface SandboxBoardHandoff {
  mapId: PilMapId;
  source: 'spawn-predict' | 'region-lock' | 'manual';
  whiteboard?: boolean;
  enableZones?: boolean;
  highlightTid?: number | null;
  hunterRole?: string | null;
  survivorZones?: number[];
  hunterZone?: number | null;
  timestamp: number;
}
