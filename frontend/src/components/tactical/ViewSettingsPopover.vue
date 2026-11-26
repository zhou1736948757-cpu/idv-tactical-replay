<script setup lang="ts">
import MapPresetSwitch from './MapPresetSwitch.vue';
import type { LandmarkVisibility, SnapTargets, UnderlayUiState } from '@/lib/board';

const props = withDefaults(
  defineProps<{
    open: boolean;
    pitch?: number;
    yaw?: number;
    yScale?: number;
    floorPlanes?: boolean;
    dropLines?: boolean;
    viewCones: boolean;
    trails: boolean;
    dirArrows: boolean;
    labels: boolean;
    underlay: UnderlayUiState;
    underlayStatus: 'none' | 'loading' | 'ok' | 'missing';
    landmarks: LandmarkVisibility;
    spawnIndex: number;
    spawnCount: number;
    cipherGroupIndex?: number;
    cipherGroupCount?: number;
    chairIndex?: number;
    chairSetCount?: number;
    chairBasementIndex?: number;
    boxBasementIndex?: number;
    basementCount?: number;
    dungeonIndex?: number;
    dungeonCount?: number;
    hasPhoneBooths?: boolean;
    zoomLocked?: boolean;
  }>(),
  {
    pitch: 90,
    yaw: 0,
    yScale: 1,
    floorPlanes: false,
    dropLines: false,
    cipherGroupIndex: 0,
    cipherGroupCount: 1,
    chairIndex: 0,
    chairSetCount: 0,
    chairBasementIndex: 0,
    boxBasementIndex: 0,
    basementCount: 0,
    dungeonIndex: 0,
    dungeonCount: 0,
    hasPhoneBooths: false,
    zoomLocked: false,
  },
);

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'update:pitch', v: number): void;
  (e: 'update:yaw', v: number): void;
  (e: 'update:yScale', v: number): void;
  (e: 'update:floorPlanes', v: boolean): void;
  (e: 'update:dropLines', v: boolean): void;
  (e: 'update:viewCones', v: boolean): void;
  (e: 'update:trails', v: boolean): void;
  (e: 'update:dirArrows', v: boolean): void;
  (e: 'update:labels', v: boolean): void;
  (e: 'update:zoomLocked', v: boolean): void;
  (e: 'zoom', factor: number): void;
  (e: 'reset-view'): void;
  (e: 'rotate-underlay'): void;
  (e: 'rotate-board-90'): void;
  (e: 'cycle-spawn', delta: number): void;
  (e: 'cycle-cipher', delta: number): void;
  (e: 'cycle-chair', delta: number): void;
  (e: 'cycle-basement', delta: number): void;
  (e: 'cycle-box-basement', delta: number): void;
  (e: 'cycle-dungeon', delta: number): void;
}>();

const SNAP_TARGET_LABELS: ReadonlyArray<readonly [keyof SnapTargets, string]> = [
  ['cipher', '密码机'],
  ['door', '大门'],
  ['dungeon', '地窖'],
  ['chair', '狂欢之椅'],
  ['locker', '柜子'],
  ['box', '箱子'],
  ['phoneBooth', '电话亭'],
  ['spawn', '出生点'],
  ['endpoint', '线段端点'],
];
</script>

