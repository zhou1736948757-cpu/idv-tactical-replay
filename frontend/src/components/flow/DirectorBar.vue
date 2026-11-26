<script setup lang="ts">
import { play, setStep } from '@/store/app';
import { flow, resumeDirector, suspendDirector } from '@/store/flow';
</script>
<template>
<div v-if="flow.director !== 'off' || flow.mode === 'pro-opening' || flow.openingFinished" class="director dark fr cut" data-test="director-bar" :data-mode="flow.segment?.mode">
  <span>{{ flow.openingFinished ? '高手开局回放完毕' : flow.director === 'suspended' ? '导播已暂停' : flow.segment?.caption ?? '智能导播' }}</span>
  <template v-if="flow.openingFinished">
    <button class="gbtn" @click="flow.openingFinished = false; play()">继续实况</button>
    <button class="gbtn" @click="setStep(4)">返回对照</button>
  </template>
  <button v-if="flow.director === 'suspended'" class="gbtn" @click="resumeDirector">恢复</button>
  <button v-if="flow.director === 'running'" class="gbtn" @click="suspendDirector">自由观看</button>
</div>
</template>
<style scoped>
.director { position: absolute; bottom: 38px; left: 50%; transform: translateX(-50%); z-index: 4; padding: 5px 8px; display: flex; align-items: center; gap: 8px; }
</style>
