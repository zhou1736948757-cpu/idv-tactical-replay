import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import type { RulerState, TacticalReplayRenderer } from '@idv/replay-renderer';
import NoticeDialog from '@/components/NoticeDialog.vue';
import TacticalBoardCanvas from '@/components/TacticalBoardCanvas.vue';
import SandboxView from '@/components/SandboxView.vue';
import { flow } from '@/store/flow';
import { resetStore, store } from '@/store/app';
import { installCanvasStub, installImageStub } from './canvas-stub';
import { makeAnalytics, makeReplay } from './fixtures';

const mock3dResetView = vi.fn();
const mock3dSetCameraMode = vi.fn();

vi.mock('@/components/tactical/Tactical3DCanvas.vue', () => ({
  __esModule: true,
  default: defineComponent({
    name: 'Tactical3DCanvas',
    props: {
      mapId: { type: Number, required: true },
      payload: { type: Object, default: null },
      t: { type: Number, default: 0 },
      isStandalone: { type: Boolean, default: false },
      floor: { type: String, default: 'ALL' },
      board: { type: Object, default: null },
      selectedUid: { type: String, default: null },
      followUid: { type: String, default: null },
      landmarks: { type: Object, default: null },
    },
    setup(props, { expose }) {
      expose({
        resetView: mock3dResetView,
        setCameraMode: mock3dSetCameraMode,
      });
      return () =>
        h('div', {
          class: 'mock-tactical-3d-canvas',
          'data-test': 'tactical-3d-canvas',
          'data-map-id': String(props.mapId),
          'data-floor': props.floor,
        });
    },
  }),
}));

const UNDERLAY = { enabled: true, opacity: 0.55, rotationQuadrants: 0 as const, flipX: false, flipZ: false };

function mountBoard(extra: Record<string, unknown> = {}) {
  return mount(TacticalBoardCanvas, {
    props: { payload: makeReplay(), t: 0, pitch: 90, yaw: 0, yScale: 1, layers: {}, underlay: { ...UNDERLAY }, ...extra },
  });
}

function rendererOf(w: { vm: unknown }): TacticalReplayRenderer {
  return (w.vm as { renderer: TacticalReplayRenderer }).renderer;
}

async function click(el: { trigger: (ev: string, opts?: object) => Promise<void> }, x: number, y: number, button = 0) {
  await el.trigger('pointerdown', { button, clientX: x, clientY: y });
  await el.trigger('pointerup', { button, clientX: x, clientY: y });
}

let restoreImage: (() => void) | null = null;
beforeEach(() => {
  resetStore();
  mock3dResetView.mockClear();
  mock3dSetCameraMode.mockClear();
  installCanvasStub();
});
afterEach(() => {
  restoreImage?.();
  restoreImage = null;
  vi.unstubAllGlobals();
});

