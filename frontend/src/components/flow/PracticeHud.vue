<script setup lang="ts">
import { flow } from '@/store/flow';
defineProps<{ ready?: boolean }>();
defineEmits<{ lock: [] }>();
</script>
<template>
<div v-if="flow.mode === 'blind'" class="practice-hud" data-test="practice-blind">
  <div class="practice-hud-copy">
    <strong class="practice-hud-title">
      <svg class="practice-seal-ico" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 7V5.3a3 3 0 1 1 6 0V7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        <rect x="3" y="7" width="10" height="7.5" rx="1.6" fill="currentColor" />
        <circle cx="8" cy="10.7" r="1.2" fill="#f7ebd2" />
      </svg>
      <span>盲练中 · 真相已封印</span>
    </strong>
    <span class="practice-hud-count">求生 {{ flow.draftRegion?.survivorZones.length ?? 0 }}/4 · 监管 {{ flow.draftRegion?.hunterZones.length ?? 0 }}/1</span>
  </div>
  <button v-if="ready !== undefined" type="button" class="gbtn practice-lock-btn" data-test="practice-lock" :disabled="!ready || !flow.truthReady" @click="$emit('lock')">锁定我的开局 · 揭晓高手选择</button>
</div>
</template>
<style scoped>
.practice-hud {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 10px;
  padding: 9px 12px;
  border: 1px solid #9d7948;
  border-left: 3.5px solid #7c2028;
  border-radius: 4px;
  background: linear-gradient(180deg, #f6ead0 0%, #e9d5ae 100%);
  box-shadow: inset 0 1px 0 rgba(255, 251, 240, 0.8), 0 1px 4px rgba(48, 28, 12, 0.14);
  color: #26160b;
}
.practice-hud-copy {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  min-width: 0;
}
.practice-hud-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-cjk);
  font-size: 13px;
  font-weight: 700;
  color: #771d26;
}
.practice-seal-ico {
  width: 14px;
  height: 14px;
  flex: none;
  color: #771d26;
}
.practice-hud-count {
  font-family: var(--font-cjk);
  font-size: 12.5px;
  font-weight: 600;
  color: #362211;
}
.practice-lock-btn {
  padding: 5px 12px;
  font-size: 12.5px;
  font-weight: 700;
  border: 1px solid #8a6434;
  border-radius: 4px;
  background: linear-gradient(180deg, #694b2c 0%, #48311d 54%, #342213 100%);
  box-shadow: inset 0 0 0 1px rgba(246, 218, 162, 0.42), 0 2px 4px rgba(38, 22, 10, 0.35);
  color: #fff5df;
}
.practice-lock-btn:disabled {
  opacity: 1;
  background: linear-gradient(180deg, #665441 0%, #4e3f30 100%);
  border-color: #887259;
  color: #f4e8d2;
  cursor: not-allowed;
}
</style>
