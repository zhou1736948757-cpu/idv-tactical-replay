<script setup lang="ts">
import ManorOrnaments from './tactical/ManorOrnaments.vue';
import { computed, nextTick, ref } from 'vue';
import {
  classifyFloor,
  formatCrossFloorBadge,
  measureTacticalDistance,
  sampleChairAtTime,
  sampleCipherAtTime,
  sampleGateAtTime,
  samplePalletAtTime,
  samplePlayerAtTime,
  type MatchAnalyticsPayload,
  type Replay2DPayload,
  type RulerState,
  type StaticSceneEntity,
} from '@idv/replay-renderer';
import {
  TAC_ITEM_TYPES,
  TAC_ROLES,
  cipherOf,
  type CipherPoint,
  type EndgameScenarioKind,
  type TacticalBoardState,
} from '@/tactical';
import {
  propDisplayName,
  resolvePropRangeCircles,
  resolveTokenRangeCircles,
  tokenCamp,
  tokenDisplayName,
  type BoardGeoContext,
  type BoardProp,
  type BoardSelection,
  type BoardToken,
} from '@/lib/board';
import {
  campLabel,
  fearStateLabel,
  fmtNum,
  formatClock,
  pidLabel,
  playerName,
  talentLabel,
} from '@/lib/format';

const props = defineProps<{
  payload: Replay2DPayload | null;
  analytics: MatchAnalyticsPayload | null;
  t: number;
  selectedUid: number | null;
  ruler: RulerState | null;
  isStandalone: boolean;
  geo: BoardGeoContext;
  cipherGroupIndex: number;
  board: TacticalBoardState;
  selection: BoardSelection;
}>();

const emit = defineEmits<{
  (e: 'inspect-player', uid: number): void;
  (e: 'clear-selection'): void;
  (e: 'delete-tac'): void;
  (e: 'focus-tools'): void;
  (e: 'focus-place'): void;
  (e: 'quick-opening'): void;
  (e: 'quick-endgame', variant: EndgameScenarioKind): void;
}>();

// ------------------------------------------------------------------ replay status
const ciphers = computed(() => {
  if (!props.payload) return [];
  return props.payload.entities.ciphers.map((c) => ({
    uid: c.uid,
    floor: c.floor,
    ...sampleCipherAtTime(c, props.t),
  }));
});
const ciphersDone = computed(() => ciphers.value.filter((c) => c.isCompleted).length);
const phaseNow = computed(() =>
  props.analytics?.phases.find((p) => props.t >= p.start_t && props.t < p.end_t) ??
  props.analytics?.phases.at(-1) ??
  null,
);
const hunter = computed(() => props.payload?.players.find((p) => p.camp === 1) ?? null);

const inspector = ref<HTMLElement>();
async function inspectPlayer(uid: number) {
  emit('inspect-player', uid);
  await nextTick();
  inspector.value?.scrollIntoView?.({ block: 'nearest' });
}
const survivors = computed(() => props.payload?.players.filter(p => p.camp === 2) ?? []);

type CameoKind = 'hunter' | 'surv-1' | 'surv-2' | 'surv-3' | 'surv-4' | 'neutral';

const CAMEO_PATHS: Readonly<Record<CameoKind, string>> = Object.freeze({
  // Victorian tall stovepipe top-hat & high-collared cape (Hunter)
  hunter: 'M18 8h12l-1 9h4.5v2.4H14.5V17H19l-1-9Zm.5 11.4c-.5 4.2 1.2 7.5 3.6 8.5l-.4 2.4c-5.8 1.4-9.5 4.3-11.2 8.7h27c-1.7-4.4-5.4-7.3-11.2-8.7l-.4-2.4c2.4-1 4.1-4.3 3.6-8.5H18.5Z',
  // Wide-brimmed garden bonnet & wavy bob silhouette (Survivor 1)
  'surv-1': 'M11 18c2-4.8 7.4-7.5 13-7.5s11 2.7 13 7.5c-2.6 1-5.2 1.4-7.6 1.2.4 2.6-.5 5.4-2.2 6.8l.4 3.2c4.4 1.3 7.6 4.4 9 9.8H11.4c1.4-5.4 4.6-8.5 9-9.8l.4-3.2c-1.7-1.4-2.6-4.2-2.2-6.8-2.4.2-5-.2-7.6-1.2Z',
  // High chignon bun & pleated Victorian nurse cap profile (Survivor 2)
  'surv-2': 'M21 9.2c1.2-1.8 4.8-1.8 6 0l3.2 2.4c1.4 1.6 1.8 4 1.2 6.4 1.4.4 2 1.8 1.2 3.1-.7 1.1-1.9 1.3-2.9 1.2-.5 2.4-1.8 4.4-3.6 5.4v2.6c4.9 1.3 8.5 4.2 10.2 8.7H11.7c1.7-4.5 5.3-7.4 10.2-8.7v-2.6c-2.2-1.2-3.7-3.8-3.9-7.1-.2-3.7 1-7.4 3-11.4Z',
  // Draped Victorian hooded cowl & mantle silhouette (Survivor 3)
  'surv-3': 'M24 8.5c5.8 0 10.2 4.6 10.6 11.4.3 4.8 1.5 9.2 4.1 19.1H9.3c2.6-9.9 3.8-14.3 4.1-19.1C13.8 13.1 18.2 8.5 24 8.5Zm0 5.4c-3.1 0-5.4 2.9-5.4 6.6 0 3.4 2 6.2 4.7 6.8l.7.1.7-.1c2.7-.6 4.7-3.4 4.7-6.8 0-3.7-2.3-6.6-5.4-6.6Z',
  // Peaked flat cap & upturned detective collar silhouette (Survivor 4)
  'surv-4': 'M15 15.2c1.4-4 5.2-6.2 9.8-6.2 4.4 0 8.2 2 9.4 5.4l4.3 1.4-.7 2.2-5.4-.4c-.1 3.7-1.7 6.9-4.1 8.4l.4 3.2c4.8 1.5 8.1 4.6 9.6 9.8H10.5c1.5-5.2 4.8-8.3 9.6-9.8l.4-3.2c-2.2-1.4-3.7-4.3-4-7.7-.9-.7-1.7-1.9-1.5-3.1Z',
  // Neutral embossed classical bust fallback (unknown / missing PID)
  neutral: 'M24 11.5a6.6 6.6 0 1 1 0 13.2 6.6 6.6 0 0 1 0-13.2Zm0 15.8c6.7 0 11.7 3.6 13.2 11.7H10.8c1.5-8.1 6.5-11.7 13.2-11.7Z',
});