describe('TacticalBoardCanvas ↔ @idv/replay-renderer', () => {
  it('feeds payload, explicit underlay worldRect, camera and layers into the renderer and renders', async () => {
    const { calls } = installCanvasStub();
    const w = mountBoard();
    await flushPromises();
    const r = rendererOf(w);
    expect(r.getPayload()?.match.match_id).toBe('6b04323a84b889718100f507');
    expect(r.getUnderlay().worldRect).toEqual({ min_x: -120, max_x: 130, min_z: -110, max_z: 115 });
    expect(r.getCamera().pitchDeg).toBe(90);
    expect(w.find('.hud').text()).toContain('2D 俯视');
    expect(w.find('.hud').text()).not.toContain('2.5D');
    expect(calls.fillRect).toBeGreaterThan(0);

    await w.setProps({ pitch: 55, yaw: 120, yScale: 2.5 });
    await flushPromises();
    // Pure 2D top-down keeps pitchDeg locked at 90 and yScale at 1 while honoring yaw rotation.
    expect(r.getCamera()).toMatchObject({ pitchDeg: 90, yawDeg: 120, yScale: 1 });

    await w.setProps({ layers: { visibleFloors: { B1: true, '1F': false, '2F': false }, floorPlanes: false, dropLines: false, viewCones: false, trails: false } });
    await flushPromises();
    expect(r.getLayers()).toMatchObject({ visibleFloors: { B1: true, '1F': false, '2F': false }, floorPlanes: false, dropLines: false, viewCones: false, trails: false });

    // Switching matches must replace the underlay worldRect (setPayload keeps the old one otherwise).
    const other = makeReplay();
    other.world.map_underlay.world_rect = { min_x: 800, max_x: 2200, min_z: 600, max_z: 2400 };
    await w.setProps({ payload: other });
    await flushPromises();
    expect(r.getUnderlay().worldRect).toEqual({ min_x: 800, max_x: 2200, min_z: 600, max_z: 2400 });

    await w.setProps({ underlay: { enabled: false, opacity: 0.3, rotationQuadrants: 1, flipX: true, flipZ: false } });
    await flushPromises();
    expect(r.getUnderlay()).toMatchObject({ enabled: false, opacity: 0.3, rotationQuadrants: 1, flipX: true, flipZ: false });
  });

  it('calibrates the frame against ground distances and the rotated map north axis', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const w = mountBoard();
    await flushPromises();
    const r = rendererOf(w);
    const frame = w.findComponent({ name: 'ManorMapFrame' });
    const expectedSpan = () => {
      const a = r.screenToWorld(400, 280, 0);
      const b = r.screenToWorld(500, 280, 0);
      return 100 * 40 * 45 / 3.8 / Math.hypot(a[0] - b[0], a[2] - b[2]);
    };
    expect(frame.props('pxPerMeter') * 40).toBeCloseTo(expectedSpan(), 2);
    expect(frame.props('northAngle')).toBeCloseTo(0);
    await w.find('canvas').trigger('wheel', { deltaY: -180, clientX: 400, clientY: 280 });
    await w.setProps({ yaw: 35, underlay: { ...UNDERLAY, rotationQuadrants: 1, flipX: true } });
    await flushPromises();
    const a = r.project([0, 0, 0]);
    const n = r.project([-1, 0, 0]);
    expect(frame.props('northAngle')).toBeCloseTo(Math.atan2(n.x - a.x, a.y - n.y) * 180 / Math.PI);
    expect(frame.props('pxPerMeter') * 40).toBeCloseTo(expectedSpan(), 2);
    w.unmount();
  });

  it('preloads the map underlay via window.Image and degrades gracefully on img.onerror', async () => {
    const { ctx } = installCanvasStub();
    ctx.getImageData = () => ({ data: new Uint8ClampedArray(1024 * 891 * 4) });
    ctx.putImageData = vi.fn();
    restoreImage = installImageStub('load').restore;
    const loaded = makeReplay();
    loaded.world.map_underlay.asset_url = '/assets/maps/loaded-test-map.jpg';
    const w = mountBoard({ payload: loaded });
    await new Promise((res) => setTimeout(res, 5));
    await flushPromises();
    const u = rendererOf(w).getUnderlay();
    expect(u.image).toBeInstanceOf(HTMLCanvasElement);
    expect(u).toMatchObject({
      tone: { brightness: 1, contrast: 1.04, saturation: 2.25 },
      backing: '#2b251d',
      opacity: 0.95,
    });
    expect(u.imageWidth).toBe(1024);
    expect(u.imageHeight).toBe(891);
    expect(w.emitted('underlay-status')?.at(-1)).toEqual(['ok']);
    restoreImage();

    restoreImage = installImageStub('error').restore;
    const missing = makeReplay();
    missing.world.map_underlay.asset_url = '/assets/maps/missing-test-map.jpg';
    const w2 = mountBoard({ payload: missing });
    await new Promise((res) => setTimeout(res, 5));
    await flushPromises();
    expect(rendererOf(w2).getUnderlay().image).toBeNull();
    expect(w2.emitted('underlay-status')?.at(-1)).toEqual(['missing']);
    expect(w2.text()).toContain('底图缺失');
  });

  it('two-point ruler snaps to entities and emits a 45 u/s measurement state', async () => {
    const w = mountBoard({ rulerMode: true });
    await flushPromises();
    const r = rendererOf(w);
    const canvas = w.find('canvas');
    const pallet = r.project([20, 0, 20]);
    await click(canvas, pallet.x, pallet.y);
    expect(r.getRuler()?.a).toEqual([20, 0, 20]);
    expect(w.emitted('ruler-point')?.[0]?.[0]).toMatchObject({ index: 0, snapped: { kind: 'pallet', uid: 801 } });
    const far = r.project([20, 0, -80]);
    await click(canvas, far.x, far.y);
    const ruler = w.emitted('update:ruler')?.at(-1)?.[0] as RulerState;
    expect(ruler.a).toEqual([20, 0, 20]);
    expect(ruler.b[0]).toBeCloseTo(20, 3);
    expect(ruler.b[2]).toBeCloseTo(-80, 3);
    expect(r.getRuler()).toEqual(ruler);
  });

  it('click picks entities, wheel zooms, left-drag pans and right-drag rotates yaw while keeping pure 2D pitch', async () => {
    const w = mountBoard();
    await flushPromises();
    const r = rendererOf(w);
    const canvas = w.find('canvas');
    const sv = r.project([50, 0, 50]);
    await click(canvas, sv.x, sv.y);
    expect(w.emitted('update:selectedUid')?.at(-1)).toEqual([1000008]);
    expect((w.emitted('pick')?.at(-1)?.[0] as { kind: string }).kind).toBe('player');

    const z0 = r.getCamera().zoom;
    await canvas.trigger('wheel', { deltaY: -200, clientX: 400, clientY: 280 });
    expect(r.getCamera().zoom).toBeGreaterThan(z0);

    const c0 = r.getCamera().centerX;
    await canvas.trigger('pointerdown', { button: 0, clientX: 300, clientY: 300 });
    await canvas.trigger('pointermove', { button: 0, clientX: 360, clientY: 300 });
    await canvas.trigger('pointerup', { button: 0, clientX: 360, clientY: 300 });
    expect(r.getCamera().centerX).toBeLessThan(c0);

    await canvas.trigger('pointerdown', { button: 2, clientX: 300, clientY: 300 });
    await canvas.trigger('pointermove', { button: 2, clientX: 350, clientY: 340 });
    await canvas.trigger('pointerup', { button: 2, clientX: 350, clientY: 340 });
    expect(w.emitted('update:yaw')?.at(-1)?.[0]).toBeCloseTo(20, 1);
    expect(r.getCamera().pitchDeg).toBe(90);
    expect(w.emitted('update:pitch')).toBeUndefined();
  });
});

