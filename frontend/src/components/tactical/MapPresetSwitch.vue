<script setup lang="ts">
import type { VisualPresetId } from '@idv/replay-renderer';
import { useMapPreset } from '@/lib/mapTone';

const { visualPreset, setPreset } = useMapPreset();
const options: { id: VisualPresetId; label: string }[] = [
  { id: 'clarity', label: '清晰复盘' },
  { id: 'original', label: '原始风格' },
  { id: 'dossier', label: '羊皮档案' },
];
</script>

<template>
  <select class="sel map-preset" :value="visualPreset" aria-label="地图视觉预设" data-test="map-preset"
    @change="setPreset(($event.target as HTMLSelectElement).value as VisualPresetId)">
    <option v-for="option in options" :key="option.id" :value="option.id">{{ option.label }}</option>
  </select>
</template>

<style scoped>
.map-preset {
  min-height: 26px;
  padding-block: 3px;
  font-size: 12.5px;
}
</style>
