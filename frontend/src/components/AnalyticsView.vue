<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import ManorOrnaments from './tactical/ManorOrnaments.vue';
import type { MatchSummary } from '@idv/replay-renderer';
import { focusTime, loadAllAnalytics, openMatch, setStep, store } from '@/store/app';
import { findPilMapByName } from '@/tactical/maps';
import {
  eventTypeLabel,
  filterEvents,
  fmtNum,
  fmtSec,
  formatClock,
  formatDuration,
  isHunterWin,
  MODE_OPTIONS,
  modeKey,
  modeShort,
  pidLabel,
  type ModeKey,
} from '@/lib/format';

const SURVIVOR_COLORS = ['#91272d', '#234c78', '#78490f', '#5c3572'];
const CONTRIBUTOR_LETTERS = ['A', 'B', 'C', 'D'] as const;

const a = computed(() => store.analytics);
const summary = computed(() => store.matches.find((m) => m.match_id === store.selectedId) ?? store.replay?.match ?? null);
const mapNameEn = computed(() => {
  const raw = summary.value ? findPilMapByName(summary.value.map_name)?.mapNameEn ?? '' : '';
  return raw === 'China Town' ? 'Chinatown' : raw;
});
const matchDuration = computed(() => store.replay?.time.duration_s ?? summary.value?.duration_s ?? a.value?.phases.at(-1)?.end_t ?? 0);

function jump(t: number | null | undefined, uid: number | null = null): void {
  if (t === null || t === undefined || !Number.isFinite(t)) return;
  focusTime(t, uid);
  setStep(2);
}

// ------------------------------------------------------------------ hunter KPIs
const hunterKpis = computed(() => {
  const h = a.value?.hunter_metrics;
  if (!h) return [];
  return [
    { label: '首追', t: h.first_chase_t },
    { label: '首刀', t: h.first_hit_t },
    { label: '首倒', t: h.first_down_t },
    { label: '首挂', t: h.first_chair_t },
  ];
});

// ------------------------------------------------------------------ survivors
const survivorRows = computed(() =>
  (a.value?.survivor_metrics ?? []).map((s, i) => ({ ...s, color: SURVIVOR_COLORS[i % SURVIVOR_COLORS.length] as string })),
);

// ------------------------------------------------------------------ distance chart
// Native CSS-pixel coordinates keep chart type and hit testing independent of panel size.
const plot = ref<SVGSVGElement | null>(null);
const width = ref(760);
const height = ref(220);
let observer: ResizeObserver | undefined;
watch(plot, (svg) => {
  observer?.disconnect();
  if (!svg || typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    width.value = entry.contentRect.width;
    height.value = entry.contentRect.height;
  });
  observer.observe(svg);
});
onBeforeUnmount(() => observer?.disconnect());

