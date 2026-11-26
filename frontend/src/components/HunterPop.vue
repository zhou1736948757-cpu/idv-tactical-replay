<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { HUNTER_PORTRAITS, hunterPortraitUrl, SEAL_URL } from '@/lib/format';

const props = defineProps<{ open: boolean; selected: string | null; pid: number | null }>();
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'select', v: string | null): void;
}>();

const q = ref('');
const list = computed(() => {
  const s = q.value.trim();
  return s ? HUNTER_PORTRAITS.filter((n) => n.includes(s)) : HUNTER_PORTRAITS;
});
const broken = ref<Record<string, boolean>>({});

function choose(name: string | null): void {
  emit('select', name);
  emit('update:open', false);
}

function onImgErr(e: Event, name: string): void {
  broken.value = { ...broken.value, [name]: true };
  const img = e.target as HTMLImageElement;
  if (!img.src.endsWith(SEAL_URL)) img.src = SEAL_URL;
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.open || e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  emit('update:open', false);
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div id="hunterPop" class="overlay" :class="{ show: props.open }" :aria-hidden="!props.open ? 'true' : undefined" @click.self="emit('update:open', false)">
    <div class="pop dark fr cut" role="dialog" aria-modal="true" aria-labelledby="hunterPopTitle">
      <div class="popHead">
        <span id="hunterPopTitle" class="k">监管者肖像</span>
        <span class="muted">仅作展示用途 · 录像中角色为 PID #{{ props.pid ?? '?' }}（角色名未经验证）</span>
        <input id="hunterSearch" v-model="q" placeholder="搜索" autocomplete="off" />
      </div>
      <div id="hunterGrid">
        <button class="hchip" :class="{ sel: !props.selected }" data-test="hchip-seal" @click="choose(null)">
          <span class="av"><img :src="SEAL_URL" alt="庄园印章" /></span>
          <span>庄园印章</span>
        </button>
        <button
          v-for="n in list"
          :key="n"
          class="hchip"
          :class="{ sel: props.selected === n }"
          :data-hunter="n"
          @click="choose(n)"
        >
          <span class="av"><img :src="hunterPortraitUrl(n)" :alt="n" loading="lazy" @error="onImgErr($event, n)" /></span>
          <span>{{ n }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
#hunterPop .pop {
  border: 1px solid #b58d52;
  border-radius: 6px;
  clip-path: none;
  background: linear-gradient(180deg, #1d2533 0%, #131924 100%);
  box-shadow:
    inset 0 0 0 1px rgba(244, 214, 158, 0.24),
    inset 0 1px 0 rgba(255, 245, 220, 0.16),
    0 20px 54px rgba(0, 0, 0, 0.84);
}
#hunterPop .pop::before {
  content: none;
}
.popHead {
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(202, 162, 100, 0.34);
}
.popHead .k {
  color: #f3d79e;
  font-size: 14px;
  letter-spacing: 0.08em;
}
.popHead .muted {
  font-size: 12px;
  color: #cfc0a4;
}
#hunterSearch {
  border: 1px solid #967240;
  border-radius: 4px;
  background: linear-gradient(180deg, #17120e 0%, #241c16 100%);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.65);
  padding: 5px 10px;
  color: #f5e6c8;
  font-size: 13px;
}
.hchip {
  padding: 6px 4px;
  border-radius: 5px;
  border: 1px solid transparent;
  transition: background 0.14s ease, border-color 0.14s ease;
}
.hchip:hover {
  background: rgba(216, 179, 106, 0.09);
  border-color: rgba(216, 179, 106, 0.32);
}
.hchip.sel {
  background: rgba(216, 179, 106, 0.15);
  border-color: #d8b36a;
}
</style>
