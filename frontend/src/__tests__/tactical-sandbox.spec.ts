import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { TacticalReplayRenderer } from '@idv/replay-renderer';
import SandboxView from '@/components/SandboxView.vue';
import TacticalBoardCanvas from '@/components/TacticalBoardCanvas.vue';
import {
  MAPS_DATA,
  PIL_STORAGE_KEY,
  applySpawnPredictionToBoard,
  clearNavGridCache,
  consumeSandboxBoardHandoff,
  setActiveMapId,
  setDefaultNavGridDecoder,
  type DecodedNavPixels,
  type NavGridManifestEntry,
} from '@/tactical';
import { resetStore, store } from '@/store/app';
import { installCanvasStub, installImageStub } from './canvas-stub';
import { makeAnalytics, makeReplay } from './fixtures';

const NAV_GRID_DIR = path.resolve(__dirname, '../../public/assets/nav-grid');

function decodeNavPngNode(filePath: string): DecodedNavPixels {
  const raw = fs.readFileSync(filePath);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];
  while (pos + 8 <= raw.length) {
    const length = raw.readUInt32BE(pos);
    const type = raw.subarray(pos + 4, pos + 8).toString('ascii');
    const chunkData = raw.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      colorType = chunkData[9]!;
    } else if (type === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (type === 'IEND') {
      break;
    }
  }
  const bpp = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * bpp;
  const recon = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ftype = inflated[y * (stride + 1)]!;
    const srcOff = y * (stride + 1) + 1;
    const dstOff = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = inflated[srcOff + x]!;
      const a = x >= bpp ? recon[dstOff + x - bpp]! : 0;
      const b = y > 0 ? recon[dstOff - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? recon[dstOff - stride + x - bpp]! : 0;
      let val = v;
      if (ftype === 1) val = (v + a) & 0xff;
      else if (ftype === 2) val = (v + b) & 0xff;
      else if (ftype === 3) val = (v + ((a + b) >> 1)) & 0xff;
      else if (ftype === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        val = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      recon[dstOff + x] = val;
    }
  }
  if (bpp === 1) return { width, height, data: recon };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = recon[i * bpp]!;
    rgba[i * 4 + 1] = recon[i * bpp + 1]!;
    rgba[i * 4 + 2] = recon[i * bpp + 2]!;
    rgba[i * 4 + 3] = bpp === 4 ? recon[i * 4 + 3]! : 255;
  }
  return { width, height, data: rgba };
}

function installRealNavGridDecoder(): void {
  clearNavGridCache();
  setDefaultNavGridDecoder((_url: string, meta: NavGridManifestEntry) =>
    decodeNavPngNode(path.join(NAV_GRID_DIR, meta.file)),
  );
}

async function waitForCondition(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await flushPromises();
    if (check()) return;
    await new Promise((res) => setTimeout(res, 15));
  }
  await flushPromises();
}

function rendererOf(w: { vm: unknown }): TacticalReplayRenderer {
  return (w.vm as { renderer: TacticalReplayRenderer }).renderer;
}

async function clickCanvas(canvas: { trigger: (ev: string, opts?: object) => Promise<void> }, x: number, y: number) {
  await canvas.trigger('pointerdown', { button: 0, clientX: x, clientY: y });
  await canvas.trigger('pointerup', { button: 0, clientX: x, clientY: y });
}

async function dragCanvas(
  canvas: { trigger: (ev: string, opts?: object) => Promise<void> },
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  await canvas.trigger('pointerdown', { button: 0, clientX: x1, clientY: y1 });
  await canvas.trigger('pointermove', { button: 0, clientX: (x1 + x2) / 2, clientY: (y1 + y2) / 2 });
  await canvas.trigger('pointermove', { button: 0, clientX: x2, clientY: y2 });
  await canvas.trigger('pointerup', { button: 0, clientX: x2, clientY: y2 });
}

let restoreImage: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  setActiveMapId(0);
  resetStore();
  installCanvasStub();
  restoreImage = installImageStub('load').restore;
});