const totalContribution = computed(() => {
  const rows = survivorRows.value;
  return rows.length && rows.every(s => s.cipher_contrib_pct != null)
    ? rows.reduce((sum, s) => sum + (s.cipher_contrib_pct ?? 0), 0) : null;
});
const contributors = computed(() => {
  const rows = survivorRows.value;
  const denominator = rows.reduce((sum, row) => sum + (row.cipher_contrib_pct ?? 0), 0);
  return rows.map(row => ({
    ...row,
    share: denominator > 0 && row.cipher_contrib_pct != null
      ? 100 * row.cipher_contrib_pct / denominator : null,
  }));
});
const keyEvents = computed(() => filterEvents(store.replay?.events ?? [], 'key'));
const phaseEnglish: Record<string, string> = { opening: 'Opening', midgame: 'Mid-game', endgame: 'Endgame' };
const midPhaseStart = computed(() => a.value?.phases[1]?.start_t ?? a.value?.phases[0]?.start_t ?? null);
const chartMidTime = computed(() => (matchDuration.value > 0 ? matchDuration.value / 2 : null));
const firstChaseSeg = computed(() => {
  const segs = a.value?.chase_segments ?? [];
  const firstUid = survivorRows.value[0]?.uid;
  return segs.find((seg) => seg.survivor_uid === firstUid) ?? segs[0] ?? null;
});
const firstChaseTime = computed(() => a.value?.hunter_metrics.first_chase_t ?? null);
const PAD = { l: 44, r: 28, t: 10, b: 22 };
const chart = computed(() => {
  const curve = a.value?.distance_curve_1hz;
  if (!curve || !curve.t?.length) return null;
  const ts = curve.t;
  const tMax = Math.max(ts[ts.length - 1] ?? 0, matchDuration.value, 1);
  let dMax = 0;
  for (const arr of Object.values(curve.by_survivor_uid)) for (const v of arr) if (Number.isFinite(v) && v > dMax) dMax = v;
  dMax = Math.max(50, Math.ceil(dMax / 100) * 100);
  const x = (t: number) => PAD.l + (t / tMax) * (width.value - PAD.l - PAD.r);
  const y = (d: number) => PAD.t + (1 - d / dMax) * (height.value - PAD.t - PAD.b);
  const lines = survivorRows.value.map((s) => {
    const arr = curve.by_survivor_uid[String(s.uid)] ?? [];
    let dpath = '';
    let pen = false;
    arr.forEach((v, i) => {
      const t = ts[i];
      if (t === undefined || v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      dpath += `${pen ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return { uid: s.uid, name: s.player_name, color: s.color, d: dpath };
  });
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: Math.round(dMax * f), y: y(dMax * f) }));
  const xTicks = Array.from({ length: 7 }, (_, i) => (tMax * i) / 6).map((t) => ({ t, x: x(t) }));
  const minorY = [0.125, 0.375, 0.625, 0.875].map((f) => y(dMax * f));
  const minorX = Array.from({ length: 6 }, (_, i) => x((tMax * (i + 0.5)) / 6));
  return { lines, yTicks, xTicks, minorY, minorX, tMax, x };
});

function onChartClick(e: MouseEvent): void {
  const c = chart.value;
  const svg = e.currentTarget as SVGSVGElement | null;
  if (!c || !svg) return;
  const rect = svg.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const t = ((px - PAD.l) / (width.value - PAD.l - PAD.r)) * c.tMax;
  jump(Math.max(0, Math.min(c.tMax, t)));
}

// ------------------------------------------------------------------ gantt
const gantt = computed(() => {
  const segs = a.value?.chase_segments ?? [];
  const tMax = Math.max(matchDuration.value, ...segs.map((s) => s.end_t), 1);
  return survivorRows.value.map((s) => ({
    uid: s.uid,
    name: s.player_name,
    color: s.color,
    segs: segs
      .filter((g) => g.survivor_uid === s.uid)
      .map((g) => ({ ...g, left: (g.start_t / tMax) * 100, width: Math.max(0.3, ((g.end_t - g.start_t) / tMax) * 100) })),
  }));
});

// ------------------------------------------------------------------ comparison matrix
const mMap = ref('all');
const mMode = ref<ModeKey>('all');
const mapNames = computed(() => [...new Set(store.matches.map((m) => m.map_name))]);
const matrix = computed(() =>
  store.matches
    .filter((m) => (mMap.value === 'all' || m.map_name === mMap.value) && (mMode.value === 'all' || modeKey(m.mode_id) === mMode.value))
    .map((m: MatchSummary) => {
      const an = store.analyticsById[m.match_id];
      return {
        m,
        firstChair: an?.hunter_metrics.first_chair_t ?? null,
        ciphers: an ? an.phases.reduce((n, p) => n + (p.ciphers_completed_in_phase ?? 0), 0) : null,
        chase: an?.hunter_metrics.chase_total_s ?? null,
        loaded: !!an,
      };
    }),
);

function openRow(id: string): void {
  if (id === store.selectedId) return;
  void openMatch(id, { step: 3 });
}

onMounted(() => {
  void loadAllAnalytics();
});
</script>

<template>
  <div class="analysis-stack folio-stack">
    <div id="analysis" class="paper-folio">
      <header class="analytics-heading">
        <div class="heading-copy">
          <h1>对比分析 <span v-if="summary">｜ {{ summary.map_name }} · {{ formatClock(matchDuration) }}</span></h1>
          <em>Match Phase &amp; Telemetry Dossier<template v-if="mapNameEn"> — {{ mapNameEn }}</template></em>
        </div>
        <span v-if="mapNameEn" class="header-map-script" aria-hidden="true">{{ mapNameEn }}</span>
        <div class="ornate-rule" aria-hidden="true"><span></span></div>
      </header>
      <p v-if="store.analyticsLoading && !a" class="empty">分析档案生成中…</p>
      <p v-else-if="store.analyticsError && !a" class="err" data-test="analytics-error">{{ store.analyticsError }}</p>

      <template v-if="a">
        <div class="phases">
          <button
            v-for="p in a.phases"
            :key="p.phase_id"
            type="button"
            class="phase phase-plate"
            :class="p.phase_id"
            :data-phase="p.phase_id"
            :title="`跳转至战术沙盘 ${formatClock(p.start_t)} · ${formatDuration(p.duration_s)} · 关键事件 ${p.key_events_count}`"
            @click="jump(p.start_t)"
          >
            <div class="phase-title">
              <h3 class="ribbon-h">{{ p.label_zh }} <small>{{ phaseEnglish[p.phase_id] }}</small></h3>
              <time class="num">{{ formatClock(p.start_t) }} – {{ formatClock(p.end_t) }}</time>
            </div>
            <div class="phase-body">
              <span class="phase-etching" aria-hidden="true"></span>
              <span class="phase-medallion" aria-hidden="true">
                <svg v-if="p.phase_id === 'opening'" class="phase-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <circle cx="14.5" cy="5.2" r="2.1" />
                  <path d="M5 11.8 9.2 8.4l4.5 1 2.7 3.2 3.8.9M12.6 9.8 9.5 15.2l4.4 2-1.8 4.4M9.5 15.2 6.2 19H3.2" />
                </svg>
                <svg v-else-if="p.phase_id === 'midgame'" class="phase-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M6.5 4h11v6.2h-11ZM4.6 10.2h14.8l2 8.2H2.6ZM4 20.4h16M8.5 7h7M7.2 13.3h1.2m2.8 0h1.4m2.8 0h1.4M7.2 16.3h9.6" />
                </svg>
                <svg v-else class="phase-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M4.5 20V5.2h15V20M3 20h18M12 5.2V20M8.2 5.2v14.8M15.8 5.2v14.8M7.5 12.6h1.2M15.3 12.6h1.2" />
                </svg>
              </span>
              <div class="phase-metric">
                <span>{{ p.phase_id === 'opening' ? '阶段时长' : p.phase_id === 'midgame' ? '完成密码机' : '关键事件' }}</span>
                <b class="num">{{ p.phase_id === 'opening' ? formatClock(p.duration_s) : p.phase_id === 'midgame' ? (p.ciphers_completed_in_phase ?? '—') + ' 台' : (p.key_events_count ?? '—') + ' 次' }}</b>
              </div>
            </div>
            <div class="stats">
              <div><b class="num">{{ p.ciphers_completed_in_phase }}</b><span>破译</span></div>
              <div><b class="num">{{ p.hits_in_phase }}</b><span>命中</span></div>
              <div><b class="num">{{ p.chairs_in_phase }}</b><span>上椅</span></div>
              <div><b class="num">{{ p.rescues_in_phase }}</b><span>救下</span></div>
            </div>
          </button>
        </div>

        <section class="overview phase-plate">
          <h2 class="ribbon-h">全局指标 <small>Match KPIs</small></h2>
          <div class="overview-values">
            <p>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18z M12 6v6l4 2" /></svg>
              <span class="kpi-copy">对局时长<small>Duration</small></span>
              <b class="num">{{ formatClock(matchDuration) }}</b>
            </p>
            <p>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v7H6z M5 10h14l3 9H2z M4 21h16 M8 6h8 M7 13h1m3 0h1m3 0h1 M7 16h10" /></svg>
              <span class="kpi-copy">破译贡献<small>Decoding</small></span>
              <b class="num">{{ totalContribution == null ? '—' : fmtNum(totalContribution, 2) + '%' }}</b>
            </p>
            <p>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M4 12l4-4 5 1 3 4 5 1 M13 9l-4 6 5 2-2 5 M9 15l-3 4H2" /></svg>
              <span class="kpi-copy">追击时长<small>Pursuit</small></span>
              <b class="num">{{ formatClock(a.hunter_metrics.chase_total_s) }}</b>
            </p>
            <p>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h17l-5-5 M21 16H4l5 5" /></svg>
              <span class="kpi-copy">目标切换<small>Switches</small></span>
              <b class="num">{{ a.hunter_metrics.target_switches ?? '—' }}</b>
            </p>
          </div>
        </section>

        <div class="analysis-detail">
          <div class="phase-plate chart" data-test="distance-chart">
            <h2 class="ribbon-h">求生者与监管者距离 <small>Distance · u</small></h2>
            <div class="legend">
              <span v-for="s in survivorRows" :key="s.uid"><i :style="{ background: s.color }"></i>{{ s.player_name }}</span>
            </div>
            <svg v-if="chart" ref="plot" role="img" aria-label="距离曲线" @click="onChartClick">
              <g>
                <rect
                  :x="PAD.l"
                  :y="PAD.t"
                  :width="Math.max(0, width - PAD.l - PAD.r)"
                  :height="Math.max(0, height - PAD.t - PAD.b)"
                  fill="#f3e6cb"
                  fill-opacity="0.54"
                  stroke="#9c794a"
                  stroke-width="1"
                />
                <line
                  v-for="(mx, i) in chart.minorX"
                  :key="`mx${i}`"
                  :x1="mx"
                  :x2="mx"
                  :y1="PAD.t"
                  :y2="height - PAD.b"
                  stroke="#d3bc96"
                  stroke-width="0.75"
                  stroke-opacity="0.5"
                />
                <line
                  v-for="(my, i) in chart.minorY"
                  :key="`my${i}`"
                  :x1="PAD.l"
                  :x2="width - PAD.r"
                  :y1="my"
                  :y2="my"
                  stroke="#d3bc96"
                  stroke-width="0.75"
                  stroke-opacity="0.5"
                />
                <rect
                  v-for="(g, i) in a.chase_segments"
                  :key="i"
                  :x="chart.x(g.start_t)"
                  :y="PAD.t"
                  :width="Math.max(0, chart.x(g.end_t) - chart.x(g.start_t))"
                  :height="Math.max(0, height - PAD.t - PAD.b)"
                  fill="#c2654c"
                  fill-opacity="0.24"
                />
                <line
                  v-for="(g, i) in a.chase_segments"
                  :key="`cs${i}`"
                  :x1="chart.x(g.start_t)"
                  :x2="chart.x(g.start_t)"
                  :y1="PAD.t"
                  :y2="height - PAD.b"
                  stroke="#9e3d38"
                  stroke-width="0.85"
                  stroke-dasharray="2.5 2.5"
                  stroke-opacity="0.52"
                />
                <line
                  v-for="(g, i) in a.chase_segments"
                  :key="`ce${i}`"
                  :x1="chart.x(g.end_t)"
                  :x2="chart.x(g.end_t)"
                  :y1="PAD.t"
                  :y2="height - PAD.b"
                  stroke="#9e3d38"
                  stroke-width="0.85"
                  stroke-dasharray="2.5 2.5"
                  stroke-opacity="0.52"
                />
                <line
                  v-for="tk in chart.xTicks"
                  :key="`xg${tk.t}`"
                  :x1="tk.x"
                  :x2="tk.x"
                  :y1="PAD.t"
                  :y2="height - PAD.b"
                  stroke="#c2aa83"
                  stroke-width="1"
                  stroke-opacity="0.7"
                />
                <line
                  v-for="tk in chart.yTicks"
                  :key="`y${tk.v}`"
                  :x1="PAD.l"
                  :x2="width - PAD.r"
                  :y1="tk.y"
                  :y2="tk.y"
                  stroke="#b59870"
                  stroke-width="1"
                />
                <line
                  :x1="PAD.l"
                  :x2="PAD.l"
                  :y1="PAD.t"
                  :y2="height - PAD.b"
                  stroke="#7b5c37"
                  stroke-width="1.2"
                />
                <line
                  :x1="PAD.l"
                  :x2="width - PAD.r"
                  :y1="height - PAD.b"
                  :y2="height - PAD.b"
                  stroke="#7b5c37"
                  stroke-width="1.2"
                />
                <text
                  v-for="tk in chart.yTicks"
                  :key="`yt${tk.v}`"
                  :x="PAD.l - 6"
                  :y="tk.y + 4"
                  fill="#301e12"
                  font-size="13"
                  font-weight="600"
                  font-family="var(--font-num, Georgia, serif)"
                  text-anchor="end"
                >{{ tk.v }}</text>
                <text
                  v-for="tk in chart.xTicks"
                  :key="`xt${tk.t}`"
                  :x="tk.x"
                  :y="height - 5"
                  fill="#301e12"
                  font-size="13"
                  font-weight="600"
                  font-family="var(--font-num, Georgia, serif)"
                  text-anchor="middle"
                >{{ formatClock(tk.t) }}</text>
              </g>
              <line
                :x1="chart.x(store.t)"
                :x2="chart.x(store.t)"
                :y1="PAD.t"
                :y2="height - PAD.b"
                stroke="#8c5b1f"
                stroke-width="1.6"
                stroke-dasharray="3 3"
              />
              <path
                v-for="l in chart.lines"
                :key="l.uid"
                :d="l.d"
                :stroke="l.color"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                fill="none"
              />
            </svg>
            <p v-else class="muted">无距离曲线数据</p>
            <div class="chart-foot">
              <span class="chase-legend"><i class="chase-key"></i>追击区间</span>
              <div class="jump-triggers" data-test="chart-jumps">
                <button type="button" class="jump-btn" data-jump="phase" :disabled="midPhaseStart == null" @click="jump(midPhaseStart)">
                  阶段 {{ formatClock(midPhaseStart) }}
                </button>
                <button type="button" class="jump-btn" data-jump="curve" :disabled="chartMidTime == null" @click="jump(chartMidTime)">
                  曲线 {{ formatClock(chartMidTime) }}
                </button>
                <button type="button" class="jump-btn" data-jump="chase" :disabled="!firstChaseSeg" @click="jump(firstChaseSeg?.start_t, firstChaseSeg?.survivor_uid ?? null)">
                  追击段 {{ formatClock(firstChaseSeg?.start_t) }}
                </button>
                <button type="button" class="jump-btn" data-jump="first-chase" :disabled="firstChaseTime == null" @click="jump(firstChaseTime)">
                  首追 {{ formatClock(firstChaseTime) }}
                </button>
              </div>
            </div>
          </div>

          <section class="contributions phase-plate">
            <h2 class="ribbon-h">解码贡献 <small>Decoding Contribution</small></h2>
            <p class="contribution-key">数值：个人破译贡献　条长：占全队</p>
            <div v-for="(s, idx) in contributors" :key="s.uid" class="contributor" :data-contributor="s.uid">
              <i class="contrib-seal" :style="{ background: s.color }" aria-hidden="true">{{ CONTRIBUTOR_LETTERS[idx % 4] }}</i>
              <b>{{ s.player_name }}</b>
              <span class="num">{{ s.cipher_contrib_pct == null ? '—' : fmtNum(s.cipher_contrib_pct, 2) + '%' }}</span>
              <small class="share num">占全队 {{ s.share == null ? '—' : (s.share === 0 ? '0' : fmtNum(s.share, 2)) + '%' }}</small>
              <svg class="contrib-bar" aria-hidden="true" width="100%" height="8">
                <rect width="100%" height="8" rx="4" fill="#d3bd98" />
                <rect :width="(s.share ?? 0) + '%'" height="8" rx="4" :fill="s.color" />
              </svg>
            </div>
          </section>
        </div>

        <div class="card phase-plate ledger-card kpi-strip" data-test="hunter-kpis">
          <div class="ledger-head">
            <h2 class="ribbon-h">监管节奏 <small>Hunter Tempo</small></h2>
            <span class="k ledger-sub">{{ a.hunter_metrics.player_name }} · {{ pidLabel(a.hunter_metrics.pid) }}</span>
          </div>
          <div class="kpis">
            <div v-for="k in hunterKpis" :key="k.label" class="kpi hot">
              <span>{{ k.label }}</span>
              <button v-if="k.t !== null && k.t !== undefined" class="num" @click="jump(k.t)">{{ formatClock(k.t, true) }}</button>
              <b v-else>—</b>
            </div>
            <div class="kpi"><span>合并追击时长</span><b class="num">{{ fmtSec(a.hunter_metrics.chase_total_s) }}</b></div>
            <div class="kpi"><span>原始 et=47</span><b class="num">{{ fmtSec(a.hunter_metrics.chase_raw_et47_s) }}</b></div>
            <div class="kpi"><span>结算追击</span><b class="num">{{ fmtSec(a.hunter_metrics.reported_pursuit_s) }}</b></div>
            <div class="kpi"><span>换追次数</span><b class="num">{{ a.hunter_metrics.target_switches ?? '—' }}</b></div>
            <div class="kpi"><span>普攻命中 / 出刀</span><b class="num">{{ a.hunter_metrics.normal_hits ?? '—' }} / {{ a.hunter_metrics.total_attack_swings ?? '—' }}</b></div>
            <div class="kpi"><span>踩板</span><b class="num">{{ a.hunter_metrics.pallet_breaks ?? '—' }}</b></div>
            <div class="kpi"><span>移动距离</span><b class="num">{{ fmtNum(a.hunter_metrics.distance_xz_u, 0) }}u</b></div>
          </div>
        </div>

        <section class="timeline phase-plate ledger-card">
          <div class="ledger-head">
            <h2 class="ribbon-h">追击甘特图 <small>Pursuit Timeline</small></h2>
            <span class="k ledger-sub">点击片段跳转战术沙盘</span>
          </div>
          <div class="gantt" data-test="gantt">
            <div v-for="row in gantt" :key="row.uid" class="grow">
              <span :style="{ color: row.color }">{{ row.name }}</span>
              <div class="lane">
                <button
                  v-for="(g, i) in row.segs"
                  :key="i"
                  class="seg"
                  :style="{ left: `${g.left}%`, width: `${g.width}%` }"
                  :title="`${formatClock(g.start_t)}–${formatClock(g.end_t)} · ${fmtSec(g.duration_s)}`"
                  @click="jump(g.start_t, g.survivor_uid)"
                ></button>
              </div>
            </div>
          </div>
          <details class="event-register">
            <summary>关键事件 · {{ keyEvents.length }}</summary>
            <button v-for="(event, i) in keyEvents" :key="i" @click="jump(event.t, event.actor_uid)">
              <time>{{ formatClock(event.t, true) }}</time> {{ eventTypeLabel(event) }}
            </button>
          </details>
        </section>

        <div class="card phase-plate ledger-card table-card" data-test="survivor-table">
          <div class="ledger-head">
            <h2 class="ribbon-h">求生者战术表 <small>Survivor Ledger</small></h2>
          </div>
          <table class="dt">
            <thead>
              <tr>
                <th>求生者</th>
                <th>结局</th>
                <th>修机贡献%</th>
                <th>修机时长</th>
                <th>牵制时长</th>
                <th>摸椅 opt=4</th>
                <th>救下 opt=3</th>
                <th>下板/翻窗/翻板/飞轮</th>
                <th>被挂</th>
                <th>最小监管距离</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in survivorRows" :key="s.uid" :data-uid="s.uid">
                <td><b :style="{ color: s.color }">{{ s.player_name }}</b> <span class="dimtxt">{{ pidLabel(s.pid) }}{{ s.is_bot ? ' · 人机' : '' }}</span></td>
                <td>{{ s.res_label || '—' }}</td>
                <td>
                  <span class="pbar"><i :style="{ width: `${Math.max(0, Math.min(100, s.cipher_contrib_pct ?? 0))}%` }"></i></span>
                  <span class="num">{{ fmtNum(s.cipher_contrib_pct, 1) }}%</span>
                </td>
                <td class="num">{{ fmtSec(s.cipher_active_time_s) }} · {{ s.ciphers_finished }}台</td>
                <td class="num">{{ fmtSec(s.chased_time_s) }}</td>
                <td class="num">{{ s.rescues_attempted }}</td>
                <td class="num">{{ s.rescues_completed }}<span v-if="s.avg_chair_to_rescue_s !== null" class="dimtxt"> · 均 {{ fmtSec(s.avg_chair_to_rescue_s) }}</span></td>
                <td class="num">{{ s.pallet_drops }} / {{ s.window_vaults }} / {{ s.pallet_vaults }} / {{ s.flywheel_uses }}</td>
                <td class="num">{{ s.times_chaired }}</td>
                <td class="num">{{ s.min_dist_to_hunter_u !== null ? `${fmtNum(s.min_dist_to_hunter_u, 1)}u` : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <div class="card phase-plate ledger-card table-card" data-test="matrix">
        <div class="ledger-head">
          <h2 class="ribbon-h">多局对比矩阵 <small>Match Matrix</small></h2>
          <div class="mfilters">
            <select v-model="mMap" class="sel" aria-label="地图">
              <option value="all">全部地图</option>
              <option v-for="n in mapNames" :key="n" :value="n">{{ n }}</option>
            </select>
            <select v-model="mMode" class="sel" aria-label="模式">
              <option v-for="o in MODE_OPTIONS" :key="o.key" :value="o.key">{{ o.label }}</option>
            </select>
          </div>
        </div>
        <table class="dt">
          <thead>
            <tr>
              <th>时间 (UTC+8)</th>
              <th>地图</th>
              <th>模式</th>
              <th>监管者</th>
              <th>时长</th>
              <th>首挂</th>
              <th>密码机</th>
              <th>追击总长</th>
              <th>逃脱/淘汰/投降</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in matrix"
              :key="r.m.match_id"
              class="click"
              :class="{ cur: r.m.match_id === store.selectedId }"
              :data-match="r.m.match_id"
              @click="openRow(r.m.match_id)"
            >
              <td class="num">{{ r.m.save_time_utc8 }}</td>
              <td><b>{{ r.m.map_name }}</b></td>
              <td>{{ modeShort(r.m) }}</td>
              <td>{{ pidLabel(r.m.hunter.pid) }} · {{ r.m.hunter.player_name }}</td>
              <td class="num">{{ formatClock(r.m.duration_s) }}</td>
              <td class="num">{{ r.loaded ? formatClock(r.firstChair) : '…' }}</td>
              <td class="num">{{ r.loaded ? r.ciphers : '…' }}</td>
              <td class="num">{{ r.loaded ? fmtSec(r.chase, 0) : '…' }}</td>
              <td class="num">{{ r.m.survivor_escape_count }} / {{ r.m.survivor_elim_count }} / {{ r.m.survivor_surrender_count }}</td>
              <td :class="isHunterWin(r.m) ? 'red' : 'blue'">{{ r.m.result_label }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <ManorOrnaments kind="clip" />
  </div>
</template>

<style scoped>
/* Engraved parchment manuscript folio with 7px inset antique-gold border (D-026 §4.3) */
.analysis-stack {
  margin: 0;
  height: 100%;
  border-radius: 4px;
}
.analysis-stack > .binder-clip {
  right: 14px;
  top: 2px;
  width: clamp(44px, 3.6vw, 54px);
  transform: rotate(7deg);
  filter: drop-shadow(1px 3px 2px rgba(56, 36, 16, 0.42));
}

#analysis {
  display: block;
  overflow: auto;
  scrollbar-width: none;
  padding: 16px 20px 18px;
  border: 1px solid var(--paper-frame-border, #9e7b4b);
  border-radius: 4px;
  background:
    var(--paper-inset-frame),
    var(--paper-stock);
  box-shadow: none;
}

/* Header with Chinatown sepia streetscape, calligraphic English map watermark & diamond rule */
.analytics-heading {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  padding: 4px 8px 6px;
  height: clamp(76px, 11vh, 114px);
  border-bottom: 0;
  background: url('/assets/dossier/analytics-header-sketch.png') right 16px center / min(54%, 690px) auto no-repeat;
}
.heading-copy {
  position: relative;
  z-index: 1;
  max-width: 56%;
}
.analytics-heading h1 {
  color: #24150c;
  font-size: clamp(25px, 2.25vw, 37px);
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: 0.04em;
  text-shadow: 0 1px 0 rgba(255, 248, 232, 0.72);
}
.analytics-heading h1 span {
  color: #7e1f2a;
  font-size: 0.76em;
  font-weight: 600;
}
.analytics-heading em {
  display: block;
  margin-top: 2px;
  color: #533820;
  font: italic 600 clamp(15.5px, 1.4vw, 21px)/1.2 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
}
.header-map-script {
  position: absolute;
  right: 78px;
  top: 5px;
  z-index: 1;
  padding: 1px 10px;
  border-radius: 10px;
  background: radial-gradient(ellipse at 50% 50%, rgba(244, 232, 206, 0.9) 46%, rgba(244, 232, 206, 0) 100%);
  color: #4f351c;
  font: italic 600 clamp(17px, 1.55vw, 24px)/1.08 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
  letter-spacing: 0.03em;
  transform: rotate(-7deg);
  pointer-events: none;
}

.ornate-rule {
  position: relative;
  height: 5px;
  margin-top: auto;
  border-top: 1px solid #9d794b;
  border-bottom: 1px solid rgba(255, 245, 218, 0.85);
}
.ornate-rule span {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 7px;
  height: 7px;
  background: #9c7240;
  border: 1px solid #f6e3ba;
  transform: translate(-50%, -50%) rotate(45deg);
}

/* Shared double-brass embossed parchment plate */
#analysis .phase-plate {
  position: relative;
  border: 1px solid #967242;
  border-radius: 5px;
  background:
    radial-gradient(ellipse at 50% 45%, rgba(255, 249, 234, 0.28) 45%, rgba(142, 98, 48, 0.12) 100%),
    var(--paper-stock);
  box-shadow:
    inset 0 0 0 2px #f4e6cb,
    inset 0 0 0 3px rgba(158, 120, 67, 0.52),
    0 2px 8px rgba(42, 26, 12, 0.14);
}

/* Sculpted metallic ribbons */
#analysis .ribbon-h {
  position: relative;
  z-index: 2;
  display: flex;
  gap: 7px;
  align-items: center;
  height: 31px;
  margin: 0;
  padding: 3px 24px 3px 21px;
  color: #fff5e0;
  font: 700 17px/1.2 var(--font-cjk);
  white-space: nowrap;
}
#analysis .ribbon-h small {
  margin: 0;
  color: #f8e3b8;
  font: italic 600 14.5px/1.1 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
}

/* 3 Double-Brass Phase Plaques with sepia etchings & circular antique-bronze medallions */
#analysis .phases {
  margin: 14px 0 0;
  gap: 12px;
}
#analysis .phase {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 6px 8px 5px;
  height: clamp(128px, 17.1vh, 178px);
  color: #24160c;
  text-align: left;
  cursor: pointer;
  border: 1px solid #967242;
  box-shadow:
    inset 0 0 0 2px #f4e6cb,
    inset 0 0 0 3px rgba(158, 120, 67, 0.56),
    0 3px 9px rgba(42, 26, 12, 0.16);
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
}
#analysis .phase:hover {
  border-color: #b48646;
  box-shadow:
    inset 0 0 0 2px #f8ecd5,
    inset 0 0 0 3px rgba(176, 132, 68, 0.68),
    0 5px 14px rgba(42, 26, 12, 0.22);
  transform: translateY(-1px);
}
#analysis .phase:focus-visible {
  outline: 2px solid #8c5a20;
  outline-offset: 2px;
}
.phase-title {
  position: relative;
  z-index: 2;
  display: flex;
  justify-content: space-between;
  gap: 6px;
  align-items: center;
}
#analysis .phase .ribbon-h {
  width: clamp(188px, 54%, 226px);
  padding: 3px 22px 3px 20px;
  font-size: clamp(14px, 1.12vw, 17.5px);
}
#analysis .phase.opening h3.ribbon-h,
#analysis .phase.midgame h3.ribbon-h,
#analysis .phase.endgame h3.ribbon-h {
  color: #fff5e0;
}
.phase-title time {
  padding: 2px 7px;
  border: 1px solid rgba(154, 118, 66, 0.55);
  border-radius: 3px;
  background: linear-gradient(180deg, #e7d5b2 0%, #f5e9ce 100%);
  box-shadow: inset 0 1px 1px rgba(58, 36, 16, 0.14), 0 1px 0 rgba(255, 250, 236, 0.78);
  color: #2e1c0e;
  font: 600 13.5px/1.15 var(--font-num, Georgia, serif);
  white-space: nowrap;
}
.phase-body {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 192px) 34px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  padding: 2px 3px;
}
.phase-etching {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 54px;
  background: var(--plate) left center / contain no-repeat;
  mix-blend-mode: multiply;
  opacity: 0.94;
  pointer-events: none;
}
.phase-medallion {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1.5px solid #e7c584;
  background: radial-gradient(circle at 34% 28%, #88653c 0%, #593e21 64%, #3c2713 100%);
  box-shadow:
    0 0 0 1px #6e4e2a,
    inset 0 1px 1px rgba(255, 246, 218, 0.45),
    0 2px 4px rgba(42, 24, 10, 0.34);
  color: #fff4da;
  pointer-events: none;
}
.phase-icon {
  width: 19px;
  height: 19px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.phase-metric {
  padding-left: 2px;
  line-height: 1.14;
  min-width: 0;
}
#analysis .phase-metric span {
  display: block;
  color: #3d2a1b;
  font: 700 14px/1.2 var(--font-cjk);
  white-space: nowrap;
}
.phase-metric b,
.overview-values b,
.contributor span {
  color: #7f1f28;
  font-family: var(--font-num, Georgia, serif);
  font-weight: 700;
  font-style: italic;
  font-synthesis-style: none;
}
.phase-metric b {
  display: block;
  margin-top: 2px;
  font-size: clamp(22px, 1.95vw, 33px);
  line-height: 1.06;
}
#analysis .phase .stats {
  position: relative;
  z-index: 2;
  margin: 0;
  padding: 2px 0 0;
  border: 0;
  border-top: 1px solid #b49265;
  background: rgba(238, 222, 190, 0.64);
}
#analysis .phase .stats div {
  padding: 2px 0;
  border-right: 1px solid rgba(173, 138, 92, 0.55);
}
#analysis .phase .stats div:last-child { border-right: 0; }
#analysis .phase .stats b {
  display: inline;
  margin-right: 4px;
  color: #2c1c10;
  font-size: 13.5px;
  font-weight: 700;
}
#analysis .phase .stats span {
  color: #4b3522;
  font-size: 12px;
  font-weight: 600;
}

/* Global KPI Strip with circular bronze-ringed icons & diamond brass dividers */
.overview,
.timeline,
#analysis > .card {
  margin-top: clamp(10px, 2.0vh, 20px);
}
.overview {
  height: clamp(86px, 11.8vh, 122px);
  padding: 6px 9px 6px;
}
#analysis .overview h2.ribbon-h { width: 252px; }
.overview-values {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  height: calc(100% - 31px);
  align-items: center;
  background-image:
    url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiIHZpZXdCb3g9IjAgMCA4IDgiPjxwYXRoIGQ9Ik00IC42IDcuNCA0IDQgNy40LjYgNFoiIGZpbGw9IiNjZmEyNWUiIHN0cm9rZT0iIzZlNGMyMyIgc3Ryb2tlLXdpZHRoPSIuOSIvPjwvc3ZnPg=="),
    url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiIHZpZXdCb3g9IjAgMCA4IDgiPjxwYXRoIGQ9Ik00IC42IDcuNCA0IDQgNy40LjYgNFoiIGZpbGw9IiNjZmEyNWUiIHN0cm9rZT0iIzZlNGMyMyIgc3Ryb2tlLXdpZHRoPSIuOSIvPjwvc3ZnPg=="),
    url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiIHZpZXdCb3g9IjAgMCA4IDgiPjxwYXRoIGQ9Ik00IC42IDcuNCA0IDQgNy40LjYgNFoiIGZpbGw9IiNjZmEyNWUiIHN0cm9rZT0iIzZlNGMyMyIgc3Ryb2tlLXdpZHRoPSIuOSIvPjwvc3ZnPg==");
  background-position: 25% 50%, 50% 50%, 75% 50%;
  background-size: 8px 8px;
  background-repeat: no-repeat;
}
.overview-values p {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 5.5%;
  border-right: 1px solid #b59366;
  min-width: 0;
}
.overview-values p:last-child { border-right: 0; }
.overview-values svg {
  flex: none;
  width: 31px;
  height: 31px;
  padding: 5px;
  border-radius: 50%;
  border: 1.5px solid #96703d;
  background: radial-gradient(circle at 35% 30%, #faf0d8 0%, #e7d2a7 65%, #cfb078 100%);
  box-shadow:
    inset 0 0 0 1px rgba(255, 250, 236, 0.8),
    0 1px 3px rgba(52, 32, 14, 0.24);
  fill: none;
  stroke: #4e3216;
  stroke-width: 1.85;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.kpi-copy {
  display: flex;
  flex-direction: column;
  color: #26170c;
  font: 700 14.5px/1.15 var(--font-cjk);
  white-space: nowrap;
}
.kpi-copy small {
  color: #533820;
  font: italic 600 12.5px/1.12 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
}
.overview-values b {
  margin-left: auto;
  display: inline-block;
  font-size: clamp(20px, 1.85vw, 31px);
  line-height: 1.06;
  white-space: nowrap;
}

/* Main Telemetry Row: Distance Chart + Decoding Contributions */
.analysis-detail {
  margin-top: clamp(10px, 1.8vh, 17px);
  display: grid;
  grid-template-columns: minmax(0, 64fr) minmax(0, 35.2fr);
  gap: 11px;
  height: calc(
    100% - clamp(76px, 11vh, 114px) - clamp(128px, 17.1vh, 178px) - clamp(86px, 11.8vh, 122px)
    - 14px - clamp(10px, 2.0vh, 20px) - clamp(10px, 1.8vh, 17px) + 4.8px
  );
  min-height: 245px;
}
#analysis .chart,
.contributions {
  min-width: 0;
  min-height: 0;
  padding: 11px 12px 7px;
  display: flex;
  flex-direction: column;
}
#analysis .chart h2.ribbon-h { width: min(360px, 100%); }
#analysis .contributions h2.ribbon-h { width: min(343px, 100%); }
#analysis .chart svg {
  flex: 1;
  width: 100%;
  min-height: 0;
  height: 0;
  max-height: none;
  cursor: crosshair;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
  margin: 6px 4px 4px;
  padding: 3px 10px;
  border: 1px solid rgba(158, 120, 67, 0.36);
  border-radius: 4px;
  background: rgba(247, 237, 214, 0.56);
  color: #2b1a0e;
  font: 600 13px/1.2 var(--font-cjk);
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend i {
  display: inline-block;
  width: 16px;
  height: 3px;
  margin: 0;
  border-radius: 1.5px;
}

/* Chart Footer: Chase Swatch + 4 Jump-to-Sandbox Triggers */
.chart-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 5px;
  padding: 4px 4px 0;
  border-top: 1px solid rgba(173, 138, 92, 0.45);
}
.chase-legend {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #463220;
  font: 600 12.5px/1.2 var(--font-cjk);
  white-space: nowrap;
}
.chase-key {
  display: inline-block;
  width: 18px;
  height: 10px;
  border: 1px dashed #a45147;
  border-radius: 2px;
  background: rgba(194, 101, 76, 0.28);
}
.jump-triggers {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  min-width: 0;
}
.jump-btn {
  height: 26px;
  padding: 0 9px;
  border: 1px solid #966f3e;
  border-radius: 4px;
  background: linear-gradient(180deg, #fbf0d2 0%, #ebd4a4 55%, #d6b174 100%);
  box-shadow:
    inset 0 0 0 1px rgba(255, 250, 236, 0.78),
    inset 0 -1px 2px rgba(128, 86, 38, 0.35),
    0 1px 2px rgba(52, 34, 16, 0.28);
  color: #28180c;
  font: 700 12px/1 var(--font-cjk);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  transition: filter 0.14s ease, transform 0.14s ease;
}
.jump-btn:hover:not(:disabled) {
  filter: brightness(1.06);
  transform: translateY(-1px);
}
.jump-btn:focus-visible {
  outline: 2px solid #8a561e;
  outline-offset: 1px;
}
.jump-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Decoding Contributions: 4 rows + recessed brass-rimmed enamel progress capsules */
.contribution-key {
  flex: none;
  margin: 5px 6px 2px;
  color: #4d3724;
  font: 600 13px/1.25 var(--font-cjk);
}
.contributor {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) 106px;
  align-content: center;
  align-items: center;
  gap: 2px 9px;
  padding: 3px 6px;
  border-bottom: 1px solid rgba(169, 136, 92, 0.55);
  overflow-wrap: anywhere;
}
.contributor:last-child { border-bottom: 0; }
.contrib-seal {
  grid-column: 1;
  grid-row: 1 / span 2;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1.5px solid #e7c584;
  box-shadow:
    0 0 0 1px #6e4e2a,
    inset 0 1px 1px rgba(255, 245, 214, 0.45),
    0 1px 3px rgba(42, 26, 12, 0.38);
  color: #fff3d8;
  font: normal 700 12.5px/1 var(--font-latin, Georgia, serif);
}
.contributor b {
  grid-column: 2;
  grid-row: 1;
  color: #24160c;
  font: 700 14.5px/1.2 var(--font-cjk);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.contributor span {
  grid-column: 3;
  grid-row: 1;
  font-size: 19px;
  line-height: 1.15;
  text-align: right;
  white-space: nowrap;
}
.contributor .contrib-bar {
  grid-column: 2;
  grid-row: 2;
  width: 100%;
  height: 8px;
  display: block;
  box-sizing: content-box;
  border: 1px solid #967242;
  border-radius: 5px;
  background: #d3bd98;
  box-shadow:
    inset 0 1px 2px rgba(42, 24, 10, 0.32),
    0 1px 0 rgba(255, 250, 236, 0.78);
  overflow: hidden;
}
.contributor .share {
  grid-column: 3;
  grid-row: 2;
  color: #493422;
  font: 600 12.5px/1.15 var(--font-num, Georgia, serif);
  text-align: right;
  white-space: nowrap;
}

/* Below-the-Fold Manor Parchment Ledger Cards & Tables (D-026 §4.3) */
#analysis .ledger-card {
  padding: 13px 16px 14px;
  color: #24160c;
}
#analysis .table-card {
  overflow-x: auto;
}
.ledger-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin-bottom: 10px;
}
.ledger-sub {
  color: #4f361e;
  font: 700 12.5px/1.25 var(--font-cjk);
  letter-spacing: 0.04em;
}

#analysis .kpi-strip {
  background:
    radial-gradient(ellipse at 50% 45%, rgba(255, 249, 234, 0.28) 45%, rgba(142, 98, 48, 0.12) 100%),
    var(--paper-stock);
}
#analysis .kpis {
  gap: 8px;
}
#analysis .kpi {
  padding: 7px 10px;
  border: 1px solid rgba(154, 118, 66, 0.48);
  border-radius: 4px;
  background: linear-gradient(180deg, rgba(248, 239, 219, 0.78), rgba(232, 214, 181, 0.56));
  box-shadow: inset 0 1px 0 rgba(255, 250, 236, 0.76);
}
#analysis .kpi.hot {
  background: linear-gradient(135deg, #f8e8c6 0%, #e4c68f 100%);
  border: 1px solid #9e7440;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgba(255, 250, 236, 0.7), 0 1px 3px rgba(48, 28, 12, 0.16);
}
#analysis .kpi.hot button {
  color: #7d1f2a;
  font: italic 700 17px/1.15 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
}
#analysis .kpi span {
  color: #4a331e;
  font: 700 12px/1.25 var(--font-cjk);
  letter-spacing: 0.04em;
}
#analysis .kpi b {
  color: #24160c;
  font: 700 16px/1.2 var(--font-num, Georgia, serif);
}

.timeline { padding: 13px 16px 14px; }
#analysis .gantt { gap: 6px; margin-top: 6px; }
#analysis .grow { color: #2b1a0e; font: 600 13px/1.25 var(--font-cjk); }
#analysis .grow .lane {
  height: 15px;
  border: 1px solid #9d7949;
  border-radius: 3px;
  background: linear-gradient(180deg, #dbc7a2 0%, #ebd9b8 100%);
  box-shadow: inset 0 1px 2px rgba(56, 36, 16, 0.22);
}
#analysis .grow .seg {
  background: linear-gradient(180deg, #a6343e 0%, #7d212b 100%);
  border-radius: 2px;
  box-shadow: inset 0 1px 0 rgba(255, 224, 212, 0.35);
}
#analysis .grow .seg:hover {
  background: linear-gradient(180deg, #c98d3c 0%, #986320 100%);
}
.event-register {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid rgba(154, 118, 66, 0.45);
  color: #2c1b0f;
}
.event-register summary {
  cursor: pointer;
  font: 700 13.5px/1.3 var(--font-cjk);
  color: #3a2413;
}
.event-register button {
  padding: 5px 10px;
  border-bottom: 1px solid rgba(162, 128, 82, 0.45);
  color: #26180d;
  font: 500 13px/1.35 var(--font-cjk);
}
.event-register button:hover { background: rgba(216, 179, 106, 0.2); }
.event-register time { color: #7e1f2a; font-weight: 700; }

/* Cohesive Manor Parchment Ledger Tables */
#analysis .mfilters {
  margin: 0;
  gap: 8px;
}
#analysis .mfilters select.sel {
  min-width: 118px;
  height: 30px;
}
#analysis table.dt {
  width: 100%;
  border-collapse: collapse;
  font: 500 13px/1.38 var(--font-cjk);
  color: #24160c;
}
#analysis table.dt thead th {
  padding: 7px 8px;
  background: linear-gradient(180deg, #e7d4ad 0%, #dfc89e 100%);
  border-top: 1.5px solid #967242;
  border-bottom: 1.5px solid #8a6437;
  color: #2b180b;
  font: 700 12.5px/1.3 var(--font-cjk);
  letter-spacing: 0.03em;
}
#analysis table.dt tbody td {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(154, 118, 66, 0.36);
  color: #26180d;
}
#analysis table.dt tbody tr:nth-child(even) td {
  background: rgba(226, 206, 170, 0.32);
}
#analysis table.dt td:first-child,
#analysis table.dt th:first-child {
  position: sticky;
  left: 0;
}
#analysis table.dt thead th:first-child {
  background: linear-gradient(180deg, #e7d4ad 0%, #dfc89e 100%);
}
#analysis table.dt tbody td:first-child {
  background: #efe1c4;
}
#analysis table.dt tbody tr:nth-child(even) td:first-child {
  background: #e7d6b5;
}
#analysis table.dt tbody tr.click:hover td {
  background: rgba(216, 179, 106, 0.28);
  color: #1e1107;
}
#analysis table.dt tbody tr.cur td {
  background: rgba(216, 174, 104, 0.34);
  color: #24150a;
  font-weight: 700;
}
#analysis table.dt tbody tr.cur td:first-child {
  background: #e2c590;
  box-shadow: inset 3px 0 0 #7e1f2a;
}
#analysis table.dt td b {
  color: #26160b;
  font-weight: 700;
}
#analysis table.dt .dimtxt {
  color: #513a23;
  font-size: 12px;
}
#analysis table.dt .red {
  color: #7e1f2a;
  font-weight: 700;
}
#analysis table.dt .blue {
  color: #1d4064;
  font-weight: 700;
}
#analysis .pbar {
  display: inline-block;
  width: 72px;
  height: 7px;
  border: 1px solid #967242;
  border-radius: 4px;
  background: #d6c09a;
  overflow: hidden;
  vertical-align: middle;
  margin-right: 6px;
}
#analysis .pbar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #8b5b24, #b57b33);
}

/* Compact height tuning for 1366x768 so all 4 contributor rows + chart foot fit with 0 overflow */
@media (min-width: 901px) and (max-height: 850px) {
  .analytics-heading { height: clamp(68px, 9.6vh, 84px); padding: 2px 8px 4px; }
  .analytics-heading h1 { font-size: clamp(22px, 1.95vw, 28px); }
  .analytics-heading em { font-size: 14.5px; }
  .header-map-script { right: 64px; top: 3px; font-size: 16.5px; }
  #analysis .phases { margin-top: 9px; }
  #analysis .phase { height: clamp(118px, 16.2vh, 136px); padding: 4px 7px 3px; }
  #analysis .ribbon-h { height: 28px; font-size: 15px; }
  #analysis .ribbon-h small { font-size: 13px; }
  .phase-title time { padding: 1px 5px; font-size: 12.5px; }
  .phase-body { grid-template-columns: 44% 30px minmax(0, 1fr); gap: 6px; }
  .phase-medallion { width: 30px; height: 30px; }
  .phase-icon { width: 16px; height: 16px; }
  .phase-metric b { font-size: clamp(20px, 1.72vw, 25px); }
  #analysis .phase-metric span { font-size: 13px; }
  .overview { margin-top: 9px; height: clamp(78px, 10.6vh, 92px); padding: 4px 8px 4px; }
  .overview-values { height: calc(100% - 28px); }
  .overview-values p { padding: 1px 4%; gap: 7px; }
  .overview-values svg { width: 28px; height: 28px; padding: 4px; }
  .kpi-copy { font-size: 13.5px; }
  .kpi-copy small { font-size: 12px; }
  .overview-values b { font-size: clamp(19px, 1.6vw, 24px); }
  .analysis-detail {
    margin-top: 9px;
    height: calc(
      100% - clamp(68px, 9.6vh, 84px) - clamp(118px, 16.2vh, 136px) - clamp(78px, 10.6vh, 92px)
      - 27px + 2px
    );
  }
  #analysis .chart,
  .contributions { padding: 7px 9px 6px; }
  .legend { margin: 4px 4px 2px; padding: 2px 8px; font-size: 12.5px; }
  .chart-foot { margin-top: 3px; padding-top: 3px; }
  .jump-btn { height: 24px; padding: 0 7px; font-size: 12px; }
  .contribution-key { margin: 3px 4px 1px; font-size: 12.5px; }
  .contributor {
    grid-template-columns: 24px minmax(0, 1fr) 98px;
    padding: 1px 5px;
    row-gap: 1px;
    column-gap: 7px;
  }
  .contrib-seal { width: 22px; height: 22px; font-size: 12px; }
  .contributor b { font-size: 13.5px; line-height: 1.15; }
  .contributor span { font-size: 16.5px; line-height: 1.1; }
  .contributor .share { font-size: 12px; line-height: 1.1; }
}

@media (max-width: 900px) {
  .overview-values { grid-template-columns: repeat(2, minmax(0, 1fr)); height: auto; row-gap: 6px; background-image: none; }
  .overview { height: auto; }
  .overview-values p { gap: 4px; flex-wrap: wrap; }
  #analysis .phases { grid-template-columns: 1fr; }
  .analysis-detail { height: auto; grid-template-columns: 1fr; }
  #analysis .chart { height: 320px; }
  .overview-values b { margin: 0; }
  .analysis-stack { margin-inline: 0; }
  .chart-foot { flex-wrap: wrap; }
  .jump-triggers { flex-wrap: wrap; }
}
</style>
