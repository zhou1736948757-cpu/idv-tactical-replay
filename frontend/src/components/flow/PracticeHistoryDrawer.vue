<script setup lang="ts">
import { computed } from 'vue';
import { flow, openEntry } from '@/store/flow';
import { MAPS_DATA } from '@/tactical/maps';
defineEmits<{ close: [] }>();
const mapStats = computed(() => MAPS_DATA.flatMap(({ mapId, mapName }) => {
  const records = flow.history.filter((record) => record.mapId === mapId);
  if (!records.length) return [];
  const rate = (total: number, slots = 1) => Math.round(total * 100 / (records.length * slots));
  return [{ mapId, mapName, survivor: rate(records.reduce((sum, record) => sum + record.survivorHits, 0), 4),
    hunter: rate(records.filter((record) => record.hunterHit).length),
    lock: rate(records.filter((record) => record.lockCipherMatch).length) }];
}));
const average = computed(() => Math.round(flow.history.reduce((sum, record) => sum + record.totalScore, 0) / flow.history.length));
</script>
<template>
  <aside class="history paper-folio" aria-label="盲练记录" data-test="practice-history">
    <header class="history-head">
      <div>
        <h2>盲练记录</h2>
        <em>Blind Practice Ledger</em>
      </div>
      <button class="gbtn history-close" @click="$emit('close')">关闭</button>
    </header>
    <div class="history-rule" aria-hidden="true"><span></span></div>
    <p v-if="flow.history.length" class="history-summary">
      {{ flow.history.length }} 次练习 · 平均 <b class="num">{{ average }}</b> 分
    </p>
    <p v-else class="history-empty">暂无练习记录</p>
    <div v-if="mapStats.length" class="history-stats">
      <h3 class="ribbon-h">地图统计 <small>Map Accuracy</small></h3>
      <p v-for="stat in mapStats" :key="stat.mapId" class="stat-row">
        {{ stat.mapName }} · 求生 {{ stat.survivor }}% · 监管 {{ stat.hunter }}% · 封禁 {{ stat.lock }}%
      </p>
    </div>
    <ul v-if="flow.history.length" class="history-list">
      <li v-for="(record, index) in flow.history.slice().reverse()" :key="index" class="history-item">
        <span class="history-meta">
          {{ MAPS_DATA[record.mapId]?.mapName }} · <b class="num">{{ record.totalScore }}</b> 分 · 求生 {{ record.survivorHits }}/4 · 监管 {{ record.hunterHit ? '命中' : '偏差' }}
        </span>
        <div class="history-actions">
          <button v-if="record.attempt" class="gbtn" @click="openEntry(record.matchId, 'practice', { reviewedAttempt: record.attempt })">查看对照</button>
          <button class="gbtn on" @click="openEntry(record.matchId, 'practice')">再练一次</button>
        </div>
      </li>
    </ul>
  </aside>
</template>
<style scoped>
.history {
  position: fixed;
  z-index: 45;
  inset: 60px 0 0 auto;
  width: min(440px, 100%);
  overflow: auto;
  padding: 20px 22px 24px;
  border-left: 1.5px solid #9e7b4b;
  border-radius: 4px 0 0 4px;
  color: #24160c;
  font-family: var(--font-cjk);
}
.history-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.history-head h2 {
  margin: 0;
  color: #24150c;
  font: 700 24px/1.15 var(--font-cjk);
  letter-spacing: 0.04em;
}
.history-head em {
  display: block;
  margin-top: 2px;
  color: #533820;
  font: italic 600 14.5px/1.2 var(--font-num, Georgia, serif);
  font-synthesis-style: none;
}
.history-close {
  padding: 4px 12px;
  font-size: 13px;
}
.history-rule {
  position: relative;
  height: 5px;
  margin: 10px 0 12px;
  border-top: 1px solid #9e7a4c;
  border-bottom: 1px solid rgba(255, 246, 222, 0.8);
}
.history-rule span {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 6px;
  height: 6px;
  background: #9c7240;
  border: 1px solid #f6e3ba;
  transform: translate(-50%, -50%) rotate(45deg);
}
.history-summary {
  margin: 0 0 12px;
  padding: 8px 12px;
  border: 1px solid rgba(154, 118, 66, 0.55);
  border-radius: 4px;
  background: linear-gradient(180deg, rgba(246, 236, 214, 0.72), rgba(226, 206, 170, 0.45));
  color: #2c1a0e;
  font: 600 14px/1.35 var(--font-cjk);
}
.history-summary b {
  color: #7e1f2a;
  font: italic 700 18px/1 var(--font-num, Georgia, serif);
}
.history-empty {
  margin: 12px 0;
  color: #513a23;
  font: 600 14px/1.5 var(--font-cjk);
}
.history-stats {
  margin-bottom: 14px;
  padding: 8px 10px;
  border: 1px solid rgba(154, 118, 66, 0.45);
  border-radius: 4px;
  background: rgba(245, 234, 211, 0.56);
}
.history-stats .ribbon-h {
  margin-bottom: 8px;
  font-size: 14px;
}
.stat-row {
  margin: 0;
  padding: 5px 4px;
  border-top: 1px solid rgba(154, 118, 72, 0.34);
  color: #2b1b10;
  font: 600 13px/1.4 var(--font-cjk);
}
.stat-row:first-of-type { border-top: 0; }
.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.history-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 11px;
  border: 1px solid rgba(154, 118, 66, 0.52);
  border-radius: 4px;
  background: linear-gradient(180deg, rgba(248, 238, 218, 0.76), rgba(232, 214, 180, 0.48));
  box-shadow: inset 0 1px 0 rgba(255, 250, 236, 0.75);
}
.history-meta {
  color: #24160c;
  font: 600 13.5px/1.4 var(--font-cjk);
}
.history-meta b {
  color: #7e1f2a;
  font: italic 700 16px/1 var(--font-num, Georgia, serif);
}
.history-actions {
  display: flex;
  gap: 8px;
}
.history-actions .gbtn {
  padding: 4px 10px;
  font-size: 12.5px;
}
</style>
