<script setup lang="ts">
defineProps<{ active: boolean; uploading: boolean }>();
</script>
<template>
<div v-if="active || uploading" class="overlay" data-test="global-drop" role="status"><strong>{{ uploading ? '正在解析录像…' : '松开以导入 .zip 录像' }}</strong><span v-if="!uploading">按住 Shift 投递可进入盲练</span></div>
</template>
<style scoped>
.overlay { position: fixed; z-index: 30; inset: 50px 0 0; display: grid; place-content: center; gap: 12px; text-align: center; color: #fff0cf; background: #16120eef; pointer-events: none; }
</style>