function cameoFor(
  player: { camp: 1 | 2; pid?: number | null; player_name?: string | null } | null | undefined,
  slotIndex = 0,
): CameoKind {
  if (!player || player.pid === null || player.pid === undefined || player.pid < 0 || !player.player_name?.trim()) {
    return 'neutral';
  }
  if (player.camp === 1) return 'hunter';
  const kinds: readonly CameoKind[] = ['surv-1', 'surv-2', 'surv-3', 'surv-4'];
  return kinds[slotIndex % 4]!;
}

const hunterCameo = computed<CameoKind>(() => cameoFor(hunter.value, 0));
const matchSerialFull = computed(() => props.payload?.match.match_id ?? '');
const outcome = computed(() => {
  const label = props.payload?.match.result_label;
  if (label === '监管胜') return { kind: 'win', zh: '胜利', en: 'Win' } as const;
  if (label === '监管负') return { kind: 'lose', zh: '失败', en: 'Lose' } as const;
  if (label === '平局' || label === '监管平') return { kind: 'neutral', zh: '平局', en: 'Tie' } as const;
  if (label?.includes('人机')) return { kind: 'neutral', zh: '人机', en: 'Bot' } as const;
  return { kind: 'neutral', zh: '未定', en: 'N/A' } as const;
});
const firstEvents = computed(() => {
  const metrics = props.analytics?.match_id === props.payload?.match.match_id ? props.analytics?.hunter_metrics : null;
  if (!metrics) return props.payload?.markers.filter(m => m.t <= props.t).slice(0, 3) ?? [];
  return [
    { type: 'chase', label_zh: '首追', t: metrics.first_chase_t },
    { type: 'hit', label_zh: '首次命中', t: metrics.first_hit_t },
    { type: 'down', label_zh: '首次击倒', t: metrics.first_down_t },
  ].filter((m): m is { type: string; label_zh: string; t: number } => m.t != null && m.t <= props.t);
});
const chairsNow = computed(() => {
  if (!props.payload) return [];
  return props.payload.entities.chairs
    .map((c) => ({ chair: c, s: sampleChairAtTime(c, props.t) }))
    .filter((x) => x.s.isOccupied);
});
const hangsSoFar = computed(() => {
  if (!props.payload) return 0;
  return props.payload.entities.chairs.reduce(
    (n, c) => n + c.hang_intervals.filter((h) => h.start_t <= props.t).length,
    0,
  );
});

// ------------------------------------------------------------------ standalone summary
const cipherGroupCount = computed(() => props.geo.mapData.cipherCombinations.length);
const activeCipherGroup = computed<CipherPoint[]>(() => {
  const groups = props.geo.mapData.cipherCombinations;
  if (!groups.length) return [];
  const idx = Math.max(0, Math.min(groups.length - 1, props.cipherGroupIndex));
  const ids = groups[idx] ?? [];
  return ids
    .map((cid) => cipherOf(props.geo.mapId, cid))
    .filter((c): c is CipherPoint => Boolean(c));
});
const activeCipherHint = computed(() => {
  const md = props.geo.mapData;
  const idx = props.cipherGroupIndex;
  return md.hints?.[idx] ?? md.fixedHint ?? '';
});

// ------------------------------------------------------------------ inspector (replay & tactical)
type Inspected =
  | { kind: 'player'; title: string; rows: Array<[string, string]>; talents: string[]; hunterTalents: boolean; camp: 1 | 2 }
  | { kind: 'static'; title: string; rows: Array<[string, string]> }
  | { kind: 'tac'; title: string; rows: Array<[string, string]>; badges: string[] }
  | null;

function vec(p: readonly number[]): string {
  return `(${fmtNum(p[0], 1)}, ${fmtNum(p[1], 1)}, ${fmtNum(p[2], 1)})`;
}