describe('02 战术沙盘 (SandboxView)', () => {
  function setupStore() {
    store.selectedId = '6b04323a84b889718100f507';
    store.replay = makeReplay();
    store.analytics = makeAnalytics();
    store.step = 2;
  }

  it.each([
    ['监管胜', '胜利', 'Win'], ['监管负', '失败', 'Lose'], ['平局', '平局', 'Tie'],
    ['人机自退', '人机', 'Bot'], ['自退/未分胜负', '未定', 'N/A'], ['', '未定', 'N/A'],
  ])('keeps the raw outcome %s beside the public bilingual seal', async (label, zh, en) => {
    setupStore();
    store.replay!.match.result_label = label;
    const view = mount(SandboxView);
    try {
      expect(view.get('.verdict').text()).toBe(label || '未知');
      expect(view.findAll('.hunter-entry .wax-seal text').map(t => t.text())).toEqual([zh, en]);
    } finally {
      view.unmount();
    }
  });

  it('wires 2D/3D toggle, ViewSettingsPopover layers, floor filter, underlay calibration, 3D WASD isolation and keyboard shortcuts', async () => {
    setupStore();
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();
    const board = w.findComponent(TacticalBoardCanvas);
    const r = rendererOf(board);
    expect(r.getCamera().pitchDeg).toBe(90);
    expect(w.find('[data-test="btn-25d"]').exists()).toBe(false);
    expect(w.find('[data-test="btn-2d"]').classes()).toContain('on');
    expect(w.find('[data-test="btn-3d"]').classes()).not.toContain('on');
    expect(w.find('[data-test="tactical-3d-canvas"]').exists()).toBe(false);

    // Open ViewSettingsPopover: obsolete 2.5D sliders/toggles removed, clean 2D controls & replay layers intact
    await w.find('[data-test="btn-view-settings"]').trigger('click');
    await flushPromises();
    const pop = w.find('[data-test="view-settings-popover"]');
    expect((pop.element as HTMLElement).style.display).not.toBe('none');
    expect(pop.text()).toContain('视角与缩放');
    expect(pop.text()).toContain('复盘图层');
    expect(pop.text()).not.toContain('2.5D');
    expect(w.find('[data-test="pitch"]').exists()).toBe(false);
    expect(w.find('[data-test="yaw"]').exists()).toBe(false);
    expect(w.find('[data-test="yscale"]').exists()).toBe(false);
    expect(w.find('[data-test="btn-planes"]').exists()).toBe(false);
    expect(w.find('[data-test="btn-drop"]').exists()).toBe(false);

    // Switch to 3D via toolbar button
    await w.find('[data-test="btn-3d"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="btn-3d"]').classes()).toContain('on');
    expect(w.find('[data-test="btn-2d"]').classes()).not.toContain('on');
    expect((board.element as HTMLElement).style.display).toBe('none');
    expect(w.find('[data-test="tactical-3d-canvas"]').exists()).toBe(true);

    // Reset view delegates to Tactical3DCanvas.resetView() while in 3D mode
    await w.find('[data-test="btn-reset"]').trigger('click');
    expect(mock3dResetView).toHaveBeenCalledTimes(1);

    // CRITICAL: In 3D mode, WASD & Arrow keys must NOT nudge 2D tokens or scrub store.t
    const vm = w.vm as unknown as {
      boardState: { tokenSeq: number; tokens: Array<{ tid: number; role: string; x: number; y: number; label: string }> };
      selection: { type: 'token'; tid: number } | null;
    };
    vm.boardState.tokens.push({ tid: 1, role: 'mercenary', x: 0.5, y: 0.5, label: '佣兵' });
    vm.selection = { type: 'token', tid: 1 };
    await nextTick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await flushPromises();
    expect(vm.boardState.tokens[0]!.x).toBe(0.5);
    expect(vm.boardState.tokens[0]!.y).toBe(0.5);
    expect(store.t).toBe(0);
    vm.boardState.tokens = [];
    vm.selection = null;

    await w.find('[data-test="btn-view-close"]').trigger('click');
    await flushPromises();
    expect((w.find('[data-test="view-settings-popover"]').element as HTMLElement).style.display).toBe('none');

    // Keyboard '2' returns to 2D, '3' enters 3D, '2' returns to 2D cleanly
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
    await flushPromises();
    expect(w.find('[data-test="btn-2d"]').classes()).toContain('on');
    expect(w.find('[data-test="tactical-3d-canvas"]').exists()).toBe(false);
    expect((board.element as HTMLElement).style.display).not.toBe('none');
    expect(r.getCamera().pitchDeg).toBe(90);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }));
    await flushPromises();
    expect(w.find('[data-test="btn-3d"]').classes()).toContain('on');
    expect(w.find('[data-test="tactical-3d-canvas"]').exists()).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
    await flushPromises();
    expect(w.find('[data-test="btn-2d"]').classes()).toContain('on');

    await w.find('[data-floor="2F"]').trigger('click');
    await flushPromises();
    expect(r.getLayers().visibleFloors).toEqual({ B1: false, '1F': false, '2F': true });
    await w.find('[data-test="btn-cone"]').trigger('click');
    await w.find('[data-test="btn-trail"]').trigger('click');
    await w.find('[data-test="btn-dir"]').trigger('click');
    await w.find('[data-test="btn-labels"]').trigger('click');
    await flushPromises();
    expect(r.getLayers()).toMatchObject({ floorPlanes: false, dropLines: false, viewCones: false, trails: false, dirArrows: false, labels: false });

    await w.find('[data-test="btn-rot"]').trigger('click');
    await w.find('[data-test="btn-flipz"]').trigger('click');
    await w.find('[data-test="opacity"]').setValue('0.8');
    await flushPromises();
    expect(r.getUnderlay()).toMatchObject({ rotationQuadrants: 1, flipZ: true, opacity: 0.8 });
    expect(board.props('chaseSegments')).toEqual(makeAnalytics().chase_segments);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(store.t).toBe(5);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(store.t).toBe(0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    expect(store.playing).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
    expect(store.playing).toBe(false);

    const notice = mount(NoticeDialog);
    expect(notice.text()).toContain('2 / 3 切换 2D 俯视 / 3D 实景与模拟跑图');
    notice.unmount();
    w.unmount();
  });

  it('timeline scrubber + markers seek playback, survivor token locks camera follow', async () => {
    setupStore();
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();
    const r = rendererOf(w.findComponent(TacticalBoardCanvas));

    await w.find('[data-marker="first_chair"]').trigger('click');
    expect(store.t).toBe(70);
    await w.find('[data-test="scrubber"]').setValue('60');
    expect(store.t).toBe(60);
    await w.find('[data-test="btn-back5"]').trigger('click');
    expect(store.t).toBe(55);
    await w.find('[data-test="speed"]').setValue('4');
    expect(store.speed).toBe(4);
    await nextTick();
    expect(w.find('[data-test="clock"]').text()).toContain('00:55.0 / 02:00');

    await w.find('.svtok[data-uid="1000008"]').trigger('click');
    store.t = 60;
    await flushPromises();
    // survivor at t=60 sits at (50, 60, -50): follow mode centers the camera there.
    expect(r.getCamera().centerX).toBeCloseTo(50, 3);
    expect(r.getCamera().centerZ).toBeCloseTo(-50, 3);
    expect(store.selectedUid).toBe(1000008);
    expect(w.find('.svtok[data-uid="1000008"]').text()).toContain('跟随');
    w.unmount();
  });

  it('#dossier inspector shows raw hunter talent ids, survivor names; event feed seeks + pulses', async () => {
    setupStore();
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();

    store.selectedUid = 1000006;
    await nextTick();
    const talents = w.find('[data-test="talents"]').text();
    expect(talents).toContain('监管天赋 #24');
    expect(talents).toContain('监管天赋 #4');
    expect(talents).not.toContain('飞轮效应');
    expect(w.find('[data-test="inspector"]').text()).toContain('PID #126');

    store.selectedUid = 1000008;
    await nextTick();
    expect(w.find('[data-test="talents"]').text()).toContain('飞轮效应');
    expect(w.find('[data-test="talents"]').text()).toContain('天赋 #99');

    store.t = 80;
    await nextTick();
    expect(w.find('[data-test="chair-occupied"]').text()).toContain('秦晓萌');
    expect(w.find('#ciphers').text()).toContain('✓');

    await w.find('[data-right-tab="tools"]').trigger('click');
    await nextTick();
    expect(w.find('[data-right-tab="tools"]').classes()).toContain('on');
    expect(w.find('[data-test="tactical-tools-panel"]').isVisible()).toBe(true);

    await w.find('[data-right-tab="events"]').trigger('click');
    await nextTick();
    expect(w.find('[data-right-tab="events"]').classes()).toContain('on');

    const feedRows = w.findAll('#feed li[data-event]');
    expect(feedRows.map((li) => li.attributes('data-event'))).toEqual(['1', '2', '4']);
    await w.find('#feed li[data-event="1"] button').trigger('click');
    await flushPromises();
    expect(store.t).toBe(12.5);
    expect(store.focus?.pos).toEqual([10, 0, 10]);
    expect(w.find('[data-test="pulse"]').exists()).toBe(true);
    const r = rendererOf(w.findComponent(TacticalBoardCanvas));
    expect(r.getCamera().centerX).toBeCloseTo(10, 3);

    await w.find('[data-group="skill"]').trigger('click');
    expect(w.findAll('#feed li[data-event]').map((li) => li.attributes('data-event'))).toEqual(['3']);

    await w.find('[data-right-tab="status"]').trigger('click');
    await nextTick();
    expect(w.find('[data-right-tab="status"]').classes()).toContain('on');

    // ruler readout from toolbar-driven ruler mode
    await w.find('[data-test="btn-ruler"]').trigger('click');
    const canvas = w.find('canvas');
    const a = r.project([0, 0, 0]);
    const b = r.project([45, 0, 0]);
    await click(canvas, a.x + 0.0001, a.y);
    await click(canvas, b.x, b.y);
    await flushPromises();
    expect(w.find('[data-test="ruler-readout"]').text()).toMatch(/45 u\/s/);
    w.unmount();
  });
});

