/**
 * Calibrated 2D <-> 3D affine coordinate transforms & Identity V movement speed presets
 * for all 9 canonical PIL tactical maps (+ Red Church Night variant `h55_demo2`).
 *
 * Matrix convention in `board-calibration.json` (`normalizedToWorld: [a, b, c, d, e, f]`):
 *   worldX = a * u + c * v + e
 *   worldZ = b * u + d * v + f
 * Verified to < 1e-13 px round-trip against `worldToPixel` and `.nav.glb` bounds across all 9 maps.
 */
import type { WorldRect } from '@idv/replay-renderer';
import type { PilMapId } from '../types';
import { withBaseUrl } from '@/lib/assetUrl';

/** 45 game world units/s === 3.80 m/s ordinary survivor run speed (11.842105263157896 u/m). */
export const UNITS_PER_METER = 45.0 / 3.8;
export const METERS_PER_UNIT = 3.8 / 45.0;

export type PrimaryScene3DId =
  | 'ordnance_factory1'
  | 'h55_hospital2'
  | 'h55_demo'
  | 'h55_fishingvillage'
  | 'h55_playground'
  | 'ordnance_factory2'
  | 'h55_sleepingtown3'
  | 'h55_chinatown'
  | 'h55_deadforest_sp';

export type Scene3DId = PrimaryScene3DId | 'h55_demo2';

export type Affine2DMatrix = readonly [
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
];

export interface Map3DCalibrationEntry {
  readonly mapId: PilMapId;
  readonly scene: PrimaryScene3DId;
  readonly nightScene?: Scene3DId;
  readonly nameEn: string;
  readonly nameZh: string;
  readonly nightNameZh?: string;
  readonly size: readonly [widthPx: number, heightPx: number];
  readonly normalizedToWorld: Affine2DMatrix;
  readonly worldToPixel: Affine2DMatrix;
  readonly maxHeldoutErrorPixels: number;
}