function findStatic(uid: number): { kind: string; e: StaticSceneEntity } | null {
  if (!props.payload) return null;
  const E = props.payload.entities;
  const lists: Array<[string, readonly StaticSceneEntity[]]> = [
    ['密码机', E.ciphers],
    ['狂欢之椅', E.chairs],
    ['木板', E.pallets],
    ['窗户', E.windows],
    ['大门', E.exit_gates],
    ['箱子', E.chests],
    ['地窖', E.hatch ? [E.hatch] : []],
  ];
  for (const [kind, list] of lists) {
    const e = list.find((x) => x.uid === uid);
    if (e) return { kind, e };
  }
  return null;
}

function inspectTacticalSelection(sel: NonNullable<BoardSelection>): Inspected {
  const wM = props.geo.effectiveWidthM;
  if (sel.type === 'token') {
    const tk = props.board.tokens.find((x) => x.tid === sel.tid) as BoardToken | undefined;
    if (!tk) return null;
    const camp = tokenCamp(tk);
    const def = TAC_ROLES[tk.role];
    const circles = resolveTokenRangeCircles(tk, wM);
    const rows: Array<[string, string]> = [
      ['阵营', camp === 'hunter' ? '监管者' : '求生者'],
      ['角色', def?.name ?? tk.role],
      ['坐标', `(${(tk.x * 100).toFixed(1)}%, ${(tk.y * 100).toFixed(1)}%)`],
      ['轨迹点', `${tk.anim?.points?.length ?? 0} 个`],
    ];
    if (tk.label) rows.push(['备注', tk.label]);
    const badges = circles.map((c) => `${c.label} ${c.radiusM.toFixed(1)}m`);
    return { kind: 'tac', title: tokenDisplayName(tk), rows, badges };
  }
  if (sel.type === 'prop') {
    const pr = props.board.items.find((x) => x.iid === sel.iid) as BoardProp | undefined;
    if (!pr) return null;
    const def = TAC_ITEM_TYPES[pr.kind];
    const circles = resolvePropRangeCircles(pr, wM);
    const rows: Array<[string, string]> = [
      ['道具', def?.name ?? pr.kind],
      ['所属', TAC_ROLES[pr.role ?? '']?.name ?? pr.role ?? '通用'],
      ['坐标', `(${(pr.x * 100).toFixed(1)}%, ${(pr.y * 100).toFixed(1)}%)`],
    ];
    if (pr.linkTid) rows.push(['绑定棋子', `#${pr.linkTid}`]);
    const badges = circles.map((c) => `${c.label} ${c.radiusM.toFixed(1)}m`);
    return { kind: 'tac', title: propDisplayName(pr), rows, badges };
  }
  if (sel.type === 'text') {
    const tx = props.board.texts.find((x) => x.id === sel.id);
    if (!tx) return null;
    return {
      kind: 'tac',
      title: `文本标注 #${tx.id}`,
      rows: [
        ['内容', tx.text || '—'],
        ['坐标', `(${(tx.x * 100).toFixed(1)}%, ${(tx.y * 100).toFixed(1)}%)`],
        ['字号', `${tx.fontSize ?? 14}px`],
      ],
      badges: [],
    };
  }
  if (sel.type === 'shape') {
    const sh = props.board.shapes.find((x) => x.id === sel.id);
    if (!sh) return null;
    const kindNames: Record<string, string> = {
      arrow: '箭头',
      line: '直线',
      circle: '虚线圆',
      rect: '虚线框',
      freehand: '画笔',
    };
    return {
      kind: 'tac',
      title: `${kindNames[sh.kind] ?? sh.kind} #${sh.id}`,
      rows: [
        ['起点', `(${(sh.x1 * 100).toFixed(1)}%, ${(sh.y1 * 100).toFixed(1)}%)`],
        ['颜色 / 线宽', `${sh.color ?? '#c9a25f'} / ${sh.width ?? 2}px`],
      ],
      badges: [],
    };
  }
  if (sel.type === 'measure') {
    const ml = props.board.measures.find((x) => x.id === sel.id);
    if (!ml) return null;
    const segM = props.geo.distMeters({ x: ml.x1, y: ml.y1 }, { x: ml.x2, y: ml.y2 });
    return {
      kind: 'tac',
      title: `测算线段 #${ml.id}`,
      rows: [
        ['线段长', `${segM.toFixed(2)} m`],
        ['折线组', ml.chain !== null ? `#${ml.chain}` : '单段'],
      ],
      badges: [],
    };
  }
  return null;
}

