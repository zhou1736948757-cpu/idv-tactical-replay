<script setup lang="ts">
import ManorOrnaments from "./tactical/ManorOrnaments.vue";
import { computed, ref } from 'vue';
import type { MatchSummary } from '@idv/replay-renderer';
import { isZipFile } from '@/api/client';
import { flow, importFiles, openEntry } from '@/store/flow';
import { findPilMapByName } from '@/tactical/maps';
import PracticeHistoryDrawer from './flow/PracticeHistoryDrawer.vue';
import { loadMatches, store } from '@/store/app';
import {
  formatDuration,
  formatClock,
  matchMapUrl,
  MODE_OPTIONS,
  modeKey,
  modeShort,
  outcomeSummary,
  pidLabel,
  RESULT_OPTIONS,
  resultKey,
  sourceBadge,
  type ModeKey,
  type ResultKey,
} from '@/lib/format';

const mapFilter = ref<string>('all');
const modeFilter = ref<ModeKey>('all');
const resultFilter = ref<ResultKey>('all');
const query = ref('');

const mapNames = computed(() => [...new Set(store.matches.map((m) => m.map_name))].sort((a, b) => a.localeCompare(b, 'zh')));

const filtered = computed<MatchSummary[]>(() => {
  const q = query.value.trim().toLowerCase();
  return store.matches.filter((m) => {
    if (mapFilter.value !== 'all' && m.map_name !== mapFilter.value) return false;
    if (modeFilter.value !== 'all' && modeKey(m.mode_id) !== modeFilter.value) return false;
    if (resultFilter.value !== 'all' && resultKey(m) !== resultFilter.value) return false;
    if (q) {
      const hay = [
        m.match_id,
        m.map_name,
        m.mode_name,
        m.recorder_name,
        m.hunter.player_name,
        String(m.hunter.pid),
        ...m.survivors.map((s) => s.player_name),
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
});

const outcomes = {
  win: { kind: 'win', zh: '胜利', en: 'Win', description: '监管胜' },
  lose: { kind: 'lose', zh: '失败', en: 'Lose', description: '监管负' },
  tie: { kind: 'neutral', zh: '平局', en: 'Tie', description: '平局' },
  quit: { kind: 'neutral', zh: '自退', en: 'Quit', description: '自退/未分胜负' },
  unknown: { kind: 'neutral', zh: '未知', en: 'N/A', description: '结果未知' },
} as const;

function outcome(m: MatchSummary) {
  const label = m.result_label?.trim();
  if (label) {
    if (label.includes('自退')) return outcomes.quit;
    if (label.includes('监管胜')) return outcomes.win;
    if (label.includes('监管负')) return outcomes.lose;
    if (['平局', '监管平', '监管平局'].includes(label)) return outcomes.tie;
    return outcomes.unknown;
  }
  switch (m.result_code) {
    case 7: return outcomes.win;
    case 9: return outcomes.lose;
    case 3: return outcomes.quit;
    default: return outcomes.unknown;
  }
}

const brokenImg = ref<Record<string, boolean>>({});
function onImgError(id: string): void {
  brokenImg.value = { ...brokenImg.value, [id]: true };
}

// ------------------------------------------------------------------ upload
const dragOver = ref(false);
const uploading = ref(false);
const uploadMsg = ref('');
const uploadErr = ref('');
const lastUploaded = ref<MatchSummary[]>([]);
const historyOpen = ref(false);
const bestScores = computed(() => {
  const scores = new Map<string, number>();
  for (const record of flow.history) scores.set(record.matchId, Math.max(scores.get(record.matchId) ?? 0, record.totalScore));
  return scores;
});
const fileInput = ref<HTMLInputElement | null>(null);

async function handleFile(file: File | null | undefined): Promise<void> {
  uploadErr.value = '';
  uploadMsg.value = '';
  if (!file) return;
  if (!isZipFile(file)) {
    uploadErr.value = '仅支持 .zip 录像压缩包（请直接上传游戏录像文件夹压缩包）';
    return;
  }
  uploading.value = true;
  uploadMsg.value = `正在上传并安全解析 ${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）…`;
  try {
    const matches = await importFiles([file]);
    lastUploaded.value = matches;
    uploadMsg.value = matches.length > 0 ? `已导入 ${matches.length} 场对局，点击下方档案即可打开` : '压缩包中未发现可解析的对局录像';
  } catch (err) {
    uploadMsg.value = '';
    uploadErr.value = `导入失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    uploading.value = false;
  }
}

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  void handleFile(f);
}

function open(m: MatchSummary, entry: 'sandbox' | 'practice' = 'sandbox'): void {
  void openEntry(m.match_id, entry);
}

function onCardKeydown(e: KeyboardEvent, m: MatchSummary): void {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const target = e.target as HTMLElement | null;
  if (target && target !== e.currentTarget && target.closest('button, a, input, select, textarea')) return;
  e.preventDefault();
  open(m);
}
</script>

<template>
  <div id="archive">
    <section class="archive-board">
      <header class="archive-heading">
        <div class="heading-main">
          <h1>档案库 <span>· 对局档案与双路径中心</span></h1>
          <div class="heading-sub">
            <em>Match Archive — Match Library &amp; Dual-Path Hub</em>
            <button class="history-link" @click="historyOpen = true">盲练记录</button>
          </div>
        </div>
        <div class="ornate-rule" aria-hidden="true"><span></span></div>
      </header>
      <div id="filters">
        <b class="count">
          <svg class="count-emblem" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.4 9.7 6.3 14.6 8 9.7 9.7 8 14.6 6.3 9.7 1.4 8 6.3 6.3Z" />
          </svg>
          对局列表 · 共 <em class="num">{{ filtered.length }}</em><template v-if="filtered.length !== store.matches.length"> / {{ store.matches.length }}</template> 场
        </b>
        <label class="filter-field">
          <span class="filter-lbl">地图</span>
          <select v-model="mapFilter" class="sel" data-test="f-map" aria-label="地图">
            <option value="all">全部地图</option>
            <option v-for="n in mapNames" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
        <label class="filter-field">
          <span class="filter-lbl">模式</span>
          <select v-model="modeFilter" class="sel" data-test="f-mode" aria-label="模式">
            <option v-for="o in MODE_OPTIONS" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
        </label>
        <label class="filter-field">
          <span class="filter-lbl">结果</span>
          <select v-model="resultFilter" class="sel" data-test="f-result" aria-label="结果">
            <option v-for="o in RESULT_OPTIONS" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
        </label>
        <input v-model="query" class="search" data-test="f-q" aria-label="搜索玩家、地图、对局 ID 或 PID" placeholder="搜索玩家 / 地图 / PID" />
        <button class="gbtn fr cut sm" :disabled="store.matchesLoading" @click="loadMatches">刷新</button>
      </div>
      <p v-if="store.matchesError" class="err" data-test="list-error">{{ store.matchesError }}</p>
      <p v-if="store.matchesLoading && !store.matches.length" class="empty">档案调阅中…</p>
      <div id="mapGrid">
        <article v-for="m in filtered" :key="m.match_id" class="mapcard paper-folio"
          :class="{ sel: store.selectedId === m.match_id }" :data-match="m.match_id" @click="open(m)">
          <figure class="photograph">
            <span class="photo-mount">
              <img v-if="matchMapUrl(m) && !brokenImg[m.match_id]" :src="matchMapUrl(m) ?? undefined"
                :alt="m.map_name" loading="lazy" @error="onImgError(m.match_id)" />
              <span v-else class="photo-missing">暂无地图照片</span>
            </span>
            <ManorOrnaments kind="rivet" />
          </figure>
          <div class="card-copy" tabindex="0">
            <h2>{{ m.map_name }}</h2>
            <em>{{ findPilMapByName(m.map_name)?.mapNameEn }}</em>
            <div class="copy-rule" aria-hidden="true"></div>
            <p class="meta-row meta-verdict">
              <span class="meta-k">
                <svg class="meta-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5v11M3 3.2h8.6l-1.8 2.8 1.8 2.8H3" /></svg>结果
              </span>
              <span class="meta-v">
                <strong :class="outcome(m).kind">{{ m.result_label || outcome(m).description }}</strong>
                <span class="meta-sep">·</span>{{ modeShort(m) }} · {{ sourceBadge(m) }}
                <b v-if="store.recentUploads.includes(m.match_id)" class="new-tag">新</b>
              </span>
            </p>
            <p class="meta-row meta-hunter">
              <span class="meta-k">
                <svg class="meta-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 7.5a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM3.4 13.6c.6-2.5 2.4-3.8 4.6-3.8s4 1.3 4.6 3.8Z" /></svg>监管
              </span>
              <span class="meta-v">{{ pidLabel(m.hunter.pid) }} · {{ m.hunter.player_name }}</span>
            </p>
            <p class="meta-row">
              <span class="meta-k">
                <svg class="meta-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 6.8a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM10.8 7.3a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4ZM2.2 13.2c.4-2 1.7-3.1 3.4-3.1s3 1.1 3.4 3.1M9.1 13.2c.3-1.4 1.2-2.2 2.4-2.2 1.1 0 2 .8 2.3 2.2" /></svg>战况
              </span>
              <span class="meta-v">
                {{ outcomeSummary(m) }}<template v-if="m.is_bot_match"> · 人机</template><template v-if="bestScores.has(m.match_id)"> · 盲练 {{ bestScores.get(m.match_id) }} 分</template>
              </span>
            </p>
            <p class="meta-row" :title="formatDuration(m.duration_s)">
              <span class="meta-k">
                <svg class="meta-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" /><path d="M8 4.8V8l2.5 1.6" /></svg>时长
              </span>
              <span class="meta-v num">{{ formatClock(m.duration_s) }}</span>
            </p>
            <p class="meta-row meta-time">
              <span class="meta-k">
                <svg class="meta-ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="3.4" width="11.2" height="10" rx="1.4" /><path d="M5.2 2v2.4M10.8 2v2.4M2.4 6.6h11.2" /></svg>存档
              </span>
              <time class="meta-v num">{{ m.save_time_utc8 }} (UTC+8)</time>
            </p>
          </div>
          <ManorOrnaments :kind="outcome(m).kind" :label-pair="outcome(m)" />
          <div class="entry-buttons">
            <button class="cta-replay" data-test="entry-replay" @click.stop="open(m)">▶ 实况复盘</button>
            <button class="cta-practice" data-test="entry-practice" @click.stop="open(m, 'practice')">⚔ 盲练开局</button>
          </div>
        </article>
        <p v-if="!store.matchesLoading && !filtered.length" class="empty">{{ store.matches.length ? '无符合筛选条件的档案' : '暂无对局档案' }}</p>
      </div>
    </section>
    <aside class="folio-stack import-stack">
      <div id="dropZone" class="paper-folio folio-inner" :class="{ over: dragOver }" data-test="dropzone"
        @dragover.prevent="dragOver = true" @dragleave.prevent="dragOver = false" @drop="dragOver = false">
        <header>
          <div class="import-title">
            <h2>导入对局</h2>
            <em>Import Match</em>
          </div>
          <ManorOrnaments kind="laurel" />
          <div class="ornate-rule folio-rule" aria-hidden="true"><span></span></div>
        </header>
        <div class="import-copy">
          <p class="import-copy-zh">导入游戏对局录像文件，<br />生成可复盘、可盲练的对局档案。</p>
          <em class="import-copy-en">Import a match file to generate a replay and blind-start practice.</em>
        </div>
        <div class="drop-well">
          <svg class="zip-doc-icon" viewBox="0 0 56 66" aria-hidden="true" focusable="false">
            <path d="M7 4h29l13 13v42a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" fill="#f7ebd2" stroke="#6f4d28" stroke-width="2.1" stroke-linejoin="round" />
            <path d="M9.5 7.5h24.5l11.5 11.5v37.5h-36Z" fill="none" stroke="#c39d63" stroke-width="0.9" opacity="0.72" />
            <path d="M36 4v11a2 2 0 0 0 2 2h11" fill="#e2ca9d" stroke="#6f4d28" stroke-width="1.9" stroke-linejoin="round" />
            <path d="M13 48.5h30" stroke="#a6814e" stroke-width="0.9" opacity="0.65" />
            <text x="28" y="42" text-anchor="middle" fill="#472d14" font-family="var(--font-num, Georgia, serif)" font-weight="700" font-size="18">.zip</text>
          </svg>
          <strong>将对局文件 (.zip) 拖至此处</strong>
          <em>Drag and drop a match file (.zip) here</em>
        </div>
        <div class="import-or" aria-hidden="true"><span>或</span></div>
        <button class="cta-practice pick" :disabled="uploading" data-test="pick-btn" @click="fileInput?.click()">
          <svg class="pick-folder-icon" viewBox="0 0 24 20" aria-hidden="true" focusable="false">
            <path d="M2 4.2A2.2 2.2 0 0 1 4.2 2h4.7l2.1 2.2h8.8A2.2 2.2 0 0 1 22 6.4v9.4A2.2 2.2 0 0 1 19.8 18H4.2A2.2 2.2 0 0 1 2 15.8Z" fill="#4a3017" stroke="#2a180b" stroke-width="1.2" stroke-linejoin="round" />
            <path d="M2.6 7.4h18.8v8.4c0 .9-.7 1.6-1.6 1.6H4.2c-.9 0-1.6-.7-1.6-1.6Z" fill="#704c26" stroke="#2a180b" stroke-width="1.1" />
            <path d="M4.2 9.4h15.6" stroke="#f2d69f" stroke-width="1" opacity="0.65" />
          </svg>
          <span class="pick-copy">
            <span class="pick-zh">{{ uploading ? '解析中…' : '选择文件' }}</span>
            <small class="pick-en">Select .zip File</small>
          </span>
        </button>
        <input ref="fileInput" type="file" accept=".zip,application/zip" data-test="file-input" @change="onPick" />
        <span v-if="uploadMsg" class="ok" data-test="upload-msg">{{ uploadMsg }}</span>
        <span v-if="uploadErr" class="err" data-test="upload-err">{{ uploadErr }}</span>
        <div v-if="lastUploaded.length" class="uplist">
          <button v-for="m in lastUploaded" :key="m.match_id" class="gbtn fr cut sm on" data-test="open-uploaded" @click="open(m)">
            打开 {{ m.map_name }} · {{ m.save_time_utc8.slice(5, 16) }}
          </button>
        </div>
        <div class="drop-foot">
          <img class="drop-etching" src="/assets/dossier/parchment-etching-gate.png" alt="" />
          <span class="manor-signature" aria-hidden="true">Oletus Manor</span>
        </div>
      </div>
      <ManorOrnaments kind="clip" />
    </aside>
  </div>
  <PracticeHistoryDrawer v-if="historyOpen" @close="historyOpen = false" />
</template>

<style scoped>
#archive {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 25.55%;
  gap: 14px;
  margin: 0;
  height: 100%;
}

/* Carved slate-walnut exhibition board with 6px inset double antique-gold hairline frame (0 DOM clutter) */
.archive-board {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  padding: 12px 14px 14px;
  border: 1.5px solid #b89154;
  border-radius: 6px;
  background:
    linear-gradient(90deg, rgba(212, 172, 104, 0.56), rgba(212, 172, 104, 0.56)) 6px 6px / calc(100% - 12px) 1px no-repeat,
    linear-gradient(90deg, rgba(212, 172, 104, 0.56), rgba(212, 172, 104, 0.56)) 6px calc(100% - 6px) / calc(100% - 12px) 1px no-repeat,
    linear-gradient(180deg, rgba(212, 172, 104, 0.56), rgba(212, 172, 104, 0.56)) 6px 6px / 1px calc(100% - 12px) no-repeat,
    linear-gradient(180deg, rgba(212, 172, 104, 0.56), rgba(212, 172, 104, 0.56)) calc(100% - 6px) 6px / 1px calc(100% - 12px) no-repeat,
    radial-gradient(ellipse at 26% 0%, rgba(224, 182, 112, 0.12), transparent 54%),
    repeating-linear-gradient(178deg, rgba(255, 226, 174, 0.022) 0 2px, transparent 2px 6px),
    linear-gradient(114deg, rgba(29, 30, 34, 0.96), rgba(24, 24, 27, 0.97) 52%, rgba(33, 28, 24, 0.96)),
    url('/assets/bg.jpg') center / cover;
  box-shadow:
    inset 0 0 0 2px rgba(24, 20, 16, 0.85),
    inset 0 1px 0 rgba(250, 224, 168, 0.24),
    0 12px 30px rgba(0, 0, 0, 0.52);
}

/* Sculpted dark/gold header with carriage etching and diamond divider */
.archive-heading {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  gap: 0;
  min-height: 75px;
  padding: 2px 10px 6px 14px;
  border-bottom: 0;
  color: #fce8be;
}
.archive-heading::after {
  right: 12px;
  top: 2px;
  bottom: 7px;
  width: 34%;
  max-width: 332px;
  opacity: 0.96;
  filter: brightness(2.75) sepia(0.46) saturate(1.22) contrast(1.12);
}
.heading-main { position: relative; z-index: 1; max-width: 68%; }
.archive-heading h1 {
  font-size: clamp(24px, 2.2vw, 34px);
  font-weight: 700;
  line-height: 1.18;
  letter-spacing: 0.05em;
  color: #fce8be;
  text-shadow: 0 2px 6px rgba(8, 5, 2, 0.82);
}
.archive-heading h1 span {
  font-size: 0.66em;
  font-weight: 600;
  color: #f3deb3;
  letter-spacing: 0.04em;
}
.heading-sub {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-top: 2px;
}
.archive-heading em,
.import-stack em {
  font: italic 600 18px/1.2 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
}
.archive-heading em { color: #e4c794; letter-spacing: 0.015em; }
.history-link {
  padding: 2px 9px;
  border: 1px solid #b58d52;
  border-radius: 4px;
  background: linear-gradient(180deg, #2d3544 0%, #1c222e 100%);
  box-shadow: inset 0 0 0 1px rgba(244, 214, 154, 0.2), 0 1px 3px rgba(0, 0, 0, 0.45);
  color: #f6e3be;
  font: 600 12px/1.35 var(--font-cjk);
  letter-spacing: 0.04em;
  white-space: nowrap;
  transition: border-color 0.2s, background 0.2s;
}
.history-link:hover,
.history-link:focus-visible {
  border-color: #f5d694;
  background: linear-gradient(180deg, #3c4658, #242c3b);
  outline: none;
}

.ornate-rule {
  position: relative;
  height: 5px;
  margin-top: 5px;
  border-top: 1px solid #c09859;
  border-bottom: 1px solid rgba(244, 214, 152, 0.36);
}
.ornate-rule span {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 7px;
  height: 7px;
  background: #d8ac67;
  border: 1px solid #ffebb8;
  transform: translate(-50%, -50%) rotate(45deg);
}

/* Sculpted recessed dark-slate brass filter controls (6 exact direct children preserved) */
#filters {
  display: grid;
  grid-template-columns: 20.4% 12.6% 12.9% 12.9% 22.7% minmax(56px, 9.6%);
  align-items: center;
  gap: 7px;
  padding: 3px 0 10px 9px;
}
#filters .count {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  color: #f3dfb6;
  font: 600 14.5px/1.2 var(--font-cjk);
  letter-spacing: 0.03em;
  white-space: nowrap;
}
#filters .count-emblem {
  width: 13px;
  height: 13px;
  flex: none;
  fill: #e2b86d;
  stroke: #7a5526;
  stroke-width: 0.7;
}
#filters .count em {
  font: 700 17px/1 var(--font-num, Georgia, serif);
  font-style: normal;
  color: #ff9a73;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.65);
}
#filters .filter-field {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  height: 33px;
}
#filters .filter-lbl {
  flex: none;
  color: #dfc391;
  font: 600 12px/1 var(--font-cjk);
  letter-spacing: 0.02em;
  white-space: nowrap;
}
#filters select.sel {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  height: 33px;
  padding: 2px 21px 2px 7px;
  border: 1px solid #a9834c;
  border-radius: 4px;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  background-color: #1c1712;
  background-image:
    var(--chevron-gold),
    linear-gradient(180deg, #16120e 0%, #241d16 100%);
  background-position: right 6px center, 0 0;
  background-size: 9px 6px, 100% 100%;
  background-repeat: no-repeat;
  box-shadow:
    inset 0 1px 3px rgba(0, 0, 0, 0.72),
    0 1px 0 rgba(244, 214, 154, 0.16);
  color: #f6e7c9;
  font: 600 12.5px/1.2 var(--font-cjk);
  letter-spacing: 0.01em;
}
#filters select.sel option { background: #1e1812; color: #f6e7c9; }
#filters input.search {
  width: 100%;
  min-width: 0;
  height: 33px;
  padding: 2px 10px;
  border: 1px solid #a6824c;
  border-radius: 4px;
  background: linear-gradient(180deg, #15110d 0%, #221b15 100%);
  box-shadow:
    inset 0 1px 3px rgba(0, 0, 0, 0.72),
    0 1px 0 rgba(244, 214, 154, 0.15);
  color: #f6e7c9;
  font: 600 12.5px/1.2 var(--font-cjk);
  letter-spacing: 0.02em;
}
#filters input.search::placeholder { color: #c9b592; opacity: 1; }
#filters button.gbtn {
  width: 100%;
  min-width: 0;
  height: 33px;
  padding: 2px 9px;
  border: 1px solid #b58d52;
  border-radius: 4px;
  background: linear-gradient(180deg, #4b3927 0%, #312418 54%, #251b12 100%);
  box-shadow:
    inset 0 0 0 1px rgba(244, 214, 154, 0.34),
    inset 0 1px 0 rgba(255, 242, 206, 0.24),
    0 2px 4px rgba(8, 6, 4, 0.55);
  color: #fff2d6;
  font: 700 13px/1.2 var(--font-cjk);
  letter-spacing: 0.04em;
  clip-path: none;
}
#filters :is(select.sel, input.search, button.gbtn):hover,
#filters :is(select.sel, input.search, button.gbtn):focus-visible {
  border-color: #f2cf8c;
  outline: none;
}
#filters button.gbtn::before { content: none; }

/* 2x2 Match Card Grid */
#mapGrid {
  flex: 1;
  min-height: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: calc((100% - 12px) / 2);
  gap: 12px;
  padding: 2px 2px 4px;
  scrollbar-width: none;
}

/* Engraved double-gold warm parchment dossier card */
#mapGrid .mapcard {
  position: relative;
  display: block;
  min-height: 0;
  padding: 14px 16px;
  overflow: hidden;
  border: 1px solid #a47e49;
  border-radius: 5px;
  background:
    linear-gradient(90deg, rgba(154, 114, 60, 0.48), rgba(154, 114, 60, 0.48)) 5px 5px / calc(100% - 10px) 1px no-repeat,
    linear-gradient(90deg, rgba(154, 114, 60, 0.48), rgba(154, 114, 60, 0.48)) 5px calc(100% - 5px) / calc(100% - 10px) 1px no-repeat,
    linear-gradient(180deg, rgba(154, 114, 60, 0.48), rgba(154, 114, 60, 0.48)) 5px 5px / 1px calc(100% - 10px) no-repeat,
    linear-gradient(180deg, rgba(154, 114, 60, 0.48), rgba(154, 114, 60, 0.48)) calc(100% - 5px) 5px / 1px calc(100% - 10px) no-repeat,
    radial-gradient(ellipse at 50% 44%, rgba(255, 249, 234, 0.34) 44%, rgba(140, 96, 46, 0.18) 100%),
    var(--paper-stock);
  box-shadow:
    inset 0 0 0 1px rgba(255, 249, 232, 0.68),
    0 10px 26px rgba(0, 0, 0, 0.38),
    0 2px 6px rgba(0, 0, 0, 0.24);
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}
#mapGrid .mapcard:hover,
#mapGrid .mapcard.sel {
  border-color: #c89c58;
  box-shadow:
    inset 0 0 0 1px rgba(255, 250, 236, 0.8),
    0 12px 30px rgba(0, 0, 0, 0.46),
    0 3px 8px rgba(0, 0, 0, 0.28);
}
.mapcard::after { display: none; }

/* Upright pinned archival map plate with double border, dark bronze inner bezel & top-left brass rivet */
.photograph {
  position: absolute;
  left: 12px;
  top: 15px;
  bottom: 54px;
  width: 39.2%;
  margin: 0;
  z-index: 2;
  display: block;
  background: transparent;
  border: 0;
  box-shadow: none;
}
.photo-mount {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  padding: 5px;
  border: 1.5px solid #8f6b3e;
  border-radius: 2px;
  background: linear-gradient(155deg, #f5e7c9, #e1cba3);
  box-shadow:
    inset 0 0 0 1px #fdf3db,
    inset 0 0 0 2.5px rgba(124, 88, 44, 0.4),
    1px 3px 7px rgba(48, 28, 12, 0.42);
  transform: none;
}
#mapGrid .photograph img {
  position: static;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: 1.5px solid #593e22;
  filter: brightness(1.18) contrast(1.12) saturate(1.06) sepia(0.06);
  transition: filter 0.2s ease;
}
#mapGrid .mapcard:hover .photograph img {
  transform: none;
  filter: brightness(1.26) contrast(1.14) saturate(1.1) sepia(0.04);
}
.photo-missing {
  color: #46311f;
  font: 600 13px var(--font-cjk);
  text-align: center;
  padding: 8px;
}
.photograph .folio-rivet {
  position: absolute;
  top: -5px;
  left: -4px;
  width: 17px;
  height: 17px;
  z-index: 4;
  filter: drop-shadow(1px 2px 2px rgba(42, 24, 10, 0.62));
}

/* Archival card copy & ruled ledger rows with antique bronze mini-icons */
.card-copy {
  position: absolute;
  inset: 13px 12px 54px calc(39.2% + 22px);
  z-index: 2;
  overflow: auto;
  scrollbar-width: thin;
  color: #26180f;
  font: 500 13.5px/1.36 var(--font-cjk);
  overflow-wrap: anywhere;
}
.card-copy h2,
.card-copy em,
.card-copy .meta-verdict,
.card-copy .meta-hunter {
  padding-right: 76px;
}
.card-copy h2 {
  display: block;
  margin: 0;
  color: #24150c;
  font-size: clamp(20px, 1.75vw, 27px);
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: 0.03em;
  text-shadow: 0 1px 0 rgba(255, 248, 232, 0.72);
}
.card-copy em {
  display: block;
  margin-top: 2px;
  color: #533820;
  font: italic 600 14.5px/1.2 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
}
.copy-rule {
  position: relative;
  height: 4px;
  margin: 5px 80px 4px 0;
  border-top: 1px solid #a48153;
  border-bottom: 1px solid rgba(255, 244, 214, 0.72);
}
.copy-rule::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 5px;
  height: 5px;
  background: #9c7442;
  transform: translate(-50%, -50%) rotate(45deg);
}
.card-copy .meta-row {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  align-items: baseline;
  gap: 3px;
  margin: 0;
  padding-block: 3px;
  border-top: 1px solid rgba(154, 118, 72, 0.34);
}
.card-copy .meta-row.meta-verdict { border-top: 0; padding-top: 1px; }
.card-copy .meta-k {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: #4f3721;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.card-copy .meta-ic {
  width: 12px;
  height: 12px;
  flex: none;
  fill: none;
  stroke: #5c3d1e;
  stroke-width: 1.45;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.card-copy .meta-v {
  color: #24160d;
  font-size: 13.5px;
  min-width: 0;
}
.card-copy .meta-time .meta-v {
  font-size: 12.5px;
  color: #362417;
}
.card-copy strong {
  display: inline;
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: #4d3521;
}
.card-copy strong.win { color: #7e1f2a; }
.card-copy strong.lose { color: #1d4064; }
.card-copy strong.neutral { color: #4a3521; }
.card-copy .meta-sep { margin: 0 4px; color: #614730; }
.card-copy .new-tag {
  display: inline-block;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 2px;
  background: #7c232d;
  color: #fff3d8;
  font-size: 12px;
  line-height: 1.3;
}

/* Wax seal with crisp drop shadow */
#mapGrid .wax-seal {
  top: 6px;
  right: 7px;
  width: 76px;
  height: 92px;
  z-index: 4;
  filter: drop-shadow(2px 4px 3px rgba(48, 25, 13, 0.52));
}

/* Dual sculpted cast-bronze & champagne-brass CTA plaques */
.entry-buttons {
  position: absolute;
  right: 18px;
  bottom: 11px;
  z-index: 4;
  display: flex;
  justify-content: flex-end;
  gap: 7px;
  width: 76%;
}
.entry-buttons button {
  width: min(39.8%, 168px);
  height: 38px;
  padding: 4px 10px;
  border-radius: 5px;
  font: 700 15.5px/1.1 var(--font-cjk);
  letter-spacing: 0.04em;
  transition: transform 0.14s ease, filter 0.14s ease;
}
.entry-buttons .cta-replay {
  border: 1.5px solid #8a6437;
  background: linear-gradient(180deg, #6d4f2f 0%, #4b331e 50%, #372314 100%);
  box-shadow:
    inset 0 0 0 1px rgba(244, 214, 158, 0.54),
    inset 0 2px 1px rgba(255, 244, 214, 0.36),
    inset 0 -2px 2px rgba(18, 10, 4, 0.7),
    0 2px 5px rgba(42, 24, 10, 0.44);
  color: #fff4da;
}
.entry-buttons .cta-practice,
#dropZone .pick {
  border: 1.5px solid #8f6939;
  background: linear-gradient(180deg, #fcf2d4 0%, #eed8a8 52%, #d8b577 100%);
  box-shadow:
    inset 0 0 0 1px rgba(255, 251, 236, 0.88),
    inset 0 2px 1px rgba(255, 252, 238, 0.65),
    inset 0 -2px 3px rgba(128, 86, 38, 0.38),
    0 2px 5px rgba(48, 30, 14, 0.36);
  color: #28170b;
}
.entry-buttons button:hover,
#dropZone .pick:hover {
  filter: brightness(1.06);
  transform: translateY(-1px);
}
.entry-buttons button:focus-visible,
#dropZone .pick:focus-visible {
  outline: 2px solid #8a561e;
  outline-offset: 2px;
}

/* Right Import Folio (inherits 7px inset antique gold frame from dossier-views.css) */
.import-stack {
  min-width: 0;
  min-height: 0;
}
#dropZone {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  padding: 18px 20px 16px;
  gap: 6px;
  box-shadow: none;
  overflow: auto;
}
#dropZone::after { display: none; }

#dropZone header {
  position: relative;
  text-align: left;
  padding: 24px 0 6px;
  border-bottom: 0;
}
.import-title {
  padding-right: 58px;
}
#dropZone h2 {
  color: #24150c;
  font-size: clamp(26px, 2.35vw, 36px);
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: 0.04em;
  text-shadow: 0 1px 0 rgba(255, 248, 232, 0.72);
}
#dropZone header em {
  display: block;
  margin-top: 2px;
  color: #533820;
  font: italic 600 clamp(17px, 1.45vw, 22px)/1.18 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
}
#dropZone header .folio-laurel {
  position: absolute;
  right: 2px;
  top: 28px;
  width: 50px;
  height: 50px;
  z-index: 2;
  pointer-events: none;
}
.folio-rule {
  margin-top: 10px;
  border-top-color: #9e7a4c;
  border-bottom-color: rgba(255, 245, 218, 0.85);
}
.folio-rule span {
  background: #9c7240;
  border-color: #f6e3ba;
}

.import-copy {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  margin: 0;
  padding: 12px 0 14px;
  text-align: left;
}
.import-copy-zh {
  margin: 0;
  color: #2b1a0e;
  font: 600 clamp(13.5px, 1.05vw, 15.5px)/1.52 var(--font-cjk);
}
.import-copy-en {
  display: block;
  color: #4f3720;
  font: italic 600 13.5px/1.3 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
}

.drop-well {
  position: relative;
  flex: 0 0 258px;
  min-height: 158px;
  max-height: 268px;
  padding: 14px 12px;
  border: 1.5px dashed rgba(138, 102, 48, 0.58);
  border-radius: 6px;
  background:
    radial-gradient(ellipse at 50% 48%, rgba(255, 248, 232, 0.34), rgba(220, 198, 160, 0.28));
  box-shadow: inset 0 1px 4px rgba(82, 54, 24, 0.08);
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.zip-doc-icon {
  width: 52px;
  height: 62px;
  flex: none;
  filter: drop-shadow(1px 2px 3px rgba(72, 46, 18, 0.24));
}
.drop-well strong {
  color: #26170d;
  font-size: clamp(14.5px, 1.15vw, 17px);
  font-weight: 700;
  line-height: 1.25;
}
.drop-well em {
  color: #4d3621;
  font: italic 600 13.5px/1.22 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
}

/* Subtle centered — 或 — hairline divider */
.import-or {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 14% 6px;
  color: #4d341c;
  font: 600 12.5px/1 var(--font-cjk);
}
.import-or::before,
.import-or::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, #8e693b 24%, #8e693b 76%, transparent 100%);
}

#dropZone .pick {
  flex: none;
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 75.5%;
  height: 52px;
  margin: 2px 0 4px;
  padding: 4px 14px;
}
.pick-folder-icon {
  width: 24px;
  height: 20px;
  flex: none;
}
.pick-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.1;
  text-align: left;
}
.pick-zh {
  font: 700 17.5px/1.15 var(--font-cjk);
  letter-spacing: 0.06em;
  color: #261509;
}
.pick-en {
  font: italic 600 12.5px/1.1 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
  color: #4a3017;
  letter-spacing: 0.02em;
}

.drop-foot {
  position: relative;
  flex: 1 1 112px;
  min-height: 92px;
  max-height: 156px;
  margin-top: auto;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.drop-etching {
  width: 100%;
  height: 100%;
  min-height: 92px;
  max-height: 152px;
  object-fit: contain;
  object-position: center bottom;
  mix-blend-mode: multiply;
  opacity: 0.94;
}
.manor-signature {
  position: absolute;
  right: 4px;
  bottom: 2px;
  padding: 0 4px;
  background: rgba(238, 224, 196, 0.78);
  border-radius: 3px;
  color: #4f351c;
  font: italic 600 13px/1.15 var(--font-hand, var(--font-num));
  letter-spacing: 0.04em;
  transform: rotate(-5deg);
  pointer-events: none;
}

@media (max-height: 810px) {
  .archive-heading { min-height: 60px; padding-bottom: 4px; }
  .archive-heading h1 { font-size: clamp(22px, 1.9vw, 28px); }
  .archive-heading em { font-size: 15.5px; }
  #filters { padding-top: 2px; padding-bottom: 7px; gap: 6px; }
  #filters .count { font-size: 13.5px; }
  #filters .count em { font-size: 15.5px; }
  .photograph { top: 11px; bottom: 50px; }
  .card-copy { top: 9px; bottom: 50px; line-height: 1.24; }
  .card-copy h2 { font-size: clamp(18px, 1.55vw, 24px); line-height: 1.14; }
  .card-copy em { font-size: 13px; }
  .copy-rule { margin: 4px 78px 3px 0; }
  .card-copy .meta-row { padding-block: 2px; }
  .card-copy .meta-v { font-size: 12.5px; }
  .card-copy strong { font-size: 13px; }
  .card-copy .meta-time .meta-v { font-size: 12px; }
  .entry-buttons { bottom: 8px; }
  .entry-buttons button { height: 35px; font-size: 14.5px; }
  #dropZone { padding: 16px 18px 14px; gap: 4px; }
  #dropZone header { padding: 22px 0 3px; }
  #dropZone h2 { font-size: clamp(22px, 2vw, 28px); }
  #dropZone header em { font-size: 15.5px; }
  #dropZone header .folio-laurel { top: 26px; width: 42px; height: 42px; }
  .folio-rule { margin-top: 6px; }
  .import-copy { padding: 2px 0 3px; gap: 2px; }
  .import-copy-zh { font-size: 13px; line-height: 1.4; }
  .import-copy-en { font-size: 12.5px; line-height: 1.22; }
  .drop-well { flex: 1 1 142px; min-height: 130px; max-height: 170px; padding: 9px 8px; gap: 4px; }
  .zip-doc-icon { width: 42px; height: 50px; }
  .drop-well strong { font-size: 14px; }
  .drop-well em { font-size: 12.5px; }
  .import-or { margin: 2px 14% 1px; }
  #dropZone .pick { width: 78%; height: 46px; margin: 1px 0 2px; }
  .pick-zh { font-size: 16px; }
  .pick-en { font-size: 12px; }
  .drop-foot { min-height: 82px; max-height: 118px; }
  .drop-etching { min-height: 82px; max-height: 114px; }
}

@media (max-width: 920px) {
  #archive { display: block; overflow: auto; }
  .archive-board { min-height: 580px; }
  #mapGrid { grid-auto-rows: minmax(240px, auto); }
  #filters { display: flex; flex-wrap: wrap; }
  #filters > * { flex: 1 1 95px; }
  .import-stack { margin-top: 14px; }
  #dropZone { min-height: 500px; }
}
@media (max-width: 680px) {
  #mapGrid { grid-template-columns: 1fr; }
  .archive-heading::after { display: none; }
}
</style>
