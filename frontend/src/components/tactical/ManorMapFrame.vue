<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
const props = withDefaults(defineProps<{
  pxPerMeter: number;
  northAngle: number;
  safeInset?: number | Partial<Record<'top'|'left'|'bottom'|'right', number>>;
}>(), { safeInset: 12 });
const frame = ref<HTMLElement>();
const width = ref(0);
let observer: ResizeObserver | undefined;
let fitBaseline: { w: number; h: number; ppm: number } | null = null;
let resetRaf = 0;
function seedBaseline() {
  const el = frame.value;
  if (!el || !Number.isFinite(props.pxPerMeter) || props.pxPerMeter <= 0) return;
  const w = Math.round(el.clientWidth), h = Math.round(el.clientHeight);
  if (w > 0 && h > 0) fitBaseline = { w, h, ppm: props.pxPerMeter };
}
function onFitReset() {
  fitBaseline = null;
  if (typeof cancelAnimationFrame === 'function' && resetRaf) cancelAnimationFrame(resetRaf);
  if (typeof requestAnimationFrame === 'function') {
    resetRaf = requestAnimationFrame(() => { resetRaf = 0; if (!fitBaseline) seedBaseline(); });
  }
}
watch(() => props.pxPerMeter, (ppm) => {
  const el = frame.value;
  if (!el || !Number.isFinite(ppm) || ppm <= 0) return;
  const w = Math.round(el.clientWidth), h = Math.round(el.clientHeight);
  if (w <= 0 || h <= 0) return;
  if (!fitBaseline || Math.abs(fitBaseline.w - w) > 1 || Math.abs(fitBaseline.h - h) > 1) {
    fitBaseline = { w, h, ppm };
    return;
  }
  const zoomed = Math.abs(ppm - fitBaseline.ppm) / fitBaseline.ppm > 0.02;
  if (zoomed) el.dispatchEvent(new CustomEvent('idv-map-zoom-change', { bubbles: true, detail: { zoomed: true } }));
});
onMounted(() => {
  if (typeof window !== 'undefined') window.addEventListener('idv-map-fit-reset', onFitReset);
  if (!frame.value) return;
  width.value = frame.value.clientWidth;
  seedBaseline();
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      width.value = entry.contentRect.width;
      const w = Math.round(entry.contentRect.width), h = Math.round(entry.contentRect.height);
      if (fitBaseline && (Math.abs(fitBaseline.w - w) > 1 || Math.abs(fitBaseline.h - h) > 1)) {
        fitBaseline = Number.isFinite(props.pxPerMeter) && props.pxPerMeter > 0 ? { w, h, ppm: props.pxPerMeter } : null;
      }
    });
    observer.observe(frame.value);
  }
});
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('idv-map-fit-reset', onFitReset);
  if (typeof cancelAnimationFrame === 'function' && resetRaf) cancelAnimationFrame(resetRaf);
  observer?.disconnect();
});
function inset(side: 'left'|'right'|'top'|'bottom') {
  const v = typeof props.safeInset === 'number' ? props.safeInset : props.safeInset[side] ?? 12;
  return Number.isFinite(v) ? Math.max(0, v) : 12;
}
const scale = computed(() => {
  const ppm = props.pxPerMeter;
  const available = width.value - inset('left') - inset('right') - 48;
  if (!Number.isFinite(ppm) || ppm <= 0 || available < 100) return null;
  let meters = 40;
  if (40 * ppm < 100 || 40 * ppm > available) {
    const target = Math.min(available, 240) / ppm;
    const unit = 10 ** Math.floor(Math.log10(target));
    meters = Math.max(1, Math.floor(([1, 2, 4, 5, 8].filter(n => n * unit <= target).pop() ?? 1) * unit));
  }
  if (meters * ppm > available) return null;
  const fractions = meters % 4 === 0 ? [0, .25, .5, 1] : meters % 2 === 0 ? [0, .5, 1] : [0, 1];
  const ticks = fractions.map(f => ({ x: 12 + meters * ppm * f, value: Number((meters * f).toPrecision(3)) }));
  const segments = ticks.slice(0, -1).map((tick, idx) => ({
    x: tick.x,
    w: ticks[idx + 1]!.x - tick.x,
    gold: idx % 2 === 0,
  }));
  return { width: meters * ppm + 48, ticks, segments };
});
const DEGREE_TICKS = Array.from({ length: 16 }, (_, i) => i * 22.5);
</script>
<template>
  <div ref="frame" class="manor-map-frame" aria-hidden="true">
    <!-- Subtle mitered brass corner brackets (internal class, never .folio-corner) -->
    <svg
      v-for="corner in ['nw', 'ne', 'se', 'sw']"
      :key="corner"
      class="map-corner-mitre"
      :class="corner"
      viewBox="0 0 26 26"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 22V7L7 2H22" fill="none" stroke="#e8c37c" stroke-width="1.5" stroke-linejoin="round" />
      <path d="M5.5 18V8.8L8.8 5.5H18" fill="none" stroke="#a67c42" stroke-width="0.9" stroke-linejoin="round" />
      <path d="M7.2 7.2 9.4 5 11.6 7.2 9.4 9.4z" fill="#f5d899" stroke="#5b3d1c" stroke-width="0.6" />
    </svg>

    <!-- Astrolabe 8-point gold compass rose over smoked-obsidian disc (64x64) -->
    <svg
      class="compass"
      viewBox="0 0 72 72"
      aria-hidden="true"
      focusable="false"
      :style="{ top: inset('top') + 'px', left: inset('left') + 'px' }"
    >
      <circle cx="36" cy="36" r="34.5" fill="#16120e" fill-opacity="0.92" stroke="#dfba79" stroke-width="2" />
      <circle cx="36" cy="36" r="31.2" fill="none" stroke="#9e7a47" stroke-width="1" />
      <g stroke="#b89258" stroke-width="0.8" opacity="0.72">
        <line
          v-for="deg in DEGREE_TICKS"
          :key="deg"
          x1="36"
          y1="5.2"
          x2="36"
          :y2="deg % 90 === 0 ? 8.2 : 7.1"
          :transform="`rotate(${deg} 36 36)`"
        />
      </g>
      <g :transform="'rotate(' + (Number.isFinite(northAngle) ? northAngle : 0) + ' 36 36)'">
        <circle cx="36" cy="36" r="14.5" fill="none" stroke="#b69057" stroke-width="0.9" opacity="0.85" />
        <circle cx="36" cy="36" r="10.2" fill="none" stroke="#856336" stroke-width="0.65" />
        <!-- 4 ordinal needles -->
        <path
          v-for="a in [45, 135, 225, 315]"
          :key="a"
          d="M36 22.5 38.6 36 36 33.4 33.4 36z"
          fill="#9d7843"
          stroke="#4d3519"
          stroke-width="0.65"
          :transform="'rotate(' + a + ' 36 36)'"
        />
        <!-- 4 split two-tone cardinal pointers -->
        <g v-for="a in [0, 90, 180, 270]" :key="a" :transform="'rotate(' + a + ' 36 36)'">
          <path d="M36 19.5 39.8 36 36 32.8z" fill="#f7dca2" stroke="#5b3e1d" stroke-width="0.65" stroke-linejoin="round" />
          <path d="M36 19.5 32.2 36 36 32.8z" fill="#b98e4c" stroke="#5b3e1d" stroke-width="0.65" stroke-linejoin="round" />
        </g>
        <circle cx="36" cy="36" r="3.1" fill="#fbe3ad" stroke="#5b3e1d" stroke-width="0.9" />
        <circle cx="36" cy="36" r="1.1" fill="#4f3314" />
        <g text-anchor="middle" fill="#fff6dc" font-size="14" font-weight="700">
          <text x="36" y="17.5">N</text>
          <text x="59.5" y="41">E</text>
          <text x="36" y="64.5">S</text>
          <text x="13" y="41">W</text>
        </g>
      </g>
    </svg>

    <!-- Brass-rimmed smoked-slate ruler scale plaque (32px height) -->
    <svg
      v-if="scale"
      class="scale"
      :width="scale.width"
      height="32"
      :style="{ bottom: inset('bottom') + 'px', left: inset('left') + 'px' }"
    >
      <rect
        v-for="(seg, idx) in scale.segments"
        :key="idx"
        :x="seg.x"
        y="22"
        :width="seg.w"
        height="3.5"
        :fill="seg.gold ? '#e4bd76' : '#6c5334'"
        stroke="#f4d498"
        stroke-width="0.7"
      />
      <path :d="'M12 22H' + scale.ticks[scale.ticks.length - 1]!.x" stroke="#f6da9d" stroke-width="1.2" />
      <g v-for="(tick, index) in scale.ticks" :key="index" fill="#fff5d8">
        <path :d="'M' + tick.x + ' 18.5v7.5'" stroke="#f6da9d" stroke-width="1.15" />
        <text :x="tick.x" y="15.5" text-anchor="middle" font-size="12" font-weight="600">{{ tick.value }}{{ index === scale.ticks.length - 1 ? ' m' : '' }}</text>
      </g>
    </svg>
  </div>