it('supplies only the empty tactical map to the blind draft renderer', () => {
  flow.mode = 'blind';
  const view = mount(SandboxView);
  try {
    const props = view.getComponent(TacticalBoardCanvas).props();
    expect(props.payload?.players).toEqual([]);
    expect(props.payload?.entities.ciphers).toEqual([]);
    expect(props.payload?.trajectories).toEqual({});
    expect(props.chaseSegments).toBeNull();
    expect(view.find('.hunter-entry .wax-seal, .verdict').exists()).toBe(false);
  } finally {
    view.unmount();
    flow.mode = 'idle';
  }
});

describe('Phase 5 (T-026) Declutter, Zoom Lock, 90° Rotation, Coords, Export & Shortcuts', () => {
  it('removes corner ornaments and desktop still-life selectors while keeping CSS local and >= 12px', () => {
    const sandboxSrc = readFileSync(resolve(__dirname, '../components/SandboxView.vue'), 'utf8');
    const canvasSrc = readFileSync(resolve(__dirname, '../components/TacticalBoardCanvas.vue'), 'utf8');
    const cssSrc = readFileSync(resolve(__dirname, '../styles/tactical-sandbox.css'), 'utf8');

    expect(sandboxSrc).not.toContain('kind="corner"');
    expect(canvasSrc).not.toContain('.desk-still > img');
    expect(canvasSrc).not.toContain('.desk-still > .photo-pin');
    expect(canvasSrc).toContain('.desk-still > .bookmark');
    expect(cssSrc).not.toMatch(/https?:\/\//i);
    for (const m of cssSrc.matchAll(/font-size:\s*([\d.]+)px/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(12);
    }
  });

  it('supports zoom/pan lock, 90° clockwise rotation, live cursor coords tooltip, and crop/rotation PNG export', async () => {
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();
    const boardComp = w.findComponent(TacticalBoardCanvas);
    const r = rendererOf(boardComp);
    const canvas = w.find('[data-test="board-canvas"]');

    // Open ViewSettingsPopover
    await w.find('[data-test="btn-view-settings"]').trigger('click');
    await nextTick();

    // 90° clockwise board rotation
    expect(r.getCamera().yawDeg).toBe(0);
    await w.find('[data-test="btn-board-rotate-90"]').trigger('click');
    await flushPromises();
    expect(r.getCamera().yawDeg).toBe(90);
    await w.find('[data-test="btn-board-rotate-90"]').trigger('click');
    await flushPromises();
    expect(r.getCamera().yawDeg).toBe(180);

    // Zoom/pan lock blocks wheel zoom and drag pan
    await w.find('[data-test="btn-zoom-lock"]').trigger('click');
    await nextTick();
    const zoomBefore = r.getCamera().zoom;
    const cxBefore = r.getCamera().centerX;
    await canvas.trigger('wheel', { deltaY: -240, clientX: 400, clientY: 280 });
    await canvas.trigger('pointerdown', { button: 0, clientX: 300, clientY: 300 });
    await canvas.trigger('pointermove', { button: 0, clientX: 380, clientY: 300 });
    await canvas.trigger('pointerup', { button: 0, clientX: 380, clientY: 300 });
    expect(r.getCamera().zoom).toBeCloseTo(zoomBefore, 6);
    expect(r.getCamera().centerX).toBeCloseTo(cxBefore, 6);

    // Cursor coords tooltip
    await w.find('[data-test="toggle-show-coords"]').setValue(true);
    await canvas.trigger('pointermove', { clientX: 320, clientY: 240 });
    await nextTick();
    const tip = w.find('[data-test="tac-coords-tip"]');
    expect(tip.exists()).toBe(true);
    expect(tip.text()).toMatch(/X\s+\d+px\s*\([\d.]+m\)\s*·\s*Y\s+\d+px\s*\([\d.]+m\)/);

    // PNG export options inside archive-popover (crop & keepRotation)
    await w.find('[data-test="btn-tac-archive"]').trigger('click');
    await nextTick();
    await w.find('[data-test="toggle-export-crop"]').setValue(true);
    await w.find('[data-test="toggle-export-rot"]').setValue(false);
    await nextTick();

    const toDataSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,EXPORT_OPTS_OK');
    const vm = w.vm as unknown as {
      exportBoardPng: () => { dataUrl: string; crop?: boolean; keepRotation?: boolean };
    };
    const res = vm.exportBoardPng();
    expect(toDataSpy).toHaveBeenCalledWith('image/png');
    expect(res.dataUrl).toBe('data:image/png;base64,EXPORT_OPTS_OK');
    expect(res.crop).toBe(true);
    expect(res.keepRotation).toBe(false);
    // Live camera yaw must be restored to 180° after unrotated export
    expect(r.getCamera().yawDeg).toBe(180);
    w.unmount();
  });

  it('handles WASD/Arrow nudge (fine & Shift coarse), Escape cancel/deselect, Delete, and Ctrl+Z with input-focus guard', async () => {
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();

    // Place a token
    await w.find('[data-tool="place"]').trigger('click');
    await w.find('[data-test="role-btn-mercenary"]').trigger('click');
    const canvas = w.find('[data-test="board-canvas"]');
    await click(canvas, 320, 260);
    await flushPromises();

    const vm = w.vm as unknown as {
      boardState: { tokens: Array<{ tid: number; x: number; y: number }> };
      selection: { type: string; tid?: number } | null;
      placePending: unknown;
    };
    expect(vm.boardState.tokens.length).toBe(1);
    const x0 = vm.boardState.tokens[0]!.x;
    const y0 = vm.boardState.tokens[0]!.y;

    // Fine nudge right ('d') and coarse nudge down (Shift + ArrowDown)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
    await flushPromises();
    expect(vm.boardState.tokens[0]!.x).toBeCloseTo(x0 + 0.005, 5);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true }));
    await flushPromises();
    expect(vm.boardState.tokens[0]!.y).toBeCloseTo(y0 + 0.02, 5);

    // Input-focus guard: keydown dispatched on an <input> must not move or delete token
    const searchInput = w.find('[data-test="place-search"]').element as HTMLInputElement;
    const xBeforeInput = vm.boardState.tokens[0]!.x;
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    await flushPromises();
    expect(vm.boardState.tokens.length).toBe(1);
    expect(vm.boardState.tokens[0]!.x).toBeCloseTo(xBeforeInput, 5);

    // First Escape cancels placePending; second Escape clears selection
    expect(vm.placePending).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(vm.placePending).toBeNull();
    expect(vm.selection).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(vm.selection).toBeNull();

    // Re-select token, Delete removes it, Ctrl+Z restores it
    vm.selection = { type: 'token', tid: vm.boardState.tokens[0]!.tid };
    await nextTick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    await flushPromises();
    expect(vm.boardState.tokens.length).toBe(0);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    await flushPromises();
    expect(vm.boardState.tokens.length).toBe(1);
    w.unmount();
  });
});

describe('Phase 6 (T-031) Stage 02 Dossier Folio Typography, Laurel Watermark & Lineup Banners', () => {
  it('renders concept-faithful file-heading typography, crimson serial, laurel watermark, faction sub-banners, and keeps desk props removed', async () => {
    store.selectedId = '6b04323a84b889718100f507';
    store.replay = makeReplay();
    store.analytics = makeAnalytics();
    store.step = 2;
    store.t = 120;
    const w = mount(SandboxView, { attachTo: document.body });
    try {
      await flushPromises();
      expect(w.get('.folio-eyebrow').text()).toBe('OLETUS MANOR · CASE FILES');
      expect(w.get('.folio-en').text()).toBe('Chinatown — Tactical Case File');
      expect(w.get('[data-test="folio-serial"]').text()).toBe('№ 00F507');
      expect(w.find('.file-heading .heading-laurel').exists()).toBe(true);
      expect(w.find('.hunter-banner').text()).toContain('1/1');
      expect(w.find('.surv-banner').text()).toContain('/4');
      expect(w.findAll('.case-notes .note-bullet').length).toBeGreaterThan(0);
      expect(w.findAll('.manor-photo, .folio-corner').length).toBe(0);
    } finally {
      w.unmount();
    }
  });
});
