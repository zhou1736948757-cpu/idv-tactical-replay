<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  MAPS_DATA,
  PREDICT_HUNTER_ROLE_KEYS,
  SPAWN_PREDICT_DATA,
  findPredictHunterIndex,
  predictHunterPortraitUrl,
  type PilMapId,
} from '@/tactical';

const props = defineProps<{
  mapId: PilMapId;
  selectedIdx: number;
}>();

const emit = defineEmits<{
  (e: 'select', hunterIdx: number): void;
  (e: 'close'): void;
}>();

const search = ref('');
const searchInputEl = ref<HTMLInputElement | null>(null);

const mapName = computed(() => MAPS_DATA[props.mapId]?.mapName ?? SPAWN_PREDICT_DATA.maps[props.mapId] ?? '');

const counts = computed(() => {
  const totalByHunter = new Array<number>(SPAWN_PREDICT_DATA.hunters.length).fill(0);
  const mapByHunter = new Array<number>(SPAWN_PREDICT_DATA.hunters.length).fill(0);
  let mapTotal = 0;
  for (const rec of SPAWN_PREDICT_DATA.records) {
    const h = rec[1];
    if (h >= 0 && h < totalByHunter.length) {
      totalByHunter[h] = totalByHunter[h]! + 1;
      if (rec[0] === props.mapId) {
        mapByHunter[h] = mapByHunter[h]! + 1;
      }
    }
    if (rec[0] === props.mapId) mapTotal++;
  }
  return {
    totalByHunter,
    mapByHunter,
    mapTotal,
    allTotal: SPAWN_PREDICT_DATA.records.length,
  };
});

interface HunterOption {
  idx: number;
  name: string;
  portrait: string;
  mapCount: number;
  totalCount: number;
  isAll: boolean;
}

const allOptions = computed<HunterOption[]>(() => {
  const c = counts.value;
  const list: HunterOption[] = [
    {
      idx: -1,
      name: '不限监管',
      portrait: predictHunterPortraitUrl(-1),
      mapCount: c.mapTotal,
      totalCount: c.allTotal,
      isAll: true,
    },
  ];
  for (let i = 0; i < SPAWN_PREDICT_DATA.hunters.length; i++) {
    list.push({
      idx: i,
      name: SPAWN_PREDICT_DATA.hunters[i]!,
      portrait: predictHunterPortraitUrl(i),
      mapCount: c.mapByHunter[i] ?? 0,
      totalCount: c.totalByHunter[i] ?? 0,
      isAll: false,
    });
  }
  return list;
});

const filteredOptions = computed<HunterOption[]>(() => {
  const raw = search.value.trim();
  if (!raw) return allOptions.value;
  const lower = raw.toLowerCase();
  const aliasHit = findPredictHunterIndex(raw);
  return allOptions.value.filter((opt) => {
    if (opt.isAll) {
      return '不限监管全部all'.includes(lower);
    }
    if (aliasHit === opt.idx) return true;
    if (opt.name.toLowerCase().includes(lower)) return true;
    const roleKey = PREDICT_HUNTER_ROLE_KEYS[opt.idx] ?? '';
    return roleKey.toLowerCase().includes(lower);
  });
});

function pick(idx: number): void {
  emit('select', idx);
  emit('close');
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydown);
  searchInputEl.value?.focus();
});

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div
    class="sp-modal-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label="选择监管者筛选"
    data-test="spawn-hunter-modal"
    @click.self="emit('close')"
  >
    <div class="sp-modal-sheet paper-folio">
      <header class="sp-modal-head">
        <div class="sp-modal-titles">
          <span class="sp-modal-eyebrow">OLETUS MANOR · HUNTER ROSTER</span>
          <h3>选择监管者筛选</h3>
          <small>当前地图：{{ mapName }}（本图 {{ counts.mapTotal }} 局 / 全库 {{ counts.allTotal }} 局）</small>
        </div>
        <button
          type="button"
          class="sp-modal-close"
          data-test="btn-spawn-hunter-close"
          aria-label="关闭监管者选择"
          @click="emit('close')"
        >
          ✕
        </button>
      </header>

      <div class="sp-modal-search-row">
        <input
          ref="searchInputEl"
          v-model="search"
          type="search"
          class="sp-modal-search"
          data-test="spawn-hunter-search"
          placeholder="搜索监管者名或简称（如 宿伞、邦邦、约瑟夫、歌剧）…"
          aria-label="搜索监管者"
        />
        <span class="sp-modal-match-count">共 {{ filteredOptions.length }} 项</span>
      </div>

      <div class="sp-hunter-grid">
        <button
          v-for="opt in filteredOptions"
          :key="opt.idx"
          type="button"
          class="sp-hunter-card"
          :class="{
            active: opt.idx === selectedIdx,
            zero: !opt.isAll && opt.mapCount === 0,
            all: opt.isAll,
          }"
          :data-hunter-idx="opt.idx"
          @click="pick(opt.idx)"
        >
          <span class="sp-hunter-avatar" :class="{ seal: opt.isAll }">
            <img :src="opt.portrait" :alt="opt.name" />
          </span>
          <span class="sp-hunter-meta">
            <strong>{{ opt.name }}</strong>
            <small>本图 {{ opt.mapCount }} 局 · 总 {{ opt.totalCount }}</small>
          </span>
        </button>
        <p v-if="!filteredOptions.length" class="sp-modal-empty">未找到匹配的监管者，请尝试其他名称或简称。</p>
      </div>
    </div>
  </div>
</template>
