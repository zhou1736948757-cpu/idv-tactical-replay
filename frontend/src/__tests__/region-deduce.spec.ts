import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeReplayLink } from '@/tactical/replay-link';
import { evaluatePractice } from '@/tactical/practice';
import { flow, setRegionSubmode } from '@/store/flow';
import { resetStore, store } from '@/store/app';
import RegionView from '@/components/RegionView.vue';
import DeduceView from '@/components/DeduceView.vue';
import {
  MAPS_DATA,
  SPAWN_PREDICT_DATA,
  analyzeRegionCiphers,
  calculateZoneCenters,
  cellIdToPilZone,
  consumeSandboxBoardHandoff,
  formatCellCoord,
  getActiveMapId,
  loadBoardState,
  loadRegionState,
  mapsZonesRelative,
  pilZoneToCellId,
  predictHunterSpawn,
  setActiveMapId,
  topSurvivorLayouts,
} from '@/tactical';
import { installCanvasStub, installImageStub } from './canvas-stub';

let restoreImg: (() => void) | null = null;

beforeEach(() => {
  resetStore();
  flow.prefs.autoFlow = false;
  flow.mode = 'idle';
  flow.link = null;
  flow.reveal = null;
  flow.draftRegion = null;
  setRegionSubmode('lock');
  location.hash = '';
  localStorage.clear();
  setActiveMapId(0);
});

afterEach(() => {
  flow.prefs.autoFlow = true;
  flow.mode = 'idle';
  flow.link = null;
  flow.reveal = null;
  flow.draftRegion = null;
  setRegionSubmode('lock');
  location.hash = '';
  consumeSandboxBoardHandoff();
  restoreImg?.();
  restoreImg = null;
  vi.unstubAllGlobals();
});