afterEach(() => {
  restoreImage?.();
  restoreImage = null;
  setDefaultNavGridDecoder(null);
  clearNavGridCache();
  consumeSandboxBoardHandoff();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Stage 2 Tactical Whiteboard & Replay Dual-Mode (T-006)', () => {
  it('runs standalone 9-map mode, syncs 永眠镇 rotationQuadrants=1, cycles groups, and toggles replay/whiteboard', async () => {
    const w = mount(SandboxView, { attachTo: document.body });
    expect(w.findAll('#toolbar .seg')).toHaveLength(4);
    await w.get('[data-test="folio-toggle"]').trigger('click');
    expect(w.get('#stage2').classes()).toContain('folio-closed');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }));
    await w.vm.$nextTick();
    expect(w.get('#stage2').classes()).not.toContain('folio-closed');
    await flushPromises();

    const boardComp = w.findComponent(TacticalBoardCanvas);
    const r = rendererOf(boardComp);
    expect(w.find('[data-test="tactical-overlay-canvas"]').exists()).toBe(true);
    expect(w.find('[data-test="sandbox-map-select"]').exists()).toBe(true);
    expect(w.findAll('#ciphers .cph').length).toBe(7);
    expect(r.getUnderlay().rotationQuadrants).toBe(0);

    // Cycle cipher group
    await w.find('[data-test="btn-cipher-next"]').trigger('click');
    await flushPromises();
    expect(w.find('#dossier').text()).toContain('密码机组合 2/');

    // Switch map to 永眠镇 (mapId = 6): rotationQuadrants must auto-calibrate to 1
    await w.find('[data-test="sandbox-map-select"]').setValue('6');
    await flushPromises();
    expect(w.find('#vCell').text()).toBe('永眠镇');
    expect(r.getUnderlay().rotationQuadrants).toBe(1);

    // Load a replay dynamically -> auto switches out of standalone mode; user can flip back & forth
    store.selectedId = '6b04323a84b889718100f507';
    store.replay = makeReplay();
    store.analytics = makeAnalytics();
    await flushPromises();
    expect(w.find('[data-test="btn-switch-whiteboard"]').exists()).toBe(true);
    expect(r.getUnderlay().rotationQuadrants).toBe(0);

    await w.find('[data-test="btn-switch-whiteboard"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="sandbox-map-select"]').exists()).toBe(true);

    await w.find('[data-test="btn-switch-replay"]').trigger('click');
    await flushPromises();
    expect(w.find('#svRow .svtok').exists()).toBe(true);
    w.unmount();
  });

  it('places hunter/survivor tokens, explorer treasure rings, and syncs BloodyQueen aquaMirror reflection', async () => {
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();

    // Selecting place tool opens rightTab=tools
    await w.find('[data-tool="place"]').trigger('click');
    await nextTick();
    expect(w.find('[data-right-tab="tools"]').classes()).toContain('on');

    const canvas = w.find('[data-test="board-canvas"]');

    // Place Bloody Queen hunter token
    await w.find('[data-test="place-camp-hunter"]').trigger('click');
    await w.find('[data-test="role-btn-bloodyQueen"]').trigger('click');
    await clickCanvas(canvas, 300, 300);
    await flushPromises();

    const vm = w.vm as unknown as {
      boardState: {
        tokens: Array<{ tid: number; role: string; x: number; y: number }>;
        items: Array<{ iid: number; kind: string; x: number; y: number; linkTid?: number | null }>;
      };
    };
    expect(vm.boardState.tokens.length).toBe(1);
    const bq = vm.boardState.tokens[0]!;
    expect(bq.role).toBe('bloodyQueen');

    // Place aquaMirror prop -> auto links BloodyQueen and auto creates reflected mirrorImage
    await w.find('[data-test="prop-btn-aquaMirror"]').trigger('click');
    await clickCanvas(canvas, 450, 300);
    await flushPromises();
    expect(vm.boardState.items.some((i) => i.kind === 'aquaMirror')).toBe(true);
    expect(vm.boardState.items.some((i) => i.kind === 'mirrorImage')).toBe(true);

    const bqBeforeX = bq.x;
    const miBefore = vm.boardState.items.find((i) => i.kind === 'mirrorImage')!;
    const miBeforeX = miBefore.x;

    // Swap mirror exchanges BloodyQueen & MirrorImage coordinates
    await w.find('[data-placed-prop]').trigger('click');
    await w.find('[data-test="btn-swap-mirror"]').trigger('click');
    await flushPromises();
    expect(bq.x).toBeCloseTo(miBeforeX, 4);
    expect(miBefore.x).toBeCloseTo(bqBeforeX, 4);

    // Place Explorer & toggle treasure range
    await w.find('[data-test="place-camp-survivor"]').trigger('click');
    await w.find('[data-test="role-btn-explorer"]').trigger('click');
    await clickCanvas(canvas, 250, 260);
    await flushPromises();
    expect(vm.boardState.tokens.some((t) => t.role === 'explorer')).toBe(true);
    await w.find('[data-test="toggle-treasure-range"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="inspector"]').text()).toContain('冒险家');
    w.unmount();
  });

  it('draws arrow/circle/freehand/text notes and supports >=30 undo snapshots and clear', async () => {
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();

    await w.find('[data-tool="draw"]').trigger('click');
    await nextTick();
    const canvas = w.find('[data-test="board-canvas"]');

    // Draw arrow
    await w.find('[data-draw-shape="arrow"]').trigger('click');
    await dragCanvas(canvas, 200, 200, 320, 240);
    await flushPromises();

    // Draw dashed circle
    await w.find('[data-draw-shape="circle"]').trigger('click');
    await dragCanvas(canvas, 360, 260, 420, 320);
    await flushPromises();

    // Draw freehand
    await w.find('[data-draw-shape="freehand"]').trigger('click');
    await dragCanvas(canvas, 150, 150, 210, 190);
    await flushPromises();

    // Place text note
    await w.find('[data-test="tac-text-input"]').setValue('大房窗口点');
    await w.find('[data-draw-shape="text"]').trigger('click');
    await clickCanvas(canvas, 260, 220);
    await flushPromises();

    const vm = w.vm as unknown as {
      boardState: {
        shapes: Array<{ kind: string }>;
        texts: Array<{ text: string }>;
      };
      undoStack: unknown[];
    };
    expect(vm.boardState.shapes.map((s) => s.kind)).toEqual(['arrow', 'circle', 'freehand']);
    expect(vm.boardState.texts[0]?.text).toBe('大房窗口点');

    // Undo removes text note
    await w.find('[data-test="btn-tac-undo"]').trigger('click');
    await flushPromises();
    expect(vm.boardState.texts.length).toBe(0);

    // Push 34 additional arrows to verify >= 30 step undo stack retains 30+ history
    await w.find('[data-draw-shape="arrow"]').trigger('click');
    for (let i = 0; i < 34; i++) {
      await dragCanvas(canvas, 100 + i * 2, 100, 140 + i * 2, 140);
    }
    await flushPromises();
    expect(vm.undoStack.length).toBeGreaterThanOrEqual(30);

    // Clear board removes all shapes and allows undo back
    await w.find('[data-test="btn-tac-clear"]').trigger('click');
    await flushPromises();
    expect(vm.boardState.shapes.length).toBe(0);
    await w.find('[data-test="btn-tac-undo"]').trigger('click');
    await flushPromises();
    expect(vm.boardState.shapes.length).toBeGreaterThan(30);
    w.unmount();
  });

  it('computes multi-point polyline ETA with survivor/hunter speed, traits, talents and custom buffs', async () => {
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();

    await w.find('[data-tool="measure"]').trigger('click');
    await nextTick();
    await w.find('[data-test="btn-measure-chain"]').trigger('click');
    const canvas = w.find('[data-test="board-canvas"]');

    await clickCanvas(canvas, 220, 220);
    await clickCanvas(canvas, 340, 220);
    await clickCanvas(canvas, 340, 340);
    await w.find('[data-test="btn-measure-finish"]').trigger('click');
    await flushPromises();

    const simBefore = w.find('[data-test="measure-sim-result"]').text();
    expect(simBefore).toMatch(/\d+\.\d+\s*m/);
    expect(simBefore).toMatch(/\d+\.\d+\s*s/);

    // Switch to hunter camp + custom buff adds speed modifier to simulation
    await w.find('[data-test="measure-camp-hunter"]').trigger('click');
    await w.find('[data-test="custom-buff-pct"]').setValue('50');
    await w.find('[data-test="custom-buff-dur"]').setValue('5');
    await w.find('[data-test="btn-add-custom-buff"]').trigger('click');
    await flushPromises();
    const simAfter = w.find('[data-test="tool-panel-measure"]').text();
    expect(simAfter).toContain('50%');
    expect(simAfter).toContain('5s');
    expect(w.find('[data-test="measure-sim-result"]').text()).not.toBe(simBefore);
    w.unmount();
  });

  it('evaluates 5-band Carry and Tide range models against map chairs and custom points', async () => {
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();

    await w.find('[data-tool="range"]').trigger('click');
    await nextTick();

    // Point mode -> click board computes Carry 5 bands + chair ETA table
    await w.find('[data-test="btn-range-mode-point"]').trigger('click');
    const canvas = w.find('[data-test="board-canvas"]');
    await clickCanvas(canvas, 380, 280);
    await flushPromises();

    expect(w.findAll('[data-test="range-legend"] [data-band]').length).toBe(5);
    expect(w.find('[data-test="range-summary"]').text()).toContain('狂欢之椅');
    expect(w.findAll('[data-test="range-chair-table"] tbody tr').length).toBeGreaterThan(0);

    // Switch to Tide 20s model
    await w.find('[data-test="btn-range-tide"]').trigger('click');
    await w.find('[data-test="btn-add-tide-talent"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="range-summary"]').text()).toContain('20s');
    w.unmount();
  });

  it('records animation waypoints, syncs TacticalAnimBar timeline, and interpolates positions', async () => {
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();

    // Place a token first
    await w.find('[data-tool="place"]').trigger('click');
    await w.find('[data-test="role-btn-mercenary"]').trigger('click');
    const canvas = w.find('[data-test="board-canvas"]');
    await clickCanvas(canvas, 200, 240);
    await flushPromises();

    // Switch to Anim tool, arm waypoint clicking, add 2 points
    await w.find('[data-tool="anim"]').trigger('click');
    await nextTick();
    expect(w.find('[data-test="tac-anim-bar"]').exists()).toBe(true);
    await w.find('[data-test="btn-anim-arm"]').trigger('click');
    await clickCanvas(canvas, 320, 240);
    await clickCanvas(canvas, 420, 300);
    await flushPromises();

    expect(w.findAll('[data-test="anim-waypoint-list"] .tac-list-row').length).toBe(3);
    expect(w.findAll('[data-test="tac-anim-track"]').length).toBe(1);

    const vm = w.vm as unknown as {
      boardState: { tokens: Array<{ anim?: { points: Array<{ x: number; y: number }>; times?: number[] } }> };
      geo: { animGeom: { dw: number; dh: number; widthM: number } };
      animTime: number;
      animPositionAt: (a: unknown, g: unknown, t: number) => { x: number; y: number } | null;
    };
    const tok = vm.boardState.tokens[0]!;
    expect(tok.anim?.points.length).toBe(3);

    // Switch to time mode and scrub timeline midpoint
    await w.find('[data-test="btn-anim-mode-time"]').trigger('click');
    await flushPromises();
    const total = Number(w.find('[data-test="tac-anim-scrubber"]').attributes('max'));
    expect(total).toBeGreaterThan(0);

    await w.find('[data-test="tac-anim-scrubber"]').setValue(String(total / 2));
    await flushPromises();
    expect(vm.animTime).toBeCloseTo(total / 2, 1);

    const interp = vm.animPositionAt(tok.anim, vm.geo.animGeom, total / 2)!;
    expect(interp.x).toBeGreaterThan(tok.anim!.points[0]!.x);
    expect(interp.x).toBeLessThan(tok.anim!.points[2]!.x + 1e-4);
    w.unmount();
  });

  it('auto-saves to localStorage, round-trips JSON archive safely, and composites untainted PNG export', async () => {
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();

    await w.find('[data-tool="place"]').trigger('click');
    await w.find('[data-test="role-btn-seer"]').trigger('click');
    const canvas = w.find('[data-test="board-canvas"]');
    await clickCanvas(canvas, 310, 260);
    await flushPromises();

    // Auto-saved under idv.pil.v2
    const savedRaw = localStorage.getItem(PIL_STORAGE_KEY);
    expect(savedRaw).toBeTruthy();

    // Export JSON via archive menu
    await w.find('[data-test="btn-tac-archive"]').trigger('click');
    await w.find('[data-test="btn-export-json"]').trigger('click');
    await flushPromises();
    const vm = w.vm as unknown as {
      lastExportedJson: string;
      importJsonText: (s: string) => { ok: boolean };
      boardState: { tokens: Array<{ role: string }> };
      exportBoardPng: () => { dataUrl: string; fileName: string };
    };
    const exported = vm.lastExportedJson;
    expect(exported).toContain('"format": "idv-pil-board"');
    expect(exported).toContain('"seer"');

    // Invalid JSON must show error and keep existing tokens intact
    const bad = vm.importJsonText('{invalid-json');
    await nextTick();
    expect(bad.ok).toBe(false);
    expect(w.find('[data-test="tac-archive-err"]').text()).toContain('失败');
    expect(vm.boardState.tokens.length).toBe(1);

    // Remount fresh component -> auto-restores from localStorage
    w.unmount();
    const w2 = mount(SandboxView, { attachTo: document.body });
    await flushPromises();
    const vm2 = w2.vm as unknown as typeof vm;
    expect(vm2.boardState.tokens.length).toBe(1);
    expect(vm2.boardState.tokens[0]?.role).toBe('seer');

    // Clear and re-import JSON
    await w2.find('[data-test="btn-tac-clear"]').trigger('click');
    await flushPromises();
    expect(vm2.boardState.tokens.length).toBe(0);
    const ok = vm2.importJsonText(exported);
    expect(ok.ok).toBe(true);
    expect(vm2.boardState.tokens[0]?.role).toBe('seer');

    // PNG Export compositing: stub toDataURL on HTMLCanvasElement prototype
    const toDataSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,COMPOSITED_OK');
    const pngRes = vm2.exportBoardPng();
    expect(toDataSpy).toHaveBeenCalledWith('image/png');
    expect(pngRes.dataUrl).toBe('data:image/png;base64,COMPOSITED_OK');
    expect(pngRes.fileName).toContain('战术沙盘.png');
    w2.unmount();
  });
});