const inspected = computed<Inspected>(() => {
  if (props.selection) {
    const tac = inspectTacticalSelection(props.selection);
    if (tac) return tac;
  }
  const uid = props.selectedUid;
  if (uid === null || !props.payload) return null;
  const pl = props.payload.players.find((p) => p.uid === uid);
  if (pl) {
    const s = samplePlayerAtTime(props.payload.trajectories?.[String(uid)], props.t);
    const rows: Array<[string, string]> = [
      ['阵营', campLabel(pl.camp)],
      ['角色', pidLabel(pl.pid)],
      ['坐标', s ? vec(s.pos) : '—'],
      ['楼层', s ? classifyFloor(s.pos[1]) : '—'],
      ['速度', s ? `${fmtNum(s.speed, 1)} u/s` : '—'],
      ['视角 cam_yaw', s && s.camYawDeg !== null ? `${fmtNum(s.camYawDeg, 0)}°` : '—'],
    ];
    if (pl.camp === 2) rows.push(['状态', s ? fearStateLabel(s.fearState) : '—'], ['结局', pl.res_label || '—']);
    else rows.push(['辅助技能', pl.support_skill_ids.length ? pl.support_skill_ids.map((id) => `#${id}`).join(' ') : '—']);
    if (pl.is_bot) rows.push(['类型', '人机']);
    return {
      kind: 'player',
      camp: pl.camp,
      title: pl.player_name,
      rows,
      talents: pl.talents.map((tl) => `${talentLabel(pl.camp, tl)}${tl.level > 1 ? ` ×${tl.level}` : ''}`),
      hunterTalents: pl.camp === 1,
    };
  }
  const st = findStatic(uid);
  if (!st) return null;
  const rows: Array<[string, string]> = [
    ['UID', String(st.e.uid)],
    ['坐标', vec(st.e.pos)],
    ['楼层', st.e.floor],
  ];
  const E = props.payload.entities;
  const cph = E.ciphers.find((c) => c.uid === uid);
  if (cph) {
    const s = sampleCipherAtTime(cph, props.t);
    rows.push(
      ['进度', `${fmtNum(s.progressPct, 0)}%`],
      ['破译人数', String(s.activeFixerCount)],
      ['完成于', cph.completed_at !== null ? formatClock(cph.completed_at, true) : '未完成'],
    );
  }
  const pal = E.pallets.find((p) => p.uid === uid);
  if (pal) rows.push(['状态', { upright: '竖立', dropped: '已放下', broken: '已踩碎' }[samplePalletAtTime(pal, props.t)]]);
  const ch = E.chairs.find((c) => c.uid === uid);
  if (ch) {
    const s = sampleChairAtTime(ch, props.t);
    rows.push(
      ['地下室', ch.is_basement ? '是 (B1)' : '否'],
      ['状态', s.isOccupied ? `${playerName(props.payload.players, s.victimUid)} ${fmtNum(s.eliminationPct, 0)}%` : '空闲'],
      ['累计上椅', String(ch.hang_intervals.length)],
    );
  }
  const gate = E.exit_gates.find((g) => g.uid === uid);
  if (gate) rows.push(['状态', { unpowered: '未通电', powered: '已通电', opened: '已开启' }[sampleGateAtTime(gate, props.t)]]);
  return { kind: 'static', title: `${st.kind} #${uid}`, rows };
});

// ------------------------------------------------------------------ ruler
const rulerReadout = computed(() => {
  if (!props.ruler) return null;
  const m = measureTacticalDistance(props.ruler.a, props.ruler.b);
  return { m, badge: formatCrossFloorBadge(m) };
});
</script>