</template>
<style scoped>
.manor-map-frame {
  position: absolute;
  inset: 0;
  z-index: 2;
  border: 1px solid #c99f5d;
  box-shadow:
    inset 0 0 0 2px #342517,
    inset 0 0 0 3px #f3d293,
    inset 0 0 0 5px rgba(34, 24, 15, 0.72);
}
.manor-map-frame::before {
  content: "";
  position: absolute;
  inset: 1px;
  border: 5px solid;
  border-image: var(--wood-frame-grain, repeating-linear-gradient(123deg, #291b12, #51351f 3px, #3c2719 5px, #6b4527 8px)) 5;
  outline: 1px solid #5f4128;
  box-shadow:
    inset 0 0 0 1px #dfb677,
    inset 0 0 0 3px #3d2c1d,
    inset 0 0 8px 4px rgba(24, 16, 10, 0.58);
}
.manor-map-frame,
.manor-map-frame * { pointer-events: none; }
.map-corner-mitre {
  position: absolute;
  width: 22px;
  height: 22px;
  z-index: 3;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.65));
}
.nw { inset: 4px auto auto 4px; transform: none; }
.ne { inset: 4px 4px auto auto; transform: scaleX(-1); }
.se { inset: auto 4px 4px auto; transform: rotate(180deg); }
.sw { inset: auto auto 4px 4px; transform: scaleY(-1); }
.compass,
.scale {
  position: absolute;
  background: rgba(20, 16, 12, 0.92);
  border-radius: 4px;
}
.compass {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  font-family: var(--font-latin);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.62);
}
.scale {
  font-family: var(--font-num);
  border: 1px solid #cfa562;
  box-shadow:
    inset 0 0 0 1px #312317,
    inset 0 0 0 2px rgba(232, 198, 134, 0.36),
    0 3px 10px rgba(0, 0, 0, 0.62);
}
</style>
