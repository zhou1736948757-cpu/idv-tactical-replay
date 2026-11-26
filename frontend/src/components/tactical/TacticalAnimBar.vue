<script setup lang="ts">
import { computed } from 'vue';
import { animDuration, animSegments, type TacticalBoardState } from '@/tactical';
import { propDisplayName, tokenDisplayName, type BoardGeoContext, type BoardSelection } from '@/lib/board';

const props = defineProps<{
  board: TacticalBoardState;
  geo: BoardGeoContext;
  animTime: number;
  animPlaying: boolean;
  selection: BoardSelection;
}>();

const emit = defineEmits<{
  (e: 'toggle-play'): void;
  (e: 'reset'): void;
  (e: 'scrub', t: number): void;
  (e: 'select', sel: BoardSelection): void;
}>();

const tracks = computed(() => {
  const out: Array<{
    key: string;
    name: string;
    sel: BoardSelection;
    end: number;
    segs: Array<{ t0: number; dur: number }>;
  }> = [];
  for (const tk of props.board.tokens) {
    if (!tk.anim || tk.anim.points.length < 2) continue;
    const dur = animDuration(tk.anim, props.geo.animGeom);
    const segs = animSegments(tk.anim, props.geo.animGeom);
    out.push({
      key: `t-${tk.tid}`,
      name: tokenDisplayName(tk),
      sel: { type: 'token', tid: tk.tid },
      end: dur.end,
      segs,
    });
  }
  for (const it of props.board.items) {
    if (!it.anim || it.anim.points.length < 2) continue;
    const dur = animDuration(it.anim, props.geo.animGeom);
    const segs = animSegments(it.anim, props.geo.animGeom);
    out.push({
      key: `i-${it.iid}`,
      name: propDisplayName(it),
      sel: { type: 'prop', iid: it.iid },
      end: dur.end,
      segs,
    });
  }
  return out;
});

const totalDuration = computed(() => tracks.value.reduce((mx, tr) => Math.max(mx, tr.end), 0));

function isSelected(sel: BoardSelection): boolean {
  if (!sel || !props.selection) return false;
  if (sel.type === 'token' && props.selection.type === 'token') return sel.tid === props.selection.tid;
  if (sel.type === 'prop' && props.selection.type === 'prop') return sel.iid === props.selection.iid;
  return false;
}
</script>

<template>
  <div id="transport" class="dark fr cut tac-anim-bar" data-test="tac-anim-bar">
    <div class="row1">
      <button
        class="gbtn fr cut"
        :class="{ on: animPlaying }"
        data-test="btn-tac-anim-play"
        :disabled="totalDuration <= 0"
        @click="emit('toggle-play')"
      >
        {{ animPlaying ? '⏹ 停止' : '▶ 协同播放' }}
      </button>
      <button class="gbtn fr cut sm" data-test="btn-tac-anim-reset" @click="emit('reset')">⟲ 归零</button>
      <span class="clock num" data-test="tac-anim-clock">{{ animTime.toFixed(1) }}s / {{ totalDuration.toFixed(1) }}s</span>
      <span class="tac-anim-hint">点击地图加点 · 拖动编号点微调</span>
    </div>

    <div id="timeline">
      <input
        type="range"
        min="0"
        :max="Math.max(0.1, totalDuration)"
        step="0.05"
        :value="Math.min(animTime, totalDuration)"
        :disabled="totalDuration <= 0"
        data-test="tac-anim-scrubber"
        aria-label="战术动画时间轴"
        @input="emit('scrub', Number(($event.target as HTMLInputElement).value))"
      />
    </div>

    <div v-if="tracks.length" class="tac-anim-tracks">
      <button
        v-for="tr in tracks"
        :key="tr.key"
        type="button"
        class="tac-anim-track"
        :class="{ on: isSelected(tr.sel) }"
        data-test="tac-anim-track"
        @click="emit('select', tr.sel)"
      >
        <span class="nm">{{ tr.name }}</span>
        <span class="lane">
          <i
            v-for="(seg, idx) in tr.segs"
            :key="idx"
            class="seg"
            :style="{
              left: totalDuration > 0 ? `${(seg.t0 / totalDuration) * 100}%` : '0%',
              width: totalDuration > 0 ? `${(seg.dur / totalDuration) * 100}%` : '0%',
            }"
          ></i>
        </span>
        <span class="num">{{ tr.end.toFixed(1) }}s</span>
      </button>
    </div>
    <div v-else class="tac-anim-empty">暂无轨迹 · 放置造物后在「动画」点击地图加点</div>
  </div>
</template>
