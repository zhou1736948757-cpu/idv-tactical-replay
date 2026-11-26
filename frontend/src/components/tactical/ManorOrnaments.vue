<script setup lang="ts">
import { computed, useId } from 'vue';
defineOptions({ inheritAttrs: false });
const props = defineProps<{
  kind: 'clip'|'seal'|'corner'|'win'|'lose'|'neutral'|'rivet'|'laurel'|'typewriter'|'ribbon'|'stage';
  hunter?: boolean;
  stage?: string;
  labelPair?: { zh: string; en: string };
}>();
const id = useId();
const metal = 'url(#' + id + '-brass)';
const wax = 'url(#' + id + '-wax)';
const ribbonGrad = 'url(#' + id + '-ribbon)';
const palette = computed(() =>
  props.kind === 'neutral'
    ? ['#b59a79', '#70583f', '#473525', '#322417']
    : props.kind === 'lose' || (props.kind === 'seal' && !props.hunter)
      ? ['#6f92b5', '#284a6b', '#152a40', '#0c1a29']
      : ['#cf6154', '#97292e', '#571520', '#3a0c13'],
);
const seal = computed(() => ['seal', 'win', 'lose', 'neutral'].includes(props.kind));
const label = computed(() => ({ win: 'Win', lose: 'Lose', neutral: 'Neutral' }[props.kind as 'win' | 'lose' | 'neutral'] ?? 'V'));
const viewBox = computed(() => {
  if (seal.value) return '0 0 76 92';
  if (props.kind === 'stage') return '0 0 96 44';
  if (props.kind === 'laurel') return '0 0 48 48';
  if (props.kind === 'ribbon') return '0 0 120 24';
  if (props.kind === 'clip') return '0 0 48 32';
  return '0 0 32 32';
});
const stageRoman = computed(() => ({ '01': 'I', '02': 'II', '03': 'III', '04': 'IV', '05': 'V' }[props.stage ?? ''] ?? props.stage ?? ''));
</script>
<template>
  <svg
    v-if="kind !== 'corner'"
    v-bind="$attrs"
    :class="seal ? 'wax-seal' : kind === 'clip' ? 'binder-clip' : 'folio-' + kind"
    :viewBox="viewBox"
    aria-hidden="true"
    focusable="false"
    style="pointer-events:none"
  >
    <defs>
      <linearGradient :id="id+'-brass'" x1="0" y1="0" x2=".32" y2="1">
        <stop stop-color="#fff3c4" />
        <stop offset=".26" stop-color="#c99d58" />
        <stop offset=".48" stop-color="#76502c" />
        <stop offset=".66" stop-color="#eac078" />
        <stop offset="1" stop-color="#64401e" />
      </linearGradient>
      <radialGradient :id="id+'-wax'" cx=".32" cy=".22" r=".82">
        <stop :stop-color="palette[0]" />
        <stop offset=".46" :stop-color="palette[1]" />
        <stop offset=".80" :stop-color="palette[2]" />
        <stop offset=".93" :stop-color="palette[0]" />
        <stop offset="1" :stop-color="palette[3]" />
      </radialGradient>
      <linearGradient :id="id+'-ribbon'" x1="0" y1="0" x2="1" y2="1">
        <stop :stop-color="palette[0]" />
        <stop offset=".45" :stop-color="palette[1]" />
        <stop offset="1" :stop-color="palette[3]" />
      </linearGradient>
    </defs>

    <!-- 3D sculpted wax seal with drip bevel, beaded collar & twin swallowtail ribbons -->
    <g v-if="seal">
      <path d="M24 47 14 86 24 79 32 89 40 53" :fill="ribbonGrad" :stroke="palette[3]" stroke-width="1.2" stroke-linejoin="round" />
      <path d="M26 52 20 82" stroke="#fff2d2" stroke-opacity=".22" stroke-width="1" />
      <path d="M36 53 46 89 52 79 62 86 52 47" :fill="ribbonGrad" :stroke="palette[3]" stroke-width="1.2" stroke-linejoin="round" />
      <path d="M50 52 56 82" stroke="#fff2d2" stroke-opacity=".22" stroke-width="1" />
      <!-- Organic scalloped wax outer flange -->
      <path
        d="M37 3c7-2 11 4 17 5s10 8 10 14 9 11 6 19-5 8-8 15-12 6-17 10-11 1-17-2-12 0-16-8-2-11-6-17 0-11 2-17S18 10 24 8s7-5 13-5Z"
        :fill="wax"
        :stroke="palette[3]"
        stroke-width="1.8"
      />
      <!-- Raised wax collar & specular rim highlight -->
      <circle cx="38" cy="35" r="25.5" fill="none" :stroke="palette[0]" stroke-width="2.1" />
      <circle cx="38" cy="35" r="23.6" fill="none" stroke="#fff4d6" stroke-opacity=".32" stroke-width=".9" stroke-dasharray="1.8 2.6" />
      <path d="M18.5 23a23.5 23.5 0 0 1 32.5-7.5" fill="none" stroke="#fff6dd" stroke-opacity=".46" stroke-width="1.8" stroke-linecap="round" />
      <!-- Deep recessed stamp core (> 9:1 contrast behind ivory text) -->
      <circle cx="38" cy="35" r="22" :fill="palette[2]" :stroke="palette[3]" stroke-width="1.1" />
      <circle cx="38" cy="35" r="20.4" fill="none" :stroke="palette[0]" stroke-opacity=".38" stroke-width=".8" />
      <g v-if="labelPair" text-anchor="middle" fill="#fff3d6">
        <text x="38" y="33" font-size="14" font-weight="700" font-family="var(--font-cjk, 'Noto Serif SC', serif)">{{ labelPair.zh }}</text>
        <text x="38" y="48" font-size="13" font-weight="600" font-family="var(--font-num, Georgia, serif)" font-style="italic">{{ labelPair.en }}</text>
      </g>
      <text
        v-else
        x="38"
        y="43"
        text-anchor="middle"
        fill="#fff3d6"
        :font-size="kind === 'neutral' ? 16 : 25"
        font-weight="700"
        font-family="var(--font-latin, Georgia, serif)"
        font-style="italic"
      >{{ label }}</text>
    </g>

    <!-- Antique brass bulldog binder clip -->
    <g v-else-if="kind==='clip'">
      <path d="M5 29.5h39l2 2H3z" fill="#3a2410" opacity=".36" />
      <path d="M16 19l3-11c1.3-4.2 3.4-6.5 6-6.5s4.7 2.3 6 6.5l3 11z" :fill="metal" stroke="#5a3b1c" stroke-width="1.1" stroke-linejoin="round" />
      <circle cx="25" cy="9.5" r="4.2" fill="#2c1d12" stroke="#6d4a23" stroke-width="1.1" />
      <path d="M21 6.4a5.3 5.3 0 0 1 7.2-.6" fill="none" stroke="#fff5c8" stroke-width="1.1" stroke-linecap="round" />
      <path d="M7 21.5l10-3.2h16l10 3.2z" :fill="metal" stroke="#5b3d1e" stroke-width="1" stroke-linejoin="round" />
      <path d="M4 20.5h40l2.2 7.5H1.8z" :fill="metal" stroke="#5d3c1b" stroke-width="1.1" stroke-linejoin="round" />
      <path d="M5.5 22.3h37" stroke="#fff1ba" stroke-width="1.3" stroke-linecap="round" opacity=".88" />
      <path d="M4.2 25.4h39.6" stroke="#5a3919" stroke-width="1.1" opacity=".75" />
      <path d="M3.2 27.6h41.6" stroke="#f5d590" stroke-width="1.1" opacity=".85" />
      <circle cx="9.5" cy="24" r="1.4" fill="#fff0b8" stroke="#61401e" stroke-width=".7" />
      <circle cx="38.5" cy="24" r="1.4" fill="#fff0b8" stroke="#61401e" stroke-width=".7" />
    </g>

    <!-- Concept-faithful Stage 04 (Stage 04 + Roman IV laurel crest) & Stage 05 (05 / Stage laurel crest) -->
    <g v-else-if="kind==='stage'">
      <template v-if="stage === '04'">
        <text x="26" y="25.5" text-anchor="middle" fill="#6e1f19" font-family="var(--font-num, Georgia, serif)" font-style="italic" font-weight="700" font-size="14.5" style="font-variant-numeric: lining-nums tabular-nums">Stage 04</text>
        <path d="M4 30h44" stroke="#a67c47" stroke-width="0.9" opacity="0.82" />
        <path d="M26 28.5l2 1.5-2 1.5-2-1.5z" fill="#8f6331" />
        <!-- Circular double-ring gold laurel wreath seal containing Roman IV -->
        <g transform="translate(73, 22)">
          <circle r="13.2" fill="#f6ebd4" stroke="none" />
          <circle r="13.5" fill="none" stroke="#99713d" stroke-width="1.1" />
          <circle r="11.8" fill="none" stroke="#b9935a" stroke-width="0.7" />
          <path d="M-15 10C-18.8 3.5-18.5-5.5-12.8-13M15 10C18.8 3.5 18.5-5.5 12.8-13" fill="none" stroke="#946c39" stroke-width="1.05" stroke-linecap="round" />
          <g fill="#a47c45">
            <ellipse cx="-16" cy="5.8" rx="3" ry="1.45" transform="rotate(-32 -16 5.8)" />
            <ellipse cx="-17.2" cy="0.2" rx="3.1" ry="1.45" transform="rotate(-8 -17.2 0.2)" />
            <ellipse cx="-16.2" cy="-5.4" rx="3" ry="1.45" transform="rotate(20 -16.2 -5.4)" />
            <ellipse cx="-13" cy="-10.6" rx="2.8" ry="1.35" transform="rotate(42 -13 -10.6)" />
            <ellipse cx="-8" cy="-14.5" rx="2.6" ry="1.25" transform="rotate(64 -8 -14.5)" />
            <ellipse cx="16" cy="5.8" rx="3" ry="1.45" transform="rotate(32 16 5.8)" />
            <ellipse cx="17.2" cy="0.2" rx="3.1" ry="1.45" transform="rotate(8 17.2 0.2)" />
            <ellipse cx="16.2" cy="-5.4" rx="3" ry="1.45" transform="rotate(-20 16.2 -5.4)" />
            <ellipse cx="13" cy="-10.6" rx="2.8" ry="1.35" transform="rotate(-42 13 -10.6)" />
            <ellipse cx="8" cy="-14.5" rx="2.6" ry="1.25" transform="rotate(-64 8 -14.5)" />
          </g>
          <path d="M-5.5 14 0 11.8 5.5 14 2.8 16.2 0 14.5-2.8 16.2z" fill="#8f6736" />
          <text x="0" y="5" text-anchor="middle" fill="#452710" font-family="var(--font-latin, Georgia, serif)" font-weight="700" font-size="14">{{ stageRoman }}</text>
        </g>
      </template>
      <template v-else>
        <!-- Delicate antique gold left sprig leading into Stage 05 laurel crest -->
        <path d="M4 22h40" stroke="#a67c47" stroke-width="0.95" opacity="0.78" />
        <path d="M13 22q4-4.5 9-3.5-4 4.5-9 3.5zm0 0q4 4.5 9 3.5-4-4.5-9-3.5zm14 0q3.5-3.5 7.5-2.8-3.5 3.5-7.5 2.8zm0 0q3.5 3.5 7.5 2.8-3.5-3.5-7.5-2.8z" fill="#a8814a" opacity="0.82" />
        <path d="M40 22 43 19.5l3 2.5-3 2.5z" fill="#8f6533" />
        <!-- Roomy circular double-ring gold laurel wreath seal containing 05 over Stage (100% pure cream interior behind glyphs) -->
        <g transform="translate(72, 22)">
          <circle r="16.8" fill="#f6ebd4" stroke="none" />
          <circle r="17.2" fill="none" stroke="#99713d" stroke-width="1.05" />
          <circle r="18.6" fill="none" stroke="#b9935a" stroke-width="0.65" />
          <path d="M-17.8 11.5C-21.6 4.2-21.3-6.2-15-14.8M17.8 11.5C21.6 4.2 21.3-6.2 15-14.8" fill="none" stroke="#946c39" stroke-width="1" stroke-linecap="round" />
          <g fill="#a47c45">
            <ellipse cx="-18.6" cy="7.2" rx="2.9" ry="1.35" transform="rotate(-34 -18.6 7.2)" />
            <ellipse cx="-20.2" cy="0.8" rx="3" ry="1.4" transform="rotate(-10 -20.2 0.8)" />
            <ellipse cx="-19.2" cy="-5.8" rx="2.9" ry="1.35" transform="rotate(18 -19.2 -5.8)" />
            <ellipse cx="-15.6" cy="-12.2" rx="2.7" ry="1.3" transform="rotate(42 -15.6 -12.2)" />
            <ellipse cx="-9.8" cy="-16.8" rx="2.5" ry="1.2" transform="rotate(64 -9.8 -16.8)" />
            <ellipse cx="18.6" cy="7.2" rx="2.9" ry="1.35" transform="rotate(34 18.6 7.2)" />
            <ellipse cx="20.2" cy="0.8" rx="3" ry="1.4" transform="rotate(10 20.2 0.8)" />
            <ellipse cx="19.2" cy="-5.8" rx="2.9" ry="1.35" transform="rotate(-18 19.2 -5.8)" />
            <ellipse cx="15.6" cy="-12.2" rx="2.7" ry="1.3" transform="rotate(-42 15.6 -12.2)" />
            <ellipse cx="9.8" cy="-16.8" rx="2.5" ry="1.2" transform="rotate(-64 9.8 -16.8)" />
          </g>
          <path d="M-5.5 17.5 0 15.5 5.5 17.5 2.6 19.8 0 18.1-2.6 19.8z" fill="#8f6736" />
          <text x="0" y="-2.2" text-anchor="middle" fill="#3d220c" font-family="var(--font-num, Georgia, serif)" font-weight="700" font-size="15" style="font-variant-numeric: lining-nums tabular-nums">{{ stage }}</text>
          <text x="0" y="8.2" text-anchor="middle" fill="#4c2c12" font-family="var(--font-num, Georgia, serif)" font-style="italic" font-weight="600" font-size="12.1">Stage</text>
        </g>
      </template>
    </g>

    <!-- 3D domed antique brass tack rivet -->
    <g v-else-if="kind==='rivet'">
      <circle cx="16" cy="16" r="12.5" :fill="metal" stroke="#5a3b19" stroke-width="1.8" />
      <circle cx="16" cy="16" r="9.6" fill="none" stroke="#7e5628" stroke-width="0.8" opacity=".6" />
      <circle cx="12.2" cy="12" r="3.4" fill="#fff6d2" opacity=".82" />
    </g>

    <!-- Engraved olive/laurel wreath encircling Roman V (viewBox 0 0 48 48) -->
    <g v-else-if="kind==='laurel'" opacity="0.86">
      <circle cx="24" cy="24" r="15.5" fill="none" stroke="#9e7845" stroke-width="1.1" />
      <circle cx="24" cy="24" r="13.2" fill="none" stroke="#ba9660" stroke-width="0.7" />
      <path d="M10 36C4.5 28 4.8 16 11.5 8.5M38 36C43.5 28 43.2 16 36.5 8.5" fill="none" stroke="#8f6837" stroke-width="1.25" stroke-linecap="round" />
      <g :fill="metal" stroke="#7c572b" stroke-width="0.45">
        <ellipse cx="8.2" cy="31" rx="3.8" ry="1.8" transform="rotate(-34 8.2 31)" />
        <ellipse cx="6.2" cy="24.5" rx="4" ry="1.9" transform="rotate(-10 6.2 24.5)" />
        <ellipse cx="7.4" cy="17.8" rx="3.9" ry="1.85" transform="rotate(18 7.4 17.8)" />
        <ellipse cx="11.2" cy="11.8" rx="3.6" ry="1.75" transform="rotate(42 11.2 11.8)" />
        <ellipse cx="16.8" cy="7.5" rx="3.3" ry="1.6" transform="rotate(64 16.8 7.5)" />
        <ellipse cx="39.8" cy="31" rx="3.8" ry="1.8" transform="rotate(34 39.8 31)" />
        <ellipse cx="41.8" cy="24.5" rx="4" ry="1.9" transform="rotate(10 41.8 24.5)" />
        <ellipse cx="40.6" cy="17.8" rx="3.9" ry="1.85" transform="rotate(-18 40.6 17.8)" />
        <ellipse cx="36.8" cy="11.8" rx="3.6" ry="1.75" transform="rotate(-42 36.8 11.8)" />
        <ellipse cx="31.2" cy="7.5" rx="3.3" ry="1.6" transform="rotate(-64 31.2 7.5)" />
      </g>
      <path d="M17.5 39.5 24 36.8 30.5 39.5 27.5 42.5 24 40.3 20.5 42.5z" fill="#8f6736" />
      <text x="24" y="31.5" text-anchor="middle" fill="#6b4922" font-size="22" font-weight="700" font-family="var(--font-latin, Georgia, serif)">V</text>
    </g>

    <path v-else-if="kind==='ribbon'" d="m1 12 9-10h108l-8 10 8 10H10Z" :fill="metal" stroke="#845c37" />
    <g v-else stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round">
      <path d="M8 3h16v10H8zM5 12h22l3 13H2zM4 28h24M10 7h12M7 16h3m2 0h3m2 0h3m2 0h3M8 20h15" />
    </g>
  </svg>
</template>
