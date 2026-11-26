<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Replay2DPayload, ReplayTimelineEvent } from '@idv/replay-renderer';
import { focusEvent } from '@/store/app';
import { EVENT_GROUPS, eventTone, eventTypeLabel, filterEvents, formatClock, type EventGroupKey } from '@/lib/format';

const props = defineProps<{
  payload: Replay2DPayload | null;
  isStandalone: boolean;
  t: number;
}>();

const feedGroup = ref<EventGroupKey>('key');
const feed = computed(() => {
  if (!props.payload || props.isStandalone) return [];
  return filterEvents(props.payload.events, feedGroup.value).slice().sort((a, b) => a.t - b.t || a.id - b.id);
});

function rowState(e: ReplayTimelineEvent): string {
  if (Math.abs(e.t - props.t) <= 1.5) return 'now';
  return e.t < props.t ? 'past' : '';
}

function onEvent(e: ReplayTimelineEvent): void {
  focusEvent(e);
}
</script>

<template>
  <div class="dark fr cut tac-feed-card" data-test="event-feed-panel">
    <div class="tac-feed-ribbon-track">
      <h3 class="ribbon-h">战术事件流 <small>Event Ledger</small></h3>
    </div>
    <template v-if="payload && !isStandalone">
      <div id="feedFilter">
        <button
          v-for="g in EVENT_GROUPS"
          :key="g.key"
          class="gbtn fr cut sm"
          :class="{ on: feedGroup === g.key }"
          :data-group="g.key"
          @click="feedGroup = g.key"
        >
          {{ g.label }}
        </button>
      </div>
      <ul id="feed">
        <li v-for="e in feed" :key="e.id" :class="rowState(e)" :data-event="e.id">
          <button :title="e.label_zh" @click="onEvent(e)">
            <span class="t num">{{ formatClock(e.t, true) }}</span>
            <span class="ty" :class="eventTone(e)">{{ eventTypeLabel(e) }}</span>
            <span class="desc">{{ e.label_zh }}<template v-if="e.floor"> · {{ e.floor }}</template></span>
          </button>
        </li>
        <li v-if="!feed.length" class="tac-feed-empty">该分类暂无事件</li>
      </ul>
    </template>
    <p v-else class="empty tac-feed-empty">
      当前处于 9 图演练白板模式，暂无对局录像事件流。可在「Ⅰ 档案库」选择对局进入复盘，或点击顶部「返回复盘」。
    </p>
  </div>
</template>
