<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  CARRY_BAND_COLORS,
  CARRY_BAND_LABELS_ZH,
  CARRY_SURVIVORS,
  CARRY_TALENTS,
  OPENING_HUNTER_PRESETS,
  TAC_COMMON_ITEM_TYPES,
  TAC_CUSTOM_KEYS,
  TAC_HUNTER_ROLES,
  TAC_ITEM_TYPES,
  TAC_MOVEMENT_BUFFS,
  TAC_MOVEMENT_SURVIVOR,
  TAC_ROLES,
  TAC_SURVIVOR_ROLES,
  TAC_TALENT_TYPES,
  TIDE_BAND_COLORS,
  TIDE_BAND_LABELS_ZH,
  animDuration,
  animSegments,
  cipherOf,
  convertAnimMode,
  tZh,
  type AnimSpeedEntry,
  type CarryChairEval,
  type EndgameScenarioKind,
  type MeasureBase,
  type MeasureBuff,
  type Point2D,
  type TacticalBoardState,
  type TideChairEval,
} from '@/tactical';
import {
  ANIM_SPEED_PRESETS,
  SHARED_MANAGE_ROLES,
  TAC_DRAW_COLORS,
  TAC_TACTICAL_TALENTS_BY_CAMP,
  closeHittingPointChain,
  defaultMeasureBase,
  groupMeasureLines,
  isChainLinkableProp,
  letterLabel,
  propDisplayName,
  setHittingPointAllowLink,
  setHittingPointShowLink,
  syncSharedRoleManageState,
  tokenCamp,
  tokenDisplayName,
  type BoardGeoContext,
  type BoardProp,
  type BoardSelection,
  type BoardToken,
  type BoardToolId,
  type DrawShapeKind,
  type LandmarkVisibility,
  type MeasureModeId,
  type PlacePending,
  type RangeEvaluation,
  type RangeOverlayState,
  type SnapTargets,
} from '@/lib/board';

const props = withDefaults(
  defineProps<{
    activeTool: BoardToolId;
    board: TacticalBoardState;
    geo: BoardGeoContext;
    landmarks: LandmarkVisibility;
    cipherGroupIndex: number;
    cipherGroupCount: number;
    isDraft?: boolean;
    highlightedCipherId?: string | null;
    selection: BoardSelection;
    placePending: PlacePending;
    drawShape: DrawShapeKind;
    drawColor: string;
    drawWidth: number;
    textInput: string;
    textFontSize: number;
    snapLandmarks: boolean;
    measureMode: MeasureModeId;
    measureScope: 'chain' | 'seg';
    measureCamp: 'survivor' | 'hunter';
    measureBase: MeasureBase;
    measureBuffs: MeasureBuff[];
    measurePending: Point2D | null;
    measureVault: boolean;
    measureAutoFix: boolean;
    delSegOnly: boolean;
    routePickSlot: 'a' | 'b' | null;
    routePointA: Point2D | null;
    routePointB: Point2D | null;
    routeFixNote: string;
    routeComputing?: boolean;
    rangeState: RangeOverlayState;
    rangeEval: RangeEvaluation | null;
    basementCount: number;
    rangeComputing?: boolean;
    animArmed: boolean;
    animSinglePlaying: boolean;
    animAutoRoute: boolean;
    animVault: boolean;
    animSpeedPresetKey: string;
  }>(),
  {
    isDraft: false,
    highlightedCipherId: null,
    routeComputing: false,
    rangeComputing: false,
  },
);

const emit = defineEmits<{
  (e: 'update:activeTool', v: BoardToolId): void;
  (e: 'update:selection', v: BoardSelection): void;
  (e: 'update:placePending', v: PlacePending): void;
  (e: 'update:drawShape', v: DrawShapeKind): void;
  (e: 'update:drawColor', v: string): void;
  (e: 'update:drawWidth', v: number): void;
  (e: 'update:textInput', v: string): void;
  (e: 'update:textFontSize', v: number): void;
  (e: 'update:snapLandmarks', v: boolean): void;
  (e: 'update:measureMode', v: MeasureModeId): void;
  (e: 'update:measureScope', v: 'chain' | 'seg'): void;
  (e: 'update:measureCamp', v: 'survivor' | 'hunter'): void;
  (e: 'update:measureBase', v: MeasureBase): void;
  (e: 'update:measureBuffs', v: MeasureBuff[]): void;
  (e: 'update:measureVault', v: boolean): void;
  (e: 'update:measureAutoFix', v: boolean): void;
  (e: 'update:delSegOnly', v: boolean): void;
  (e: 'route-pick-arm', slot: 'a' | 'b'): void;
  (e: 'route-run'): void;
  (e: 'route-clear'): void;
  (e: 'finish-measure-chain'): void;
  (e: 'delete-measure', id: number): void;
  (e: 'delete-shape', id: number): void;
  (e: 'delete-text', id: number): void;
  (e: 'mutate', fn: () => void, recordUndo?: boolean): void;
  (e: 'delete-selection'): void;
  (e: 'update:animArmed', v: boolean): void;
  (e: 'update:animAutoRoute', v: boolean): void;
  (e: 'update:animVault', v: boolean): void;
  (e: 'update:animSpeedPresetKey', v: string): void;
  (e: 'anim-apply-preset', speed: number, name: string): void;
  (e: 'anim-remove-point', idx: number): void;
  (e: 'anim-recompute-all'): void;
  (e: 'toggle-anim-single'): void;
  (e: 'reset-anim-single'): void;
  (e: 'clear-anim'): void;
  (e: 'range-pick-arm'): void;
  (e: 'range-clear'): void;
  (e: 'range-toggle-basement'): void;
  (e: 'cycle-basement', delta: number): void;
  (e: 'cycle-cipher', delta: number): void;
  (e: 'cycle-spawn', delta: number): void;
  (e: 'highlight-cipher', cipherId: string): void;
  (e: 'swap-mirror', aqIid: number): void;
  (e: 'apply-opening-scenario', hunterRole: string): void;
  (e: 'apply-endgame-scenario', variant: EndgameScenarioKind, hunterRole: string): void;
}>();

const scenarioHunterRole = ref('operaSinger');
const scenarioStatusNote = ref('');

function triggerOpeningScenario(): void {
  emit('apply-opening-scenario', scenarioHunterRole.value);
  scenarioStatusNote.value = `已按当前刷点组自动落子 1 监管 + 4 求生并生成开局时间轴`;
}

function triggerEndgameScenario(variant: EndgameScenarioKind): void {
  emit('apply-endgame-scenario', variant, scenarioHunterRole.value);
  const names: Record<EndgameScenarioKind, string> = {
    'prime-pop': '压机亮机残局（99%压机+冲门）',
    'chair-rescue': '守椅救人残局（外围拦截+抢机）',
    'gate-war': '开门战残局（双大门+地窖博弈）',
  };
  scenarioStatusNote.value = `已布置：${names[variant]}`;
}

function toggleCipherProgressMode(enabled: boolean): void {
  emit('mutate', () => {
    props.board.cipherProgressEnabled = enabled;
    if (!props.board.cipherProgress) {
      props.board.cipherProgress = {};
    }
  });
}

function setCipherProgressValue(cipherId: string, pct: number): void {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  emit('mutate', () => {
    props.board.cipherProgressEnabled = true;
    const map = (props.board.cipherProgress ??= {});
    map[cipherId] = clamped;
  }, false);
}

function selectedPropRangeOption(pr: BoardProp) {
  const def = TAC_ITEM_TYPES[pr.kind];
  if (!def?.ranges?.options?.length) return null;
  const subs = pr.rangeBox?.subs ?? (pr.showRange === false ? [] : [pr.rangeSubIndex ?? 0]);
  const firstIdx = subs[0];
  if (firstIdx == null) return null;
  return def.ranges.options[firstIdx] ?? null;
}

function selectedPropGearValues(pr: BoardProp): number[] | null {
  const opt = selectedPropRangeOption(pr);
  return opt && Array.isArray(opt.size_m) ? opt.size_m : null;
}

function selectedPropRadiusBounds(pr: BoardProp): { min: number; max: number; cur: number } | null {
  const opt = selectedPropRangeOption(pr);
  if (!opt || typeof opt.size_m !== 'object' || Array.isArray(opt.size_m)) return null;
  const min = opt.size_m.min;
  const max = opt.size_m.max ?? Math.round(props.geo.effectiveWidthM);
  const cur = pr.rangeM ?? (opt.size_m.max ?? 20);
  return { min, max, cur };
}

function propChainMembers(pr: BoardProp): BoardProp[] {
  if (!isChainLinkableProp(pr.kind) || pr.chainId == null) return [];
  return (props.board.items as BoardProp[]).filter(
    (o) => o.kind === pr.kind && o.chainId === pr.chainId && o.allowLink !== false,
  );
}

function onToggleSharedFixedSpawn(tk: BoardToken, checked: boolean): void {
  emit('mutate', () => {
    syncSharedRoleManageState(props.board, tk, { showFixedSpawns: checked });
  });
}

function onToggleSharedSpawnDir(tk: BoardToken, checked: boolean): void {
  emit('mutate', () => {
    syncSharedRoleManageState(props.board, tk, { showSpawnDir: checked });
  });
}

const SNAP_TARGET_LABELS: ReadonlyArray<readonly [keyof SnapTargets, string]> = [
  ['cipher', '密码机'],
  ['door', '大门'],
  ['dungeon', '地窖'],
  ['chair', '狂欢之椅'],
  ['locker', '柜子'],
  ['box', '箱子'],
  ['phoneBooth', '电话亭'],
  ['spawn', '出生点'],
  ['endpoint', '端点'],
];

