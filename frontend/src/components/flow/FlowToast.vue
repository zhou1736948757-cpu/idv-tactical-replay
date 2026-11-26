<script setup lang="ts">
defineProps<{ message: string }>();
defineEmits<{ dismiss: [] }>();
</script>
<template>
<div v-if="message" class="toast paper-folio" role="status">{{ message }} <button class="gbtn" @click="$emit('dismiss')">关闭</button></div>
</template>
<style scoped>
.toast { position: fixed; right: 12px; bottom: 56px; z-index: 20; pointer-events: none; padding: 8px 12px; }
.toast button { pointer-events: auto; }
</style>