export const MAP_3D_CALIBRATION: Readonly<Record<PilMapId, Map3DCalibrationEntry>> = Object.freeze({
  0: Object.freeze({
    mapId: 0,
    scene: 'ordnance_factory1',
    nameEn: 'Arms Factory',
    nameZh: '军工厂',
    size: [750, 644] as const,
    normalizedToWorld: [
      -0.14095130677566828,
      -1967.2821629272382,
      1691.8801370984213,
      3.6676132194130604,
      -2398.869334545493,
      2473.957506719018,
    ] as const,
    worldToPixel: [
      0.0008264348338313186,
      0.38064168134748944,
      -0.3812366780020509,
      -2.727211348238128e-5,
      945.1458505596731,
      913.1771268842034,
    ] as const,
    maxHeldoutErrorPixels: 0.544818524859533,
  }),
  1: Object.freeze({
    mapId: 1,
    scene: 'h55_hospital2',
    nameEn: 'Sacred Heart Hospital',
    nameZh: '圣心医院',
    size: [644, 604] as const,
    normalizedToWorld: [
      4.416143362352656,
      -1794.9628953865229,
      1676.997763245942,
      0.9519836039829637,
      -855.2479420935857,
      897.6669461024895,
    ] as const,
    worldToPixel: [
      0.00020366986267494574,
      0.3601669421795496,
      -0.35878128858257574,
      0.0008861179554926486,
      322.240291871556,
      307.2365973102056,
    ] as const,
    maxHeldoutErrorPixels: 1.6159518252307585,
  }),
  2: Object.freeze({
    mapId: 2,
    scene: 'h55_demo',
    nightScene: 'h55_demo2',
    nameEn: 'The Red Church',
    nameZh: '红教堂',
    nightNameZh: '红教堂（夜）',
    size: [596, 599] as const,
    normalizedToWorld: [
      -1814.8867185992876,
      -2.190964266253171,
      -1.0517923731161005,
      -1829.7808085862694,
      904.6864791335174,
      932.1053809738149,
    ] as const,
    worldToPixel: [
      -0.3283953799846867,
      0.00039519717140445765,
      0.0001887678318701594,
      -0.32736184184168604,
      296.9189085702189,
      304.7782047685731,
    ] as const,
    maxHeldoutErrorPixels: 0.5110444222277742,
  }),
  3: Object.freeze({
    mapId: 3,
    scene: 'h55_fishingvillage',
    nameEn: 'Lakeside Village',
    nameZh: '湖景村',
    size: [1280, 1208] as const,
    normalizedToWorld: [
      -2360.982811071354,
      -43.13658827428783,
      -1.3789941254679021,
      -2228.5538705147596,
      1118.3581779472775,
      1141.7264115285063,
    ] as const,
    worldToPixel: [
      -0.5421532360522238,
      0.009903795759722594,
      0.00033547590547889245,
      -0.5420616810116153,
      605.9384835378686,
      607.8101469078962,
    ] as const,
    maxHeldoutErrorPixels: 2.191765146252523,
  }),
  4: Object.freeze({
    mapId: 4,
    scene: 'h55_playground',
    nameEn: 'Moonlit River Park',
    nameZh: '月亮河公园',
    size: [1492, 1028] as const,
    normalizedToWorld: [
      -2179.1764125790287,
      -1.0619453820584124,
      -4.172592496923546,
      -1511.4591813472261,
      1093.0815509798467,
      768.5286091087804,
    ] as const,
    worldToPixel: [
      -0.68466325102402,
      0.0003314416383841389,
      0.0018901077709526403,
      -0.6801383693700502,
      746.940166431964,
      522.3435022733344,
    ] as const,
    maxHeldoutErrorPixels: 0.7558563916614636,
  }),
  5: Object.freeze({
    mapId: 5,
    scene: 'ordnance_factory2',
    nameEn: "Leo's Memory",
    nameZh: '里奥的回忆',
    size: [750, 635] as const,
    normalizedToWorld: [
      2.730825885337628,
      -1992.6263727336334,
      1692.5067989041481,
      -0.10327532173135544,
      -2405.6426228454047,
      2468.9952756522503,
    ] as const,
    worldToPixel: [
      -2.296685668526089e-5,
      0.37518316234404336,
      -0.37638770267282007,
      0.000514175615404696,
      929.2442096634418,
      901.2871095434679,
    ] as const,
    maxHeldoutErrorPixels: 0.6595999863154562,
  }),
  6: Object.freeze({
    mapId: 6,
    scene: 'h55_sleepingtown3',
    nameEn: 'Eversleeping Town',
    nameZh: '永眠镇',
    size: [750, 874] as const,
    normalizedToWorld: [
      -1617.6715170773136,
      4.844967497441832,
      -5.4136328555612385,
      -1892.4848742876775,
      137.03921805256147,
      684.2234650844931,
    ] as const,
    worldToPixel: [
      -0.463625381587779,
      -0.0013831708377718933,
      0.0013262444696581423,
      -0.461822719904102,
      62.62741217553103,
      316.1794903175713,
    ] as const,
    maxHeldoutErrorPixels: 2.312279846299306,
  }),
  7: Object.freeze({
    mapId: 7,
    scene: 'h55_chinatown',
    nameEn: 'China Town',
    nameZh: '唐人街',
    size: [1345, 1152] as const,
    normalizedToWorld: [
      -1698.7212509197038,
      0.33279850404085265,
      2.416768161221838,
      -1465.5421058174047,
      852.7672820310049,
      735.5597277941945,
    ] as const,
    worldToPixel: [
      -0.7917723015476485,
      -0.000153997462409236,
      -0.0013056807318752696,
      -0.7860575056856771,
      676.1579197419458,
      578.3235689101987,
    ] as const,
    maxHeldoutErrorPixels: 0.6406405389700806,
  }),
  8: Object.freeze({
    mapId: 8,
    scene: 'h55_deadforest_sp',
    nameEn: 'Darkwoods',
    nameZh: '不归林',
    size: [1247, 1265] as const,
    normalizedToWorld: [
      -1585.4773610988984,
      -0.7142838800413968,
      -3.7923613175011406,
      -1606.4624994792282,
      802.074603825804,
      814.047878821861,
    ] as const,
    worldToPixel: [
      -0.7865147474320004,
      0.0003547571843274431,
      0.0018567181647702483,
      -0.7874453003275845,
      629.3320469660729,
      640.7336346918397,
    ] as const,
    maxHeldoutErrorPixels: 1.9297722398485704,
  }),
});

export const SCENE_3D_LABELS_ZH: Readonly<Record<Scene3DId, string>> = Object.freeze({
  ordnance_factory1: '军工厂',
  h55_hospital2: '圣心医院',
  h55_demo: '红教堂',
  h55_demo2: '红教堂（夜）',
  h55_fishingvillage: '湖景村',
  h55_playground: '月亮河公园',
  ordnance_factory2: '里奥的回忆',
  h55_sleepingtown3: '永眠镇',
  h55_chinatown: '唐人街',
  h55_deadforest_sp: '不归林',
});

export function hasScene3D(mapId: number): boolean {
  if (!Number.isInteger(mapId) || mapId < 0) return false;
  const entry = (MAP_3D_CALIBRATION as Readonly<Record<number, Map3DCalibrationEntry | undefined>>)[mapId];
  return Boolean(entry?.scene);
}

