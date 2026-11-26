<script setup lang="ts">
import { flow, watchOpening } from '@/store/flow';
</script>
<template>
<section v-if="flow.mode === 'revealed' && flow.reveal" class="reveal paper-folio" data-test="practice-reveal">
  <header class="reveal-head">
    <strong class="reveal-score num" data-test="practice-score">盲练 {{ flow.reveal.score.totalScore }} 分</strong>
    <span class="reveal-tag">{{ flow.reveal.score.groupExactMatch ? '布局命中' : '对照复盘' }}</span>
  </header>
  <ul class="reveal-insights"><li v-for="insight in flow.reveal.score.insights" :key="insight">{{ insight }}</li></ul>
  <p class="reveal-summary">实际第 {{ (flow.reveal.truth.groupIndex ?? 0) + 1 }} 组 · {{ flow.reveal.score.groupExactMatch ? '判断一致' : '判断有偏差' }}
  <template v-if="flow.reveal.score.cipherHitCount !== null"> · 密码机 {{ flow.reveal.score.cipherHitCount }}/7</template></p>
  <button type="button" class="gbtn reveal-cta" data-test="practice-opening" @click="watchOpening">▶ 看高手开局前 60 秒</button>
</section>
</template>
<style scoped>
.reveal {
  padding: 12px 14px;
  border: 1px solid #9d7948;
  border-radius: 4px;
  background: linear-gradient(180deg, #f6ebd3 0%, #ebd8b4 100%);
  box-shadow: inset 0 0 0 1px rgba(255, 250, 236, 0.72), 0 2px 6px rgba(48, 28, 12, 0.16);
  color: #26160b;
}
.reveal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(154, 118, 66, 0.45);
}
.reveal-score {
  font-size: 18px;
  font-weight: 700;
  color: #771d26;
}
.reveal-tag {
  padding: 1px 8px;
  border-radius: 3px;
  background: #533619;
  border: 1px solid #d4ae6d;
  color: #fff4dc;
  font-family: var(--font-cjk);
  font-size: 12px;
  font-weight: 700;
}
.reveal-insights {
  margin: 7px 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.5;
  color: #2b1a0e;
}
.reveal-insights li::marker {
  color: #7c2028;
}
.reveal-summary {
  margin: 0 0 8px;
  padding: 5px 0 0;
  border-top: 1px dashed rgba(154, 118, 66, 0.5);
  font-size: 13px;
  font-weight: 600;
  color: #3a2412;
}
.reveal-cta {
  width: 100%;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 700;
  border: 1px solid #8a6434;
  border-radius: 4px;
  background: linear-gradient(180deg, #694b2c 0%, #48311d 54%, #342213 100%);
  box-shadow: inset 0 0 0 1px rgba(246, 218, 162, 0.42), 0 2px 4px rgba(38, 22, 10, 0.35);
  color: #fff5df;
}
</style>