<template>
  <div id="dossier" class="dark fr cut">
    <template v-if="!isStandalone && payload">
      <section class="case-overview">
        <div class="ribbon-track">
          <h3 class="ribbon-h">案件概览 <small>Case Overview</small></h3>
        </div>
        <div class="overview-body">
          <dl class="case-facts">
            <dt><span class="fact-ico" aria-hidden="true">⌖</span>对局模式</dt><dd>{{ payload.match.mode_name || '未知' }}</dd>
            <dt><span class="fact-ico" aria-hidden="true">◷</span>对局时长</dt><dd class="num">{{ formatClock(payload.match.duration_s) }}</dd>
            <dt><span class="fact-ico" aria-hidden="true">⚑</span>对局结果</dt><dd class="verdict" :class="outcome.kind">{{ payload.match.result_label || '未知' }}</dd>
            <dt><span class="fact-ico" aria-hidden="true">☷</span>存档时间</dt><dd class="num file-date-val">{{ payload.match.save_time_utc8 || '未知' }}</dd>
          </dl>
        </div>
      </section>
      <section class="case-lineup">
        <div class="ribbon-track">
          <h3 class="ribbon-h">双方阵容 <small>Lineup</small></h3>
        </div>
        <div class="team-label hunter-banner">
          <span class="team-ico" aria-hidden="true">♛</span>监管者 <i>Hunter</i><span class="num">{{ hunter ? '1/1' : '0/1' }}</span>
        </div>
        <button
          v-if="hunter"
          type="button"
          class="hunter-entry"
          :class="{ active: selectedUid === hunter.uid }"
          @click="inspectPlayer(hunter.uid)"
        >
          <svg class="cameo hunter-cameo" :data-cameo="hunterCameo" aria-hidden="true" viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="21.5" fill="#f1e1c1" :stroke="hunterCameo === 'neutral' ? '#8c724d' : '#8b2d30'" stroke-width="2.2" />
            <circle cx="24" cy="24" r="18.5" fill="none" stroke="#b99660" stroke-width="1" />
            <path :fill="hunterCameo === 'neutral' ? '#5a4835' : '#7b2528'" :d="CAMEO_PATHS[hunterCameo]" />
          </svg>
          <span class="hunter-meta">
            <small>监管者 · Hunter</small>
            <strong>{{ hunter.player_name || '未知监管者' }}</strong>
            <span class="pid-tag num">{{ pidLabel(hunter.pid) }}</span>
          </span>
          <ManorOrnaments :kind="outcome.kind" :label-pair="outcome" />
        </button>
        <div v-else class="hunter-entry empty-entry">
          <svg class="cameo" data-cameo="neutral" aria-hidden="true" viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="21.5" fill="#ede0c3" stroke="#8c724d" stroke-width="2" />
            <circle cx="24" cy="24" r="18.5" fill="none" stroke="#b99660" stroke-width="1" />
            <path fill="#5a4835" :d="CAMEO_PATHS.neutral" />
          </svg>
          <span class="hunter-meta"><small>监管者 · Hunter</small><strong>暂无监管者数据</strong></span>
        </div>
        <div class="team-label surv-banner">
          <span class="team-ico" aria-hidden="true">❖</span>求生者 <i>Survivors</i><span class="num">{{ survivors.length }}/4</span>
        </div>
        <div v-if="survivors.length" class="roster-grid">
          <button
            v-for="(player, index) in survivors"
            :key="player.uid"
            type="button"
            class="cameo-card"
            :class="{ active: selectedUid === player.uid }"
            :title="`${player.player_name} · ${pidLabel(player.pid)}`"
            @click="inspectPlayer(player.uid)"
          >
            <span class="cameo-wrap">
              <svg class="cameo" :data-cameo="cameoFor(player, index)" aria-hidden="true" viewBox="0 0 48 48">
                <circle cx="24" cy="24" r="21.5" fill="#f0e1c2" :stroke="cameoFor(player, index) === 'neutral' ? '#8c724d' : '#2f5370'" stroke-width="2.1" />
                <circle cx="24" cy="24" r="18.5" fill="none" stroke="#b99660" stroke-width="1" />
                <path :fill="cameoFor(player, index) === 'neutral' ? '#5a4835' : '#24425c'" :d="CAMEO_PATHS[cameoFor(player, index)]" />
              </svg>
              <em class="cameo-idx num">{{ index + 1 }}</em>
            </span>
            <strong>{{ player.player_name || `求生者 ${index + 1}` }}</strong>
            <span class="pid-tag num">{{ pidLabel(player.pid) }}</span>
          </button>
        </div>
        <div v-else class="empty-roster">
          <svg class="cameo" data-cameo="neutral" aria-hidden="true" viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="21.5" fill="#ede0c3" stroke="#8c724d" stroke-width="2" />
            <path fill="#5a4835" :d="CAMEO_PATHS.neutral" />
          </svg>
          <span>暂无求生者阵容记录</span>
        </div>
      </section>
      <section class="case-notes">
        <div class="ribbon-track">
          <h3 class="ribbon-h">战局要点 <small>Tactical Notes</small></h3>
        </div>
        <p v-for="m in firstEvents" :key="m.type + m.t" class="note-row">
          <span class="note-bullet" aria-hidden="true">❖</span>
          <time class="num">{{ formatClock(m.t) }}</time>
          <span>{{ m.label_zh }}</span>
        </p>
        <p v-if="!firstEvents.length" class="muted note-empty">尚无已发生的关键事件。</p>
      </section>

      <section class="telemetry-ledger">
        <div class="k telemetry-k">战术档案 · {{ phaseNow?.label_zh ?? '复盘' }}</div>
        <div id="vMain" class="go">
          <span id="vCell" class="num">{{ formatClock(t) }}</span><i class="vsep"></i>
          <span id="vPct" class="num">{{ ciphersDone }}/{{ ciphers.length }} 密码机</span>
        </div>
        <div id="vBasis">
          监管者 {{ hunter?.player_name ?? '—' }} · {{ pidLabel(hunter?.pid) }}
          <em v-if="chairsNow.length">{{ chairsNow.length }} 人在椅</em>
          <span v-if="matchSerialFull" class="match-id-ref num" :title="`完整对局标识：${matchSerialFull}`">档案 ID {{ matchSerialFull }}</span>
        </div>

        <div class="row">
          <span class="k">密码机</span>
          <div id="ciphers">
            <div
              v-for="(c, i) in ciphers"
              :key="c.uid"
              class="cph"
              :class="{ done: c.isCompleted, act: c.activeFixerCount > 0 && !c.isCompleted }"
              :title="`密码机 #${c.uid} · ${c.floor}`"
            >
              <span class="num">{{ i + 1 }}</span>
              <span class="bar"><i :style="{ width: `${Math.min(100, c.progressPct)}%` }"></i></span>
              <span class="num">{{ c.isCompleted ? '✓' : `${Math.round(c.progressPct)}%` }}</span>
            </div>
          </div>
        </div>

        <div class="row">
          <span class="k">狂欢之椅</span>
          <div class="chairs">
            <div v-for="x in chairsNow" :key="x.chair.uid" class="chairrow" data-test="chair-occupied">
              <span>{{ playerName(payload.players, x.s.victimUid) }}{{ x.chair.is_basement ? ' · 地下室' : '' }}</span>
              <span class="bar"><i :style="{ width: `${x.s.eliminationPct}%` }"></i></span>
              <span class="num">{{ Math.round(x.s.eliminationPct) }}%</span>
            </div>
            <span v-if="!chairsNow.length" class="muted">当前无人上椅 · 累计上椅 {{ hangsSoFar }} 次</span>
          </div>
        </div>
      </section>
    </template>

    <template v-else>
      <section class="telemetry-ledger standalone-ledger">
        <div class="ribbon-track">
          <h3 class="ribbon-h">地图资料 <small>Map Index</small></h3>
        </div>
        <div class="k telemetry-k">白板演算 · 9 图独立沙盘</div>
        <div id="vMain" class="go">
          <span id="vCell" class="num">{{ geo.mapData.mapName }}</span><i class="vsep"></i>
          <span id="vPct" class="num">{{ geo.effectiveWidthM.toFixed(0) }}m · {{ activeCipherGroup.length }} 机</span>
        </div>
        <div id="vBasis">
          棋子 {{ board.tokens.length }} · 道具 {{ board.items.length }} · 测算 {{ board.measures.length }} · 标注 {{ board.shapes.length + board.texts.length }}
        </div>

        <div class="row">
          <span class="k">密码机组合 {{ cipherGroupIndex + 1 }}/{{ Math.max(1, cipherGroupCount) }}</span>
          <div id="ciphers">
            <div v-for="(c, i) in activeCipherGroup" :key="c.id" class="cph" :title="`${c.name} · ${c.feature || '1F'} (${c.location[0]}, ${c.location[1]})`">
              <span class="num">{{ i + 1 }}</span>
              <span class="bar"><i style="width: 100%"></i></span>
              <span class="num">{{ c.name }}</span>
            </div>
          </div>
          <p v-if="activeCipherHint" class="muted cipher-hint">{{ activeCipherHint }}</p>
        </div>

        <div class="row">
          <span class="k">地标概览</span>
          <span class="muted">
            固定椅 {{ geo.mapData.rocketChairs.fixed.length }} · 地下室 {{ Object.keys(geo.mapData.basements).length }} · 地窖 {{ geo.mapData.dungeons.length }} · 大门 {{ geo.mapData.escapeDoors.length }}
          </span>
        </div>

        <div class="row quick-deduce-row" data-test="dossier-quick-scenarios">
          <span class="k">实战推演 · 快速落子</span>
          <div class="quick-deduce-grid">
            <button type="button" class="gbtn fr cut sm on" data-test="btn-dossier-place" @click="emit('focus-place')">
              ＋ 放置角色/道具
            </button>
            <button type="button" class="gbtn fr cut sm" data-test="btn-dossier-opening" @click="emit('quick-opening')">
              一键开局推演
            </button>
            <button type="button" class="gbtn fr cut sm" data-test="btn-dossier-prime" @click="emit('quick-endgame', 'prime-pop')">
              压机残局
            </button>
            <button type="button" class="gbtn fr cut sm" data-test="btn-dossier-rescue" @click="emit('quick-endgame', 'chair-rescue')">
              守椅救人
            </button>
            <button type="button" class="gbtn fr cut sm" data-test="btn-dossier-gate" @click="emit('quick-endgame', 'gate-war')">
              开门战
            </button>
          </div>
        </div>
      </section>
    </template>

    <div ref="inspector" class="row target-inspector" data-test="inspector">
      <span class="k">检视</span>
      <template v-if="inspected">
        <div class="tac-insp-head">
          <b class="insp-title">{{ inspected.title }}</b>
          <div class="tac-row-actions">
            <button v-if="inspected.kind === 'tac'" class="gbtn fr cut sm" data-test="btn-insp-tools" @click="emit('focus-tools')">编辑</button>
            <button v-if="inspected.kind === 'tac'" class="gbtn fr cut sm danger" data-test="btn-insp-del" @click="emit('delete-tac')">删除</button>
            <button class="gbtn fr cut sm" @click="emit('clear-selection')">取消</button>
          </div>
        </div>
        <dl class="kv" style="width: 100%">
          <template v-for="r in inspected.rows" :key="r[0]">
            <dt>{{ r[0] }}</dt>
            <dd class="num">{{ r[1] }}</dd>
          </template>
        </dl>
        <div v-if="inspected.kind === 'player'" class="talents" :class="{ hunter: inspected.hunterTalents }" data-test="talents">
          <span v-for="tl in inspected.talents" :key="tl">{{ tl }}</span>
          <span v-if="!inspected.talents.length">无天赋记录</span>
        </div>
        <div v-if="inspected.kind === 'tac' && inspected.badges.length" class="talents">
          <span v-for="b in inspected.badges" :key="b">{{ b }}</span>
        </div>
      </template>
      <span v-else class="muted">点击沙盘中的角色、道具、电机或标注查看实时参数</span>
    </div>

    <div v-if="rulerReadout" class="row target-inspector" data-test="ruler-readout">
      <span class="k">测距</span>
      <span class="ruler-read num">
        {{ rulerReadout.m.effectiveDistanceU.toFixed(1) }}u · {{ rulerReadout.m.survivorSprintEtaS.toFixed(1) }}s
        <small>平面 {{ rulerReadout.m.planarDistanceU.toFixed(1) }}u · 高差 {{ rulerReadout.m.verticalDeltaU.toFixed(1) }}u · 45 u/s 冲刺</small>
      </span>
      <span v-if="rulerReadout.badge" class="red">{{ rulerReadout.badge }}</span>
    </div>
  </div>