<template>
  <div
    v-show="open"
    class="view-pop dark fr cut"
    data-test="view-settings-popover"
  >
    <div class="vp-head">
      <span class="k">视图与图层 <small class="vp-head-en">View &amp; Layers</small></span>
      <button class="gbtn fr cut sm" data-test="btn-view-close" @click="emit('update:open', false)">收起</button>
    </div>

    <div class="vp-row"><MapPresetSwitch /></div>

    <div class="vp-sec">
      <div class="vp-lbl">视角与缩放</div>
      <div class="vp-row">
        <button class="gbtn fr cut sm" data-test="btn-zoom-in" title="放大" @click="emit('zoom', 1.25)">＋ 放大</button>
        <button class="gbtn fr cut sm" data-test="btn-zoom-out" title="缩小" @click="emit('zoom', 0.8)">－ 缩小</button>
        <button class="gbtn fr cut sm" data-test="btn-reset" @click="emit('reset-view')">复位视角</button>
        <button
          class="gbtn fr cut sm"
          :class="{ on: zoomLocked }"
          data-test="btn-zoom-lock"
          @click="emit('update:zoomLocked', !zoomLocked)"
        >
          {{ zoomLocked ? '已锁定缩放/拖动' : '锁定缩放/拖动' }}
        </button>
        <button
          class="gbtn fr cut sm"
          data-test="btn-board-rotate-90"
          @click="emit('rotate-board-90')"
        >
          顺时针旋转 90°
        </button>
      </div>
    </div>

    <div class="vp-sec">
      <div class="vp-lbl">复盘图层</div>
      <div class="vp-chips">
        <button class="gbtn fr cut sm" :class="{ on: viewCones }" data-test="btn-cone" @click="emit('update:viewCones', !viewCones)">视锥 et=304</button>
        <button class="gbtn fr cut sm" :class="{ on: trails }" data-test="btn-trail" @click="emit('update:trails', !trails)">轨迹 5s</button>
        <button class="gbtn fr cut sm" :class="{ on: dirArrows }" data-test="btn-dir" @click="emit('update:dirArrows', !dirArrows)">朝向</button>
        <button class="gbtn fr cut sm" :class="{ on: labels }" data-test="btn-labels" @click="emit('update:labels', !labels)">名牌</button>
      </div>
    </div>

    <div class="vp-sec">
      <div class="vp-lbl">底图校准</div>
      <div class="vp-chips">
        <button class="gbtn fr cut sm" :class="{ on: underlay.enabled }" data-test="btn-underlay" @click="underlay.enabled = !underlay.enabled">
          {{ underlayStatus === 'missing' ? '底图(缺失)' : '底图' }}
        </button>
        <label class="rng">
          透明
          <input v-model.number="underlay.opacity" type="range" min="0" max="1" step="0.05" data-test="opacity" />
          <span class="num">{{ Math.round(underlay.opacity * 100) }}%</span>
        </label>
        <button class="gbtn fr cut sm" data-test="btn-rot" @click="emit('rotate-underlay')">旋转 {{ underlay.rotationQuadrants * 90 }}°</button>
        <button class="gbtn fr cut sm" :class="{ on: underlay.flipX }" data-test="btn-flipx" @click="underlay.flipX = !underlay.flipX">翻转X</button>
        <button class="gbtn fr cut sm" :class="{ on: underlay.flipZ }" data-test="btn-flipz" @click="underlay.flipZ = !underlay.flipZ">翻转Z</button>
      </div>
    </div>

    <div class="vp-sec">
      <div class="vp-lbl">静态地标、分组与图标尺寸</div>
      <div class="vp-landmark-list">
        <div class="vp-landmark-row">
          <button class="gbtn fr cut sm" :class="{ on: landmarks.ciphers }" data-test="btn-landmark-ciphers" @click="landmarks.ciphers = !landmarks.ciphers">密码机</button>
          <span v-if="cipherGroupCount > 1" class="vp-cyc">
            <button class="gbtn fr cut sm" data-test="btn-vp-cipher-prev" @click="emit('cycle-cipher', -1)">‹</button>
            <span class="num">{{ (cipherGroupIndex % cipherGroupCount) + 1 }}/{{ cipherGroupCount }}</span>
            <button class="gbtn fr cut sm" data-test="btn-vp-cipher-next" @click="emit('cycle-cipher', 1)">›</button>
          </span>
          <label class="vp-size-rng">
            大小
            <input v-model.number="landmarks.sizes.cipher" type="range" min="2" max="12" step="0.5" />
          </label>
        </div>

        <div class="vp-landmark-row">
          <button class="gbtn fr cut sm" :class="{ on: landmarks.gates }" data-test="btn-landmark-gates" @click="landmarks.gates = !landmarks.gates">大门</button>
          <button class="gbtn fr cut sm" :class="{ on: landmarks.escapeDoorLock }" data-test="btn-landmark-doorlock" @click="landmarks.escapeDoorLock = !landmarks.escapeDoorLock">封门点</button>
          <label class="vp-size-rng">
            大小
            <input v-model.number="landmarks.sizes.door" type="range" min="2" max="12" step="0.5" />
          </label>
        </div>

        <div class="vp-landmark-row">
          <button class="gbtn fr cut sm" :class="{ on: landmarks.hatch }" data-test="btn-landmark-hatch" @click="landmarks.hatch = !landmarks.hatch">地窖</button>
          <span v-if="dungeonCount > 0" class="vp-cyc">
            <button class="gbtn fr cut sm" data-test="btn-vp-dungeon-prev" @click="emit('cycle-dungeon', -1)">‹</button>
            <span class="num">{{ (dungeonIndex % dungeonCount) + 1 }}/{{ dungeonCount }}</span>
            <button class="gbtn fr cut sm" data-test="btn-vp-dungeon-next" @click="emit('cycle-dungeon', 1)">›</button>
          </span>
          <label class="vp-size-rng">
            大小
            <input v-model.number="landmarks.sizes.dungeon" type="range" min="2" max="12" step="0.5" />
          </label>
        </div>

        <div class="vp-landmark-row">
          <button class="gbtn fr cut sm" :class="{ on: landmarks.spawns }" data-test="btn-landmark-spawns" @click="landmarks.spawns = !landmarks.spawns">出生点</button>
          <span v-if="spawnCount > 0" class="vp-cyc">
            <button class="gbtn fr cut sm" data-test="btn-spawn-prev" @click="emit('cycle-spawn', -1)">‹</button>
            <span class="num">{{ (spawnIndex % spawnCount) + 1 }}/{{ spawnCount }}</span>
            <button class="gbtn fr cut sm" data-test="btn-spawn-next" @click="emit('cycle-spawn', 1)">›</button>
          </span>
          <label class="vp-size-rng">
            大小
            <input v-model.number="landmarks.sizes.spawn" type="range" min="3" max="12" step="0.5" />
          </label>
        </div>

        <div class="vp-landmark-row">
          <button class="gbtn fr cut sm" :class="{ on: landmarks.chairs }" data-test="btn-landmark-chairs" @click="landmarks.chairs = !landmarks.chairs">狂欢之椅</button>
          <span v-if="chairSetCount > 0" class="vp-cyc">
            <button class="gbtn fr cut sm" data-test="btn-vp-chair-prev" @click="emit('cycle-chair', -1)">‹</button>
            <span class="num">{{ (chairIndex % chairSetCount) + 1 }}/{{ chairSetCount }}</span>
            <button class="gbtn fr cut sm" data-test="btn-vp-chair-next" @click="emit('cycle-chair', 1)">›</button>
          </span>
          <label class="vp-size-rng">
            大小
            <input v-model.number="landmarks.sizes.chair" type="range" min="2" max="12" step="0.5" />
          </label>
        </div>

        <div class="vp-landmark-row">
          <button class="gbtn fr cut sm" :class="{ on: landmarks.basement }" data-test="btn-landmark-basement" @click="landmarks.basement = !landmarks.basement">地下室椅</button>
          <span v-if="basementCount > 0" class="vp-cyc">
            <button class="gbtn fr cut sm" data-test="btn-vp-basement-prev" @click="emit('cycle-basement', -1)">‹</button>
            <span class="num">{{ (chairBasementIndex % basementCount) + 1 }}/{{ basementCount }}</span>
            <button class="gbtn fr cut sm" data-test="btn-vp-basement-next" @click="emit('cycle-basement', 1)">›</button>
          </span>
          <button class="gbtn fr cut sm" :class="{ on: landmarks.basementChest }" data-test="btn-landmark-basement-chest" @click="landmarks.basementChest = !landmarks.basementChest">地下室箱</button>
          <span v-if="basementCount > 0" class="vp-cyc">
            <button class="gbtn fr cut sm" data-test="btn-vp-box-basement-prev" @click="emit('cycle-box-basement', -1)">‹</button>
            <span class="num">{{ (boxBasementIndex % basementCount) + 1 }}/{{ basementCount }}</span>
            <button class="gbtn fr cut sm" data-test="btn-vp-box-basement-next" @click="emit('cycle-box-basement', 1)">›</button>
          </span>
        </div>

        <div class="vp-landmark-row">
          <button class="gbtn fr cut sm" :class="{ on: landmarks.chests }" data-test="btn-landmark-chests" @click="landmarks.chests = !landmarks.chests">箱子</button>
          <label class="vp-size-rng">
            大小
            <input v-model.number="landmarks.sizes.box" type="range" min="2" max="8" step="0.5" />
          </label>
        </div>

        <div class="vp-landmark-row">
          <button class="gbtn fr cut sm" :class="{ on: landmarks.lockers }" data-test="btn-landmark-lockers" @click="landmarks.lockers = !landmarks.lockers">柜子</button>
          <label class="vp-size-rng">
            大小
            <input v-model.number="landmarks.sizes.locker" type="range" min="2" max="8" step="0.5" />
          </label>
        </div>

        <div v-if="hasPhoneBooths" class="vp-landmark-row">
          <button class="gbtn fr cut sm" :class="{ on: landmarks.phoneBooths }" data-test="btn-landmark-phonebooths" @click="landmarks.phoneBooths = !landmarks.phoneBooths">电话亭</button>
          <label class="vp-size-rng">
            大小
            <input v-model.number="landmarks.sizes.phoneBooth" type="range" min="2" max="8" step="0.5" />
          </label>
        </div>

        <div class="vp-landmark-row">
          <button class="gbtn fr cut sm" :class="{ on: landmarks.zones }" data-test="btn-landmark-zones" @click="landmarks.zones = !landmarks.zones">区域线</button>
          <button class="gbtn fr cut sm" :class="{ on: landmarks.fixedSpawns }" data-test="btn-landmark-fixed" @click="landmarks.fixedSpawns = !landmarks.fixedSpawns">固定刷点</button>
          <button class="gbtn fr cut sm" :class="{ on: landmarks.fixedSpawnDir }" data-test="btn-landmark-fixed-dir" @click="landmarks.fixedSpawnDir = !landmarks.fixedSpawnDir">朝向箭头</button>
          <select v-model="landmarks.fixedSpawnScreen" class="sel" data-test="select-madeyes-screen" aria-label="疯眼控制台视野">
            <option value="off">疯眼屏:关</option>
            <option value="pc">疯眼屏:PC</option>
            <option value="ios">疯眼屏:iOS</option>
          </select>
        </div>
      </div>
    </div>

    <div class="vp-sec">
      <div class="vp-lbl">战术辅助与吸附</div>
      <div class="vp-chips">
        <label class="vp-snap-chk">
          <input v-model="landmarks.showCoords" type="checkbox" data-test="toggle-show-coords" />
          显示坐标
        </label>
        <label class="vp-snap-chk">
          <input v-model="landmarks.selGlow" type="checkbox" data-test="toggle-sel-glow" />
          造物高亮
        </label>
        <button class="gbtn fr cut sm" :class="{ on: landmarks.hideEndpoints }" data-test="btn-landmark-hide-endpoints" @click="landmarks.hideEndpoints = !landmarks.hideEndpoints">隐藏测距端点</button>
        <label class="vp-snap-chk">
          <input v-model="landmarks.snapLandmarks" type="checkbox" data-test="toggle-snap-master" />
          吸附总开关
        </label>
      </div>
      <div v-if="landmarks.snapLandmarks" class="vp-snap-grid">
        <label v-for="[k, lbl] in SNAP_TARGET_LABELS" :key="k" class="vp-snap-chk">
          <input v-model="landmarks.snapTargets[k]" type="checkbox" :data-test="`toggle-snap-${k}`" />
          {{ lbl }}
        </label>
      </div>
    </div>
  </div>
</template>