describe('04 区域选点 (RegionView)', () => {
  it('supports all 9 maps including Eversleeping 10-zone rotation and Lakeside/Moonlit 12 zones', async () => {
    const { calls } = installCanvasStub();
    const imgStub = installImageStub('load', { w: 750, h: 644 });
    restoreImg = imgStub.restore;

    const w = mount(RegionView);
    await new Promise((r) => setTimeout(r, 5));
    await flushPromises();

    expect(w.findAll('[data-test="region-map-select"] option')).toHaveLength(9);
    expect(w.findAll('[data-zone-idx]')).toHaveLength(9);
    expect(calls.drawImage).toBeGreaterThan(0);

    // Switch to 永眠镇 (mapId = 6): 10 zones + rotationQuadrants = 1 canvas transform
    await w.find('[data-test="region-map-select"]').setValue('6');
    await new Promise((r) => setTimeout(r, 5));
    await flushPromises();
    expect(getActiveMapId()).toBe(6);
    expect(w.findAll('[data-zone-idx]')).toHaveLength(10);
    expect(imgStub.created.at(-1)?.src).toContain(encodeURI('永眠镇_grid.jpg'));
    expect(calls.transform).toBeGreaterThan(0);

    // Lakeside (3) & Moonlit (4) have 12 zones; Red Church (2) has 9 staggered zones
    await w.find('[data-test="region-map-select"]').setValue('3');
    expect(w.findAll('[data-zone-idx]')).toHaveLength(12);
    await w.find('[data-test="region-map-select"]').setValue('4');
    expect(w.findAll('[data-zone-idx]')).toHaveLength(12);
    await w.find('[data-test="region-map-select"]').setValue('2');
    expect(w.findAll('[data-zone-idx]')).toHaveLength(9);
    w.unmount();
  });

  it('degrades gracefully when map artwork fails to load', async () => {
    installCanvasStub();
    restoreImg = installImageStub('error').restore;
    setActiveMapId(8);
    const w = mount(RegionView);
    await new Promise((r) => setTimeout(r, 5));
    await flushPromises();
    expect(w.text()).toContain('线框模式');
    await w.find('[data-zone-idx="0"]').trigger('click');
    expect(w.find('[data-test="region-side-survivor"]').text()).toContain('1 / 4');
    w.unmount();
  });

  it('enforces survivor 4-cap, hunter 1-cap, mutual exclusion banners, and canvas coordinate clicks', async () => {
    installCanvasStub();
    restoreImg = installImageStub('load').restore;
    const w = mount(RegionView);
    await flushPromises();

    // Select 4 survivor zones, then attempt a 5th -> capped at 4
    await w.find('[data-zone-idx="0"]').trigger('click');
    await w.find('[data-zone-idx="1"]').trigger('click');
    await w.find('[data-zone-idx="2"]').trigger('click');
    await w.find('[data-zone-idx="3"]').trigger('click');
    expect(w.find('[data-test="region-side-survivor"]').text()).toContain('4 / 4');

    await w.find('[data-zone-idx="4"]').trigger('click');
    expect(w.find('[data-test="region-side-survivor"]').text()).toContain('4 / 4');
    expect(w.find('[data-test="region-msg"]').text()).toContain('最多选择 4 个区域');

    // Toggle one off -> 3 / 4
    await w.find('[data-zone-idx="3"]').trigger('click');
    expect(w.find('[data-test="region-side-survivor"]').text()).toContain('3 / 4');

    // Switch to hunter and attempt clicking a survivor-occupied zone -> mutual exclusion banner
    await w.find('[data-test="region-side-hunter"]').trigger('click');
    await w.find('[data-zone-idx="0"]').trigger('click');
    expect(w.find('[data-test="region-msg"]').text()).toBe('该区域已被求生者选择，监管者无法选择');
    expect(w.find('[data-test="region-side-hunter"]').text()).toContain('0 / 1');

    // Click zone 5 directly via <canvas> coordinates -> places hunter in zone 5
    const centers = calculateZoneCenters(mapsZonesRelative[0]!);
    const [mw, mh] = MAPS_DATA[0]!.mapSize;
    await w.find('[data-test="region-canvas"]').trigger('click', {
      clientX: centers[5]!.x * mw,
      clientY: centers[5]!.y * mh,
    });
    expect(w.find('[data-test="region-side-hunter"]').text()).toContain('1 / 1');

    // Clicking zone 8 as hunter moves the single hunter zone cleanly
    await w.find('[data-zone-idx="8"]').trigger('click');
    expect(w.find('[data-test="region-side-hunter"]').text()).toContain('1 / 1');
    expect(w.find('[data-test="hunter-zone-name"]').text()).toBe(MAPS_DATA[0]!.zoneNames[8]);

    // Switching back to survivor and clicking zone 8 -> mutual exclusion banner
    await w.find('[data-test="region-side-survivor"]').trigger('click');
    await w.find('[data-zone-idx="8"]').trigger('click');
    expect(w.find('[data-test="region-msg"]').text()).toBe('该区域已被监管者选择，求生者无法选择');
    w.unmount();
  });

  it('computes lock cipher & meter distance, cycles cipher groups, persists to localStorage, and resets', async () => {
    installCanvasStub();
    restoreImg = installImageStub('load').restore;
    const w = mount(RegionView);
    await flushPromises();

    await w.find('[data-test="region-side-hunter"]').trigger('click');
    await w.find('[data-zone-idx="2"]').trigger('click');

    const expected0 = analyzeRegionCiphers(0, 0, 2);
    expect(w.find('[data-test="lock-cipher-name"]').text()).toBe(expected0.lockCipherName);
    expect(w.find('[data-test="lock-cipher-dist"]').text()).toBe(`${expected0.lockDistanceM!.toFixed(1)} m`);
    expect(w.findAll('[data-cipher-row]')).toHaveLength(7);
    expect(w.find(`[data-cipher-row="${expected0.lockIndex}"]`).classes()).toContain('locked');
    expect(w.find(`[data-cipher-row="${expected0.lockIndex}"]`).text()).toContain('封禁');

    // Cycle cipher group forward and back
    await w.find('[data-test="region-cipher-next"]').trigger('click');
    expect(w.find('[data-test="region-cipher-label"]').text()).toContain('第 2 / 5 组密码机');
    const expected1 = analyzeRegionCiphers(0, 1, 2);
    expect(w.find('[data-test="lock-cipher-name"]').text()).toBe(expected1.lockCipherName);
    expect(w.find('[data-test="lock-cipher-dist"]').text()).toBe(`${expected1.lockDistanceM!.toFixed(1)} m`);
    expect(w.find('[data-test="region-hints"]').text()).toContain(MAPS_DATA[0]!.fixedHint);

    // Click cipher row to highlight + toggle show doors
    await w.find('[data-cipher-row="1"]').trigger('click');
    expect(w.find('[data-cipher-row="1"]').classes()).toContain('selected-cipher');
    await w.find('[data-test="region-display-btn"]').trigger('click');
    await w.find('[data-test="region-show-doors"]').setValue(true);

    // Remount restores selections & settings from localStorage
    w.unmount();
    const w2 = mount(RegionView);
    await flushPromises();
    expect(w2.find('[data-test="region-cipher-label"]').text()).toContain('第 2 / 5 组密码机');
    expect(w2.find('[data-test="lock-cipher-name"]').text()).toBe(expected1.lockCipherName);
    expect(w2.find('[data-cipher-row="1"]').classes()).toContain('selected-cipher');

    // Reset clears selections
    await w2.find('[data-test="region-reset"]').trigger('click');
    expect(w2.find('[data-test="region-side-hunter"]').text()).toContain('0 / 1');
    expect(w2.find('[data-test="lock-cipher-name"]').text()).toBe('--');
    expect(w2.find('[data-test="lock-cipher-dist"]').text()).toBe('--');
    w2.unmount();
  });

  it('toggles hunter off on repeat click, deselects cipher row on repeat click, and updates dynamic hints across groups', async () => {
    installCanvasStub();
    restoreImg = installImageStub('load').restore;
    const w = mount(RegionView);
    await flushPromises();

    // Switch to 唐人街 (7) where group 0 has a hint and group 2 has empty hint
    await w.find('[data-test="region-map-select"]').setValue('7');
    await flushPromises();
    expect(w.find('[data-test="region-hints"]').text()).toContain(MAPS_DATA[7]!.hints[0]!);
    await w.find('[data-test="region-cipher-next"]').trigger('click');
    await w.find('[data-test="region-cipher-next"]').trigger('click');
    expect(w.find('[data-test="region-cipher-label"]').text()).toContain('第 3 / 6 组密码机');
    expect(w.find('[data-test="region-hints"]').text()).toContain(MAPS_DATA[7]!.fixedHint);

    // Toggle hunter on/off
    await w.find('[data-test="region-side-hunter"]').trigger('click');
    await w.find('[data-zone-idx="4"]').trigger('click');
    expect(w.find('[data-test="region-side-hunter"]').text()).toContain('1 / 1');
    await w.find('[data-zone-idx="4"]').trigger('click');
    expect(w.find('[data-test="region-side-hunter"]').text()).toContain('0 / 1');

    // Toggle cipher row on/off
    await w.find('[data-cipher-row="0"]').trigger('click');
    expect(w.find('[data-cipher-row="0"]').classes()).toContain('selected-cipher');
    await w.find('[data-cipher-row="0"]').trigger('click');
    expect(w.find('[data-cipher-row="0"]').classes()).not.toContain('selected-cipher');
    w.unmount();
  });

  it('handles display popover toggles and size slider defaults', async () => {
    const { calls } = installCanvasStub();
    restoreImg = installImageStub('load').restore;
    const w = mount(RegionView);
    await flushPromises();

    await w.find('[data-test="region-display-btn"]').trigger('click');
    const pop = w.find('[data-test="region-display-popover"]');
    expect(pop.isVisible()).toBe(true);

    const drawCountBefore = calls.rect ?? 0;
    await w.find('[data-test="region-show-doors"]').setValue(true);
    await w.find('[data-test="region-show-dungeons"]').setValue(false);
    await flushPromises();
    expect((calls.rect ?? 0)).toBeGreaterThan(drawCountBefore);

    const sliders = pop.findAll('input[type="range"]');
    expect(sliders).toHaveLength(3);
    await sliders[0]!.setValue('80');
    const defaults = pop.findAll('button');
    expect(defaults.length).toBe(3);
    await defaults[0]!.trigger('click');
    expect((sliders[0]!.element as HTMLInputElement).value).toBe('50');
    w.unmount();
  });
});

