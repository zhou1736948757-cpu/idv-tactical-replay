<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { store } from '@/store/app';
import { formatDuration } from '@/lib/format';

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && store.noticeOpen) store.noticeOpen = false;
}
onMounted(() => window.addEventListener('keydown', onKeyDown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown));

const stats = computed(() => ({
  matches: store.matches.length,
  maps: new Set(store.matches.map((m) => m.map_name)).size,
  uploaded: store.matches.filter((m) => m.source === 'uploaded').length,
  total: store.matches.reduce((s, m) => s + (m.duration_s || 0), 0),
}));
</script>

<template>
  <div id="notice" class="overlay" :class="{ show: store.noticeOpen }" @click.self="store.noticeOpen = false">
    <div class="pop parchment-folio" role="dialog" aria-labelledby="notice-title">
      <h2 id="notice-title" class="ribbon-h">档案须知 · 图例 <small>Archive Notes</small></h2>
      <div class="stats">
        <div><b class="num">{{ stats.matches }}</b><span>对局</span></div>
        <div><b class="num">{{ stats.maps }}</b><span>地图</span></div>
        <div><b class="num">{{ stats.uploaded }}</b><span>上传</span></div>
        <div><b class="num">{{ formatDuration(stats.total) }}</b><span>总时长</span></div>
      </div>
      <div class="legendrow">
        <span><i class="swatch hunter" aria-hidden="true"></i>监管者（绯红环）</span>
        <span><i class="swatch survivor" aria-hidden="true"></i>求生者（石板蓝环）</span>
        <span><i class="swatch cipher" aria-hidden="true"></i>密码机进度环</span>
        <span><i class="swatch chair" aria-hidden="true"></i>狂欢之椅（虚线 = 地下室 B1）</span>
      </div>
      <ul>
        <li>来源：本地第五人格录像（.zip / Pickle 快照）经静态白名单审计后安全解析，不调用不受限的 pickle 反序列化。</li>
        <li>轨迹为服务器同步的移动 / 镜头 / RPC 数据，并非键鼠硬件输入重建。</li>
        <li>角色 PID 尚无经验证的中文名映射，故如实显示 <b>PID #编号</b>；监管者天赋显示原始编号 <b>监管天赋 #编号</b>，求生者天赋名仅对求生者生效。</li>
        <li>楼层：B1（y &lt; −20）、1F（−20 ≤ y &lt; 25）、2F（y ≥ 25）；测距按 45 u/s 冲刺估算，跨楼层追加 90u 楼梯惩罚。</li>
        <li>监管者肖像仅作装饰，可在沙盘顶栏自选，不代表录像中的实际角色。</li>
        <li>快捷键：空格 播放/暂停 · ←/→ 跳转 5 秒 · 2 / 3 切换 2D 俯视 / 3D 实景与模拟跑图。</li>
      </ul>
      <button class="btn-primary close" @click="store.noticeOpen = false">关闭</button>
    </div>
  </div>
</template>

<style scoped>
#notice .pop {
  font-family: var(--font-cjk);
  clip-path: none;
  background-color: #ebe0c8;
}

#notice .stats,
#notice .stats div {
  border-color: rgba(154, 118, 66, 0.55);
}

#notice .stats {
  background: linear-gradient(180deg, rgba(223, 204, 168, 0.55) 0%, rgba(242, 231, 206, 0.65) 100%);
  border-radius: 4px;
  box-shadow: inset 0 1px 2px rgba(64, 42, 18, 0.14);
}

#notice .stats b {
  color: var(--ink-red);
  font-family: var(--font-num);
  font-size: 20px;
  font-weight: 700;
}

#notice .stats span {
  color: var(--ink-muted);
  font-family: var(--font-cjk);
  font-size: var(--f-sm);
  font-weight: 600;
}

#notice .legendrow,
#notice ul {
  color: var(--ink);
  font-family: var(--font-cjk);
  font-size: 13px;
  line-height: 1.55;
}

#notice .legendrow {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 168px), 1fr));
  gap: 6px 12px;
  padding: 8px 10px;
  border-block: 1px solid rgba(154, 118, 66, 0.42);
  background: rgba(247, 238, 217, 0.45);
  font-size: var(--f-sm);
}

#notice ul li::marker {
  color: #8c6432;
}

.swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-inline-end: 7px;
  border: 2px solid currentColor;
  border-radius: 50%;
  vertical-align: -1px;
}

.hunter, .chair { color: var(--ink-red); }
.survivor { color: var(--ink-blue); }
.cipher { color: #76541f; }
.chair { background: currentColor; clip-path: polygon(50% 0, 100% 100%, 0 100%); border-radius: 0; }
</style>