</template>

<style scoped>
#dossier { padding: 0; border: 0; clip-path: none; background: transparent; color: #24160c; }
#dossier::before, #dossier::after { display: none; }

.ribbon-track {
  display: flex;
  align-items: center;
  margin-bottom: 6px;
}
.ribbon-track::after {
  content: "";
  flex: 1;
  height: 1px;
  margin-left: -6px;
  background: linear-gradient(90deg, rgba(162, 122, 66, 0.72), rgba(162, 122, 66, 0.12));
}
/* Preserve exact 286×31px bronze ribbon anchor dimensions from T-018 / D-025 */
#dossier .ribbon-h {
  width: min(286px, 100%);
  min-height: 31px;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 24px 3px 21px;
  color: #fff5e0;
  font: 700 15.5px/1.3 var(--font-cjk);
  flex: none;
}
.ribbon-h small {
  font: italic 600 13.5px/1.1 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
  color: #f8e3b8;
}

.case-overview,
.case-lineup,
.case-notes,
.telemetry-ledger {
  position: relative;
  padding: 8px 13px;
  margin-bottom: 8px;
  background: linear-gradient(180deg, rgba(252, 245, 229, 0.62) 0%, rgba(238, 223, 194, 0.36) 100%);
  border: 1px solid rgba(154, 118, 66, 0.42);
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgba(255, 250, 236, 0.58);
}