// ------------------------------------------------------------------ Cipher Quick-Card (密码机速查)
const cipherCardRows = computed(() => {
  const map = props.geo.mapData;
  const combos = map.cipherCombinations;
  if (!combos.length) return [];
  const gIdx = ((props.cipherGroupIndex % combos.length) + combos.length) % combos.length;
  const activeIds = combos[gIdx] ?? [];
  return activeIds
    .map((cid) => {
      const c = cipherOf(props.geo.mapId, cid);
      if (!c) return null;
      const alwaysPresent = Boolean(c.locked) || combos.every((g) => g.includes(cid));
      return {
        id: c.id,
        name: c.name,
        feature: c.feature,
        alwaysPresent,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
});

// ------------------------------------------------------------------ Place Tool
const placeCamp = ref<'survivor' | 'hunter' | 'other'>('survivor');
const placeSearch = ref('');

const roleList = computed(() => {
  const q = placeSearch.value.trim().toLowerCase();
  const source = placeCamp.value === 'survivor' ? TAC_SURVIVOR_ROLES : TAC_HUNTER_ROLES;
  return Object.values(source).filter((r) => !q || r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q));
});

const selectedToken = computed<BoardToken | null>(() => {
  const sel = props.selection;
  if (sel?.type !== 'token') return null;
  return (props.board.tokens.find((t) => t.tid === sel.tid) as BoardToken | undefined) ?? null;
});

const selectedProp = computed<BoardProp | null>(() => {
  const sel = props.selection;
  if (sel?.type !== 'prop') return null;
  return (props.board.items.find((i) => i.iid === sel.iid) as BoardProp | undefined) ?? null;
});

const activeRoleForProps = computed<string | null>(() => {
  if (props.placePending?.kind === 'role') return props.placePending.role;
  if (props.placePending?.kind === 'prop') return props.placePending.role;
  if (selectedToken.value) return selectedToken.value.role;
  if (selectedProp.value?.role) return selectedProp.value.role;
  return null;
});

const activeRoleProps = computed(() => {
  const r = activeRoleForProps.value;
  if (!r) return [];
  const def = TAC_ROLES[r];
  if (!def?.items?.length) return [];
  return def.items.map((k) => TAC_ITEM_TYPES[k]).filter((d): d is NonNullable<typeof d> => Boolean(d));
});

const commonPropEntries = computed(() =>
  TAC_CUSTOM_KEYS.map((k) => TAC_COMMON_ITEM_TYPES[k]).filter((d): d is NonNullable<typeof d> => Boolean(d)),
);
const skillPropEntries = computed(() =>
  (TAC_ROLES.skill?.items ?? []).map((k) => TAC_ITEM_TYPES[k]).filter((d): d is NonNullable<typeof d> => Boolean(d)),
);

function armRole(role: string): void {
  if (props.placePending?.kind === 'role' && props.placePending.role === role) {
    emit('update:placePending', null);
  } else {
    emit('update:placePending', { kind: 'role', role });
  }
}

function armProp(role: string, propKind: string): void {
  if (props.placePending?.kind === 'prop' && props.placePending.propKind === propKind) {
    emit('update:placePending', null);
  } else {
    emit('update:placePending', { kind: 'prop', role, propKind });
  }
}

function toggleTokenSubRange(token: BoardToken, idx: number): void {
  emit('mutate', () => {
    const rb = (token.rangeBox ??= { subs: [], talents: {}, fill: false });
    const subs = (rb.subs ??= []);
    const pos = subs.indexOf(idx);
    if (pos >= 0) subs.splice(pos, 1);
    else subs.push(idx);
  });
}

function toggleTokenTalentRange(token: BoardToken, talentKey: string): void {
  emit('mutate', () => {
    const rb = (token.rangeBox ??= { subs: [], talents: {}, fill: false });
    const talents = (rb.talents ??= {});
    if (talents[talentKey]) {
      delete talents[talentKey];
      if (talentKey === 'fearRadius') token.showFearRadius = false;
    } else {
      talents[talentKey] = true;
      if (talentKey === 'fearRadius') token.showFearRadius = true;
    }
  });
}

function togglePropSubRange(prop: BoardProp, idx: number): void {
  emit('mutate', () => {
    const def = TAC_ITEM_TYPES[prop.kind];
    const rb = (prop.rangeBox ??= {
      subs: prop.showRange === false ? [] : [prop.rangeSubIndex ?? 0],
      talents: {},
      fill: Boolean(def?.fill),
    });
    const subs = (rb.subs ??= []);
    const pos = subs.indexOf(idx);
    if (pos >= 0) subs.splice(pos, 1);
    else subs.push(idx);
    prop.showRange = subs.length > 0;
  });
}

function setAquaMirrorFlag(prop: BoardProp, field: 'showMirror' | 'fixedMirror', val: boolean): void {
  emit('mutate', () => {
    prop[field] = val;
    if (field === 'showMirror' && !val) {
      prop.fixedMirror = false;
      delete prop.mirrorAxis;
    }
  });
}

// ------------------------------------------------------------------ Measure Tool
const measureGroups = computed(() => groupMeasureLines(props.board.measures, props.geo));
const activeMeasureGroup = computed(() => {
  const sel = props.selection;
  if (sel?.type === 'measure') {
    const found = measureGroups.value.find((g) => g.segs.some((s) => s.id === sel.id));
    if (found) return found;
  }
  return measureGroups.value.at(-1) ?? null;
});

const activeMeasureDeleteId = computed(() => {
  if (props.selection?.type === 'measure') return props.selection.id;
  return activeMeasureGroup.value?.segs[0]?.id ?? null;
});

const measurePresetKey = ref<string>('run');
const measureSubKey = ref<string>('');
const customBuffName = ref('');
const customBuffPct = ref<number>(10);
const customBuffDur = ref<number>(0);
const selectedTraitKey = ref('');
const selectedTalentKey = ref('');
const selectedOtherKey = ref('');
const selectedBuffLv = ref(0);

const measureTraits = computed(() => TAC_MOVEMENT_BUFFS.trait[props.measureCamp]);
const measureTalents = computed(() =>
  Object.entries(TAC_MOVEMENT_BUFFS.talent)
    .filter(([, b]) => !b.camp || b.camp === props.measureCamp)
    .map(([k, b]) => ({ key: k, ...b })),
);
const measureOthers = computed(() => TAC_MOVEMENT_BUFFS.other[props.measureCamp]);

watch(
  () => props.measureCamp,
  (camp) => {
    measurePresetKey.value = camp === 'survivor' ? 'run' : 'hellEmber';
    measureSubKey.value = '';
    selectedTraitKey.value = measureTraits.value[0]?.key ?? '';
    selectedTalentKey.value = measureTalents.value[0]?.key ?? '';
    selectedOtherKey.value = measureOthers.value[0]?.key ?? '';
  },
  { immediate: true },
);

const hunterFormOptions = computed(() => {
  if (props.measureCamp !== 'hunter') return [];
  const def = TAC_HUNTER_ROLES[measurePresetKey.value];
  if (!def || typeof def.speed !== 'object') return [];
  return Object.entries(def.speed).map(([name, speed], idx) => ({ idx, name, speed }));
});

function formatRelPx(pt: Point2D | null): string {
  if (!pt) return '未选';
  const [dw, dh] = props.geo.mapData.mapSize;
  return `(${Math.round(pt.x * dw)}, ${Math.round(pt.y * dh)})`;
}

function applyMeasureBaseChange(next: MeasureBase): void {
  emit('update:measureBase', next);
  const g = activeMeasureGroup.value;
  const sel = props.selection;
  if (sel?.type === 'measure' && g) {
    emit('mutate', () => {
      const segIdx = g.segs.findIndex((s) => s.id === sel.id);
      const from = props.measureScope === 'seg' && segIdx >= 0 ? segIdx : 0;
      const to = props.measureScope === 'seg' && segIdx >= 0 ? segIdx + 1 : g.segs.length;
      const nb: MeasureBase[] = [];
      for (const b of g.lc.bases) {
        if (b.to <= from || b.from >= to) nb.push(b);
        else {
          if (b.from < from) nb.push({ ...b, to: from });
          if (b.to > to) nb.push({ ...b, from: to });
        }
      }
      nb.push({ ...next, from, to });
      nb.sort((a, b) => a.from - b.from);
      g.lc.bases = nb;
    });
  }
}

function onPresetRoleChange(key: string): void {
  measurePresetKey.value = key;
  if (props.measureCamp === 'survivor') {
    const st = TAC_MOVEMENT_SURVIVOR.states[key as keyof typeof TAC_MOVEMENT_SURVIVOR.states];
    if (st) {
      applyMeasureBaseChange({
        from: 0,
        to: 1,
        name: st.name,
        speed: st.speed,
        camp: 'survivor',
        role: null,
        form: 0,
        stKey: key,
      });
      return;
    }
    if (key === 'role') {
      const firstKey = Object.keys(TAC_MOVEMENT_SURVIVOR.roles)[0] ?? 'survivor';
      measureSubKey.value = firstKey;
      const rg = TAC_MOVEMENT_SURVIVOR.roles[firstKey]!;
      applyMeasureBaseChange({
        from: 0,
        to: 1,
        name: rg.name,
        speed: rg.speed,
        camp: 'survivor',
        role: rg.role,
        form: rg.form ?? 0,
        stKey: 'role',
      });
      return;
    }
    if (key === 'fixed') {
      const firstKey = Object.keys(TAC_MOVEMENT_SURVIVOR.fixed)[0] ?? '';
      measureSubKey.value = firstKey;
      const fg = TAC_MOVEMENT_SURVIVOR.fixed[firstKey];
      if (fg) {
        applyMeasureBaseChange({
          from: 0,
          to: 1,
          name: fg.name,
          speed: fg.speed,
          camp: 'survivor',
          role: fg.role,
          form: fg.form ?? 0,
          stKey: 'fixed',
          fixed: true,
        });
      }
      return;
    }
  } else {
    const def = TAC_HUNTER_ROLES[key];
    if (def && def.speed != null) {
      const sp = typeof def.speed === 'number' ? def.speed : Object.values(def.speed)[0] ?? 4.64;
      const fName = typeof def.speed === 'object' ? Object.keys(def.speed)[0] ?? '' : '';
      measureSubKey.value = '0';
      applyMeasureBaseChange({
        from: 0,
        to: 1,
        name: fName && fName !== def.name ? `${def.name} ${fName}` : def.name,
        speed: sp,
        camp: 'hunter',
        role: key,
        form: 0,
      });
      return;
    }
  }
  applyMeasureBaseChange({
    from: 0,
    to: 1,
    name: '自定义',
    speed: props.measureBase.speed,
    camp: props.measureCamp,
    role: null,
    form: 0,
    stKey: 'custom',
  });
}

function onSubRoleChange(sub: string): void {
  measureSubKey.value = sub;
  if (props.measureCamp === 'survivor') {
    const dict = measurePresetKey.value === 'fixed' ? TAC_MOVEMENT_SURVIVOR.fixed : TAC_MOVEMENT_SURVIVOR.roles;
    const entry = dict[sub];
    if (!entry) return;
    applyMeasureBaseChange({
      from: 0,
      to: 1,
      name: entry.name,
      speed: entry.speed,
      camp: 'survivor',
      role: entry.role,
      form: entry.form ?? 0,
      stKey: measurePresetKey.value,
      fixed: measurePresetKey.value === 'fixed',
    });
  } else {
    const idx = Number(sub) || 0;
    const f = hunterFormOptions.value[idx];
    const def = TAC_HUNTER_ROLES[measurePresetKey.value];
    if (!f || !def) return;
    applyMeasureBaseChange({
      from: 0,
      to: 1,
      name: f.name === def.name ? f.name : `${def.name} ${f.name}`,
      speed: f.speed,
      camp: 'hunter',
      role: def.key,
      form: idx,
    });
  }
}

function onMeasureCustomSpeed(v: number): void {
  if (!(v > 0)) return;
  measurePresetKey.value = 'custom';
  applyMeasureBaseChange({
    ...props.measureBase,
    name: '自定义',
    speed: v,
    stKey: 'custom',
    fixed: false,
  });
}

function pushMeasureBuff(buff: MeasureBuff): void {
  const id = ++props.board.buffSeq;
  const g = activeMeasureGroup.value;
  const sel = props.selection;
  if (sel?.type === 'measure' && g) {
    emit('mutate', () => {
      const segIdx = g.segs.findIndex((s) => s.id === sel.id);
      const from = props.measureScope === 'seg' && segIdx >= 0 ? segIdx : 0;
      const to = props.measureScope === 'seg' && segIdx >= 0 ? segIdx + 1 : g.segs.length;
      g.lc.buffs.push({ ...buff, id, from, to });
    });
  } else {
    emit('update:measureBuffs', [...props.measureBuffs, { ...buff, id }]);
  }
}

function addTraitBuff(): void {
  const def = measureTraits.value.find((t) => t.key === selectedTraitKey.value);
  if (!def) return;
  const mult = def.levels ? def.levels[Math.min(selectedBuffLv.value, def.levels.length - 1)]! : (def.mult ?? 1);
  pushMeasureBuff({
    type: 'trait',
    key: def.key,
    name: `${def.role}·${def.name}`,
    mult,
    duration: def.duration ?? 0,
    postMult: def.postMult,
  });
}

function addTalentBuff(): void {
  const def = measureTalents.value.find((t) => t.key === selectedTalentKey.value);
  if (!def) return;
  const mult = def.levels ? def.levels[Math.min(selectedBuffLv.value, def.levels.length - 1)]! : (def.mult ?? 1);
  pushMeasureBuff({
    type: 'talent',
    key: def.key,
    name: def.name,
    mult,
    duration: def.duration ?? 0,
    postMult: def.postMult,
  });
  if (def.extra) {
    pushMeasureBuff({
      type: 'talent',
      key: def.key,
      name: def.extra.name,
      mult: def.extra.mult,
      duration: 0,
    });
  }
}

function addOtherBuff(): void {
  const def = measureOthers.value.find((t) => t.key === selectedOtherKey.value);
  if (!def) return;
  const mult = def.levels ? def.levels[Math.min(selectedBuffLv.value, def.levels.length - 1)]! : (def.mult ?? 1);
  pushMeasureBuff({
    type: 'other',
    key: def.key,
    name: def.name,
    mult,
    duration: def.duration ?? 0,
    postMult: def.postMult,
  });
}

function addCustomBuff(): void {
  if (!Number.isFinite(customBuffPct.value) || customBuffPct.value === 0) return;
  pushMeasureBuff({
    type: 'custom',
    key: '',
    name: customBuffName.value.trim() || '自定义加成',
    mult: Math.max(0.1, 1 + customBuffPct.value / 100),
    duration: Math.max(0, customBuffDur.value || 0),
  });
  customBuffName.value = '';
}

function removeMeasureBuff(buffId: number | undefined): void {
  if (buffId === undefined) return;
  const g = activeMeasureGroup.value;
  if (props.selection?.type === 'measure' && g) {
    emit('mutate', () => {
      g.lc.buffs = g.lc.buffs.filter((b) => b.id !== buffId);
    });
  } else {
    emit('update:measureBuffs', props.measureBuffs.filter((b) => b.id !== buffId));
  }
}

const shownMeasureBuffs = computed(() =>
  props.selection?.type === 'measure' && activeMeasureGroup.value
    ? activeMeasureGroup.value.lc.buffs
    : props.measureBuffs,
);

// ------------------------------------------------------------------ Range Tool (Carry / Tide)
const carryTalentOptions = computed(() =>
  Object.entries(CARRY_TALENTS).map(([key, def]) => ({
    key,
    name: tZh(`talent.${def.group === 'survivor' ? 'survivor' : 'hunter'}.${key}`),
    def,
  })),
);
const selectedCarryTalent = ref(carryTalentOptions.value[0]?.key ?? 'giantClaw');
const selectedCarryLevel = ref(3);

function addCarryTalent(): void {
  const opt = carryTalentOptions.value.find((o) => o.key === selectedCarryTalent.value);
  if (!opt) return;
  const lv = Math.max(1, Math.min(opt.def.levels.length, selectedCarryLevel.value));
  props.rangeState.carryBuffs.push({
    id: Date.now() + Math.floor(Math.random() * 1000),
    key: opt.key,
    level: lv,
  });
}

function onCarryHunterSelect(key: string): void {
  props.rangeState.hunterKey = key;
  if (key === 'custom') return;
  const def = TAC_HUNTER_ROLES[key];
  if (!def || def.speed == null) return;
  props.rangeState.carryBaseSpeed = typeof def.speed === 'number' ? def.speed : Object.values(def.speed)[0] ?? 4.64;
}

const tideTalentList = computed(() =>
  Object.entries(TAC_MOVEMENT_BUFFS.talent)
    .filter(([, b]) => !b.camp || b.camp === 'survivor')
    .map(([key, b]) => ({ key, ...b })),
);
const selectedTideTalent = ref('borrowedTime');

function addTideTalentBuff(): void {
  const def = tideTalentList.value.find((t) => t.key === selectedTideTalent.value);
  if (!def) return;
  const mult = def.levels ? def.levels[def.levels.length - 1]! : (def.mult ?? 1);
  props.rangeState.tideBuffs.push({
    id: Date.now() + Math.floor(Math.random() * 1000),
    type: 'talent',
    key: def.key,
    name: def.name,
    mult,
    duration: def.duration ?? 0,
    postMult: def.postMult,
  });
}

function toggleRangeBand(band: number): void {
  const idx = props.rangeState.hiddenBands.indexOf(band);
  if (idx >= 0) props.rangeState.hiddenBands.splice(idx, 1);
  else props.rangeState.hiddenBands.push(band);
}

// ------------------------------------------------------------------ Anim Tool
const animTarget = computed<BoardToken | BoardProp | null>(() => selectedToken.value ?? selectedProp.value ?? null);
const animTargetSegs = computed(() => {
  const obj = animTarget.value;
  if (!obj?.anim || obj.anim.points.length < 2) return [];
  return animSegments(obj.anim, props.geo.animGeom);
});
const animTargetTotal = computed(() => {
  const obj = animTarget.value;
  if (!obj?.anim) return 0;
  return animDuration(obj.anim, props.geo.animGeom).total;
});

const animPresetGroups = computed(() => {
  const groups = new Map<string, typeof ANIM_SPEED_PRESETS[number][]>();
  for (const p of ANIM_SPEED_PRESETS) {
    let arr = groups.get(p.group);
    if (!arr) {
      arr = [];
      groups.set(p.group, arr);
    }
    arr.push(p);
  }
  return Array.from(groups.entries());
});

function onAnimPresetSelect(key: string): void {
  emit('update:animSpeedPresetKey', key);
  const found = ANIM_SPEED_PRESETS.find((p) => p.key === key);
  if (found) {
    emit('anim-apply-preset', found.speed, found.name);
  }
}

function switchAnimMode(mode: 'time' | 'speed'): void {
  const obj = animTarget.value;
  if (!obj?.anim || obj.anim.mode === mode) return;
  emit('mutate', () => {
    const defSpeed =
      'role' in obj && obj.role && TAC_ROLES[obj.role]?.camp === 'hunter'
        ? (typeof TAC_ROLES[obj.role]!.speed === 'number' ? (TAC_ROLES[obj.role]!.speed as number) : 4.64)
        : 3.8;
    obj.anim = convertAnimMode(obj.anim!, mode, props.geo.animGeom, defSpeed);
  });
}

function updateAnimPointTime(idx: number, val: number): void {
  const obj = animTarget.value;
  if (!obj?.anim) return;
  emit('mutate', () => {
    const times = (obj.anim!.times ??= []);
    times[idx] = Math.max(0, Number.isFinite(val) ? val : 0);
  });
}

function updateAnimSegSpeed(segIdx: number, speed: number): void {
  const obj = animTarget.value;
  if (!obj?.anim || !(speed > 0)) return;
  emit('mutate', () => {
    const speeds: AnimSpeedEntry[] = (obj.anim!.speeds ??= []);
    const cur = speeds[segIdx] ?? { name: '自定义', speed: 3.8 };
    speeds[segIdx] = { ...cur, name: '自定义', speed };
  });
}

function removeAnimPoint(idx: number): void {
  emit('anim-remove-point', idx);
}

function selectCreation(sel: BoardSelection): void {
  emit('update:selection', sel);
  emit('update:placePending', null);
}
</script>

<template>
  <div class="dark fr cut tac-tools-card" data-test="tactical-tools-panel">
    <!-- Engraved Tactician's Workbook tool bar -->
    <div class="tac-tools-head">
      <div class="tac-head-title">
        <span class="k">战术工具</span>
        <small class="tac-head-en">Tactician's Workbook</small>
      </div>
      <div class="tac-subpills">
        <button
          v-for="t in ([
            ['inspect', '检视'],
            ['place', '放置'],
            ['draw', '绘制'],
            ['measure', '测算'],
            ['range', '范围'],
            ['anim', '动画'],
          ] as const)"
          :key="t[0]"
          class="gbtn fr cut sm"
          :class="{ on: activeTool === t[0] }"
          :data-panel-tool="t[0]"
          @click="emit('update:activeTool', t[0])"
        >
          {{ t[1] }}
        </button>
      </div>
    </div>

    <!-- INSPECT / OVERVIEW -->
    <div v-if="activeTool === 'inspect'" class="tac-sec">
      <p class="tac-hint-bar">当前处于「检视」模式：拖拽沙盘平移，点击角色/道具/文字选中或用方向键/WASD微调（Shift粗调）。</p>

      <!-- P0 Quick Opening / Endgame Deduction Card -->
      <div v-if="!isDraft" class="tac-workbook-box" data-test="tac-scenario-card">
        <div class="tac-cipher-card-head">
          <span class="tac-sub-head tac-sub-inline">开局 / 残局一键推演</span>
          <span v-if="geo.mapData.spawnPoints.length" class="vp-cyc tac-cyc-pill">
            <button type="button" class="gbtn fr cut sm" data-test="btn-scenario-spawn-prev" @click="emit('cycle-spawn', -1)">‹</button>
            <span class="num">刷点 {{ (board.spawnIndex % geo.mapData.spawnPoints.length) + 1 }}/{{ geo.mapData.spawnPoints.length }}</span>
            <button type="button" class="gbtn fr cut sm" data-test="btn-scenario-spawn-next" @click="emit('cycle-spawn', 1)">›</button>
          </span>
        </div>
        <div class="tac-buff-row">
          <span class="tac-field-lbl">监管</span>
          <select v-model="scenarioHunterRole" class="sel" data-test="scenario-hunter-select">
            <option v-for="h in OPENING_HUNTER_PRESETS" :key="h.role" :value="h.role">{{ h.label }}</option>
          </select>
          <button type="button" class="gbtn fr cut sm on" data-test="btn-scenario-opening" @click="triggerOpeningScenario">
            一键开局落子
          </button>
        </div>
        <div class="tac-triple-grid">
          <button type="button" class="gbtn fr cut sm" data-test="btn-scenario-prime" @click="triggerEndgameScenario('prime-pop')">压机亮机</button>
          <button type="button" class="gbtn fr cut sm" data-test="btn-scenario-rescue" @click="triggerEndgameScenario('chair-rescue')">守椅救人</button>
          <button type="button" class="gbtn fr cut sm" data-test="btn-scenario-gate" @click="triggerEndgameScenario('gate-war')">开门战</button>
        </div>
        <p v-if="scenarioStatusNote" class="tac-status-banner" data-test="scenario-status-note">{{ scenarioStatusNote }}</p>
      </div>

      <!-- Cipher Quick-Reference Card (密码机速查 + P0 残局进度条) -->
      <div v-if="!isDraft && cipherCardRows.length" class="tac-cipher-card" data-test="tac-cipher-card">
        <div class="tac-cipher-card-head">
          <span class="tac-sub-head tac-sub-inline">密码机速查</span>
          <label class="tac-chk" style="margin-left: auto; margin-right: 6px">
            <input
              type="checkbox"
              :checked="Boolean(board.cipherProgressEnabled)"
              data-test="toggle-cipher-progress"
              @change="toggleCipherProgressMode(($event.target as HTMLInputElement).checked)"
            />
            残局进度
          </label>
          <span class="vp-cyc tac-cyc-pill">
            <button
              type="button"
              class="gbtn fr cut sm"
              data-test="btn-cipher-card-prev"
              @click="emit('cycle-cipher', -1)"
            >
              ‹
            </button>
            <span class="num">第 {{ (cipherGroupIndex % cipherGroupCount) + 1 }} / {{ cipherGroupCount }} 组</span>
            <button
              type="button"
              class="gbtn fr cut sm"
              data-test="btn-cipher-card-next"
              @click="emit('cycle-cipher', 1)"
            >
              ›
            </button>
          </span>
        </div>
        <div class="tac-cipher-rows">
          <div v-for="row in cipherCardRows" :key="row.id" class="tac-cipher-row-wrap">
            <button
              type="button"
              class="tac-cipher-row"
              :class="{ active: highlightedCipherId === row.id }"
              :data-cipher-card-row="row.id"
              @click="emit('highlight-cipher', row.id)"
            >
              <span class="tac-cipher-tag" :class="row.alwaysPresent ? 'fixed' : 'maybe'">
                {{ row.alwaysPresent ? '必刷' : '可能' }}
              </span>
              <span class="tac-cipher-name">{{ row.name }}</span>
              <span class="tac-cipher-feat">{{ row.feature }}</span>
            </button>
            <div v-if="board.cipherProgressEnabled" class="tac-cipher-prog" :data-cipher-progress-row="row.id">
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                :value="board.cipherProgress?.[row.id] ?? 0"
                :data-cipher-progress-slider="row.id"
                @input="setCipherProgressValue(row.id, Number(($event.target as HTMLInputElement).value))"
              />
              <span class="num tac-prog-num">{{ board.cipherProgress?.[row.id] ?? 0 }}%</span>
              <button type="button" class="gbtn fr cut sm" @click="setCipherProgressValue(row.id, 0)">0</button>
              <button type="button" class="gbtn fr cut sm" @click="setCipherProgressValue(row.id, 99)">99</button>
              <button type="button" class="gbtn fr cut sm" @click="setCipherProgressValue(row.id, 100)">完</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Quick Static Landmark Toggles -->
      <details class="tac-quick-details" open>
        <summary>快捷地标与辅助显示</summary>
        <div class="tac-quick-details-body">
          <div class="tac-opts">
            <button type="button" class="gbtn fr cut sm" :class="{ on: landmarks.ciphers }" data-quick-landmark="ciphers" @click="landmarks.ciphers = !landmarks.ciphers">密码机</button>
            <button type="button" class="gbtn fr cut sm" :class="{ on: landmarks.gates }" data-quick-landmark="gates" @click="landmarks.gates = !landmarks.gates">大门</button>
            <button type="button" class="gbtn fr cut sm" :class="{ on: landmarks.hatch }" data-quick-landmark="hatch" @click="landmarks.hatch = !landmarks.hatch">地窖</button>
            <button type="button" class="gbtn fr cut sm" :class="{ on: landmarks.spawns }" data-quick-landmark="spawns" @click="landmarks.spawns = !landmarks.spawns">出生点</button>
            <button type="button" class="gbtn fr cut sm" :class="{ on: landmarks.chairs }" data-quick-landmark="chairs" @click="landmarks.chairs = !landmarks.chairs">狂欢之椅</button>
            <button type="button" class="gbtn fr cut sm" :class="{ on: landmarks.basement }" data-quick-landmark="basement" @click="landmarks.basement = !landmarks.basement">地下室椅</button>
            <button type="button" class="gbtn fr cut sm" :class="{ on: landmarks.basementChest }" data-quick-landmark="basementChest" @click="landmarks.basementChest = !landmarks.basementChest">地下室箱</button>
            <button type="button" class="gbtn fr cut sm" :class="{ on: landmarks.chests }" data-quick-landmark="chests" @click="landmarks.chests = !landmarks.chests">箱子</button>
            <button type="button" class="gbtn fr cut sm" :class="{ on: landmarks.lockers }" data-quick-landmark="lockers" @click="landmarks.lockers = !landmarks.lockers">柜子</button>
            <button v-if="geo.mapData.phoneBooths?.length" type="button" class="gbtn fr cut sm" :class="{ on: landmarks.phoneBooths }" data-quick-landmark="phoneBooths" @click="landmarks.phoneBooths = !landmarks.phoneBooths">电话亭</button>
            <button type="button" class="gbtn fr cut sm" :class="{ on: landmarks.zones }" data-quick-landmark="zones" @click="landmarks.zones = !landmarks.zones">区域线</button>
            <button type="button" class="gbtn fr cut sm" :class="{ on: landmarks.fixedSpawns }" data-quick-landmark="fixedSpawns" @click="landmarks.fixedSpawns = !landmarks.fixedSpawns">固定刷点</button>
          </div>
          <div class="tac-opts tac-chk-strip">
            <label class="tac-chk">
              <input v-model="landmarks.showCoords" type="checkbox" />
              显示坐标
            </label>
            <label class="tac-chk">
              <input v-model="landmarks.selGlow" type="checkbox" />
              造物高亮
            </label>
          </div>
        </div>
      </details>

      <div class="tac-workbook-box">
        <div class="tac-sub-head">已放置造物 ({{ board.tokens.length + board.items.length }})</div>
        <div v-if="board.tokens.length || board.items.length" class="tac-chip-grid">
          <button
            v-for="tk in board.tokens"
            :key="`tk-${tk.tid}`"
            class="gbtn fr cut sm"
            :class="{ on: selection?.type === 'token' && selection.tid === tk.tid }"
            @click="selectCreation({ type: 'token', tid: tk.tid })"
          >
            {{ tokenDisplayName(tk) }}
          </button>
          <button
            v-for="it in board.items"
            :key="`it-${it.iid}`"
            class="gbtn fr cut sm"
            :class="{ on: selection?.type === 'prop' && selection.iid === it.iid }"
            @click="selectCreation({ type: 'prop', iid: it.iid })"
          >
            {{ propDisplayName(it) }}
          </button>
        </div>
        <p v-else class="empty">暂无造物 · 切换到「放置」添加角色或道具</p>
      </div>
    </div>

    <!-- PLACE TOOL -->
    <div v-else-if="activeTool === 'place'" class="tac-sec" data-test="tool-panel-place">
      <div class="tac-workbook-box">
        <div class="tac-camp-tabs">
          <button class="gbtn fr cut sm" :class="{ on: placeCamp === 'survivor' }" data-test="place-camp-survivor" @click="placeCamp = 'survivor'">求生者</button>
          <button class="gbtn fr cut sm" :class="{ on: placeCamp === 'hunter' }" data-test="place-camp-hunter" @click="placeCamp = 'hunter'">监管者</button>
          <button class="gbtn fr cut sm" :class="{ on: placeCamp === 'other' }" data-test="place-camp-other" @click="placeCamp = 'other'">通用 / 技能</button>
        </div>

        <input
          v-if="placeCamp !== 'other'"
          v-model="placeSearch"
          type="search"
          class="search tac-search"
          placeholder="搜索角色名称…"
          data-test="place-search"
        />

        <div v-if="placeCamp !== 'other'" class="tac-palette">
          <button
            v-for="r in roleList"
            :key="r.key"
            class="gbtn fr cut sm tac-role-btn"
            :class="{ on: placePending?.kind === 'role' && placePending.role === r.key }"
            :data-test="`role-btn-${r.key}`"
            @click="armRole(r.key)"
          >
            <span class="dot" :style="{ background: r.color }"></span>
            {{ r.name }}
          </button>
        </div>

        <div v-else class="tac-other-palette">
          <div class="tac-sub-head">通用地图造物</div>
          <div class="tac-palette">
            <button
              v-for="it in commonPropEntries"
              :key="it.key"
              class="gbtn fr cut sm"
              :class="{ on: placePending?.kind === 'prop' && placePending.propKind === it.key }"
              :data-test="`prop-btn-${it.key}`"
              @click="armProp('custom', it.key)"
            >
              {{ it.name }}
            </button>
          </div>
          <div class="tac-sub-head">监管者辅助特质</div>
          <div class="tac-palette">
            <button
              v-for="it in skillPropEntries"
              :key="it.key"
              class="gbtn fr cut sm"
              :class="{ on: placePending?.kind === 'prop' && placePending.propKind === it.key }"
              :data-test="`prop-btn-${it.key}`"
              @click="armProp('skill', it.key)"
            >
              {{ it.name }}
            </button>
          </div>
        </div>

        <div v-if="activeRoleProps.length" class="tac-role-props">
          <div class="tac-sub-head">{{ TAC_ROLES[activeRoleForProps!]?.name }} · 专属道具/造物</div>
          <div class="tac-palette">
            <button
              v-for="it in activeRoleProps"
              :key="it.key"
              class="gbtn fr cut sm"
              :class="{ on: placePending?.kind === 'prop' && placePending.propKind === it.key }"
              :data-test="`prop-btn-${it.key}`"
              @click="armProp(activeRoleForProps!, it.key)"
            >
              {{ it.name }}
            </button>
          </div>
        </div>

        <p v-if="placePending" class="tac-status-banner" data-test="place-armed-hint">
          已选定：{{ placePending.kind === 'role' ? TAC_ROLES[placePending.role]?.name : placePending.kind === 'prop' ? TAC_ITEM_TYPES[placePending.propKind]?.name : '文字' }} · 点击沙盘放置
        </p>
      </div>

      <!-- Placed creations list -->
      <div class="tac-workbook-box">
        <div class="tac-sub-head">画板造物 ({{ board.tokens.length + board.items.length }})</div>
        <div class="tac-chip-grid" data-test="placed-list">
          <button
            v-for="tk in board.tokens"
            :key="`pt-${tk.tid}`"
            class="gbtn fr cut sm"
            :class="{ on: selection?.type === 'token' && selection.tid === tk.tid }"
            :data-placed-token="tk.tid"
            @click="selectCreation({ type: 'token', tid: tk.tid })"
          >
            {{ tokenDisplayName(tk) }}
          </button>
          <button
            v-for="it in board.items"
            :key="`pi-${it.iid}`"
            class="gbtn fr cut sm"
            :class="{ on: selection?.type === 'prop' && selection.iid === it.iid }"
            :data-placed-prop="it.iid"
            @click="selectCreation({ type: 'prop', iid: it.iid })"
          >
            {{ propDisplayName(it) }}
          </button>
        </div>
      </div>

      <!-- Selected Token Inspector / Range Manager -->
      <div v-if="selectedToken" class="tac-sel-box" data-test="selected-creation-box">
        <div class="tac-sel-head">
          <b class="gold">{{ tokenDisplayName(selectedToken) }}</b>
          <button class="gbtn fr cut sm red" data-test="btn-delete-selected" @click="emit('delete-selection')">删除</button>
        </div>

        <!-- Role specific ranges -->
        <div v-if="TAC_ROLES[selectedToken.role]?.ranges?.options?.length" class="tac-opts">
          <span class="tac-field-lbl">技能/特质范围</span>
          <button
            v-for="(opt, idx) in TAC_ROLES[selectedToken.role]!.ranges!.options"
            :key="idx"
            class="gbtn fr cut sm"
            :class="{ on: selectedToken.rangeBox?.subs?.includes(idx) }"
            :data-test="`token-range-opt-${idx}`"
            @click="toggleTokenSubRange(selectedToken, idx)"
          >
            {{ opt.label }}
          </button>
        </div>

        <!-- Camp talent ranges (fearRadius, tinnitus, etc.) -->
        <div class="tac-opts">
          <span class="tac-field-lbl">天赋/警戒圈</span>
          <button
            v-for="tk in TAC_TACTICAL_TALENTS_BY_CAMP[tokenCamp(selectedToken)]"
            :key="tk"
            class="gbtn fr cut sm"
            :class="{ on: Boolean(selectedToken.rangeBox?.talents?.[tk]) || (tk === 'fearRadius' && selectedToken.showFearRadius) }"
            :data-test="`token-talent-${tk}`"
            @click="toggleTokenTalentRange(selectedToken, tk)"
          >
            {{ TAC_TALENT_TYPES[tk]?.name ?? tk }}
          </button>
        </div>

        <!-- Hunter multi-form fear radius selector -->
        <div
          v-if="TAC_ROLES[selectedToken.role]?.fearRadius?.forms?.length && (selectedToken.showFearRadius || selectedToken.rangeBox?.talents?.fearRadius)"
          class="tac-opts"
        >
          <span class="tac-field-lbl">恐惧半径形态</span>
          <button
            v-for="f in TAC_ROLES[selectedToken.role]!.fearRadius!.forms"
            :key="f.key"
            class="gbtn fr cut sm"
            :class="{ on: (selectedToken.fearFormKey ?? TAC_ROLES[selectedToken.role]!.fearRadius!.forms![0]!.key) === f.key }"
            @click="emit('mutate', () => { selectedToken!.fearFormKey = f.key; })"
          >
            {{ f.name }} ({{ Math.round(f.mult * 100) }}%)
          </button>
        </div>

        <!-- Explorer Treasure Range -->
        <label v-if="selectedToken.role === 'explorer'" class="tac-chk">
          <input
            type="checkbox"
            :checked="Boolean(selectedToken.showTreasureRange)"
            data-test="toggle-treasure-range"
            @change="emit('mutate', () => {
              const checked = ($event.target as HTMLInputElement).checked;
              if (checked) board.tokens.forEach((o) => { if (o.role === 'explorer' && o !== selectedToken) o.showTreasureRange = false; });
              selectedToken!.showTreasureRange = checked;
            })"
          />
          显示密码书页范围 (70m + 排除圈)
        </label>

        <!-- Fixed spawn toggle + Shared Manage (Photographer/Professor/SmileyFace) + Mad Eyes PC/iOS console screen -->
        <template v-if="geo.mapData.fixedSpawns[selectedToken.role]">
          <div class="tac-opts">
            <label class="tac-chk">
              <input
                type="checkbox"
                :checked="Boolean(selectedToken.showFixedSpawns)"
                data-test="toggle-token-fixed-spawns"
                @change="onToggleSharedFixedSpawn(selectedToken, ($event.target as HTMLInputElement).checked)"
              />
              显示 {{ geo.mapData.fixedSpawns[selectedToken.role]!.label }}
            </label>
            <label v-if="selectedToken.role === 'photographer' && selectedToken.showFixedSpawns" class="tac-chk">
              <input
                type="checkbox"
                :checked="selectedToken.showSpawnDir !== false"
                data-test="toggle-camera-dir"
                @change="onToggleSharedSpawnDir(selectedToken, ($event.target as HTMLInputElement).checked)"
              />
              相机朝向
            </label>
            <span v-if="SHARED_MANAGE_ROLES.has(selectedToken.role)" class="muted" style="font-size: 11px" data-test="shared-manage-badge">
              · 同角色共享同步
            </span>
            <label v-if="selectedToken.role === 'madEyes'" class="tac-chk">
              <input
                type="checkbox"
                :checked="Boolean(selectedToken.showFixedSpawnRange)"
                @change="emit('mutate', () => { selectedToken!.showFixedSpawnRange = ($event.target as HTMLInputElement).checked; })"
              />
              控制台屏框
            </label>
            <select
              v-if="selectedToken.role === 'madEyes' && selectedToken.showFixedSpawnRange"
              class="sel"
              :value="selectedToken.fixedSpawnDevice ?? 'pc'"
              @change="emit('mutate', () => { selectedToken!.fixedSpawnDevice = (($event.target as HTMLSelectElement).value === 'ios' ? 'ios' : 'pc'); })"
            >
              <option value="pc">PC 屏</option>
              <option value="ios">iOS 屏</option>
            </select>
          </div>
        </template>

        <div class="tac-opts tac-chk-strip">
          <label class="tac-chk">
            <input
              type="checkbox"
              :checked="Boolean(selectedToken.glow)"
              @change="emit('mutate', () => { selectedToken!.glow = ($event.target as HTMLInputElement).checked; })"
            />
            高亮
          </label>
          <label class="tac-chk">
            <input
              type="checkbox"
              :checked="Boolean(selectedToken.rangeBox?.fill)"
              @change="emit('mutate', () => {
                const rb = (selectedToken!.rangeBox ??= { subs: [], talents: {}, fill: false });
                rb.fill = ($event.target as HTMLInputElement).checked;
              })"
            />
            填充范围
          </label>
        </div>
      </div>

      <!-- Selected Prop Inspector -->
      <div v-else-if="selectedProp" class="tac-sel-box" data-test="selected-creation-box">
        <div class="tac-sel-head">
          <b class="gold">{{ propDisplayName(selectedProp) }}</b>
          <button class="gbtn fr cut sm red" data-test="btn-delete-selected" @click="emit('delete-selection')">删除</button>
        </div>

        <div v-if="TAC_ITEM_TYPES[selectedProp.kind]?.ranges?.options?.length" class="tac-opts">
          <span class="tac-field-lbl">道具范围</span>
          <button
            v-for="(opt, idx) in TAC_ITEM_TYPES[selectedProp.kind]!.ranges!.options"
            :key="idx"
            class="gbtn fr cut sm"
            :class="{ on: (selectedProp.rangeBox?.subs ?? (selectedProp.showRange === false ? [] : [0])).includes(idx) }"
            :data-test="`prop-range-opt-${idx}`"
            @click="togglePropSubRange(selectedProp, idx)"
          >
            {{ opt.label }}
          </button>
        </div>

        <!-- P2: Multi-Gear Radio (e.g. Goatman Cage 9m / 12m / 15m) -->
        <div
          v-if="selectedPropGearValues(selectedProp)"
          class="tac-opts"
          data-test="prop-gear-row"
        >
          <span class="tac-field-lbl">档位切换</span>
          <button
            v-for="(mVal, gIdx) in selectedPropGearValues(selectedProp)!"
            :key="gIdx"
            type="button"
            class="gbtn fr cut sm"
            :class="{ on: (selectedProp.rangeGear ?? 0) === gIdx }"
            :data-prop-gear="gIdx"
            @click="emit('mutate', () => { selectedProp!.rangeGear = gIdx; })"
          >
            {{ mVal }}m
          </button>
        </div>

        <!-- P2: Variable Radius Slider (e.g. Dancer Musicbox 6.3-9m / Custom Survivor & Hunter Circle) -->
        <label
          v-if="selectedPropRadiusBounds(selectedProp)"
          class="rng tac-rng"
          data-test="prop-radius-slider-row"
        >
          半径(m)
          <input
            type="range"
            :min="selectedPropRadiusBounds(selectedProp)!.min"
            :max="selectedPropRadiusBounds(selectedProp)!.max"
            step="0.5"
            :value="selectedPropRadiusBounds(selectedProp)!.cur"
            data-test="prop-radius-slider"
            @input="emit('mutate', () => { selectedProp!.rangeM = Number(($event.target as HTMLInputElement).value); }, false)"
          />
          <span class="num">{{ selectedPropRadiusBounds(selectedProp)!.cur.toFixed(1) }}m</span>
        </label>

        <!-- P2: Cross / Annulus Metrics + Prop Range Fill Toggle -->
        <div v-if="TAC_ITEM_TYPES[selectedProp.kind]?.ranges?.options?.length" class="tac-opts tac-chk-strip">
          <label class="tac-chk">
            <input
              type="checkbox"
              :checked="Boolean(selectedProp.rangeBox?.fill ?? TAC_ITEM_TYPES[selectedProp.kind]?.fill)"
              data-test="toggle-prop-range-fill"
              @change="emit('mutate', () => {
                const rb = (selectedProp!.rangeBox ??= { subs: [0], fill: false });
                rb.fill = ($event.target as HTMLInputElement).checked;
              })"
            />
            范围填充
          </label>
          <span v-if="selectedPropRangeOption(selectedProp)?.crossWidth" class="muted num" style="font-size: 11px">
            十字宽 {{ selectedPropRangeOption(selectedProp)!.crossWidth }}m
          </span>
          <span v-if="selectedPropRangeOption(selectedProp)?.ringInner" class="muted num" style="font-size: 11px">
            内径 {{ selectedPropRangeOption(selectedProp)!.ringInner }}m
          </span>
        </div>

        <!-- P2: Hitting-Point / Surging-Tides Chain Link Manager (4-35m, Early/4th Auto-Close) -->
        <div v-if="isChainLinkableProp(selectedProp.kind)" class="tac-workbook-box" data-test="hitting-point-card">
          <div class="tac-sub-head">
            {{ selectedProp.kind === 'surgingTides' ? '水渊连线闭环管理' : '击球点连线管理 (4–35m)' }}
            · {{ propChainMembers(selectedProp).length }} 点{{ selectedProp.chainClosed ? '（已闭环）' : '' }}
          </div>
          <div class="tac-opts tac-chk-strip">
            <label class="tac-chk">
              <input
                type="checkbox"
                :checked="selectedProp.allowLink !== false"
                data-test="toggle-hp-allow-link"
                @change="emit('mutate', () => setHittingPointAllowLink(board, selectedProp!, ($event.target as HTMLInputElement).checked, geo.effectiveWidthM, geo.mapData.mapSize[1] / geo.mapData.mapSize[0]))"
              />
              允许连线
            </label>
            <label class="tac-chk">
              <input
                type="checkbox"
                :checked="selectedProp.linkShow !== false"
                :disabled="selectedProp.allowLink === false"
                data-test="toggle-hp-show-link"
                @change="emit('mutate', () => setHittingPointShowLink(board, selectedProp!, ($event.target as HTMLInputElement).checked))"
              />
              显示连线
            </label>
            <button
              type="button"
              class="gbtn fr cut sm"
              :class="{ on: Boolean(selectedProp.chainClosed) }"
              :disabled="propChainMembers(selectedProp).length < 3"
              data-test="btn-hp-close-chain"
              @click="emit('mutate', () => { closeHittingPointChain(board, selectedProp!); })"
            >
              {{ selectedProp.chainClosed ? '展开闭环' : '提前闭环' }}
            </button>
          </div>
        </div>

        <div v-if="selectedProp.kind === 'aquaMirror'" class="tac-opts">
          <label class="tac-chk">
            <input
              type="checkbox"
              :checked="Boolean(selectedProp.showMirror)"
              data-test="toggle-show-mirror"
              @change="setAquaMirrorFlag(selectedProp, 'showMirror', ($event.target as HTMLInputElement).checked)"
            />
            显示镜像
          </label>
          <label class="tac-chk">
            <input
              type="checkbox"
              :checked="Boolean(selectedProp.fixedMirror)"
              :disabled="!selectedProp.showMirror"
              data-test="toggle-fixed-mirror"
              @change="setAquaMirrorFlag(selectedProp, 'fixedMirror', ($event.target as HTMLInputElement).checked)"
            />
            固定水镜位置
          </label>
          <button
            class="gbtn fr cut sm"
            :disabled="!selectedProp.showMirror"
            data-test="btn-swap-mirror"
            @click="emit('swap-mirror', selectedProp.iid)"
          >
            交换镜像
          </button>
        </div>

        <label v-if="selectedProp.kind === 'timeBomb' || selectedProp.kind === 'remoteControlledBomb'" class="rng tac-rng">
          十字角度
          <input
            type="range"
            min="0"
            max="360"
            step="5"
            :value="selectedProp.angle ?? 0"
            @input="emit('mutate', () => { selectedProp!.angle = Number(($event.target as HTMLInputElement).value); }, false)"
          />
          <span class="num">{{ selectedProp.angle ?? 0 }}°</span>
        </label>
      </div>
    </div>

    <!-- DRAW TOOL -->
    <div v-else-if="activeTool === 'draw'" class="tac-sec" data-test="tool-panel-draw">
      <div class="tac-workbook-box">
        <div class="tac-sub-head">图形与画笔</div>
        <div class="tac-triple-grid">
          <button
            v-for="sh in ([
              ['arrow', '箭头'],
              ['line', '直线'],
              ['circle', '虚线圈'],
              ['rect', '虚线框'],
              ['freehand', '自由画笔'],
              ['text', '文字标注'],
            ] as const)"
            :key="sh[0]"
            class="gbtn fr cut sm"
            :class="{ on: drawShape === sh[0] }"
            :data-draw-shape="sh[0]"
            @click="emit('update:drawShape', sh[0])"
          >
            {{ sh[1] }}
          </button>
        </div>

        <div class="tac-colors">
          <span class="tac-field-lbl">墨色</span>
          <button
            v-for="c in TAC_DRAW_COLORS"
            :key="c"
            class="tac-swatch"
            :class="{ on: drawColor === c }"
            :style="{ background: c }"
            :data-draw-color="c"
            @click="emit('update:drawColor', c)"
          ></button>
        </div>

        <div class="tac-opts tac-slider-row">
          <label class="rng tac-rng">
            线宽
            <input
              type="range"
              min="1"
              max="8"
              step="1"
              :value="drawWidth"
              data-test="draw-width"
              @input="emit('update:drawWidth', Number(($event.target as HTMLInputElement).value))"
            />
            <span class="num">{{ drawWidth }}px</span>
          </label>
          <label class="tac-chk">
            <input
              type="checkbox"
              :checked="snapLandmarks"
              @change="emit('update:snapLandmarks', ($event.target as HTMLInputElement).checked)"
            />
            吸附地标/端点
          </label>
        </div>

        <details v-if="snapLandmarks" class="tac-quick-details">
          <summary>精细吸附项</summary>
          <div class="tac-quick-details-body">
            <div class="tac-opts">
              <label v-for="[k, lbl] in SNAP_TARGET_LABELS" :key="k" class="tac-chk">
                <input v-model="landmarks.snapTargets[k]" type="checkbox" />
                {{ lbl }}
              </label>
            </div>
          </div>
        </details>
      </div>

      <div class="tac-workbook-box">
        <div class="tac-sub-head">文字标注 ({{ board.texts.length }})</div>
        <div class="tac-text-compose">
          <input
            type="text"
            class="search tac-text-in"
            placeholder="输入战术文字后点击地图放置…"
            :value="textInput"
            data-test="tac-text-input"
            @input="emit('update:textInput', ($event.target as HTMLInputElement).value)"
          />
          <button
            class="gbtn fr cut sm"
            :class="{ on: drawShape === 'text' }"
            data-test="btn-place-text"
            @click="emit('update:drawShape', 'text')"
          >
            点地图放置
          </button>
        </div>
        <label class="rng tac-rng">
          字号
          <input
            type="range"
            min="12"
            max="30"
            step="1"
            :value="textFontSize"
            data-test="text-font-size"
            @input="emit('update:textFontSize', Number(($event.target as HTMLInputElement).value))"
          />
          <span class="num">{{ textFontSize }}px</span>
        </label>

        <div v-if="board.texts.length" class="tac-list">
          <div v-for="tn in board.texts" :key="tn.id" class="tac-list-row" :data-text-id="tn.id">
            <input
              type="text"
              class="search tac-text-in"
              :value="tn.text"
              @input="emit('mutate', () => { tn.text = ($event.target as HTMLInputElement).value; }, false)"
            />
            <button class="gbtn fr cut sm red" @click="emit('delete-text', tn.id)">×</button>
          </div>
        </div>
      </div>

      <div v-if="board.shapes.length" class="tac-workbook-box">
        <div class="tac-sub-head">已绘制图形 ({{ board.shapes.length }})</div>
        <div class="tac-list">
          <div v-for="(sh, idx) in board.shapes" :key="sh.id" class="tac-list-row" :data-shape-id="sh.id">
            <span class="dot" :style="{ background: sh.color }"></span>
            <span>#{{ idx + 1 }} {{ sh.kind }}</span>
            <button class="gbtn fr cut sm red" @click="emit('delete-shape', sh.id)">×</button>
          </div>
        </div>
      </div>
    </div>

    <!-- MEASURE TOOL -->
    <div v-else-if="activeTool === 'measure'" class="tac-sec" data-test="tool-panel-measure">
      <div class="tac-workbook-box">
        <div class="tac-triple-grid">
          <button
            class="gbtn fr cut sm"
            :class="{ on: measureMode === 'single' }"
            data-test="btn-measure-single"
            @click="emit('update:measureMode', 'single')"
          >
            单段直线
          </button>
          <button
            class="gbtn fr cut sm"
            :class="{ on: measureMode === 'chain' }"
            data-test="btn-measure-chain"
            @click="emit('update:measureMode', 'chain')"
          >
            多点折线
          </button>
          <button
            class="gbtn fr cut sm"
            :class="{ on: measureMode === 'route' }"
            data-test="btn-measure-route"
            @click="emit('update:measureMode', 'route')"
          >
            路径线·绕障
          </button>
        </div>

        <div v-if="measurePending" class="tac-opts">
          <button
            class="gbtn fr cut sm on"
            data-test="btn-measure-finish"
            @click="emit('finish-measure-chain')"
          >
            完成折线
          </button>
        </div>

        <!-- Obstacle & endpoint options -->
        <div class="tac-chk-grid">
          <label class="tac-chk">
            <input
              type="checkbox"
              :checked="measureVault"
              data-test="toggle-measure-vault"
              @change="emit('update:measureVault', ($event.target as HTMLInputElement).checked)"
            />
            允许翻窗
          </label>
          <label class="tac-chk">
            <input
              type="checkbox"
              :checked="measureAutoFix"
              data-test="toggle-measure-autofix"
              @change="emit('update:measureAutoFix', ($event.target as HTMLInputElement).checked)"
            />
            自动修正阻挡点
          </label>
          <label class="tac-chk">
            <input
              v-model="landmarks.hideEndpoints"
              type="checkbox"
              data-test="toggle-hide-endpoints"
            />
            隐藏端点
          </label>
          <label class="tac-chk">
            <input
              type="checkbox"
              :checked="delSegOnly"
              data-test="toggle-del-seg-only"
              @change="emit('update:delSegOnly', ($event.target as HTMLInputElement).checked)"
            />
            仅删单段
          </label>
        </div>
      </div>

      <!-- Quick 2-point A -> B Route Planner Helper -->
      <div class="tac-route-box" data-test="route-planner-box">
        <div class="tac-sub-head">快捷两点路线规划 (A → B)</div>
        <div class="tac-opts">
          <button
            type="button"
            class="gbtn fr cut sm"
            :class="{ on: routePickSlot === 'a' }"
            data-test="btn-route-pick-a"
            @click="emit('route-pick-arm', 'a')"
          >
            {{ routePickSlot === 'a' ? '点图中起点 A…' : `起点 A ${formatRelPx(routePointA)}` }}
          </button>
          <button
            type="button"
            class="gbtn fr cut sm"
            :class="{ on: routePickSlot === 'b' }"
            data-test="btn-route-pick-b"
            @click="emit('route-pick-arm', 'b')"
          >
            {{ routePickSlot === 'b' ? '点图中终点 B…' : `终点 B ${formatRelPx(routePointB)}` }}
          </button>
          <button
            type="button"
            class="gbtn fr cut sm on"
            data-test="btn-route-run"
            :disabled="!routePointA || !routePointB || routeComputing"
            @click="emit('route-run')"
          >
            {{ routeComputing ? '计算中…' : '规划最优路线' }}
          </button>
          <button
            v-if="routePointA || routePointB || routeFixNote"
            type="button"
            class="gbtn fr cut sm"
            data-test="btn-route-clear"
            @click="emit('route-clear')"
          >
            清空
          </button>
        </div>
        <p v-if="routeFixNote" class="tac-route-note" data-test="route-fix-note">{{ routeFixNote }}</p>
      </div>

      <!-- Movement & Buff Configuration Card -->
      <div class="tac-workbook-box">
        <div v-if="measureMode === 'chain' || measureMode === 'route'" class="tac-field-row">
          <span class="tac-field-lbl">配置作用域</span>
          <div class="tac-pair-grid">
            <button class="gbtn fr cut sm" :class="{ on: measureScope === 'chain' }" @click="emit('update:measureScope', 'chain')">整条路线</button>
            <button class="gbtn fr cut sm" :class="{ on: measureScope === 'seg' }" @click="emit('update:measureScope', 'seg')">当前分段</button>
          </div>
        </div>

        <div class="tac-field-row">
          <span class="tac-field-lbl">阵营移速</span>
          <div class="tac-pair-grid">
            <button
              class="gbtn fr cut sm"
              :class="{ on: measureCamp === 'survivor' }"
              data-test="measure-camp-survivor"
              @click="emit('update:measureCamp', 'survivor'); emit('update:measureBase', defaultMeasureBase('survivor'))"
            >
              求生者
            </button>
            <button
              class="gbtn fr cut sm"
              :class="{ on: measureCamp === 'hunter' }"
              data-test="measure-camp-hunter"
              @click="emit('update:measureCamp', 'hunter'); emit('update:measureBase', defaultMeasureBase('hunter'))"
            >
              监管者
            </button>
          </div>
        </div>

        <div class="tac-buff-row">
          <select
            class="sel"
            :value="measurePresetKey"
            data-test="measure-role-select"
            @change="onPresetRoleChange(($event.target as HTMLSelectElement).value)"
          >
            <template v-if="measureCamp === 'survivor'">
              <option v-for="(st, k) in TAC_MOVEMENT_SURVIVOR.states" :key="k" :value="k">{{ st.name }} {{ st.speed }}m/s</option>
              <option value="role">角色专属移速</option>
              <option value="fixed">固定移速</option>
              <option value="custom">自定义</option>
            </template>
            <template v-else>
              <option
                v-for="h in Object.values(TAC_HUNTER_ROLES)"
                :key="h.key"
                :value="h.key"
                :disabled="h.speed == null"
              >
                {{ h.name }}{{ h.speed != null ? ` (${typeof h.speed === 'number' ? h.speed : Object.values(h.speed)[0]}m/s)` : '' }}
              </option>
              <option value="custom">自定义</option>
            </template>
          </select>

          <select
            v-if="measureCamp === 'survivor' && (measurePresetKey === 'role' || measurePresetKey === 'fixed')"
            class="sel"
            :value="measureSubKey"
            @change="onSubRoleChange(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="(item, k) in (measurePresetKey === 'fixed' ? TAC_MOVEMENT_SURVIVOR.fixed : TAC_MOVEMENT_SURVIVOR.roles)"
              :key="k"
              :value="k"
            >
              {{ item.name }} {{ item.speed }}m/s
            </option>
          </select>

          <select
            v-else-if="hunterFormOptions.length > 1"
            class="sel"
            :value="measureSubKey"
            @change="onSubRoleChange(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="f in hunterFormOptions" :key="f.idx" :value="String(f.idx)">{{ f.name }} {{ f.speed }}m/s</option>
          </select>

          <label class="tac-unit-field">
            <span>m/s</span>
            <input
              type="number"
              class="tac-num-in"
              min="0.1"
              max="40"
              step="0.05"
              :value="measureBase.speed"
              data-test="measure-base-speed"
              @change="onMeasureCustomSpeed(Number(($event.target as HTMLInputElement).value))"
            />
          </label>
        </div>

        <!-- Buff Builders -->
        <div class="tac-sub-head">速度加成</div>
        <div class="tac-buff-row">
          <select v-model="selectedTraitKey" class="sel" data-test="select-trait-buff">
            <option v-for="t in measureTraits" :key="t.key" :value="t.key">{{ t.role }}·{{ t.name }}</option>
          </select>
          <button class="gbtn fr cut sm" data-test="btn-add-trait-buff" @click="addTraitBuff">+ 特质</button>
        </div>
        <div class="tac-buff-row">
          <select v-model="selectedTalentKey" class="sel" data-test="select-talent-buff">
            <option v-for="t in measureTalents" :key="t.key" :value="t.key">{{ t.name }}</option>
          </select>
          <button class="gbtn fr cut sm" data-test="btn-add-talent-buff" @click="addTalentBuff">+ 天赋</button>
        </div>
        <div class="tac-buff-row">
          <select v-model="selectedOtherKey" class="sel" data-test="select-other-buff">
            <option v-for="o in measureOthers" :key="o.key" :value="o.key">{{ o.name }}</option>
          </select>
          <button class="gbtn fr cut sm" data-test="btn-add-other-buff" @click="addOtherBuff">+ 其它</button>
        </div>
        <div class="tac-buff-custom-row">
          <input v-model="customBuffName" type="text" class="search tac-text-in" placeholder="名称" />
          <input v-model.number="customBuffPct" type="number" class="tac-num-in" placeholder="%" data-test="custom-buff-pct" />
          <input v-model.number="customBuffDur" type="number" class="tac-num-in" min="0" step="0.5" placeholder="秒" data-test="custom-buff-dur" />
          <button class="gbtn fr cut sm" data-test="btn-add-custom-buff" @click="addCustomBuff">+ 自定义</button>
        </div>

        <div v-if="shownMeasureBuffs.length" class="tac-list">
          <div v-for="b in shownMeasureBuffs" :key="b.id ?? b.name" class="tac-list-row">
            <span>{{ b.name }}</span>
            <span class="num muted">
              {{ b.postMult ? `×${(b.mult ?? 1).toFixed(2)}` : `${Math.round(((b.mult ?? 1) - 1) * 100)}%` }}
              {{ b.duration ? `${b.duration}s` : '常驻' }}
            </span>
            <button class="gbtn fr cut sm red" @click="removeMeasureBuff(b.id)">×</button>
          </div>
        </div>
      </div>

      <!-- Simulation Result -->
      <div class="tac-sub-head">测算结果</div>
      <div v-if="activeMeasureGroup" class="tac-sim-box" data-test="measure-sim-result">
        <div class="tac-sim-summary num">
          <b>总长 {{ activeMeasureGroup.sim.dist.toFixed(1) }} m</b> ·
          <b class="tac-metric-accent">耗时 {{ activeMeasureGroup.sim.total.toFixed(2) }} s</b>
          <span class="muted">（基础 {{ activeMeasureGroup.sim.t0.toFixed(2) }}s）</span>
          <button
            v-if="activeMeasureDeleteId !== null"
            class="gbtn fr cut sm red"
            data-test="btn-measure-delete"
            @click="emit('delete-measure', activeMeasureDeleteId)"
          >
            {{ delSegOnly ? '删当前段' : '删除路线' }}
          </button>
        </div>
        <table class="dt">
          <thead>
            <tr>
              <th>段</th>
              <th>距离</th>
              <th>用时</th>
              <th>速度</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(seg, idx) in activeMeasureGroup.sim.segs" :key="idx">
              <td class="num">
                {{ letterLabel(idx) }}→{{ letterLabel(idx + 1) }}
                <span v-if="activeMeasureGroup.segs[idx]?.path?.length" class="tac-routed-pill">绕障</span>
              </td>
              <td class="num">{{ seg.dist.toFixed(1) }}m</td>
              <td class="num">{{ seg.t.toFixed(2) }}s</td>
              <td class="num">{{ seg.parts[0] ? seg.parts[0].v.toFixed(2) : '—' }}m/s</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty">在沙盘上依次点击两点绘制测距线段（路径线·绕障自动沿障碍导航网格寻路）</p>
    </div>

    <!-- RANGE TOOL (Carry / Tide) -->
    <div v-else-if="activeTool === 'range'" class="tac-sec" data-test="tool-panel-range">
      <div class="tac-workbook-box">
        <div class="tac-pair-grid">
          <button
            class="gbtn fr cut sm"
            :class="{ on: rangeState.scenario === 'carry' }"
            data-test="btn-range-carry"
            @click="rangeState.scenario = 'carry'; rangeState.detailMarkIndex = null"
          >
            牵气球-上椅
          </button>
          <button
            class="gbtn fr cut sm"
            :class="{ on: rangeState.scenario === 'tide' }"
            data-test="btn-range-tide"
            @click="rangeState.scenario = 'tide'; rangeState.detailMarkIndex = null"
          >
            化险为夷-下椅
          </button>
        </div>

        <div class="tac-pair-grid">
          <button
            class="gbtn fr cut sm"
            :class="{ on: rangeState.mode === 'chair' }"
            data-test="btn-range-mode-chair"
            @click="rangeState.mode = 'chair'; rangeState.origin = null; rangeState.detailMarkIndex = null"
          >
            选椅看范围
          </button>
          <button
            class="gbtn fr cut sm"
            :class="{ on: rangeState.mode === 'point' }"
            data-test="btn-range-mode-point"
            @click="rangeState.mode = 'point'; rangeState.origin = null; rangeState.detailMarkIndex = null"
          >
            {{ rangeState.scenario === 'tide' ? '选点看可达椅' : '选点看可挂椅' }}
          </button>
        </div>

        <!-- Basement chair selector in chair mode -->
        <div v-if="rangeState.mode === 'chair' && basementCount > 0" class="tac-opts">
          <button
            type="button"
            class="gbtn fr cut sm"
            :class="{ on: Boolean(rangeState.origin?.isBasement) }"
            data-test="toggle-range-basement"
            @click="emit('range-toggle-basement')"
          >
            地下室椅
          </button>
          <span class="vp-cyc tac-cyc-pill">
            <button type="button" class="gbtn fr cut sm" data-test="btn-range-basement-prev" @click="emit('cycle-basement', -1)">‹</button>
            <span class="num">地下室 {{ (board.chairBasementIndex % basementCount) + 1 }}/{{ basementCount }}</span>
            <button type="button" class="gbtn fr cut sm" data-test="btn-range-basement-next" @click="emit('cycle-basement', 1)">›</button>
          </span>
        </div>

        <div class="tac-opts">
          <button
            class="gbtn fr cut sm"
            :class="{ on: rangeState.armed }"
            data-test="btn-range-pick"
            @click="emit('range-pick-arm')"
          >
            {{ rangeState.armed ? '点图中椅/点…' : '重新点选' }}
          </button>
          <button class="gbtn fr cut sm" data-test="btn-range-clear" @click="emit('range-clear')">清除</button>
          <span class="tac-origin-pill">
            {{ rangeState.origin ? rangeState.origin.label : '尚未选定起点/狂欢之椅' }}
            <template v-if="rangeComputing"> · 网格计算中…</template>
          </span>
        </div>
      </div>

      <!-- Carry settings -->
      <div v-if="rangeState.scenario === 'carry'" class="tac-workbook-box tac-range-cfg">
        <div class="tac-field-row">
          <label class="tac-field-lbl">求生者</label>
          <select v-model="rangeState.survivorId" class="sel" data-test="carry-survivor-select">
            <option value="ordinary">普通求生者</option>
            <option value="forward">前锋 (+{{ Math.round(CARRY_SURVIVORS.forward.struggleBonus * 100) }}%)</option>
          </select>
        </div>
        <div class="tac-buff-row">
          <label class="tac-field-lbl">监管者</label>
          <select class="sel" :value="rangeState.hunterKey" @change="onCarryHunterSelect(($event.target as HTMLSelectElement).value)">
            <option v-for="h in Object.values(TAC_HUNTER_ROLES)" :key="h.key" :value="h.key" :disabled="h.speed == null">{{ h.name }}</option>
            <option value="custom">自定义</option>
          </select>
          <input
            v-model.number="rangeState.carryBaseSpeed"
            type="number"
            step="0.05"
            min="0.5"
            class="tac-num-in"
            data-test="carry-hunter-speed"
          />
        </div>
        <div class="tac-opts tac-slider-row">
          <label class="rng tac-rng">
            初始挣扎
            <input v-model.number="rangeState.initialProgress" type="range" min="0" max="95" step="1" data-test="carry-initial-progress" />
            <span class="num">{{ rangeState.initialProgress }}%</span>
          </label>
          <label class="tac-unit-field">
            <span>牵起(s)</span>
            <input v-model.number="rangeState.pickupSeconds" type="number" step="0.1" min="0" max="10" class="tac-num-in" data-test="carry-pickup-s" />
          </label>
        </div>
        <div class="tac-buff-row">
          <select v-model="selectedCarryTalent" class="sel" data-test="select-carry-talent">
            <option v-for="ct in carryTalentOptions" :key="ct.key" :value="ct.key">{{ ct.name }}</option>
          </select>
          <select v-model.number="selectedCarryLevel" class="sel tac-lv-sel">
            <option :value="1">1层</option>
            <option :value="2">2层</option>
            <option :value="3">3层</option>
          </select>
          <button class="gbtn fr cut sm" data-test="btn-add-carry-talent" @click="addCarryTalent">+ 天赋</button>
        </div>
        <div v-if="rangeState.carryBuffs.length" class="tac-list">
          <div v-for="b in rangeState.carryBuffs" :key="b.id" class="tac-list-row">
            <span>{{ carryTalentOptions.find((x) => x.key === b.key)?.name ?? b.key }} {{ b.level }}层</span>
            <button class="gbtn fr cut sm red" @click="rangeState.carryBuffs = rangeState.carryBuffs.filter((x) => x.id !== b.id)">×</button>
          </div>
        </div>
      </div>

      <!-- Tide settings -->
      <div v-else class="tac-workbook-box tac-range-cfg">
        <div class="tac-buff-row">
          <label class="tac-field-lbl">求生移速</label>
          <input
            v-model.number="rangeState.tideBase.speed"
            type="number"
            step="0.05"
            min="0.5"
            class="tac-num-in"
            data-test="tide-base-speed"
          />
          <span class="tac-unit-txt">m/s</span>
        </div>
        <div class="tac-buff-row">
          <select v-model="selectedTideTalent" class="sel">
            <option v-for="tt in tideTalentList" :key="tt.key" :value="tt.key">{{ tt.name }}</option>
          </select>
          <button class="gbtn fr cut sm" data-test="btn-add-tide-talent" @click="addTideTalentBuff">+ 加成</button>
        </div>
        <div v-if="rangeState.tideBuffs.length" class="tac-list">
          <div v-for="b in rangeState.tideBuffs" :key="b.id ?? b.name" class="tac-list-row">
            <span>{{ b.name }}</span>
            <button class="gbtn fr cut sm red" @click="rangeState.tideBuffs = rangeState.tideBuffs.filter((x) => x.id !== b.id)">×</button>
          </div>
        </div>
      </div>

      <!-- Band opacity, ring & label toggles -->
      <div class="tac-workbook-box">
        <div class="tac-opts tac-slider-row">
          <label class="rng tac-rng">
            色带透明
            <input v-model.number="rangeState.opacity" type="range" min="0.1" max="1" step="0.05" />
            <span class="num">{{ Math.round(rangeState.opacity * 100) }}%</span>
          </label>
          <label class="tac-chk">
            <input v-model="rangeState.hideRing" type="checkbox" />
            隐藏选中圈
          </label>
          <label class="tac-chk">
            <input v-model="rangeState.hideRingLabel" type="checkbox" data-test="toggle-range-hide-label" />
            隐藏标注
          </label>
        </div>

        <div class="tac-band-legend" data-test="range-legend">
          <button
            v-for="(lbl, idx) in (rangeState.scenario === 'tide' ? TIDE_BAND_LABELS_ZH : CARRY_BAND_LABELS_ZH)"
            :key="idx"
            type="button"
            class="tac-band-btn"
            :class="{ off: rangeState.hiddenBands.includes(idx) }"
            :data-band="idx"
            @click="toggleRangeBand(idx)"
          >
            <span class="sw" :style="{ background: (rangeState.scenario === 'tide' ? TIDE_BAND_COLORS : CARRY_BAND_COLORS)[idx] }"></span>
            {{ lbl }}
          </button>
        </div>
      </div>

      <p v-if="rangeEval" class="tac-status-banner" data-test="range-summary">{{ rangeEval.summaryText }}</p>

      <div v-if="rangeEval && rangeEval.chairRows.length" class="tac-table-wrap" data-test="range-chair-table">
        <table class="dt">
          <thead>
            <tr>
              <th>狂欢之椅</th>
              <th>距离</th>
              <th>用时</th>
              <th>判定</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, rIdx) in rangeEval.chairRows.slice(0, 14)"
              :key="rIdx"
              class="click"
              :class="{ cur: rangeState.detailMarkIndex === rIdx }"
              data-chair-row
              @click="rangeState.detailMarkIndex = rangeState.detailMarkIndex === rIdx ? null : rIdx"
            >
              <td>{{ row.label ?? `椅 #${row.index + 1}` }}</td>
              <td class="num">{{ Number.isFinite(row.distanceM) ? `${row.distanceM.toFixed(1)}m` : '不可达' }}</td>
              <td class="num">{{ Number.isFinite(row.travelSeconds) ? `${row.travelSeconds.toFixed(1)}s` : '—' }}</td>
              <td>
                <template v-if="rangeEval.scenario === 'carry'">
                  {{ (row as CarryChairEval).canHang ? ((row as CarryChairEval).risk ? '压线风险' : `可放${(row as CarryChairEval).drops ?? 0}次`) : '挣脱' }}
                </template>
                <template v-else>
                  {{ (row as TideChairEval).reachable20s ? '20s可达' : (row as TideChairEval).inMargin ? '21s余量' : '超时' }}
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ANIM TOOL -->
    <div v-else-if="activeTool === 'anim'" class="tac-sec" data-test="tool-panel-anim">
      <div class="tac-workbook-box">
        <div class="tac-sub-head">选择造物设置轨迹</div>
        <div class="tac-chip-grid">
          <button
            v-for="tk in board.tokens"
            :key="`at-${tk.tid}`"
            class="gbtn fr cut sm"
            :class="{ on: selection?.type === 'token' && selection.tid === tk.tid }"
            @click="selectCreation({ type: 'token', tid: tk.tid })"
          >
            {{ tokenDisplayName(tk) }}
          </button>
          <button
            v-for="it in board.items"
            :key="`ai-${it.iid}`"
            class="gbtn fr cut sm"
            :class="{ on: selection?.type === 'prop' && selection.iid === it.iid }"
            @click="selectCreation({ type: 'prop', iid: it.iid })"
          >
            {{ propDisplayName(it) }}
          </button>
        </div>

        <!-- Auto-routing & speed preset controls -->
        <div class="tac-opts tac-chk-strip">
          <label class="tac-chk">
            <input
              type="checkbox"
              :checked="animAutoRoute"
              data-test="toggle-anim-autoroute"
              @change="emit('update:animAutoRoute', ($event.target as HTMLInputElement).checked)"
            />
            自动规划最优路线
          </label>
          <label class="tac-chk">
            <input
              type="checkbox"
              :checked="animVault"
              data-test="toggle-anim-vault"
              @change="emit('update:animVault', ($event.target as HTMLInputElement).checked)"
            />
            允许翻窗
          </label>
        </div>

        <div class="tac-buff-row">
          <span class="tac-field-lbl">移速预设</span>
          <select
            class="sel"
            :value="animSpeedPresetKey"
            data-test="anim-speed-preset"
            @change="onAnimPresetSelect(($event.target as HTMLSelectElement).value)"
          >
            <optgroup v-for="[grpName, entries] in animPresetGroups" :key="grpName" :label="grpName">
              <option v-for="p in entries" :key="p.key" :value="p.key">
                {{ p.name }} ({{ p.speed.toFixed(2) }} m/s)
              </option>
            </optgroup>
          </select>
        </div>
      </div>

      <div v-if="animTarget" class="tac-workbook-box">
        <div class="tac-opts">
          <button
            class="gbtn fr cut sm"
            :class="{ on: animArmed }"
            data-test="btn-anim-arm"
            @click="emit('update:animArmed', !animArmed)"
          >
            {{ animArmed ? '点击地图加点中…' : '添加路径点' }}
          </button>
          <button
            v-if="animTarget.anim"
            class="gbtn fr cut sm"
            :class="{ on: animTarget.anim.mode === 'time' }"
            data-test="btn-anim-mode-time"
            @click="switchAnimMode('time')"
          >
            按时刻
          </button>
          <button
            v-if="animTarget.anim"
            class="gbtn fr cut sm"
            :class="{ on: animTarget.anim.mode === 'speed' }"
            data-test="btn-anim-mode-speed"
            @click="switchAnimMode('speed')"
          >
            按移速
          </button>
          <button
            v-if="animTarget.anim && animTarget.anim.points.length >= 2"
            type="button"
            class="gbtn fr cut sm"
            data-test="btn-anim-route-all"
            @click="emit('anim-recompute-all')"
          >
            重算绕障
          </button>
        </div>

        <div v-if="animTarget.anim?.points?.length" class="tac-list" data-test="anim-waypoint-list">
          <div v-for="(pt, idx) in animTarget.anim.points" :key="idx" class="tac-list-row">
            <span class="num tac-wp-idx">#{{ idx + 1 }}</span>
            <span v-if="idx > 0 && animTarget.anim.paths?.[idx - 1]?.length" class="tac-routed-pill">绕障</span>
            <template v-if="animTarget.anim.mode === 'time'">
              <input
                type="number"
                class="tac-num-in"
                min="0"
                step="0.5"
                :value="animTarget.anim.times?.[idx] ?? 0"
                :data-anim-time="idx"
                @change="updateAnimPointTime(idx, Number(($event.target as HTMLInputElement).value))"
              />
              <span class="muted">s</span>
              <span v-if="idx > 0 && animTargetSegs[idx - 1]?.avgSpeed != null" class="num muted">
                {{ animTargetSegs[idx - 1]!.avgSpeed!.toFixed(2) }}m/s
              </span>
            </template>
            <template v-else-if="idx > 0">
              <input
                type="number"
                class="tac-num-in"
                min="0.1"
                step="0.1"
                :value="(animTarget.anim.speeds?.[idx - 1]?.speed ?? 3.8).toFixed(2)"
                :data-anim-speed="idx - 1"
                @change="updateAnimSegSpeed(idx - 1, Number(($event.target as HTMLInputElement).value))"
              />
              <span class="muted">m/s</span>
              <span v-if="animTargetSegs[idx - 1]" class="num muted">{{ animTargetSegs[idx - 1]!.t1.toFixed(1) }}s</span>
            </template>
            <span v-else class="muted">起点 (0.0s)</span>
            <button
              v-if="animTarget.anim.points.length > 1"
              class="gbtn fr cut sm red"
              @click="removeAnimPoint(idx)"
            >
              ×
            </button>
          </div>
        </div>
        <p v-else class="tac-hint-bar">点击沙盘添加第 1 个路径点（将自动以当前位置为起点）。</p>

        <div class="tac-opts">
          <button
            class="gbtn fr cut sm"
            :class="{ on: animSinglePlaying }"
            data-test="btn-anim-play-single"
            :disabled="!animTarget.anim || animTarget.anim.points.length < 2 || animTargetTotal <= 0"
            @click="emit('toggle-anim-single')"
          >
            {{ animSinglePlaying ? '⏹ 停止' : '▶ 播放' }}
          </button>
          <button class="gbtn fr cut sm" data-test="btn-anim-reset-single" @click="emit('reset-anim-single')">⟲ 归零</button>
          <button class="gbtn fr cut sm red" data-test="btn-anim-clear" @click="emit('clear-anim')">清除动画</button>
          <span class="num tac-metric-accent" style="margin-left: auto">总 {{ animTargetTotal.toFixed(1) }}s</span>
        </div>
      </div>
      <p v-else class="empty">请先选中画板上的角色或道具以编辑路径动画</p>
    </div>
  </div>
</template>
