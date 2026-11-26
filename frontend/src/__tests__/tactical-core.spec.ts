import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CARRY_BAND_COLORS,
  CARRY_BAND_LABELS_ZH,
  CARRY_BAND_OPACITY,
  CARRY_DEFAULTS,
  CARRY_DROP_PROGRESS_DEFAULT,
  CARRY_RULES_VERSION,
  CARRY_SURVIVORS,
  CARRY_TALENTS,
  MAPS_DATA,
  METERS_PER_WORLD_UNIT,
  PIL_MAP_COUNT,
  PIL_STORAGE_KEY,
  STEP_NUMS,
  TAC_COMMON_ITEM_TYPES,
  TAC_HUNTER_ROLES,
  TAC_ITEM_TYPES,
  TAC_MOVEMENT_BUFFS,
  TAC_MOVEMENT_SURVIVOR,
  TAC_ROLES,
  TAC_SURVIVOR_ROLES,
  TAC_TALENT_KEYS,
  TAC_TALENT_TYPES,
  TAC_TREASURE_RULE,
  TIDE_BAND_COLORS,
  TIDE_BAND_LABELS_ZH,
  TIDE_BAND_OPACITY,
  TIDE_MAX_SECONDS,
  TIDE_SECONDS,
  WORLD_UNITS_PER_METER,
  analyzeRegionCiphers,
  animAllPositions,
  animAvgSpeed,
  animDuration,
  animPathLenM,
  animPointAlongPath,
  animPositionAt,
  animSegPath,
  animSegmentLenM,
  animSegments,
  buffAppliesToBase,
  buildStandaloneMapPayload,
  calculateLockCipher,
  calculateZoneCenters,
  carryBandAt,
  carryDropBudget,
  carryRangeBands,
  cipherOf,
  ciphersCoordsRelative,
  computeCarryRadialBandsM,
  computeTideRadialBandsM,
  convertAnimMode,
  createCarryProfile,
  createEmptyBoardState,
  createTideProfile,
  dedHelpers,
  dedRuleBook,
  deduce,
  evaluateChairsForCarry,
  evaluateChairsForTide,
  exportBoardJson,
  findPilMapByName,
  getActiveMapId,
  getTreasureRings,
  importBoardJson,
  loadBoardState,
  loadDeduceMarks,
  loadRegionState,
  makeDeduction,
  mapsZonesRelative,
  markKind,
  measureBaseAt,
  measureIdCounters,
  measureSegmentDistanceM,
  normalizeCarryBuffs,
  normalizeCarrySelection,
  onActiveMapChange,
  resolvePilMapId,
  restoreMeasureReferences,
  saveBoardState,
  saveDeduceMarks,
  saveRegionState,
  setActiveMapId,
  simulateMovement,
  stepNum,
  syncActiveMapByName,
  tideBandAt,
  tideRangeBands,
  type AnimGeom,
  type MeasureLineConfig,
  type StorageLike,
} from '@/tactical';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TACTICAL_DIR = path.resolve(__dirname, '../tactical');
const PUBLIC_ASSETS_DIR = path.resolve(__dirname, '../../public/assets');

function makeMemoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  };
}