describe('05 密码机推演 (DeduceView)', () => {
  it('locks fixed ciphers, cycles unknown -> yes -> no -> clear, and renders Eversleeping 90deg grid rotation', async () => {
    const w = mount(DeduceView);
    await flushPromises();

    // 军工厂: M_4 (沙包) is locked (必刷)
    const lockedBtn = w.find('[data-cipher-name="沙包"]');
    expect(lockedBtn.attributes('disabled')).toBeDefined();
    expect(lockedBtn.classes()).toContain('locked');
    expect(lockedBtn.text()).toContain('必刷');
    expect(w.find('[data-test="deduce-progress"]').text()).toContain('1 / 7');

    // Unlocked cipher cycles unknown -> user-yes -> user-no -> unknown
    const gateBtn = w.find('[data-cipher-name="正门"]');
    expect(gateBtn.classes()).toContain('unknown');
    expect(gateBtn.get('.ded-marker-label').text()).toBe('未知');
    expect(gateBtn.attributes('aria-label')).toBe('正门，未知，点击标记有');
    expect(gateBtn.attributes('title')).toContain('未知，点击标记有');
    await gateBtn.trigger('click');
    expect(w.find('[data-cipher-name="正门"]').classes()).toContain('user-yes');
    await gateBtn.trigger('click');
    expect(w.find('[data-cipher-name="正门"]').classes()).toContain('user-no');
    await gateBtn.trigger('click');
    expect(w.find('[data-cipher-name="正门"]').classes()).toContain('unknown');

    const unrotatedImage = w.get<HTMLImageElement>('.ded-map-img');
    expect(unrotatedImage.attributes('data-map-preset')).toBe('clarity');
    expect(unrotatedImage.element.style.opacity).toBe('1');

    // Switch to 永眠镇 (6): verifies gridPlacement rotationQuadrants = 1 on map image
    await w.find('[data-test="deduce-map-select"]').setValue('6');
    await flushPromises();
    const img = w.get<HTMLImageElement>('.ded-map-img');
    expect(img.attributes('data-map-preset')).toBe('clarity');
    expect(img.element.style.opacity).toBe('1');
    expect(img.attributes('data-rot-quadrants')).toBe('1');
    expect(img.attributes('style')).toContain('rotate(90deg)');
    w.unmount();
  });

  it('uniquely locks a layout, highlights step scopes (circle & chain), alerts contradictions, previews layouts & persists', async () => {
    const w = mount(DeduceView);
    await flushPromises();

    // On 军工厂: marking 伐木林 + 四合院 + 正门 + 工厂外 = yes uniquely identifies 第 1 组密码机
    await w.find('[data-cipher-name="伐木林"]').trigger('click');
    await w.find('[data-cipher-name="四合院"]').trigger('click');
    await w.find('[data-cipher-name="正门"]').trigger('click');
    await w.find('[data-cipher-name="工厂外"]').trigger('click');

    expect(w.find('[data-test="deduce-conclusion"]').text()).toBe('第 1 组密码机');
    expect(w.find('[data-test="deduce-progress"]').text()).toContain('7 / 7');
    expect(w.find('[data-layout-idx="0"] .ded-layout-badge').classes()).toContain('unique');
    for (const [id, row] of w.findAll('.ded-matrix details').entries()) {
      const marker = w.get(`[data-cipher-idx="${id}"]`);
      expect(row.get('summary b').text()).toBe(marker.get('.ded-marker-label').text());
      const source = w.vm.deduceResult.sources[id];
      if (marker.classes().includes('locked')) expect(row.get('p').text()).toBe('地图固定必刷点');
      else if (marker.classes().some(kind => kind.startsWith('inf-'))) {
        expect(source).toBeGreaterThan(0);
        expect(row.get('p').text()).toBe(w.vm.deduceResult.steps[source! - 1]!.rule);
      }
    }

    // Step selection highlights circle scope rings on map
    const stepBtns = w.findAll('[data-step-idx]');
    expect(stepBtns.length).toBeGreaterThan(0);
    await stepBtns[0]!.trigger('click');
    expect(w.findAll('.scope-ring').length).toBeGreaterThan(0);

    // Candidate layout preview switches conclusion, and clicking a marker exits preview
    await w.find('[data-layout-idx="1"]').trigger('click');
    expect(w.find('[data-test="deduce-conclusion"]').text()).toBe('第 2 组密码机');
    expect(w.find('[data-layout-idx="1"]').classes()).toContain('active');
    await w.find('[data-cipher-name="伐木林"]').trigger('click'); // cycles yes -> no, exits preview
    expect(w.find('[data-layout-idx="1"]').classes()).not.toContain('active');

    // Reset and explicitly trigger 'either' contradiction: 正门=yes & 正门废墟=yes
    await w.find('[data-test="deduce-reset"]').trigger('click');
    expect(w.find('[data-test="deduce-alert"]').exists()).toBe(false);
    await w.find('[data-cipher-name="正门"]').trigger('click');
    await w.find('[data-cipher-name="正门废墟"]').trigger('click');
    expect(w.find('[data-test="deduce-alert"]').exists()).toBe(true);
    expect(w.find('[data-test="deduce-conclusion"]').text()).toContain('矛盾');

    // Switch to 唐人街 (7) to verify chainThree SVG polyline scope rendering
    await w.find('[data-test="deduce-map-select"]').setValue('7');
    await flushPromises();
    await w.find('[data-cipher-name="花店"]').trigger('click'); // M_1 = yes
    await w.find('[data-cipher-name="肉铺"]').trigger('click'); // E_1 = yes -> triggers chainThree inference (裁缝铺内-花店-肉铺-醉芳庭)
    const steps7 = w.findAll('[data-step-idx]');
    const chainStepIdx = steps7.findIndex((b) => b.text().includes('连线') || b.text().includes('裁缝铺内') || b.text().includes('醉芳庭'));
    expect(chainStepIdx).toBeGreaterThanOrEqual(0);
    await steps7[chainStepIdx]!.trigger('click');
    expect(w.find('svg.ded-chain-svg polyline.chain-line').exists()).toBe(true);

    // Remount preserves 唐人街 and saved marks; switching to RegionView shares active map 7
    w.unmount();
    const w2 = mount(DeduceView);
    await flushPromises();
    expect((w2.find('[data-test="deduce-map-select"]').element as HTMLSelectElement).value).toBe('7');
    expect(w2.find('[data-cipher-name="花店"]').classes()).toContain('user-yes');
    w2.unmount();

    installCanvasStub();
    restoreImg = installImageStub('load').restore;
    const rw = mount(RegionView);
    await flushPromises();
    expect((rw.find('[data-test="region-map-select"]').element as HTMLSelectElement).value).toBe('7');
    rw.unmount();
  });

  it('renders cyclic chain scope polygons on Moonlit River Park and rulebook reference', async () => {
    const w = mount(DeduceView);
    await flushPromises();

    await w.find('[data-test="deduce-map-select"]').setValue('4'); // 月亮河公园
    await flushPromises();
    expect(w.find('[data-test="deduce-rules"]').text()).toContain('五边形');

    // Click 马戏团 twice -> unknown -> yes -> no, triggering cyclic chain rule (wraps to 3号站台 & 狮笼)
    await w.find('[data-cipher-name="马戏团"]').trigger('click');
    await w.find('[data-cipher-name="马戏团"]').trigger('click');
    const stepBtns = w.findAll('[data-step-idx]');
    const cyclicIdx = stepBtns.findIndex((b) => b.text().includes('五边形'));
    expect(cyclicIdx).toBeGreaterThanOrEqual(0);
    await stepBtns[cyclicIdx]!.trigger('click');

    const poly = w.find('svg.ded-chain-svg polyline.chain-line');
    expect(poly.exists()).toBe(true);
    const pts = (poly.attributes('points') ?? '').trim().split(/\s+/);
    expect(pts).toHaveLength(6); // 5 vertices + closing vertex
    expect(pts[0]).toBe(pts[pts.length - 1]); // closed cyclic loop
    w.unmount();
  });

  it('handles dual locked ciphers on Moonlit River Park and exits layout preview via 全部布局 button', async () => {
    const w = mount(DeduceView);
    await flushPromises();

    await w.find('[data-test="deduce-map-select"]').setValue('4'); // 月亮河公园
    await flushPromises();
    expect(w.find('[data-cipher-name="惊叫屋"]').attributes('disabled')).toBeDefined();
    expect(w.find('[data-cipher-name="北桥"]').attributes('disabled')).toBeDefined();
    expect(w.find('[data-test="deduce-progress"]').text()).toContain('2 / 7');

    await w.find('[data-layout-idx="0"]').trigger('click');
    expect(w.find('[data-test="deduce-conclusion"]').text()).toBe('第 1 组密码机');
    await w.find('[data-test="deduce-layout-all"]').trigger('click');
    expect(w.find('[data-test="deduce-conclusion"]').text()).toContain('待定');
    w.unmount();
  });
});