.overview-body { display: block; }
.case-facts {
  margin: 0;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 0 14px;
  color: #24160c;
  font-size: 13.5px;
}
.case-facts :is(dd, dt) {
  margin: 0;
  padding: 3px 2px;
  border-bottom: 1px solid rgba(154, 118, 66, 0.3);
}
.case-facts :is(dd:last-of-type, dt:last-of-type) { border-bottom: 0; }
.case-facts dt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #4d351e;
  font-weight: 700;
  white-space: nowrap;
}
.fact-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  color: #6b4720;
  font-size: 13px;
  line-height: 1;
}
.case-facts dd { font-weight: 700; color: #24160c; overflow-wrap: anywhere; }
.case-facts .file-date-val { font-size: 13px; font-weight: 600; color: #3d2b1b; }
.case-facts dd.verdict { color: #7f1f28; font-weight: 700; }
.case-facts dd.verdict.lose { color: #1f4569; }
.case-facts dd.verdict.neutral { color: #4a3219; }

/* Tinted faction sub-banners (chinatown-tactical-dossier.png) */
.team-label {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 4px 0 5px;
  padding: 3px 8px;
  border-radius: 3px;
  font: 700 13px/1.25 var(--font-cjk);
}
.team-label .team-ico { font-size: 12.5px; }
.team-label i {
  font: italic 600 13.5px/1.1 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
}
.team-label span.num { margin-left: auto; font-weight: 700; font-size: 13.5px; }
.team-label.hunter-banner {
  margin-top: 0;
  color: #6d1c24;
  background: linear-gradient(90deg, rgba(168, 62, 68, 0.16) 0%, rgba(168, 62, 68, 0.05) 78%, transparent 100%);
  border-left: 3px solid #8a2c34;
  border-bottom: 1px solid rgba(138, 44, 52, 0.28);
}
.team-label.hunter-banner i { color: #7b222a; }
.team-label.surv-banner {
  margin-top: 7px;
  color: #1b3d5c;
  background: linear-gradient(90deg, rgba(47, 84, 126, 0.16) 0%, rgba(47, 84, 126, 0.05) 78%, transparent 100%);
  border-left: 3px solid #2b5074;
  border-bottom: 1px solid rgba(43, 80, 116, 0.28);
}
.team-label.surv-banner i { color: #204568; }

.hunter-entry {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 10px;
  text-align: left;
  color: #24160c;
  font: 14px/1.25 var(--font-cjk);
  border: 1px solid #a88352;
  border-radius: 4px;
  background: linear-gradient(150deg, #faf1dd 0%, #ead7b3 100%);
  box-shadow: inset 0 0 0 1px rgba(255, 251, 240, 0.72), 0 1px 3px rgba(48, 30, 14, 0.16);
}
.hunter-entry.empty-entry { cursor: default; }
.hunter-meta { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
.hunter-meta small { display: block; color: #7a2228; font-size: 12px; font-weight: 700; }
.hunter-meta strong { display: block; color: #24160c; font-size: 15px; overflow-wrap: anywhere; }
.hunter-meta .pid-tag { font-size: 12px; color: #4a3622; }
.hunter-cameo { width: 40px; height: 40px; flex: none; }
#dossier .hunter-entry .wax-seal { position: static; width: 76px; height: 92px; flex: none; margin: -12px 0 -20px auto; }

.roster-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; }
.cameo-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 5px 3px 4px;
  text-align: center;
  color: #24160c;
  font: 12px/1.2 var(--font-cjk);
  border: 1px solid #a88656;
  border-top: 2.5px solid #2f5578;
  border-radius: 4px;
  background: linear-gradient(180deg, #faf1de 0%, #ead8b5 100%);
  box-shadow: inset 0 0 0 1px rgba(255, 251, 240, 0.72), 0 1px 3px rgba(48, 30, 14, 0.14);
}
.cameo-wrap { position: relative; display: inline-flex; align-items: center; justify-content: center; }
.cameo-card .cameo { width: 36px; height: 36px; display: block; }
.cameo-idx {
  position: absolute;
  right: -4px;
  bottom: -2px;
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  border-radius: 8px;
  background: #1f3d58;
  border: 1px solid #e7cd96;
  color: #fff4dc;
  font: 700 12px/14px var(--font-num, Georgia, serif);
  font-style: normal;
  text-align: center;
}
.cameo-card strong { display: block; width: 100%; font-size: 12px; font-weight: 700; color: #24160c; overflow-wrap: anywhere; }
.cameo-card .pid-tag { display: block; font-size: 12px; color: #1f4364; }
.cameo-card:hover,
.hunter-entry:hover,
.cameo-card.active,
.hunter-entry.active {
  background: linear-gradient(180deg, #fff6e0 0%, #f1deb8 100%);
  border-color: #7c5425;
  box-shadow: 0 0 0 1px #b68c4e inset, 0 2px 6px rgba(48, 30, 14, 0.22);
}
.empty-roster { display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px dashed #9d7d52; color: #473420; font-size: 13px; }
.empty-roster .cameo { width: 36px; height: 36px; flex: none; }

.case-notes .note-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  border-bottom: 1px solid rgba(154, 118, 66, 0.32);
  padding: 5px 4px;
  margin: 0;
  font-size: 13.5px;
  color: #24160c;
}
.case-notes .note-row:last-of-type { border-bottom: 0; }
.case-notes .note-bullet { color: #6d471d; font-size: 12px; flex: none; }
.case-notes time { color: #7d2229; font-weight: 700; min-width: 44px; font-variant-numeric: tabular-nums; flex: none; }
.case-notes .note-empty { margin: 2px 0 0; font-size: 13px; }

/* Antique telemetry slots (vMain, ciphers, chairs, inspector) */
.telemetry-k { margin-bottom: 4px; color: #593b1c; }
#dossier #vCell { color: #5b3812; font: 700 30px/1.08 var(--font-num, Georgia, serif); }
#dossier #vPct { color: #4a3016; font: 700 15px/1.2 var(--font-num, Georgia, serif); }
#dossier #vBasis { color: #4a3520; font-size: 12.5px; }
#dossier #vBasis em { color: #7f1f28; font-weight: 700; }
.match-id-ref { display: block; margin-top: 2px; font-size: 12px; color: #4a3622; overflow-wrap: anywhere; }
.cipher-hint { margin: 4px 0 0; font-size: 12px; }
.quick-deduce-row { flex-direction: column; align-items: stretch; gap: 6px; padding-top: 8px; border-top: 1px dashed rgba(139, 108, 66, 0.35); }
.quick-deduce-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.quick-deduce-grid .gbtn { flex: 1 1 auto; min-height: 28px; }

#dossier .cph {
  border: 1px solid #9f7c4a;
  border-radius: 4px;
  padding: 5px 3px;
  background: linear-gradient(180deg, #f7ebd2 0%, #e7d4ae 100%);
  box-shadow: inset 0 1px 0 rgba(255, 251, 240, 0.78);
  color: #362210;
  font-weight: 600;
}
#dossier .cph .bar {
  height: 5px;
  border-radius: 3px;
  background: #ccb48a;
  border: 1px solid rgba(122, 86, 40, 0.42);
  overflow: hidden;
}
#dossier .cph .bar i {
  background: linear-gradient(90deg, #8b5e24, #c59340);
}
#dossier .cph.done {
  border-color: #7c5220;
  background: linear-gradient(180deg, #faefc9 0%, #e6c98b 100%);
  color: #3d230b;
}
#dossier .cph.act {
  border-color: #2f5578;
  box-shadow: inset 0 0 0 1px rgba(47, 85, 120, 0.25);
}

#dossier .chairrow {
  padding: 4px 8px;
  border: 1px solid rgba(142, 52, 62, 0.42);
  border-radius: 4px;
  background: linear-gradient(180deg, rgba(249, 235, 226, 0.85), rgba(238, 217, 206, 0.72));
  color: #2b1612;
  font-weight: 600;
}
#dossier .chairrow .bar {
  height: 6px;
  border-radius: 3px;
  background: #d8c29e;
  border: 1px solid rgba(132, 64, 58, 0.45);
}
#dossier .chairrow .bar i { background: linear-gradient(90deg, #7d1f2a, #a63240); }
#dossier .chairrow .bar::after { background: #24160c; }

.target-inspector {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid rgba(154, 118, 66, 0.44);
  border-radius: 4px;
  background: linear-gradient(180deg, rgba(252, 245, 229, 0.68) 0%, rgba(238, 223, 194, 0.42) 100%);
  box-shadow: inset 0 1px 0 rgba(255, 251, 240, 0.68);
}
.insp-title { color: #543413; font: 700 14.5px/1.25 var(--font-cjk); }
#dossier .muted, #dossier .kv dt { color: #4d3621; }
#dossier .kv dd { color: #24160c; font-weight: 600; }
#dossier .talents span {
  padding: 1px 7px;
  border-radius: 3px;
  color: #362210;
  border: 1px solid #9e7d50;
  background: linear-gradient(180deg, #faf0d8, #ead7b1);
  font-weight: 600;
}
#dossier .talents.hunter span {
  color: #6b1b24;
  border-color: #a65760;
  background: linear-gradient(180deg, #faece8, #ecd3cd);
}
#dossier .ruler-read { color: #543413; font-weight: 700; }
#dossier .ruler-read small { color: #4d3621; }

@media (max-width: 1200px) {
  .roster-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