export function getMap3DCalibration(mapId: PilMapId): Map3DCalibrationEntry {
  return MAP_3D_CALIBRATION[mapId] ?? MAP_3D_CALIBRATION[0];
}

export function hasNightVariant(mapId: PilMapId): boolean {
  return Boolean(getMap3DCalibration(mapId).nightScene);
}

export function resolveScene3DId(mapId: PilMapId, nightVariant = false): Scene3DId {
  const entry = getMap3DCalibration(mapId);
  if (nightVariant && entry.nightScene) return entry.nightScene;
  return entry.scene;
}

export function scene3DAssetUrls(sceneId: Scene3DId): { glbUrl: string; navGlbUrl: string } {
  return {
    glbUrl: withBaseUrl(`/assets/maps-3d/${sceneId}.glb`),
    navGlbUrl: withBaseUrl(`/assets/maps-3d/${sceneId}.nav.glb`),
  };
}

/**
 * Maps normalized 2D PIL board coordinates `(u, v) in [0, 1]` to 3D GLB world `(x, z)`.
 */
export function normalizedToWorld3D(
  mapId: PilMapId,
  u: number,
  v: number,
): { x: number; z: number } {
  const [a, b, c, d, e, f] = getMap3DCalibration(mapId).normalizedToWorld;
  return {
    x: a * u + c * v + e,
    z: b * u + d * v + f,
  };
}

/**
 * Exact analytical inverse of `normalizedToWorld3D`, mapping 3D GLB `(x, z)` back to `(u, v)`.
 */
export function world3DToNormalized(
  mapId: PilMapId,
  x: number,
  z: number,
): { u: number; v: number } {
  const [a, b, c, d, e, f] = getMap3DCalibration(mapId).normalizedToWorld;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) {
    return { u: 0.5, v: 0.5 };
  }
  const dx = x - e;
  const dz = z - f;
  return {
    u: (d * dx - c * dz) / det,
    v: (-b * dx + a * dz) / det,
  };
}

/**
 * Maps a 2D replay world coordinate `(rx, ry, rz)` into 3D GLB coordinates `(x, y, z)`
 * by normalizing `(rx, rz)` via `worldRect` and preserving the vertical `ry` offset.
 */
export function replayWorldTo3D(
  mapId: PilMapId,
  rx: number,
  ry: number,
  rz: number,
  worldRect: WorldRect,
): { x: number; y: number; z: number } {
  const spanX = Math.max(1e-6, worldRect.max_x - worldRect.min_x);
  const spanZ = Math.max(1e-6, worldRect.max_z - worldRect.min_z);
  const u = (rx - worldRect.min_x) / spanX;
  const v = (rz - worldRect.min_z) / spanZ;
  const { x, z } = normalizedToWorld3D(mapId, u, v);
  return { x, y: ry, z };
}

// ---------------------------------------------------------------------------
// Identity V Canonical Movement Speed Presets (PIL Roaming Reference)
// ---------------------------------------------------------------------------

export type RoamSpeedPresetId =
  | 'wildling'
  | 'survivor'
  | 'hunter1'
  | 'hunter2'
  | 'hunter3'
  | 'hullabaloo'
  | 'witch'
  | 'yithian';

export interface RoamSpeedPreset {
  readonly id: RoamSpeedPresetId;
  readonly label: string;
  readonly shortLabel: string;
  readonly speedMps: number;
}

export const ROAM_SPEED_PRESETS: readonly RoamSpeedPreset[] = Object.freeze([
  { id: 'wildling', label: '野人 · 3.65 m/s', shortLabel: '野人', speedMps: 3.65 },
  { id: 'survivor', label: '求生者 · 3.80 m/s', shortLabel: '求生', speedMps: 3.8 },
  { id: 'hunter1', label: '监管Ⅰ · 4.56 m/s (小丑/信徒)', shortLabel: '监Ⅰ', speedMps: 4.56 },
  { id: 'hunter2', label: '监管Ⅱ · 4.64 m/s (红夫人)', shortLabel: '监Ⅱ', speedMps: 4.64 },
  { id: 'hunter3', label: '监管Ⅲ · 4.73 m/s (厂长/杰克)', shortLabel: '监Ⅲ', speedMps: 4.73 },
  { id: 'hullabaloo', label: '喧嚣 · 5.10 m/s', shortLabel: '喧嚣', speedMps: 5.1 },
  { id: 'witch', label: '女巫本体 · 6.08 m/s', shortLabel: '女巫', speedMps: 6.08 },
  { id: 'yithian', label: '伊斯人灵体 · 7.59 m/s', shortLabel: '灵体', speedMps: 7.59 },
]);

export function findRoamSpeedPreset(id: string): RoamSpeedPreset | undefined {
  return ROAM_SPEED_PRESETS.find((p) => p.id === id);
}
