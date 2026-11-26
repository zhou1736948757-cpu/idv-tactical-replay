<script setup lang="ts">
import { flow } from '@/store/flow';
import { setStep } from '@/store/app';
</script>
<template>
<section v-if="flow.summary" class="summary paper-folio" data-test="replay-summary">
  <strong>本局复盘已结束</strong>
  <button class="gbtn" @click="setStep(3)">对比分析</button>
  <button class="gbtn" @click="setStep(4)">选点复盘</button>
  <button class="gbtn" @click="flow.summary = false">继续查看</button>
</section>
</template>
<style scoped>
.summary { position: absolute; z-index: 5; left: 12px; bottom: 56px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px; }
</style>