describe('Phase 5 (T-026) PIL 2D Parity: Route Measure, Nav-Grid Contours, Anim Auto-Path, Cipher Card & Handoff', () => {
  it('computes obstacle-avoiding route polylines in route mode, 2-point A->B route pick with auto-fix note, and single-segment delete', async () => {
    installRealNavGridDecoder();
    const w = mount(SandboxView, { attachTo: document.body });
    try {
      await flushPromises();

      await w.find('[data-tool="measure"]').trigger('click');
      await nextTick();
      await w.find('[data-test="btn-measure-route"]').trigger('click');
      await nextTick();

      expect((w.find('[data-test="toggle-measure-vault"]').element as HTMLInputElement).checked).toBe(true);
      expect((w.find('[data-test="toggle-measure-autofix"]').element as HTMLInputElement).checked).toBe(true);

      const vm = w.vm as unknown as {
        boardState: {
          measures: Array<{ id: number; x1: number; y1: number; x2: number; y2: number; path?: Array<{ x: number; y: number }> }>;
        };
        geo: { relToWorld: (u: number, v: number, y?: number) => [number, number, number] };
        routePointA: { x: number; y: number } | null;
        routePointB: { x: number; y: number } | null;
        landmarks: { hideEndpoints: boolean };
      };
      const r = rendererOf(w.findComponent(TacticalBoardCanvas));
      const canvas = w.find('[data-test="board-canvas"]');

      // Click 3 points (2 routed chain segments) across Arms Factory walls
      const s1 = r.project(vm.geo.relToWorld(0.24, 0.28, 0));
      const s2 = r.project(vm.geo.relToWorld(0.72, 0.34, 0));
      const s3 = r.project(vm.geo.relToWorld(0.68, 0.72, 0));
      await clickCanvas(canvas, s1.x, s1.y);
      await clickCanvas(canvas, s2.x, s2.y);
      await clickCanvas(canvas, s3.x, s3.y);
      await w.find('[data-test="btn-measure-finish"]').trigger('click');

      await waitForCondition(() => vm.boardState.measures.length === 2 && vm.boardState.measures.every((m) => (m.path?.length ?? 0) >= 2));
      expect(vm.boardState.measures[0]?.path?.length).toBeGreaterThanOrEqual(2);
      expect(vm.boardState.measures[1]?.path?.length).toBeGreaterThanOrEqual(2);
      expect(w.find('[data-test="measure-sim-result"]').text()).toContain('绕障');

      // Toggle hide endpoints & delSegOnly -> delete removes only 1 segment, keeping the other
      await w.find('[data-test="toggle-hide-endpoints"]').setValue(true);
      expect(vm.landmarks.hideEndpoints).toBe(true);
      await w.find('[data-test="toggle-del-seg-only"]').setValue(true);
      await w.find('[data-test="btn-measure-delete"]').trigger('click');
      await flushPromises();
      expect(vm.boardState.measures.length).toBe(1);

      // Quick 2-point A->B Route Pick helper (click Arms Factory basement_1 center -> snaps via staircase exit note)
      await w.find('[data-test="btn-route-pick-a"]').trigger('click');
      const basementPt = r.project(vm.geo.relToWorld(539 / 750, 486.5 / 644, 0));
      await clickCanvas(canvas, basementPt.x, basementPt.y);
      await w.find('[data-test="btn-route-pick-b"]').trigger('click');
      const goalPt = r.project(vm.geo.relToWorld(0.45, 0.45, 0));
      await clickCanvas(canvas, goalPt.x, goalPt.y);
      await nextTick();
      expect(vm.routePointA).not.toBeNull();
      expect(vm.routePointB).not.toBeNull();

      await w.find('[data-test="btn-route-run"]').trigger('click');
      await waitForCondition(() => vm.boardState.measures.length === 2 && Boolean(vm.boardState.measures[1]?.path?.length));
      expect(vm.boardState.measures[1]?.path?.length).toBeGreaterThanOrEqual(2);
      expect(w.find('[data-test="route-fix-note"]').text()).toContain('地下室');
    } finally {
      w.unmount();
    }
  });

  it('computes real nav-grid Carry & Tide 5-band obstacle contours (ground + basement chairs) and point chair table', async () => {
    installRealNavGridDecoder();
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();

    await w.find('[data-tool="range"]').trigger('click');
    await nextTick();

    const vm = w.vm as unknown as {
      rangeEval: {
        usedNavGrid: boolean;
        navField: { reached: number; bandOf: Int8Array } | null;
        chairRows: Array<{ travelSeconds: number }>;
      } | null;
      rangeState: { hideRingLabel: boolean; origin: { isBasement?: boolean } | null };
      geo: { relToWorld: (u: number, v: number, y?: number) => [number, number, number] };
    };
    const r = rendererOf(w.findComponent(TacticalBoardCanvas));
    const canvas = w.find('[data-test="board-canvas"]');

    // Chair mode -> click near ground chair on Arms Factory
    const chPt = r.project(vm.geo.relToWorld(0.5, 0.5, 0));
    await clickCanvas(canvas, chPt.x, chPt.y);
    await waitForCondition(() => Boolean(vm.rangeEval?.usedNavGrid && (vm.rangeEval?.navField?.reached ?? 0) > 500));

    expect(vm.rangeEval?.usedNavGrid).toBe(true);
    expect(vm.rangeEval?.navField?.reached).toBeGreaterThan(500);
    expect(w.find('[data-test="range-summary"]').text()).toContain('绕障导航');

    // Toggle hideRingLabel
    await w.find('[data-test="toggle-range-hide-label"]').setValue(true);
    expect(vm.rangeState.hideRingLabel).toBe(true);

    // Basement chair mode + basement switcher
    await w.find('[data-test="toggle-range-basement"]').trigger('click');
    await waitForCondition(() => Boolean(vm.rangeState.origin?.isBasement && vm.rangeEval?.usedNavGrid));
    expect(vm.rangeState.origin?.isBasement).toBe(true);
    expect(vm.rangeEval?.navField?.reached).toBeGreaterThan(200);

    await w.find('[data-test="btn-range-basement-next"]').trigger('click');
    await waitForCondition(() => Boolean(vm.rangeState.origin?.isBasement && vm.rangeEval?.usedNavGrid));
    expect(vm.rangeEval?.usedNavGrid).toBe(true);

    // Point mode -> evaluates ground + basement chairs via evaluateChairsOnNavGrid (Carry + Tide)
    await w.find('[data-test="btn-range-mode-point"]').trigger('click');
    await clickCanvas(canvas, chPt.x, chPt.y);
    await waitForCondition(() => Boolean(vm.rangeEval?.usedNavGrid && vm.rangeEval.chairRows.length > 0));
    expect(w.findAll('[data-test="range-chair-table"] tbody tr').length).toBeGreaterThan(0);

    await w.find('[data-test="btn-range-tide"]').trigger('click');
    await waitForCondition(() => Boolean(vm.rangeEval?.usedNavGrid && w.find('[data-test="range-summary"]').text().includes('20s')));
    expect(w.find('[data-test="range-summary"]').text()).toContain('绕障导航');
    w.unmount();
  });

  it('auto-paths animation waypoints via nav-grid, applies speed presets, and clears stale paths on manual drag', async () => {
    installRealNavGridDecoder();
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();

    // Place survivor token
    await w.find('[data-tool="place"]').trigger('click');
    await w.find('[data-test="role-btn-mercenary"]').trigger('click');
    const r = rendererOf(w.findComponent(TacticalBoardCanvas));
    const canvas = w.find('[data-test="board-canvas"]');
    const vm = w.vm as unknown as {
      geo: { relToWorld: (u: number, v: number, y?: number) => [number, number, number] };
      boardState: {
        tokens: Array<{
          anim?: {
            points: Array<{ x: number; y: number }>;
            speeds?: Array<{ speed: number; name: string }>;
            paths?: Array<Array<{ x: number; y: number }> | undefined>;
          };
        }>;
      };
    };

    const p0 = r.project(vm.geo.relToWorld(0.28, 0.35, 0));
    await clickCanvas(canvas, p0.x, p0.y);
    await flushPromises();

    await w.find('[data-tool="anim"]').trigger('click');
    await nextTick();
    expect((w.find('[data-test="toggle-anim-autoroute"]').element as HTMLInputElement).checked).toBe(true);
    expect((w.find('[data-test="toggle-anim-vault"]').element as HTMLInputElement).checked).toBe(true);

    // Arm and add 2 waypoints -> anim.paths populated via routeBetweenRel
    await w.find('[data-test="btn-anim-arm"]').trigger('click');
    const p1 = r.project(vm.geo.relToWorld(0.62, 0.38, 0));
    const p2 = r.project(vm.geo.relToWorld(0.62, 0.68, 0));
    await clickCanvas(canvas, p1.x, p1.y);
    await clickCanvas(canvas, p2.x, p2.y);

    await waitForCondition(() => {
      const paths = vm.boardState.tokens[0]?.anim?.paths;
      return Boolean(paths && (paths[0]?.length ?? 0) >= 2 && (paths[1]?.length ?? 0) >= 2);
    });
    expect(vm.boardState.tokens[0]?.anim?.paths?.[0]?.length).toBeGreaterThanOrEqual(2);
    expect(vm.boardState.tokens[0]?.anim?.paths?.[1]?.length).toBeGreaterThanOrEqual(2);

    // Apply hunter speed preset via anim-speed-preset
    await w.find('[data-test="anim-speed-preset"]').setValue('surv:state:walk');
    await flushPromises();
    expect(vm.boardState.tokens[0]?.anim?.speeds?.[0]?.speed).toBeCloseTo(2.11, 2);

    // Turn auto-route off and drag waypoint #2 -> clears stale adjacent paths[0] & paths[1]
    await w.find('[data-test="toggle-anim-autoroute"]').setValue(false);
    await nextTick();
    const dragged = r.project(vm.geo.relToWorld(0.58, 0.42, 0));
    await dragCanvas(canvas, p1.x, p1.y, dragged.x, dragged.y);
    await flushPromises();
    expect(vm.boardState.tokens[0]?.anim?.paths?.[0]).toBeUndefined();
    expect(vm.boardState.tokens[0]?.anim?.paths?.[1]).toBeUndefined();
    w.unmount();
  });

  it('renders 密码机速查 card with group switching & pulse highlight, plus extended landmarks and granular snaps', async () => {
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();

    // Open Tools tab (inspect mode default) -> tac-cipher-card shows 7 ciphers with 必刷/可能 tags
    await w.find('[data-right-tab="tools"]').trigger('click');
    await nextTick();
    const card = w.find('[data-test="tac-cipher-card"]');
    expect(card.exists()).toBe(true);
    const rows = card.findAll('[data-cipher-card-row]');
    expect(rows.length).toBe(7);
    expect(card.text()).toContain('必刷');
    expect(card.text()).toContain('可能');

    // Cycle cipher group via card switcher
    await card.find('[data-test="btn-cipher-card-next"]').trigger('click');
    await nextTick();
    expect(card.text()).toContain('第 2 /');

    // Click row highlights & pulses cipher on board
    const firstId = rows[0]!.attributes('data-cipher-card-row')!;
    await rows[0]!.trigger('click');
    await nextTick();
    const vm = w.vm as unknown as {
      highlightedCipherId: string | null;
      landmarks: {
        lockers: boolean;
        basementChest: boolean;
        selGlow: boolean;
        fixedSpawnScreen: string;
        snapTargets: Record<string, boolean>;
      };
    };
    expect(vm.highlightedCipherId).toBe(firstId);
    expect(w.find('[data-test="pulse"]').exists()).toBe(true);

    // ViewSettingsPopover exposes lockers, basementChest, selGlow, Mad Eyes screen, and granular snaps
    await w.find('[data-test="btn-view-settings"]').trigger('click');
    await nextTick();
    await w.find('[data-test="btn-landmark-lockers"]').trigger('click');
    await w.find('[data-test="btn-landmark-basement-chest"]').trigger('click');
    await w.find('[data-test="toggle-sel-glow"]').setValue(true);
    await w.find('[data-test="select-madeyes-screen"]').setValue('ios');
    await w.find('[data-test="toggle-snap-locker"]').setValue(false);
    await nextTick();
    expect(vm.landmarks.lockers).toBe(true);
    expect(vm.landmarks.basementChest).toBe(true);
    expect(vm.landmarks.selGlow).toBe(true);
    expect(vm.landmarks.fixedSpawnScreen).toBe('ios');
    expect(vm.landmarks.snapTargets.locker).toBe(false);
    w.unmount();
  });

  it('consumes 04 -> 02 SandboxBoardHandoff live and on mount (switches whiteboard, map, zones, and selects hunter)', async () => {
    // 1. Live subscription while replay is active
    store.selectedId = '6b04323a84b889718100f507';
    store.replay = makeReplay();
    store.analytics = makeAnalytics();
    const w = mount(SandboxView, { attachTo: document.body });
    await flushPromises();

    const vm = w.vm as unknown as {
      whiteboardOverride: boolean;
      activeMapId: number;
      landmarks: { zones: boolean };
      selection: { type: string; tid?: number } | null;
      boardState: { tokens: Array<{ tid: number; role: string; spawnPreview?: boolean }> };
    };
    expect(vm.whiteboardOverride).toBe(false);

    const res = applySpawnPredictionToBoard(6, {
      survCells: [11, 12, 23, 32],
      hunterCell: 33,
      hunterIdx: 26, // 歌剧演员 -> operaSinger
    });
    await flushPromises();

    expect(vm.whiteboardOverride).toBe(true);
    expect(vm.activeMapId).toBe(6);
    expect(MAPS_DATA[6]!.mapName).toBe('永眠镇');
    expect(vm.landmarks.zones).toBe(true);
    expect(vm.boardState.tokens.filter((t) => t.spawnPreview).length).toBe(5);
    expect(vm.selection).toEqual({ type: 'token', tid: res.hunterTid });
    expect(vm.boardState.tokens.find((t) => t.tid === res.hunterTid)?.role).toBe('operaSinger');
    w.unmount();

    // 2. Queued handoff emitted before SandboxView mounts (consumed in onMounted)
    const res2 = applySpawnPredictionToBoard(2, {
      survCells: [11, 13, 31, 33],
      hunterCell: 22,
      hunterIdx: 13, // 红夫人 -> bloodyQueen
    });
    const w2 = mount(SandboxView, { attachTo: document.body });
    await flushPromises();
    const vm2 = w2.vm as unknown as typeof vm;
    expect(vm2.whiteboardOverride).toBe(true);
    expect(vm2.activeMapId).toBe(2);
    expect(vm2.landmarks.zones).toBe(true);
    expect(vm2.selection).toEqual({ type: 'token', tid: res2.hunterTid });
    w2.unmount();
  });

  it('applies .sel workbook control classes on every select across Measure, Range, and Anim panels (Phase 6 T-031)', async () => {
    const w = mount(SandboxView, { attachTo: document.body });
    try {
      await flushPromises();
      await w.find('[data-right-tab="tools"]').trigger('click');
      await nextTick();

      for (const tool of ['measure', 'range', 'anim'] as const) {
        await w.find(`[data-panel-tool="${tool}"]`).trigger('click');
        await nextTick();
        const selects = w.findAll('[data-test="tactical-tools-panel"] select');
        expect(selects.length).toBeGreaterThan(0);
        for (const s of selects) {
          expect(s.classes()).toContain('sel');
        }
      }
      // Range Tide mode select also uses .sel
      await w.find('[data-panel-tool="range"]').trigger('click');
      await nextTick();
      await w.find('[data-test="btn-range-tide"]').trigger('click');
      await nextTick();
      const tideSelects = w.findAll('[data-test="tactical-tools-panel"] select');
      expect(tideSelects.length).toBeGreaterThan(0);
      for (const s of tideSelects) {
        expect(s.classes()).toContain('sel');
      }
    } finally {
      w.unmount();
    }
  });
});