describe('Static Purity & Asset Integrity (frontend/src/tactical/)', () => {
  it('contains zero DOM globals, Vue imports, or external http(s) URLs', () => {
    const files = fs.readdirSync(TACTICAL_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(16);

    const forbidden = [
      /\bwindow\b/,
      /\bdocument\b/,
      /\bHTMLElement\b/,
      /\bHTMLCanvasElement\b/,
      /\bnew\s+Image\b/,
      /from\s+['"]vue['"]/,
      /https?:\/\//i,
    ];

    for (const file of files) {
      const content = fs.readFileSync(path.join(TACTICAL_DIR, file), 'utf8');
      for (const pat of forbidden) {
        expect(content, `Forbidden pattern ${pat} found in ${file}`).not.toMatch(pat);
      }
    }
  });

  it('maps all 9 maps and 36 hunter portraits strictly to shipped local /assets/ files', () => {
    expect(MAPS_DATA).toHaveLength(PIL_MAP_COUNT);
    for (const map of MAPS_DATA) {
      expect(map.mapImage.startsWith('/assets/maps/')).toBe(true);
      const relPath = decodeURI(map.mapImage).replace(/^\/assets\//, '');
      expect(fs.existsSync(path.join(PUBLIC_ASSETS_DIR, relPath)), `Missing map asset ${relPath}`).toBe(true);
    }

    const hunterWithPortraits = Object.values(TAC_HUNTER_ROLES).filter((r) => r.portraitUrl !== null);
    expect(hunterWithPortraits).toHaveLength(36);
    for (const hunter of hunterWithPortraits) {
      expect(hunter.portraitUrl!.startsWith('/assets/hunters/')).toBe(true);
      const relPath = decodeURI(hunter.portraitUrl!).replace(/^\/assets\//, '');
      expect(fs.existsSync(path.join(PUBLIC_ASSETS_DIR, relPath)), `Missing hunter portrait ${relPath}`).toBe(true);
    }
  });
});

describe('9-Map PIL Dataset, Calibration & Standalone Payload', () => {
  it('provides verified gridPlacement (Eversleeping rotationQuadrants = 1) and scale constants', () => {
    expect(WORLD_UNITS_PER_METER).toBeCloseTo(45 / 3.8, 10);
    expect(METERS_PER_WORLD_UNIT).toBeCloseTo(3.8 / 45, 10);
    expect(WORLD_UNITS_PER_METER * METERS_PER_WORLD_UNIT).toBeCloseTo(1, 12);

    expect(MAPS_DATA[0]!.mapName).toBe('军工厂');
    expect(MAPS_DATA[6]!.mapName).toBe('永眠镇');
    expect(MAPS_DATA[6]!.gridPlacement).toEqual({
      minX: 88.9,
      maxX: 708.4,
      minY: 29.1,
      maxY: 847.2,
      rotationQuadrants: 1,
      aspectRatio: 1.3076,
    });
    for (let id = 0; id < 9; id++) {
      if (id !== 6) expect(MAPS_DATA[id]!.gridPlacement.rotationQuadrants).toBe(0);
    }
  });

  it('resolves maps by ID, Chinese name, English name, and replay mode suffixes', () => {
    expect(findPilMapByName('军工厂')?.mapId).toBe(0);
    expect(findPilMapByName('唐人街排位')?.mapId).toBe(7);
    expect(findPilMapByName('Sacred Heart Hospital')?.mapId).toBe(1);
    expect(findPilMapByName('unknown-map')).toBeNull();

    expect(resolvePilMapId(6)).toBe(6);
    expect(resolvePilMapId('4')).toBe(4);
    expect(resolvePilMapId('不归林')).toBe(8);
    expect(resolvePilMapId('invalid')).toBe(0);
  });

  it('builds valid Replay2DPayload v1.0 for all 9 maps with B1/1F/2F elevation parity', () => {
    for (let id = 0; id < 9; id++) {
      const map = MAPS_DATA[id]!;
      const payload = buildStandaloneMapPayload(id);
      const uPerPx = (map.widthM / map.mapSize[0]) * WORLD_UNITS_PER_METER;

      expect(payload.schema_version).toBe('1.0');
      expect(payload.match.match_id).toBe(`pil-map-${id}`);
      expect(payload.match.map_name).toBe(map.mapName);
      expect(payload.match.source).toBe('preloaded');
      expect(payload.world.map_underlay.asset_url).toBe(map.mapImage);
      expect(payload.world.map_underlay.aspect_ratio).toBe(map.gridPlacement.aspectRatio);
      expect(payload.world.map_underlay.world_rect.min_x).toBeCloseTo(map.gridPlacement.minX * uPerPx, 6);
      expect(payload.world.map_underlay.world_rect.max_z).toBeCloseTo(map.gridPlacement.maxY * uPerPx, 6);

      expect(payload.entities.ciphers).toHaveLength(7);
      expect(payload.entities.exit_gates).toHaveLength(2);
      expect(payload.entities.hatch).not.toBeNull();

      const b1Chairs = payload.entities.chairs.filter((c) => c.floor === 'B1');
      expect(b1Chairs.length).toBeGreaterThanOrEqual(4);
      for (const ch of b1Chairs) {
        expect(ch.pos[1]).toBe(-85);
        expect(ch.is_basement).toBe(true);
      }
    }

    // Verify 3-element coordinates use pt[2] for Z and detect 2F entities (Lakeside Big Ship & Darkwoods 2F chest)
    const lakeside = buildStandaloneMapPayload(3);
    expect(lakeside.entities.chairs.some((c) => c.floor === '2F' && c.pos[1] === 60)).toBe(true);
    const darkwoods = buildStandaloneMapPayload(8);
    expect(darkwoods.entities.chests.some((c) => c.floor === '2F' && c.pos[1] === 60)).toBe(true);
    // China Town 3-element chests [959, 1, 324] should map Z from 324, not 1
    const chinaTown = buildStandaloneMapPayload(7, { includeBasementChairs: false });
    const uPerPx7 = (MAPS_DATA[7]!.widthM / MAPS_DATA[7]!.mapSize[0]) * WORLD_UNITS_PER_METER;
    expect(chinaTown.entities.chests[0]!.pos[2]).toBeCloseTo(324 * uPerPx7, 6);
  });

  it('has zero -1 cipher indices in deduction.configs and valid rule positions across all 9 maps', () => {
    for (const map of MAPS_DATA) {
      const d = map.deduction;
      const n = d.ciphers.length;
      expect(d.rules.length).toBeGreaterThan(0);
      expect(d.ruleBook).toHaveLength(d.rules.length);
      expect(d.emptyHint).toBeTruthy();

      for (const cfg of d.configs) {
        for (const ci of cfg) {
          expect(ci).toBeGreaterThanOrEqual(0);
          expect(ci).toBeLessThan(n);
        }
      }
      for (const r of d.rules) {
        for (const p of [...r.positions, ...r.pres, ...r.cons, ...r.targets, ...r.region]) {
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThan(n);
        }
        if (r.marker !== null) {
          expect(r.marker).toBeGreaterThanOrEqual(0);
          expect(r.marker).toBeLessThan(n);
        }
      }
    }
  });
});

describe('Geo, Zone Grids & Region Cipher Analysis', () => {
  it('generates 9, 10 (Eversleeping), and 12 (Lakeside/Moonlit) zones and Red Church stagger', () => {
    expect(mapsZonesRelative[0]).toHaveLength(9);
    expect(mapsZonesRelative[3]).toHaveLength(12);
    expect(mapsZonesRelative[4]).toHaveLength(12);
    expect(mapsZonesRelative[6]).toHaveLength(10);

    // Red Church (mapId 2) column stagger: col 1 row 0 y should be shifted up by 0.125 * h
    const rcZones = mapsZonesRelative[2]!;
    expect(rcZones[3]!.y).toBeLessThan(rcZones[0]!.y);
    expect(rcZones[0]!.y - rcZones[3]!.y).toBeCloseTo(0.125 * rcZones[0]!.height, 8);

    // Eversleeping 10th zone (cemetery) lies to the right/lower portion
    expect(MAPS_DATA[6]!.zoneNames[9]).toContain('墓园');
    expect(rcZones.length).toBe(9);
  });

  it('resolves CIPHER_EXTRA and computes calculateLockCipher + analyzeRegionCiphers accurately', () => {
    expect(cipherOf(4, 'E_0')?.name).toBe('二站');
    expect(ciphersCoordsRelative[0]![0]).toHaveLength(7);

    const centers = calculateZoneCenters(mapsZonesRelative[0]!);
    expect(centers).toHaveLength(9);

    const noHunter = analyzeRegionCiphers(0, 0, null);
    expect(noHunter.lockIndex).toBe(-1);
    expect(noHunter.lockCipherName).toBeNull();
    expect(noHunter.rows).toHaveLength(7);

    const withHunter = analyzeRegionCiphers(0, 0, 0); // 左上 侧门废墟
    const directLock = calculateLockCipher(
      centers[0]!,
      ciphersCoordsRelative[0]![0]!,
      MAPS_DATA[0]!.mapSize,
    );
    expect(withHunter.lockIndex).toBe(directLock);
    expect(withHunter.hunterZoneName).toBe(MAPS_DATA[0]!.zoneNames[0]);
    expect(withHunter.hunterPixelCoords).toHaveLength(2);
    expect(withHunter.lockCipherName).toBe(withHunter.rows[directLock]!.name);
    expect(withHunter.lockDistanceM).toBeGreaterThan(50);
    expect(withHunter.rows.filter((r) => r.isLocked)).toHaveLength(1);
  });
});

describe('Roles, Talents, Items & Multi-Segment Movement Calculator', () => {
  it('exposes complete roles, talents, items, and movement speeds without external URLs', () => {
    expect(Object.keys(TAC_SURVIVOR_ROLES).length).toBeGreaterThanOrEqual(50);
    expect(Object.keys(TAC_HUNTER_ROLES).length).toBeGreaterThanOrEqual(36);
    expect(TAC_ROLES.custom?.items).toEqual(expect.arrayContaining(Object.keys(TAC_COMMON_ITEM_TYPES)));
    expect(TAC_TALENT_KEYS.survivor).toHaveLength(41);
    expect(TAC_TALENT_KEYS.hunter).toHaveLength(41);
    expect(TAC_TALENT_TYPES.borrowedTime?.buff?.speedBuff?.extra?.talent).toBe('escape');

    expect(TAC_ITEM_TYPES.straightPassage?.render).toBe('link');
    expect(TAC_ITEM_TYPES.lasso?.linkToRole).toBe('cowboy');
    expect(TAC_ITEM_TYPES.umbrella?.linkMaxM).toBe(84.4);
    expect(TAC_ITEM_TYPES.fastMusicbox?.render).toBe('circle');
    expect(TAC_TREASURE_RULE).toEqual({ rangeM: 70, ringM: [5.5, 7.3] });

    expect(TAC_MOVEMENT_SURVIVOR.states.run.speed).toBe(3.8);
    expect(TAC_MOVEMENT_SURVIVOR.states.walk.speed).toBe(2.11);
    expect(TAC_MOVEMENT_SURVIVOR.states.crouch.speed).toBe(1.14);
    expect(TAC_MOVEMENT_SURVIVOR.states.crawl.speed).toBe(0.44);
    expect(TAC_MOVEMENT_BUFFS.talent.escape?.levels).toEqual([1.03, 1.04, 1.05]);
  });

  it('enforces buffAppliesToBase for postures, fixed speeds, and dual-form hunters', () => {
    const crawlBase = { from: 0, to: 1, speed: 0.44, camp: 'survivor' as const, stKey: 'crawl' };
    const runBase = { from: 0, to: 1, speed: 3.8, camp: 'survivor' as const, stKey: 'run' };
    const fixedBase = { from: 0, to: 1, speed: 5.74, camp: 'survivor' as const, stKey: 'fixed', fixed: true };
    const stickerBuff = { type: 'talent' as const, key: 'sticker', mult: 1.9 };
    const escapeBuff = { type: 'talent' as const, key: 'escape', mult: 1.05 };

    expect(buffAppliesToBase(stickerBuff, crawlBase)).toBe(true);
    expect(buffAppliesToBase(stickerBuff, runBase)).toBe(false);
    expect(buffAppliesToBase(escapeBuff, fixedBase)).toBe(false);

    const wuchangWhite = { from: 0, to: 1, speed: 4.73, camp: 'hunter' as const, role: 'wuchang', form: 0 };
    const wuchangBlack = { from: 0, to: 1, speed: 4.56, camp: 'hunter' as const, role: 'wuchang', form: 1 };
    const hellEmber = { from: 0, to: 1, speed: 4.73, camp: 'hunter' as const, role: 'hellEmber', form: 0 };
    const siphonBuff = { type: 'trait' as const, key: 'siphonSoul', mult: 1.65 };

    expect(buffAppliesToBase(siphonBuff, wuchangWhite)).toBe(true);
    expect(buffAppliesToBase(siphonBuff, wuchangBlack)).toBe(false);
    expect(buffAppliesToBase(siphonBuff, hellEmber)).toBe(false);
  });

  it('simulates additive + postMult + expiring timed buffs and elapses clocks during fixed segments', () => {
    const cfg: MeasureLineConfig = {
      lid: 1,
      bases: [
        { from: 0, to: 1, speed: 5, camp: 'hunter', role: 'smileyFace', form: 0 },
        { from: 1, to: 2, speed: 5, fixed: true },
        { from: 2, to: 3, speed: 5, camp: 'hunter', role: 'smileyFace', form: 0 },
      ],
      buffs: [
        { from: 0, to: 3, mult: 1.5 },
        { from: 0, to: 3, mult: 2.0, postMult: true },
        { from: 0, to: 3, mult: 1.5, duration: 2 },
      ],
    };
    expect(measureBaseAt(cfg, 1).fixed).toBe(true);

    // Seg 0: add = 1 + 0.5 + 0.5 = 2.0; post = 2.0 * 2.0 = 4.0 -> v = 20 m/s for 20m -> 1s (t=1)
    // Seg 1 (fixed): v = 5 m/s for 10m -> 2s (t=3, timed buff expires at t=2!)
    // Seg 2: timed buff expired; add = 1.5; post = 1.5 * 2.0 = 3.0 -> v = 15 m/s for 15m -> 1s (t=4)
    const sim = simulateMovement([20, 10, 15], cfg);
    expect(sim.arrival).toEqual([0, 1, 3, 4]);
    expect(sim.total).toBeCloseTo(4, 9);
    expect(sim.segs[0]!.parts[0]!.v).toBeCloseTo(20, 9);
    expect(sim.segs[1]!.parts[0]!.v).toBeCloseTo(5, 9);
    expect(sim.segs[2]!.parts[0]!.v).toBeCloseTo(15, 9);
  });

  it('restores shared route config references and computes ID counters', () => {
    const lc: MeasureLineConfig = { lid: 5, bases: [{ from: 0, to: 2, speed: 4 }], buffs: [{ id: 9, linkId: 12 }] };
    const clone = JSON.parse(JSON.stringify(lc)) as MeasureLineConfig;
    const boards = {
      0: { measures: [{ chain: 1, lc }, { chain: 1, lc: clone }, { chain: 2, lc: JSON.parse(JSON.stringify(lc)) }] },
    };
    restoreMeasureReferences(boards);
    expect(boards[0].measures[0]!.lc).toBe(boards[0].measures[1]!.lc);
    expect(boards[0].measures[0]!.lc).not.toBe(boards[0].measures[2]!.lc);
    expect(measureIdCounters(boards)).toEqual({ route: 2, config: 5, buff: 12 });
  });
});

describe('Carry & Tide Reachability Models', () => {
  it('computes carry bands, drop budgets, timed breakpoints, radial distances & chair evaluations', () => {
    expect(CARRY_RULES_VERSION).toBe('balloon-planning-2026-11-17-ui-v4');
    expect(CARRY_DROP_PROGRESS_DEFAULT).toBe(25);
    expect(CARRY_SURVIVORS.forward.struggleBonus).toBeCloseTo(0.1, 9);
    expect(CARRY_BAND_COLORS).toHaveLength(5);
    expect(CARRY_BAND_OPACITY).toHaveLength(5);
    expect(CARRY_BAND_LABELS_ZH).toHaveLength(5);
    expect(CARRY_DEFAULTS.baseSpeed).toBe(4.64);

    const normalized = normalizeCarrySelection({
      survivorId: 'invalid',
      baseSpeed: -10,
      initialProgress: 120,
      buffs: [{ key: 'giantClaw', level: 99 }, { key: 'unknown', level: 1 }],
    });
    expect(normalized.survivorId).toBe('ordinary');
    expect(normalized.baseSpeed).toBe(0.1);
    expect(normalized.initialProgress).toBe(100);
    expect(normalized.buffs).toEqual([{ key: 'giantClaw', level: 3 }]);
    expect(normalizeCarryBuffs('bad')).toEqual([]);

    // Forward (+10%) + Will to Survive 3 (+20%) - Giant Claw 3 (-15%) => 1.15x struggle rate, 6% drop penalty
    const complexProfile = createCarryProfile({
      survivorId: 'forward',
      buffs: [
        { key: 'willToSurvive', level: 3 },
        { key: 'giantClaw', level: 3 },
        { key: 'mischievous', level: 1 },
        { key: 'hospitable', level: 3 }, // +8%
        { key: 'controlFreak', level: 1 }, // +10% for 3s
      ],
    });
    expect(complexProfile.struggleRate).toBeCloseTo(1.15, 9);
    expect(complexProfile.dropProgressPercent).toBe(6);
    expect(complexProfile.pickupSeconds).toBeCloseTo(2 / 1.2, 9);
    expect(complexProfile.speedAt(1)).toBeCloseTo(4.64 * 1.18, 9);
    expect(complexProfile.speedAt(4)).toBeCloseTo(4.64 * 1.08, 9);

    const baseline = createCarryProfile();
    const bands = carryRangeBands(baseline);
    expect(bands.map((b) => b.maxSeconds)).toEqual([4, 8, 12, 14.4, 16]);
    expect(carryBandAt(bands, 3.9)).toBe(0);
    expect(carryBandAt(bands, 15)).toBe(4);
    expect(carryBandAt(bands, 16)).toBe(-1);
    expect(carryDropBudget(baseline, 0)).toEqual({ progressPercent: 0, drops: 3, canHang: true, risk: false });
    expect(carryDropBudget(baseline, 14.5).risk).toBe(true);
    expect(carryDropBudget(baseline, 16).canHang).toBe(false);

    // Exact piecewise integration with 3s timed buff (controlFreak)
    const controlProfile = createCarryProfile({ buffs: [{ key: 'controlFreak', level: 1 }] });
    const radial = computeCarryRadialBandsM(controlProfile);
    expect(radial).toHaveLength(5);
    // Band 0 [0, 4]: 3s at 4.64*1.1 + 1s at 4.64 = 19.952m
    expect(radial[0]!.maxRadiusM).toBeCloseTo(3 * 4.64 * 1.1 + 1 * 4.64, 6);
    expect(radial[1]!.minRadiusM).toBeCloseTo(radial[0]!.maxRadiusM, 6);

    // Evaluate chairs on a synthetic 1000x1000 / 100m map
    const chairEvals = evaluateChairsForCarry(
      controlProfile,
      [0, 0],
      [
        [0.4, 0], // 40m
        [0.19952, 0], // 19.952m => exactly 4.0s
        [0.9, 0], // 90m => unreachable
      ],
      [1000, 1000],
      100,
    );
    expect(chairEvals[0]!.distanceM).toBeCloseTo(19.952, 4);
    expect(chairEvals[0]!.travelSeconds).toBeCloseTo(4.0, 5);
    expect(chairEvals[0]!.canHang).toBe(true);
    expect(chairEvals[2]!.canHang).toBe(false);
    expect(chairEvals[2]!.band).toBe(-1);
  });

  it('computes Tide Turner 20s + 21s margin bands, timed speed buffs, and chair reachability', () => {
    expect(TIDE_SECONDS).toBe(20);
    expect(TIDE_MAX_SECONDS).toBe(21);
    expect(TIDE_BAND_COLORS).toHaveLength(5);
    expect(TIDE_BAND_OPACITY).toHaveLength(5);
    expect(TIDE_BAND_LABELS_ZH[4]).toContain('余量');

    const bands = tideRangeBands();
    expect(tideBandAt(bands, 4)).toBe(0);
    expect(tideBandAt(bands, 19.9)).toBe(3);
    expect(tideBandAt(bands, 20.5)).toBe(4);
    expect(tideBandAt(bands, 21)).toBe(-1);

    const profile = createTideProfile({
      baseSpeed: 3.8,
      buffs: [
        { mult: 1.5, duration: 5 }, // Borrowed Time 5s (+50%)
        { mult: 1.05 }, // Escape (+5%)
      ],
    });
    expect(profile.speedAt(2)).toBeCloseTo(3.8 * 1.55, 9);
    expect(profile.speedAt(6)).toBeCloseTo(3.8 * 1.05, 9);

    const radial = computeTideRadialBandsM(profile);
    expect(radial).toHaveLength(5);
    expect(radial[0]!.maxRadiusM).toBeCloseTo(5 * 3.8 * 1.55, 6);
    expect(radial[4]!.maxRadiusM).toBeCloseTo(5 * 3.8 * 1.55 + 16 * 3.8 * 1.05, 6);

    const evals = evaluateChairsForTide(
      profile,
      [0, 0],
      [
        [0.2, 0], // 20m -> < 5s
        [0.9, 0], // 90m -> 20..21s margin
        [0.99, 0], // 99m -> unreachable
      ],
      [1000, 1000],
      100,
    );
    expect(evals[0]!.reachable20s).toBe(true);
    expect(evals[0]!.inMargin).toBe(false);
    expect(evals[1]!.reachable20s).toBe(false);
    expect(evals[1]!.inMargin).toBe(true);
    expect(evals[1]!.reachable).toBe(true);
    expect(evals[2]!.reachable).toBe(false);
  });
});

describe('Treasure Rings & Waypoint Animation', () => {
  it('enforces 70m range filter and <= 8.0m nearest-cipher exclusion in getTreasureRings', () => {
    const map = {
      mapSize: [1000, 500] as [number, number],
      widthM: 100,
      ciphers: [
        { id: 'A', name: 'A', feature: '', location: [100, 200] as [number, number] },
        { id: 'B', name: 'B', feature: '', location: [900, 400] as [number, number] },
        { id: 'C', name: 'C', feature: '', location: [700, 100] as [number, number] },
        { id: 'EDGE', name: 'E', feature: '', location: [800, 200] as [number, number] },
      ],
      cipherCombinations: [['A', 'B', 'C', 'EDGE']],
    };
    const rings = getTreasureRings(map, { x: 0.1, y: 0.4, showTreasureRange: true }, 0);
    expect(rings.map((r) => r.cipherId)).toEqual(['A', 'C', 'EDGE']);
    expect(rings[0]).toEqual({
      cipherId: 'A',
      x: 0.1,
      y: 0.4,
      innerRadius: 0.055,
      outerRadius: 0.073,
      excluded: true,
    });
    expect(rings[1]!.excluded).toBe(false);
    // 8.1m away => NOT excluded
    const far = getTreasureRings(map, { x: 0.019, y: 0.4, showTreasureRange: true }, 0);
    expect(far[0]!.excluded).toBe(false);
    // Disabled token => empty
    expect(getTreasureRings(map, { x: 0.1, y: 0.4, showTreasureRange: false }, 0)).toEqual([]);
  });

  it('computes arc-length positions, teleports, global batch sampling & time<->speed conversion', () => {
    const geom: AnimGeom = { dw: 1000, dh: 1000, widthM: 100 };
    expect(animSegmentLenM({ x: 0, y: 0 }, { x: 0.3, y: 0.4 }, geom)).toBeCloseTo(50, 9);

    const animTime = {
      mode: 'time' as const,
      points: [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.2, y: 0 }],
      times: [0, 5, 5], // 2nd segment is zero-duration teleport
      paths: [[{ x: 0, y: 0 }, { x: 0.05, y: 0.05 }, { x: 0.1, y: 0 }], undefined],
    };
    expect(animSegPath(animTime, 0)).toHaveLength(3);
    expect(animPathLenM(animSegPath(animTime, 0), geom)).toBeCloseTo(10 * Math.SQRT2, 6);
    expect(animPointAlongPath([{ x: 0, y: 0 }, { x: 0.1, y: 0 }], 0.5, geom)).toEqual({ x: 0.05, y: 0 });
    expect(animAvgSpeed(animTime, geom, 1)).toBeNull();
    expect(animDuration(animTime, geom)).toEqual({ start: 0, end: 5, total: 5 });
    expect(animPositionAt(animTime, geom, 2.5)?.x).toBeCloseTo(0.05, 6);
    expect(animPositionAt(animTime, geom, 5)?.done).toBe(true);

    // Straight segments for exact time <-> speed round-trip
    const straightTime = {
      mode: 'time' as const,
      points: [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.1, y: 0.2 }],
      times: [0, 2, 12],
    };
    const asSpeed = convertAnimMode(straightTime, 'speed', geom, 3.8);
    expect(asSpeed.mode).toBe('speed');
    expect(asSpeed.speeds![0]!.speed).toBeCloseTo(5, 9);
    expect(asSpeed.speeds![1]!.speed).toBeCloseTo(2, 9);
    const backToTime = convertAnimMode(asSpeed, 'time', geom, 3.8);
    expect(backToTime.mode).toBe('time');
    expect(backToTime.times).toEqual([0, 2, 12]);
    expect(animSegments(backToTime, geom)).toHaveLength(2);

    const batch = animAllPositions([{ anim: straightTime }, { anim: asSpeed }, null], geom, 1);
    expect(batch[0]?.x).toBeCloseTo(0.05, 9);
    expect(batch[1]?.x).toBeCloseTo(0.05, 9);
    expect(batch[2]).toBeNull();
  });
});

describe('Cipher Deduction Solver (deduction.ts & deduce.ts)', () => {
  it('resolves fixed ciphers from empty marks across all maps', () => {
    for (const map of MAPS_DATA) {
      const res = deduce(map.deduction, {});
      expect(res.contradiction).toBeNull();
      for (const r of map.deduction.rules.filter((x) => x.kind === 'fixed')) {
        for (const p of r.positions) {
          expect(res.state[p]).toBe('yes');
        }
      }
    }
  });

  it('uniquely locks Arms Factory layout, propagates China Town chainThree/allAbsent & Leo link', () => {
    // Arms Factory (0): mark 人皇机 (M_2, idx 2) yes & 废料区 (W_4, idx 11) no => locks layout #4 (index 3)
    const arms = MAPS_DATA[0]!;
    const idx0 = (id: string) => arms.ciphers.findIndex((c) => c.id === id);
    const res0 = deduce(arms.deduction, { [idx0('M_2')]: 'yes', [idx0('W_4')]: 'no' });
    expect(res0.contradiction).toBeNull();
    expect(res0.candidates).toEqual([3]);
    expect(res0.state[idx0('E_3')]).toBe('yes');

    // China Town (7): chainThree closure (狮子楼 + 杂货店 => 红伞巷 no & 剧院 no)
    const ct = MAPS_DATA[7]!;
    const idx7 = (id: string) => ct.ciphers.findIndex((c) => c.id === id);
    const res7 = deduce(ct.deduction, { [idx7('W_3')]: 'yes', [idx7('W_4')]: 'yes' });
    expect(res7.state[idx7('M_4')]).toBe('no');
    expect(res7.state[idx7('M_2')]).toBe('no');

    // China Town allAbsent: 花店 (M_1) = no, 剧院 (M_2) = no => 肉铺 (E_1), 醉芳庭 (E_3), 酒楼 (M_5) all yes
    const res7b = deduce(ct.deduction, { [idx7('M_1')]: 'no', [idx7('M_2')]: 'no' });
    expect(res7b.state[idx7('E_1')]).toBe('yes');
    expect(res7b.state[idx7('E_3')]).toBe('yes');
    expect(res7b.state[idx7('M_5')]).toBe('yes');

    // Leo's Memory (5): implies & link rules
    const leo = MAPS_DATA[5]!;
    const idx5 = (id: string) => leo.ciphers.findIndex((c) => c.id === id);
    const res5 = deduce(leo.deduction, { [idx5('M_1')]: 'no' }); // 小屋 no => 侧门 & 油桶 no => link/east resolves
    expect(res5.state[idx5('W_2')]).toBe('no');
    expect(res5.state[idx5('W_3')]).toBe('no');
  });

  it('detects contradictions and formats markKind / stepNum helpers', () => {
    // Red Church chain contradiction (two adjacent 'yes' ciphers)
    const rc = MAPS_DATA[2]!;
    const idx2 = (id: string) => rc.ciphers.findIndex((c) => c.id === id);
    const contra = deduce(rc.deduction, { [idx2('W_3')]: 'yes', [idx2('W_2')]: 'yes' });
    expect(contra.contradiction).toBeTruthy();

    // Custom makeDeduction + dedHelpers + dedRuleBook check
    const customCiphers = [
      { id: 'A', name: '甲', location: [10, 10] as [number, number], feature: '', locked: true },
      { id: 'B', name: '乙', location: [20, 20] as [number, number], feature: '' },
    ];
    const h = dedHelpers(customCiphers);
    const d = makeDeduction({
      mapImage: '/assets/maps/军工厂_grid.jpg',
      mapSize: [100, 100],
      ciphers: customCiphers,
      cipherCombinations: [['A', 'B']],
      rules: [h.fixed({ cipherNames: ['甲'] }), h.same({ cipherNames: ['甲', '乙'] })],
    });
    expect(dedRuleBook(d.rules)).toHaveLength(2);
    expect(deduce(d, {}).state).toEqual(['yes', 'yes']);

    expect(STEP_NUMS[0]).toBe('①');
    expect(stepNum(1)).toBe('①');
    expect(stepNum(20)).toBe('20');
    expect(markKind(customCiphers[0]!, 'yes', undefined)).toEqual(['locked', 'lock', '必刷']);
    expect(markKind(customCiphers[1]!, 'yes', 'yes')[0]).toBe('user-yes');
    expect(markKind(customCiphers[1]!, 'no', undefined)[0]).toBe('inf-no');
    expect(markKind(customCiphers[1]!, null, undefined)[0]).toBe('unknown');
  });
});

describe('StorageLike Persistence, Legacy Migration & Active Map Bus', () => {
  it('supports board, region, and deduce persistence + active map pub/sub', () => {
    const st = makeMemoryStorage();
    const events: number[] = [];
    const unsub = onActiveMapChange((id) => events.push(id));

    expect(getActiveMapId(st)).toBe(0);
    setActiveMapId(4, st);
    expect(getActiveMapId(st)).toBe(4);
    expect(syncActiveMapByName('圣心医院排位', st)).toBe(1);
    expect(syncActiveMapByName('不存在的地图', st)).toBeNull();
    expect(events).toEqual([4, 1]);
    unsub();

    setActiveMapId(0, st);
    expect(events).toEqual([4, 1]); // unsubscribed

    const board = createEmptyBoardState(0);
    board.tokens.push({ tid: 1, role: 'mercenary', x: 0.3, y: 0.4 });
    board.shapes.push({ id: 1, kind: 'arrow', x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, color: '#c9a25f', width: 2 });
    board.texts.push({ id: 1, x: 0.2, y: 0.2, text: '转点', color: '#ddd3bd', fontSize: 14 });
    saveBoardState(0, board, st);
    expect(st.data.has(PIL_STORAGE_KEY)).toBe(true);

    const loaded = loadBoardState(0, st);
    expect(loaded.tokens[0]?.role).toBe('mercenary');
    expect(loaded.shapes[0]?.kind).toBe('arrow');
    expect(loaded.texts[0]?.text).toBe('转点');

    saveRegionState(
      6,
      {
        side: -1,
        cipherGroupIndex: 2,
        survivorZones: [0, 1, 2, 9],
        hunterZones: [5],
        selectedCipherIndex: 3,
        showDoors: true,
        roleSize: 45,
        cipherSize: 6,
        doorSize: 7,
      },
      st,
    );
    const reg = loadRegionState(6, st);
    expect(reg.hunterZones).toEqual([5]);
    expect(reg.survivorZones).toEqual([0, 1, 2, 9]);
    expect(reg.showDoors).toBe(true);

    saveDeduceMarks(0, { 1: 'yes', 11: 'no', 0: 'no' }, st); // idx 0 is locked, should be stripped
    expect(loadDeduceMarks(0, st)).toEqual({ 1: 'yes', 11: 'no' });
  });

  it('migrates legacy idv5_tactic_v1 format and validates JSON import/export', () => {
    const legacy = {
      v: 1,
      map: 2,
      boards: {
        2: {
          tokens: {
            bloodyQueen: { x: 0.4, y: 0.5, showMirror: true, fixedMirror: true },
            Naiad: { x: 0.2, y: 0.3 },
          },
          items: [{ iid: 1, kind: 'aquaMirror', x: 0.6, y: 0.5 }],
          arrows: [{ kind: 'circle', x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2, color: '#fff', width: 2 }],
        },
      },
      regions: {
        2: { side: -1, cipher: 1, surv: [1, 0, 1, 0, 0, 0, 0, 0, 0], hunt: [0, -1, 0, 0, 0, 0, 0, 0, 0], sel: 2 },
      },
      selDisplay: { doors: true, roleSize: 55, cipherSize: 5.5, doorSize: 6.5 },
      dedMarks: { 2: { 1: 'yes', 2: 'no' } },
      dungeon: { 2: 2 },
      chairs: { 2: { set: 1, basement: 1 } },
      boxes: { 2: { basement: 1 } },
      spawns: { 2: 3 },
    };
    const st = makeMemoryStorage({ idv5_tactic_v1: JSON.stringify(legacy) });

    expect(getActiveMapId(st)).toBe(2);
    const migBoard = loadBoardState(2, st);
    expect(migBoard.tokens.some((t) => t.role === 'naiad')).toBe(true);
    expect(migBoard.items[0]?.showMirror).toBe(true);
    expect(migBoard.items[0]?.linkTid).toBe(1);
    expect(migBoard.shapes[0]?.kind).toBe('circle');
    expect(migBoard.dungeonIndex).toBe(2);
    expect(migBoard.chairIndex).toBe(1);

    const migReg = loadRegionState(2, st);
    expect(migReg.survivorZones).toEqual([0, 2]);
    expect(migReg.hunterZones).toEqual([1]);
    expect(migReg.cipherGroupIndex).toBe(1);
    expect(migReg.showDoors).toBe(true);

    expect(loadDeduceMarks(2, st)).toEqual({ 1: 'yes', 2: 'no' });

    // JSON Export / Import round-trip (preserving shared chain lc ref)
    const sharedLc: MeasureLineConfig = { lid: 2, bases: [{ from: 0, to: 2, speed: 3.8 }], buffs: [] };
    migBoard.measures = [
      { id: 1, x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2, chain: 1, lc: sharedLc },
      { id: 2, x1: 0.2, y1: 0.2, x2: 0.3, y2: 0.3, chain: 1, lc: sharedLc },
    ];
    const json = exportBoardJson(2, migBoard);
    const imported = importBoardJson(json);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.mapId).toBe(2);
      expect(imported.state.measures[0]!.lc).toBe(imported.state.measures[1]!.lc);
    }

    // Malformed / invalid JSON validation with Chinese errors
    const bad1 = importBoardJson('');
    expect(bad1.ok).toBe(false);
    if (!bad1.ok) expect(bad1.error).toContain('为空');

    const bad2 = importBoardJson('{not json');
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) expect(bad2.error).toContain('JSON');

    const bad3 = importBoardJson(JSON.stringify({ format: 'idv-pil-board', mapId: 99, board: {} }));
    expect(bad3.ok).toBe(false);
    if (!bad3.ok) expect(bad3.error).toContain('地图');

    const bad4 = importBoardJson(JSON.stringify({ tokens: 'not-array' }));
    expect(bad4.ok).toBe(false);
    if (!bad4.ok) expect(bad4.error).toContain('tokens');
  });

  it('handles buildStandaloneMapPayload toggle options, escapeDoorLock, and all basements', () => {
    const bare = buildStandaloneMapPayload(0, {
      includeCiphers: false,
      includeChairs: false,
      includeBasementChairs: false,
      includeChests: false,
      includeGates: false,
      includeHatch: false,
    });
    expect(bare.entities.ciphers).toEqual([]);
    expect(bare.entities.chairs).toEqual([]);
    expect(bare.entities.chests).toEqual([]);
    expect(bare.entities.exit_gates).toEqual([]);
    expect(bare.entities.hatch).toBeNull();

    // Map 3 (月亮河公园) has 2 basements and 4 escapeDoors; test escapeDoorLock & basementIndex:'all'
    const allMoonlit = buildStandaloneMapPayload(3, {
      cipherGroupIndex: 'all',
      chairSetIndex: null,
      basementIndex: 'all',
      escapeDoorLock: true,
    });
    expect(allMoonlit.entities.ciphers.length).toBe(MAPS_DATA[3]!.ciphers.length);
    const bChairs = allMoonlit.entities.chairs.filter((c) => c.is_basement);
    expect(bChairs.length).toBeGreaterThanOrEqual(8);
    expect(allMoonlit.entities.exit_gates).toHaveLength(2);
    const lockedDoorPt = MAPS_DATA[3]!.escapeDoors[2]!;
    const uPerPx = (MAPS_DATA[3]!.widthM / MAPS_DATA[3]!.mapSize[0]) * WORLD_UNITS_PER_METER;
    expect(allMoonlit.entities.exit_gates[0]!.pos[0]).toBeCloseTo(lockedDoorPt[0] * uPerPx, 6);
    expect(allMoonlit.entities.exit_gates[0]!.pos[2]).toBeCloseTo(lockedDoorPt[1] * uPerPx, 6);
  });

  it('computes zone centers for all 9 maps and handles null/out-of-range region queries', () => {
    expect(mapsZonesRelative).toHaveLength(PIL_MAP_COUNT);
    for (let i = 0; i < PIL_MAP_COUNT; i++) {
      const centers = calculateZoneCenters(mapsZonesRelative[i]!);
      expect(centers).toHaveLength(mapsZonesRelative[i]!.length);
      for (const pt of centers) {
        expect(pt.x).toBeGreaterThan(0);
        expect(pt.y).toBeGreaterThan(0);
      }
    }

    const none = analyzeRegionCiphers(0, 0, null);
    expect(none.hunterZoneIdx).toBe(-1);
    expect(none.lockIndex).toBe(-1);
    expect(none.lockCipherName).toBeNull();
    expect(none.lockDistanceM).toBeNull();
    expect(none.rows).toHaveLength(7);

    // Out-of-range hunterZoneIdx sanitizes to -1; negative cipherGroupIndex wraps modulo comboCount
    const wrapped = analyzeRegionCiphers(0, -1, 999);
    expect(wrapped.cipherGroupIndex).toBe(MAPS_DATA[0]!.cipherCombinations.length - 1);
    expect(wrapped.hunterZoneIdx).toBe(-1);
    expect(wrapped.lockIndex).toBe(-1);
  });

  it('exercises map-specific deduction rules on Hospital, Lakeside, Moonlit, Eversleeping, and Darkwoods', () => {
    for (const mapId of [0, 2, 3, 5, 8]) {
      const ded = MAPS_DATA[mapId]!.deduction;
      const base = deduce(ded, {});
      expect(base.contradiction).toBeNull();
      expect(base.candidates.length).toBeGreaterThanOrEqual(1);
      const firstOpen = base.state.findIndex((v) => v === null);
      if (firstOpen >= 0) {
        const narrowed = deduce(ded, { [firstOpen]: 'yes' });
        expect(narrowed.contradiction).toBeNull();
        expect(narrowed.candidates.length).toBeGreaterThanOrEqual(1);
        expect(narrowed.candidates.length).toBeLessThanOrEqual(base.candidates.length);
        expect(narrowed.state[firstOpen]).toBe('yes');
      }
    }
  });

  it('handles carry-model boundary initialProgress, clamping, and tie-break sorting', () => {
    const clamped = normalizeCarrySelection({
      survivorId: 'nonexistent',
      baseSpeed: -5,
      baseStruggleSeconds: 9999,
      initialProgress: 92,
      pickupSeconds: -2,
    });
    expect(clamped.survivorId).toBe('ordinary');
    expect(clamped.baseSpeed).toBe(0.1);
    expect(clamped.baseStruggleSeconds).toBe(300);
    expect(clamped.initialProgress).toBe(92);
    expect(clamped.pickupSeconds).toBe(0);

    expect(normalizeCarryBuffs([null, { key: 'unknown' }, { key: 'giantClaw', level: 99 }])).toEqual([
      { key: 'giantClaw', level: 3 },
    ]);

    const highProg = createCarryProfile({ initialProgress: 92 });
    const bands = carryRangeBands(highProg);
    // At >= 90% initial progress, all non-risk bands [0..3] must be empty
    expect(bands[0]!.empty).toBe(true);
    expect(bands[1]!.empty).toBe(true);
    expect(bands[2]!.empty).toBe(true);
    expect(bands[3]!.empty).toBe(true);
    expect(carryBandAt(bands, 0.5)).toBe(4);
    expect(carryBandAt(bands, -1)).toBe(-1);

    // Equal-distance chairs sort deterministically by index ascending
    const tied = evaluateChairsForCarry(
      createCarryProfile({ baseSpeed: 4 }),
      { x: 0.5, y: 0.5 },
      [
        { relPos: [0.6, 0.5], index: 7, label: 'C7' },
        { relPos: [0.4, 0.5], index: 2, label: 'C2' },
      ],
      [1000, 1000],
      100,
    );
    expect(tied.map((c) => c.index)).toEqual([2, 7]);
  });

  it('handles tide-model fallback speeds, boundary bands, and margin vs unreachable chairs', () => {
    const fallback = createTideProfile({ baseSpeed: 0, buffs: [{ mult: NaN }, { mult: 1.1, duration: 5 }] });
    expect(fallback.baseSpeed).toBe(3.8);
    expect(fallback.speedAt(2)).toBeCloseTo(3.8 * 1.1, 6);
    expect(fallback.speedAt(6)).toBeCloseTo(3.8, 6);

    const bands = tideRangeBands();
    expect(tideBandAt(bands, -0.1)).toBe(-1);
    expect(tideBandAt(bands, 0)).toBe(0);
    expect(tideBandAt(bands, 19.99)).toBe(3);
    expect(tideBandAt(bands, 20.5)).toBe(4);
    expect(tideBandAt(bands, 21)).toBe(-1);

    const evals = evaluateChairsForTide(
      createTideProfile({ baseSpeed: 4.0 }),
      [0, 0],
      [
        { relPos: [0.4, 0], index: 0 }, // 40m -> 10s (reachable20s)
        { relPos: [0.82, 0], index: 1 }, // 82m -> 20.5s (inMargin)
        { relPos: [0.9, 0], index: 2 }, // 90m -> 22.5s (unreachable)
      ],
      [1000, 1000],
      100,
    );
    expect(evals[0]!.reachable20s).toBe(true);
    expect(evals[1]!.inMargin).toBe(true);
    expect(evals[1]!.reachable).toBe(true);
    expect(evals[2]!.reachable).toBe(false);
    expect(evals[2]!.band).toBe(-1);
  });

  it('handles anim null/degenerate geometry and persist null-storage & sanitization edge cases', () => {
    const geomNull: AnimGeom = { dw: 1000, dh: 1000, widthM: null };
    expect(animPathLenM([], geomNull)).toBe(0);
    expect(animPointAlongPath([{ x: 0.2, y: 0.3 }], 0.5, geomNull)).toEqual({ x: 0.2, y: 0.3 });

    const singleAnim = { mode: 'speed' as const, points: [{ x: 0.25, y: 0.75 }], speeds: [], times: [] };
    expect(animDuration(singleAnim, geomNull)).toEqual({ start: 0, end: 0, total: 0 });
    expect(animPositionAt(singleAnim, geomNull, 1)).toEqual({ x: 0.25, y: 0.75, done: true });

    const twoPt = {
      mode: 'speed' as const,
      points: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0 },
      ],
      speeds: [{ name: 'walk', speed: 5 }],
      times: [],
    };
    const customGeom: AnimGeom = { dw: 1000, dh: 1000, widthM: 100 };
    // Custom segDurFn overrides speed to 20s -> avgSpeed = 50 / 20 = 2.5 m/s
    expect(animAvgSpeed(twoPt, customGeom, 0, () => 20)).toBeCloseTo(2.5, 6);

    // Null storage safety + region zone conflict sanitization (hunter overrides survivor if both contain zone)
    expect(getActiveMapId(null)).toBe(0);
    expect(loadBoardState(0, null).tokens).toEqual([]);

    const st = makeMemoryStorage();
    saveRegionState(
      0,
      {
        side: -1,
        cipherGroupIndex: 999,
        survivorZones: [0, 1, 999],
        hunterZones: [1, 2, -3],
        selectedCipherIndex: 99,
        showDoors: false,
        roleSize: 50,
        cipherSize: 5,
        doorSize: 6,
      },
      st,
    );
    const cleaned = loadRegionState(0, st);
    expect(cleaned.side).toBe(-1);
    expect(cleaned.cipherGroupIndex).toBe(999 % MAPS_DATA[0]!.cipherCombinations.length);
    expect(cleaned.survivorZones).toEqual([0, 1]);
    expect(cleaned.hunterZones).toEqual([2]); // zone 1 stripped because survivorZones owns it, -3 out of bounds
    expect(cleaned.selectedCipherIndex).toBe(-1);
  });

  it('computes measureSegmentDistanceM (routed path vs chord) and round-trips measure.path & anim.paths', () => {
    const mapSize: [number, number] = [1000, 1000];
    const widthM = 100;
    // Straight chord: 0.0 -> 0.3 = 30m
    expect(measureSegmentDistanceM({ x1: 0, y1: 0, x2: 0.3, y2: 0 }, mapSize, widthM)).toBeCloseTo(30, 6);
    // Routed polyline detour: (0,0) -> (0,0.4) -> (0.3,0.4) = 40m + 30m = 70m
    expect(
      measureSegmentDistanceM(
        {
          x1: 0,
          y1: 0,
          x2: 0.3,
          y2: 0.4,
          path: [
            { x: 0, y: 0 },
            { x: 0, y: 0.4 },
            { x: 0.3, y: 0.4 },
          ],
        },
        mapSize,
        widthM,
      ),
    ).toBeCloseTo(70, 6);

    const st = makeMemoryStorage();
    const board = createEmptyBoardState(0);
    board.tokens.push({
      tid: 1,
      role: 'mercenary',
      x: 0.1,
      y: 0.2,
      glow: true,
      spawnPreview: true,
      anim: {
        mode: 'speed',
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.4, y: 0.5 },
        ],
        speeds: [{ name: '跑', speed: 3.8 }],
        paths: [
          [
            { x: 0.1, y: 0.2 },
            { x: 0.25, y: 0.2 },
            { x: 0.4, y: 0.5 },
          ],
        ],
      },
    });
    board.items.push({
      iid: 1,
      kind: 'aquaMirror',
      role: 'bloodyQueen',
      x: 0.3,
      y: 0.3,
      anim: {
        mode: 'time',
        points: [
          { x: 0.3, y: 0.3 },
          { x: 0.6, y: 0.6 },
        ],
        times: [0, 4],
        paths: [
          [
            { x: 0.3, y: 0.3 },
            { x: 0.45, y: 0.35 },
            { x: 0.6, y: 0.6 },
          ],
        ],
      },
    });
    board.measures.push({
      id: 1,
      x1: 0.1,
      y1: 0.1,
      x2: 0.5,
      y2: 0.5,
      path: [
        { x: 0.1, y: 0.1 },
        { x: 0.3, y: 0.1 },
        { x: 0.5, y: 0.5 },
      ],
      chain: null,
      lc: null,
    });
    saveBoardState(0, board, st);
    const loaded = loadBoardState(0, st);
    expect(loaded.measures[0]?.path).toHaveLength(3);
    expect(loaded.tokens[0]?.anim?.paths?.[0]).toHaveLength(3);
    expect(loaded.items[0]?.anim?.paths?.[0]).toHaveLength(3);
    expect(loaded.tokens[0]?.glow).toBe(true);
    expect(loaded.tokens[0]?.spawnPreview).toBe(true);

    const exported = exportBoardJson(0, loaded);
    const imported = importBoardJson(exported);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.state.measures[0]?.path).toEqual(board.measures[0]!.path);
      expect(imported.state.tokens[0]?.anim?.paths?.[0]).toEqual(board.tokens[0]!.anim!.paths![0]);
      expect(imported.state.items[0]?.anim?.paths?.[0]).toEqual(board.items[0]!.anim!.paths![0]);
    }
  });

  it('has complete 9-map static landmarks (spawnPoints, rocketChairs, basements, chests, lockers, fixedSpawns)', () => {
    for (let id = 0; id < PIL_MAP_COUNT; id++) {
      const m = MAPS_DATA[id]!;
      expect(m.spawnPoints.length).toBeGreaterThanOrEqual(4);
      expect(m.rocketChairs.fixed.length).toBeGreaterThanOrEqual(4);
      expect(m.rocketChairs.fixed.length + (m.rocketChairs.sets[0]?.length ?? 0)).toBeGreaterThanOrEqual(10);
      expect(Object.keys(m.basements).length).toBeGreaterThanOrEqual(2);
      expect(m.chests.fixed.length).toBeGreaterThanOrEqual(3);
      expect(m.lockers.length).toBeGreaterThanOrEqual(4);
      expect(Object.keys(m.fixedSpawns).length).toBeGreaterThanOrEqual(2);
    }
    // Eversleeping Town (6) escapeDoors parity with PIL upstream
    expect(MAPS_DATA[6]!.escapeDoors).toEqual([[357, 20], [225, 616], [374, 20], [209, 616]]);
  });
});