it('draws both prediction rings on comparison and neither on the pro-only layer', async () => {
  const { ctx } = installCanvasStub();
  const dash = vi.fn();
  ctx.setLineDash = dash;
  const truth = computeReplayLink(JSON.parse(readFileSync('../backend/data/cache/6b04323a84b889718100f507/replay_2d.json', 'utf8')))!;
  setActiveMapId(truth.mapId);
  const attempt = { survivorZones: [0], hunterZone: 2, groupIndex: 0, lockCipherId: null };
  flow.mode = 'revealed';
  flow.reveal = { truth, attempt, score: evaluatePractice(attempt, truth) };
  flow.draftRegion = { side: -1, survivorZones: [0], hunterZones: [2], cipherGroupIndex: 0,
    selectedCipherIndex: 0, roleSize: 50, cipherSize: 5.2, doorSize: 6, showDoors: false };
  const view = mount(RegionView);
  try {
    await flushPromises();
    expect(view.findAll('.verdict .wax-seal text').map(line => line.text())).toEqual(['偏差', 'Miss']);
    expect(dash).toHaveBeenCalledWith([5, 4]);
    expect(dash).toHaveBeenCalledWith([3, 2]);
    dash.mockClear();
    await view.get('#region-folio select').setValue('pro');
    expect(view.findAll('[data-test=practice-spawn-point]')).toHaveLength(5);
    expect(view.find('.verdict').exists()).toBe(false);
    expect(dash).not.toHaveBeenCalledWith([5, 4]);
    expect(dash).not.toHaveBeenCalledWith([3, 2]);
    expect(view.find('[data-test=region-cipher-table]').exists()).toBe(false);
    expect(view.get('[data-test=lock-cipher-name]').text()).not.toBe('');
    await view.get('#region-folio select').setValue('mine');
    expect(view.find('[data-test=practice-spawn-diff]').exists()).toBe(false);
    expect(view.find('[data-test=practice-score]').exists()).toBe(false);
    expect(view.get('[data-test=region-cipher-table]').isVisible()).toBe(true);
  } finally {
    view.unmount();
    flow.mode = 'idle';
    flow.reveal = null;
    flow.draftRegion = null;
  }
});

describe('04 区域选点 — Mode A 开局选点预测 & 跨阶段联动 (T-027)', () => {
  it('renders 2-mode segmented tabs defaulting to lock, honors #s=4&sub=predict, and supports all 9 maps + 35-hunter modal', async () => {
    installCanvasStub();
    restoreImg = installImageStub('load', { w: 750, h: 644 }).restore;

    const w = mount(RegionView);
    await flushPromises();

    // Defaults to Mode B ('lock') with [data-test="region-canvas"] mounted
    expect(w.find('[data-test="region-submode-tabs"]').exists()).toBe(true);
    expect(w.find('[data-test="btn-region-mode-lock"]').attributes('aria-selected')).toBe('true');
    expect(w.find('[data-test="region-canvas"]').exists()).toBe(true);
    expect(w.find('[data-test="spawn-predict-board"]').exists()).toBe(false);

    // Switch to Mode A ('predict')
    await w.find('[data-test="btn-region-mode-predict"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="btn-region-mode-predict"]').attributes('aria-selected')).toBe('true');
    expect(w.find('[data-test="spawn-predict-board"]').exists()).toBe(true);
    expect(w.find('[data-test="region-canvas"]').exists()).toBe(false);

    // Verify all 9 maps in selector & GEO cell counts (3x3, 3x4 Lakeside/Moonlit, 3x3+(1,4) Eversleeping)
    expect(w.findAll('[data-test="predict-map-select"] option')).toHaveLength(9);
    expect(w.findAll('[data-predict-cell]')).toHaveLength(9);

    await w.find('[data-test="predict-map-select"]').setValue('3'); // 湖景村 3x4 = 12
    await flushPromises();
    expect(getActiveMapId()).toBe(3);
    expect(w.findAll('[data-predict-cell]')).toHaveLength(12);
    expect(w.find('[data-predict-cell="34"]').exists()).toBe(true);

    await w.find('[data-test="predict-map-select"]').setValue('4'); // 月亮河公园 3x4 = 12
    await flushPromises();
    expect(w.findAll('[data-predict-cell]')).toHaveLength(12);

    await w.find('[data-test="predict-map-select"]').setValue('6'); // 永眠镇 3x3+(1,4) = 10
    await flushPromises();
    expect(w.findAll('[data-predict-cell]')).toHaveLength(10);
    expect(w.find('[data-predict-cell="14"]').exists()).toBe(true);
    expect(w.find('[data-predict-cell="24"]').exists()).toBe(false);
    expect(w.find('[data-predict-cell="34"]').exists()).toBe(false);

    // Open 35-Hunter Modal + search + local portraits (0 external URLs)
    await w.find('[data-test="btn-predict-hunter"]').trigger('click');
    await flushPromises();
    const modal = w.find('[data-test="spawn-hunter-modal"]');
    expect(modal.exists()).toBe(true);
    // 1 ("不限监管") + 35 hunters = 36 cards
    expect(modal.findAll('[data-hunter-idx]')).toHaveLength(1 + SPAWN_PREDICT_DATA.hunters.length);
    const modalImgs = modal.findAll('img').map((img) => img.attributes('src') ?? '');
    expect(modalImgs[0]).toBe('/assets/seal.jpg');
    for (const src of modalImgs) {
      expect(src).not.toMatch(/https?:\/\//i);
      expect(src.startsWith('/assets/')).toBe(true);
    }

    // Search alias "宿伞" -> finds 宿伞之魂; search "歌剧" -> selects 歌剧演员
    await modal.find('[data-test="spawn-hunter-search"]').setValue('宿伞');
    await flushPromises();
    expect(modal.text()).toContain('宿伞之魂');

    await modal.find('[data-test="spawn-hunter-search"]').setValue('歌剧');
    await flushPromises();
    const operaBtn = modal.find('[data-hunter-idx="26"]');
    expect(operaBtn.exists()).toBe(true);
    await operaBtn.trigger('click');
    await flushPromises();
    expect(w.find('[data-test="spawn-hunter-modal"]').exists()).toBe(false);
    expect(w.find('[data-test="btn-predict-hunter"]').text()).toContain('歌剧演员');
    w.unmount();

    // Deep-link #s=4&sub=predict opens directly in 'predict'
    setRegionSubmode('lock');
    location.hash = '#s=4&sub=predict';
    const wDeep = mount(RegionView);
    await flushPromises();
    expect(wDeep.find('[data-test="spawn-predict-board"]').exists()).toBe(true);
    wDeep.unmount();
  });

  it('computes heatmap, Top-1 badge, runner-ups, my-alt diff, Top-6 presets, random pick & Top-20 matched games', async () => {
    installCanvasStub();
    restoreImg = installImageStub('load', { w: 750, h: 644 }).restore;

    setActiveMapId(0);
    setRegionSubmode('predict');
    const w = mount(RegionView);
    await flushPromises();

    // Top-6 layout presets render 6 mini-grid buttons
    const presets = w.findAll('[data-test="predict-top-layouts"] [data-layout-key]');
    expect(presets).toHaveLength(6);

    // Click Top-1 layout preset -> immediate exact prediction
    await presets[0]!.trigger('click');
    await flushPromises();

    const layout0 = topSurvivorLayouts(0, -1, 6)[0]!;
    const expected = predictHunterSpawn({ mapId: 0, hunterIdx: -1, survCells: layout0.cells });
    expect(expected.status).toBe('ok');
    expect(expected.best).not.toBeNull();

    expect(w.find('[data-test="predict-best-badge"]').exists()).toBe(true);
    expect(w.find('[data-test="predict-verdict-card"]').text()).toContain('精确匹配');
    expect(w.find('[data-test="predict-best-coord"]').text()).toBe(expected.best!.coord);
    expect(w.find('[data-test="predict-best-zone"]').text()).toBe(expected.best!.zoneName);
    expect(w.find(`[data-predict-cell="${expected.best!.cellId}"]`).text()).toContain('局');

    // Matched records table has 1..20 rows with source tags and row-click loading
    const rows = w.findAll('[data-test="predict-records-table"] tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(20);
    const tableText = w.find('[data-test="predict-records-table"]').text();
    expect(tableText.includes('本人录像') || tableText.includes('实局观战')).toBe(true);

    // Toggle "标备选 (我)" and test match vs mismatch comparison
    await w.find('[data-test="btn-predict-mark-alt"]').trigger('click');
    await w.find(`[data-predict-cell="${expected.best!.cellId}"]`).trigger('click');
    await flushPromises();
    expect(w.find('[data-test="predict-my-alt-diff"]').text()).toContain('与首选一致');

    const altCell = expected.validCells.find(
      (c) => c !== expected.best!.cellId && !layout0.cells.includes(c),
    )!;
    await w.find(`[data-predict-cell="${altCell}"]`).trigger('click');
    await flushPromises();
    const diffEl = w.find('[data-test="predict-my-alt-diff"]');
    expect(diffEl.find('s').text()).toBe(formatCellCoord(altCell));

    // Random real record + Clear
    await w.find('[data-test="btn-predict-random"]').trigger('click');
    await flushPromises();
    expect(w.findAll('[data-predict-cell].surv')).toHaveLength(4);

    await w.find('[data-test="btn-predict-clear"]').trigger('click');
    await flushPromises();
    expect(w.findAll('[data-predict-cell].surv')).toHaveLength(0);
    expect(w.find('[data-test="predict-best-badge"]').exists()).toBe(false);
    w.unmount();
  });

  it('transfers 永眠镇 (14->9) and 湖景村 (14/24/34->9/10/11) via 带入封禁分析 and dispatches 发送到战术沙盘', async () => {
    installCanvasStub();
    restoreImg = installImageStub('load', { w: 750, h: 874 }).restore;

    // 1. 永眠镇 (mapId = 6) with cemetery cell 14 -> PIL zone 9
    setActiveMapId(6);
    setRegionSubmode('predict');
    const w = mount(RegionView);
    await flushPromises();

    const evSurv = [11, 14, 22, 31];
    for (const cid of evSurv) {
      await w.find(`[data-predict-cell="${cid}"]`).trigger('click');
    }
    await flushPromises();

    const evPred = predictHunterSpawn({ mapId: 6, hunterIdx: -1, survCells: evSurv });
    expect(evPred.status).toBe('ok');
    expect(evPred.best).not.toBeNull();

    // Send to Sandbox first (verifies tokens + handoff + setStep(2))
    await w.find('[data-test="btn-predict-to-sandbox"]').trigger('click');
    await flushPromises();
    expect(store.step).toBe(2);
    const board6 = loadBoardState(6);
    expect(board6.tokens.filter((t) => t.spawnPreview)).toHaveLength(5);
    const handoff = consumeSandboxBoardHandoff();
    expect(handoff).not.toBeNull();
    expect(handoff!.mapId).toBe(6);
    expect(handoff!.source).toBe('spawn-predict');
    expect(handoff!.survivorZones).toEqual(evSurv.map((c) => cellIdToPilZone(6, c)));
    expect(handoff!.hunterZone).toBe(cellIdToPilZone(6, evPred.best!.cellId));
    expect(handoff!.survivorZones).toContain(9); // (1,4) -> zone 9

    // Click 带入封禁分析 -> switches to Mode B ('lock') & computes lock cipher immediately
    await w.find('[data-test="btn-predict-to-lock"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="btn-region-mode-lock"]').attributes('aria-selected')).toBe('true');
    expect(w.find('[data-test="region-canvas"]').exists()).toBe(true);

    const saved6 = loadRegionState(6);
    expect(saved6.survivorZones).toEqual(evSurv.map((c) => cellIdToPilZone(6, c)));
    expect(saved6.hunterZones).toEqual([cellIdToPilZone(6, evPred.best!.cellId)]);
    const expectedAnalysis6 = analyzeRegionCiphers(6, saved6.cipherGroupIndex, saved6.hunterZones[0]!);
    expect(w.find('[data-test="lock-cipher-name"]').text()).toBe(expectedAnalysis6.lockCipherName);
    expect(w.find('[data-test="lock-cipher-dist"]').text()).toBe(`${expectedAnalysis6.lockDistanceM!.toFixed(1)} m`);

    // 2. 湖景村 (mapId = 3) with 4th-column cells 14, 24, 34 -> PIL zones 9, 10, 11
    await w.find('[data-test="btn-region-mode-predict"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="predict-map-select"]').setValue('3');
    await flushPromises();

    const lakeSurv = [14, 24, 34, 22];
    for (const cid of lakeSurv) {
      await w.find(`[data-predict-cell="${cid}"]`).trigger('click');
    }
    await flushPromises();
    const lakePred = predictHunterSpawn({ mapId: 3, hunterIdx: -1, survCells: lakeSurv });
    expect(lakePred.best).not.toBeNull();

    await w.find('[data-test="btn-predict-to-lock"]').trigger('click');
    await flushPromises();
    const saved3 = loadRegionState(3);
    expect(saved3.survivorZones).toEqual([9, 10, 11, 4]);
    expect(saved3.hunterZones).toEqual([cellIdToPilZone(3, lakePred.best!.cellId)]);
    const expectedAnalysis3 = analyzeRegionCiphers(3, saved3.cipherGroupIndex, saved3.hunterZones[0]!);
    expect(w.find('[data-test="lock-cipher-name"]').text()).toBe(expectedAnalysis3.lockCipherName);
    w.unmount();
  });

  it('imports public replay spawns via 从当前录像带入 and keeps spawn-predictor.css >= 12px & 100% local', async () => {
    installCanvasStub();
    restoreImg = installImageStub('load', { w: 750, h: 644 }).restore;

    const replay = JSON.parse(
      readFileSync('../backend/data/cache/6b04323a84b889718100f507/replay_2d.json', 'utf8'),
    );
    const link = computeReplayLink(replay)!;
    store.replay = replay;
    flow.link = link;
    flow.mode = 'idle';
    setRegionSubmode('predict');

    const w = mount(RegionView);
    await flushPromises();

    const importBtn = w.find('[data-test="btn-predict-from-replay"]');
    expect(importBtn.exists()).toBe(true);
    await importBtn.trigger('click');
    await flushPromises();

    expect(getActiveMapId()).toBe(link.mapId);
    const expectedCells = link.spawn.survivorZones
      .map((z) => pilZoneToCellId(link.mapId, z))
      .filter((c) => c >= 0);
    for (const cid of expectedCells) {
      expect(w.find(`[data-predict-cell="${cid}"]`).classes()).toContain('surv');
    }
    if (link.spawn.hunterZone !== null) {
      const hCell = pilZoneToCellId(link.mapId, link.spawn.hunterZone);
      if (hCell >= 0 && !expectedCells.includes(hCell)) {
        expect(w.find(`[data-predict-cell="${hCell}"]`).classes()).toContain('my-alt');
      }
    }
    w.unmount();

    // Verify spawn-predictor.css & pil-views.css hygiene: 0 external URLs, all font-sizes >= 12px
    for (const cssFile of ['../styles/spawn-predictor.css', '../styles/pil-views.css']) {
      const css = readFileSync(resolve(__dirname, cssFile), 'utf8');
      expect(css).not.toMatch(/https?:\/\//i);
      for (const match of css.matchAll(/font-size:\s*([\d.]+)px/g)) {
        expect(Number(match[1])).toBeGreaterThanOrEqual(12);
      }
    }
  });
});

describe('Phase 6 T-032 — Stage 04 & 05 Concept-Art Restoration Contracts', () => {
  it('renders Stage 04 Mode B & Mode A archival headers, ledger icons, cipher row glyphs, and modal eyebrow', async () => {
    installCanvasStub();
    restoreImg = installImageStub('load', { w: 750, h: 644 }).restore;

    setActiveMapId(0);
    setRegionSubmode('lock');
    const w = mount(RegionView);
    await flushPromises();

    // Stage 04 Mode B folio header & Stage 04 (IV) laurel crest
    const title04 = w.get('#region-folio .pil-case-title');
    expect(title04.get('small').text()).toBe('ARMS FACTORY · SPAWN REGION');
    expect(title04.get('h2').text()).toBe('军工厂 · 区域选点');
    expect(title04.get('em').text()).toBe('Arms Factory — Spawn Region & Cipher Lock');
    expect(title04.find('.folio-stage').exists()).toBe(true);

    // Antique ledger mini-icons and inline cipher table row icons
    expect(w.findAll('#region-folio .ledger-ico').length).toBeGreaterThanOrEqual(4);
    expect(w.findAll('#region-folio .cipher-row-ico')).toHaveLength(7);

    // Switch to Mode A (Spawn Predictor) and check header + SpawnHunterModal eyebrow
    await w.find('[data-test="btn-region-mode-predict"]').trigger('click');
    await flushPromises();
    const predictTitle = w.get('#predict-folio .pil-case-title');
    expect(predictTitle.get('small').text()).toBe('ARMS FACTORY · SPAWN PREDICTOR');
    expect(predictTitle.get('h2').text()).toBe('军工厂 · 开局预测');
    expect(predictTitle.get('em').text()).toBe('Arms Factory — Opening Spawn Predictor');
    expect(predictTitle.find('.folio-stage').exists()).toBe(true);

    await w.find('[data-test="btn-predict-hunter"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-test="spawn-hunter-modal"] .sp-modal-eyebrow').text()).toBe('OLETUS MANOR · HUNTER ROSTER');
    w.unmount();
  });

  it('renders Stage 05 archival header, headed 4-column matrix, parchment status legend, and intact 7 / 7 progress', async () => {
    setActiveMapId(0);
    const w = mount(DeduceView);
    await flushPromises();

    // Stage 05 folio header & 05 Stage laurel crest
    const title05 = w.get('#deduce-folio .pil-case-title');
    expect(title05.get('small').text()).toBe('OLETUS MANOR · CIPHER LAYOUT DEDUCTION');
    expect(title05.get('h2').text()).toBe('军工厂 · 密码机推演');
    expect(title05.get('em').text()).toBe('Arms Factory — Cipher Layout Deduction');
    expect(title05.find('.folio-stage').exists()).toBe(true);

    // Sculpted metallic progress band preserves exact progress substring
    expect(w.find('.ded-progress-band .ribbon-h').text()).toContain('推演进度');
    expect(w.find('[data-test="deduce-progress"]').text()).toContain('1 / 7');

    // 4-column antique table header bar above .ded-matrix rows
    const headCols = w.findAll('[data-test="deduce-matrix-head"] span').map((s) => s.text());
    expect(headCols).toEqual(['编号', '点位名称', '位置状态', '判定来源']);

    // Locked cipher row preserves exact className & text while rendering inline padlock icon
    const lockedRowBadge = w.find('.ded-matrix details summary b.locked');
    expect(lockedRowBadge.exists()).toBe(true);
    expect(lockedRowBadge.text()).toBe('必刷');
    expect(lockedRowBadge.find('.matrix-lock-ico').exists()).toBe(true);

    // Compact parchment status legend strip below .ded-matrix
    const legend = w.get('[data-test="deduce-status-legend"]');
    expect(legend.text()).toContain('状态图例');
    expect(legend.text()).toContain('必刷');
    expect(legend.text()).toContain('Must Spawn');
    expect(legend.text()).toContain('Present');
    expect(legend.text()).toContain('Inferred');
    expect(legend.text()).toContain('Absent');
    w.unmount();
  });
});
