import { describe, expect, it } from 'vitest';
import {
  MANOR_CLARITY_PALETTE, MANOR_DOSSIER_PALETTE, TacticalReplayRenderer, VISUAL_PRESETS,
  type RendererOptions, type Vec3, type VisualPresetConfig, type VisualPresetId,
} from '../src/index';
import { lineTrajectory, makePayload } from './helpers/fixtures';
import { MockCanvas2DContext } from './helpers/mockCanvas';

const VP = { width: 1000, height: 800, dpr: 2 };
const IMAGE = { width: 1000, height: 400 };
const RECT = { min_x: -100, max_x: 100, min_z: -40, max_z: 40 };
const HALO = '#0b0a09';

class TextCanvas extends MockCanvas2DContext {
  strokeText(...args: unknown[]): void { this.rec('strokeText', args); }
}

function underlay(ctx = new MockCanvas2DContext(), options?: RendererOptions) {
  const renderer = new TacticalReplayRenderer(ctx, VP, options);
  renderer.setUnderlay({ enabled: true, image: IMAGE, worldRect: RECT });
  renderer.setLayers({ grid: false });
  return renderer;
}

function scene(ctx = new MockCanvas2DContext(), options: RendererOptions = { visualPreset: 'clarity' }) {
  const renderer = new TacticalReplayRenderer(ctx, VP, options);
  const payload = makePayload();
  renderer.setPayload(payload);
  renderer.setLayers({ grid: false, trails: false, pulses: false, viewCones: false });
  return { renderer, payload };
}

it('returns exactly x and y in the screen anchor for every pickable kind', () => {
  const { renderer, payload } = scene();
  const entities = payload.entities;
  const targets: Record<string, Vec3> = {
    player: [-100, 0, 0],
    cipher: entities.ciphers[0]!.pos,
    chair: entities.chairs[1]!.pos,
    pallet: entities.pallets[0]!.pos,
    window: entities.windows[0]!.pos,
    gate: entities.exit_gates[0]!.pos,
    chest: entities.chests[0]!.pos,
    hatch: entities.hatch!.pos,
  };
  for (const [kind, pos] of Object.entries(targets)) {
    const { x, y } = renderer.project(pos);
    const pick = renderer.pickEntityAtScreen(x, y, 0);
    expect(pick?.kind).toBe(kind);
    expect(Object.keys(pick!.screen).sort()).toStrictEqual(['x', 'y']);
  }
});

describe('picking scaled glyphs', () => {
  it('uses the drawn cipher radius in clarity at zoom 2', () => {
    const ctx = new MockCanvas2DContext();
    const { renderer, payload } = scene(ctx);
    renderer.setCamera({ zoom: 2 });
    renderer.render(0);
    const { x, y } = renderer.project(payload.entities.ciphers[0]!.pos);
    const body = ctx.ops('arc').find(({ args }) => args[0] === x && args[1] === y);
    expect(body?.args[2]).toBeCloseTo(19.44);
    expect(renderer.pickEntityAtScreen(x + 17, y, 0)).toMatchObject({
      kind: 'cipher', uid: 100, distancePx: 17,
    });
    expect(renderer.pickEntityAtScreen(x + 21, y, 0)).toBeNull();
  });

  it('picks enlarged cipher and hunter bodies at glyphScale 2 in original', () => {
    const { renderer, payload } = scene(new MockCanvas2DContext(), { visualPreset: 'original', glyphScale: 2 });
    renderer.setCamera({ zoom: 1 });
    const cipher = renderer.project(payload.entities.ciphers[0]!.pos);
    const hunter = renderer.project([-100, 0, 0]);
    expect(renderer.pickEntityAtScreen(cipher.x + 16, cipher.y, 0)).toMatchObject({
      kind: 'cipher', uid: 100, distancePx: 16,
    });
    expect(renderer.pickEntityAtScreen(hunter.x + 16, hunter.y, 0)).toMatchObject({
      kind: 'player', uid: 1, distancePx: 16,
    });
  });

  it('honors an explicit 10 px radius in clarity at zoom 2', () => {
    const { renderer, payload } = scene(new MockCanvas2DContext(), { visualPreset: 'clarity', pickRadiusPx: 10 });
    renderer.setCamera({ zoom: 2 });
    const { x, y } = renderer.project(payload.entities.ciphers[0]!.pos);
    expect(renderer.pickEntityAtScreen(x + 10, y, 0)).toMatchObject({ kind: 'cipher', uid: 100, distancePx: 10 });
    expect(renderer.pickEntityAtScreen(x + 12, y, 0)).toBeNull();
  });

  it('picks the nearest eligible target and favors the player on an exact tie', () => {
    const { renderer, payload } = scene(new MockCanvas2DContext(), { visualPreset: 'original', glyphScale: 2 });
    const cipher = payload.entities.ciphers[0]!;
    const [cx, cy, cz] = cipher.pos;
    payload.trajectories['1'] = lineTrajectory([cx + 34, cy, cz], [0, 0], 0, 1);
    renderer.setPayload(payload);
    renderer.setCamera({ zoom: 1, yawDeg: 0 });
    const { x, y } = renderer.project(cipher.pos);
    expect(renderer.pickEntityAtScreen(x + 16, y, 0)).toMatchObject({
      kind: 'cipher', uid: 100, distancePx: 16,
    });
    expect(renderer.pickEntityAtScreen(x + 17, y, 0)).toMatchObject({
      kind: 'player', uid: 1, distancePx: 17,
    });
  });
});

describe('picking drawn segments at clarity zoom 3', () => {
  const cases = [
    { state: 'upright', kind: 'pallet', time: 39, color: MANOR_CLARITY_PALETTE.goldD },
    { state: 'dropped', kind: 'pallet', time: 40, color: MANOR_CLARITY_PALETTE.redL },
    { state: 'window', kind: 'window', time: 0, color: MANOR_CLARITY_PALETTE.ice },
  ] as const;

  function probe({ kind, time, color }: typeof cases[number], pickRadiusPx?: number) {
    const ctx = new MockCanvas2DContext();
    const renderer = new TacticalReplayRenderer(ctx, VP, { visualPreset: 'clarity', pickRadiusPx });
    const payload = makePayload();
    const { pallets, windows } = payload.entities;
    payload.entities = {
      pallets: kind === 'pallet' ? pallets : [], windows: kind === 'window' ? windows : [],
      ciphers: [], chairs: [], chests: [], exit_gates: [], hatch: null,
    };
    payload.players = [];
    payload.events = [];
    const entity = (kind === 'pallet' ? pallets : windows)[0]!;
    entity.pos = [0, 0, 0];
    renderer.setPayload(payload);
    renderer.setLayers({ grid: false });
    // Use an axis-aligned stroke for exact inclusive radius comparisons.
    renderer.setCamera({ zoom: 3, yawDeg: pickRadiusPx === undefined ? 25 : 0 });
    renderer.render(time);
    const path = ctx.calls.filter(c => (c.op === 'moveTo' || c.op === 'lineTo') && c.state.strokeStyle === color)
      .map(c => ({ x: Number(c.args[0]), y: Number(c.args[1]) }));
    expect(path).toHaveLength(kind === 'window' ? 4 : 2);
    const midpoint = (i: number, j: number) => ({
      x: (path[i]!.x + path[j]!.x) / 2, y: (path[i]!.y + path[j]!.y) / 2,
    });
    const a = kind === 'window' ? midpoint(0, 3) : path[0]!;
    const b = kind === 'window' ? midpoint(1, 2) : path[1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const dx = (b.x - a.x) / length;
    const dy = (b.y - a.y) / length;
    const { x, y } = renderer.project(entity.pos);
    const center = { x, y };
    const pick = (along: number, across: number, sampleTime: number = time) => renderer.pickEntityAtScreen(
      (a.x + b.x) / 2 + along * dx - across * dy,
      (a.y + b.y) / 2 + along * dy + across * dx, sampleTime,
    );
    return { pick, center, half: length / 2 };
  }

  it.each(cases)('measures distance to the finite $state centerline', fixture => {
    const { pick, center, half } = probe(fixture);
    expect(half).toBeGreaterThan(16);
    const hit = pick(16, 0);
    expect(hit).toMatchObject({ kind: fixture.kind, screen: center });
    expect(hit?.distancePx).toBeCloseTo(0, 9);
    expect(pick(16, 16)).toBeNull();
    for (const sign of [-1, 1]) {
      expect(pick(sign * (half + 6), 0)?.distancePx).toBeCloseTo(6, 9);
      expect(pick(sign * (half + 16), 0)).toBeNull();
    }
  });

  it.each(cases)('honors an explicit 10 px radius beside the $state centerline', fixture => {
    const { pick } = probe(fixture, 10);
    expect(pick(16, 10)).toMatchObject({ kind: fixture.kind, distancePx: 10 });
    expect(pick(16, 12)).toBeNull();
  });

  it('switches to center picking when the pallet breaks at the queried time', () => {
    const { pick, center } = probe(cases[1]);
    expect(pick(16, 0, 59)?.kind).toBe('pallet');
    expect(pick(16, 0, 60)).toBeNull();
    expect(pick(0, 0, 60)).toMatchObject({ kind: 'pallet', screen: center, distancePx: 0 });
  });
});

describe('underlay backing and tone', () => {
  it('draws the opaque backing over the projected quad before the default-alpha image', () => {
    const ctx = new MockCanvas2DContext();
    const r = underlay(ctx);
    r.setCamera({ yawDeg: 28, pitchDeg: 51, zoom: 2.3 });
    r.setUnderlay({ backing: '#2b251d', rotationQuadrants: 1, flipZ: true });
    r.render(0);
    const [transform] = ctx.ops('transform');
    const [, plate] = ctx.ops('fillRect');
    const [image] = ctx.ops('drawImage');
    expect(ctx.calls.indexOf(transform!)).toBeLessThan(ctx.calls.indexOf(plate!));
    expect(ctx.calls.indexOf(plate!)).toBeLessThan(ctx.calls.indexOf(image!));
    expect(plate).toMatchObject({ args: [0, 0, 1000, 400], state: { fillStyle: '#2b251d', globalAlpha: 1 } });
    expect(image?.state.globalAlpha).toBe(0.92);
    const [a, b, c, d, e, f] = transform!.args as number[];
    const corners: Vec3[] = [[100, 0, 40], [100, 0, -40], [-100, 0, 40], [-100, 0, -40]];
    [[0, 0], [1000, 0], [0, 400], [1000, 400]].forEach(([x, y], i) => {
      const p = r.project(corners[i]!);
      expect(a! * x! + c! * y! + e!).toBeCloseTo(p.x);
      expect(b! * x! + d! * y! + f!).toBeCloseTo(p.y);
    });
  });

  it('applies CSS filters only to the image and restores none', () => {
    const ctx = new MockCanvas2DContext();
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
    const r = underlay(ctx, { visualPreset: 'clarity' });
    r.setUnderlay({ tone: { contrast: 1.2, saturation: 0.8 } });
    r.render(0);
    expect(ctx.ops('fillRect')[1]?.state.filter).toBe('none');
    expect(ctx.ops('drawImage')[0]?.state).toMatchObject({
      filter: 'brightness(1) contrast(1.2) saturate(0.8)', globalAlpha: 0.95,
    });
    expect(ctx.filter).toBe('none');
    expect(ctx.ops('fillRect')).toHaveLength(2);
  });

  it('uses screen and soft-light in the same affine bounds and restores source-over', () => {
    const ctx = new MockCanvas2DContext();
    ctx.globalCompositeOperation = 'source-over';
    const r = underlay(ctx);
    r.setUnderlay({ tone: { brightness: 5, contrast: 1.5 } });
    r.render(0);
    const [image] = ctx.ops('drawImage');
    const [, screen, contrast] = ctx.ops('fillRect');
    expect(image?.state.composite).toBe('source-over');
    expect(ctx.calls.indexOf(image!)).toBeLessThan(ctx.calls.indexOf(screen!));
    expect(screen).toMatchObject({ args: [0, 0, 1000, 400], state: { composite: 'screen', fillStyle: 'rgba(255,240,215,0.35)' } });
    expect(contrast).toMatchObject({ args: [0, 0, 1000, 400], state: { composite: 'soft-light', fillStyle: 'rgba(216,179,106,0.25)' } });
    expect(ctx.globalCompositeOperation).toBe('source-over');
    expect(ctx.filter).toBeUndefined();
  });

  it('skips blend modes that the context silently rejects', () => {
    const ctx = new MockCanvas2DContext();
    Object.defineProperty(ctx, 'globalCompositeOperation', { get: () => 'source-over', set: () => {} });
    underlay(ctx, { visualPreset: 'clarity' }).render(0);
    expect(ctx.ops('drawImage')).toHaveLength(1);
    expect(ctx.ops('fillRect')).toHaveLength(2);
  });

  it('supports minimal contexts and explicit null tone/backing overrides', () => {
    const ctx = new MockCanvas2DContext();
    const r = underlay(ctx, { visualPreset: 'clarity' });
    r.render(0);
    expect(ctx.ops('drawImage')).toHaveLength(1);
    expect(ctx.ops('fillRect')).toHaveLength(2);
    expect(ctx.globalCompositeOperation).toBeUndefined();
    ctx.reset();
    ctx.filter = 'none';
    r.setUnderlay({ tone: null, backing: null, opacity: 1 });
    r.render(0);
    expect(ctx.ops('fillRect')).toHaveLength(1);
    expect(ctx.ops('drawImage')[0]?.state).toMatchObject({ filter: 'none', globalAlpha: 1 });
  });

  it('resets the filter and balances the canvas stack if drawImage throws', () => {
    const ctx = new MockCanvas2DContext();
    ctx.filter = 'none';
    ctx.drawImage = () => { throw new Error('draw failed'); };
    expect(() => underlay(ctx, { visualPreset: 'clarity' }).render(0)).toThrow('draw failed');
    expect(ctx.filter).toBe('none');
    expect(ctx.ops('restore')).toHaveLength(ctx.ops('save').length);
  });
});

describe('visual presets and landmark clarity', () => {
  it('exports all presets and preserves the complete legacy palette', () => {
    expect(MANOR_DOSSIER_PALETTE).toEqual({
      bg: '#0b0a09', bg3: '#1a1714', line: '#3a332a', line2: '#5c4e3a',
      text: '#ddd3bd', muted: '#9a8f7a', dim: '#655c4e', gold: '#c9a25f',
      goldD: '#8e7a4a', red: '#8e2f3c', redL: '#b04a58', blue: '#6f8fb8', ice: '#a9c7e8',
    });
    expect(Object.keys(VISUAL_PRESETS)).toEqual(['clarity', 'original', 'dossier']);
    const id: VisualPresetId = 'clarity';
    const clarity: VisualPresetConfig = VISUAL_PRESETS[id];
    expect(clarity.palette).toBe(MANOR_CLARITY_PALETTE);
    expect(clarity).toMatchObject({ glyphScale: 1.35, underlay: { opacity: 0.95, backing: '#2b251d' } });
    expect(VISUAL_PRESETS.original).toMatchObject({ glyphScale: 1.2, underlay: { opacity: 1, tone: null } });
    expect(VISUAL_PRESETS.dossier).toMatchObject({ glyphScale: 1, underlay: { opacity: 0.72 } });
  });

  it('draws the clarity grid using minor and every-fifth major lines', () => {
    const ctx = new MockCanvas2DContext();
    const r = underlay(ctx, { visualPreset: 'clarity' });
    r.setCamera({ zoom: 6 });
    r.setLayers({ grid: true });
    r.render(0);
    const { minor, major } = VISUAL_PRESETS.clarity.grid;
    const x = r.project([50, 0, -40]).x;
    const lines = ctx.ops('moveTo');
    expect(lines.find((c) => c.args[0] === x && c.args[1] === r.project([50, 0, -40]).y)?.state.strokeStyle).toBe(major);
    expect(ctx.ops('stroke').map((c) => c.state.strokeStyle)).toEqual([minor, major]);
  });

  it('strokes text at its origin when supported', () => {
    const ctx = new TextCanvas();
    const { renderer } = scene(ctx);
    renderer.render(10);
    const [outline] = ctx.ops('strokeText').filter((c) => c.args[0] === 'Hunter');
    expect(outline?.state).toMatchObject({ strokeStyle: HALO, lineJoin: 'round', lineWidth: 3, globalAlpha: 0.85 });
    expect(ctx.ops('fillText').filter((c) => c.args[0] === 'Hunter').map((c) => c.args)).toEqual([outline?.args]);
  });

  it('draws eight one-pixel outline offsets and one centered foreground without strokeText', () => {
    const ctx = new MockCanvas2DContext();
    const { renderer } = scene(ctx);
    renderer.render(10);
    const calls = ctx.ops('fillText').filter((c) => c.args[0] === 'Hunter');
    const [, x, y] = calls.at(-1)!.args as [string, number, number];
    expect(calls).toHaveLength(9);
    expect(calls.slice(0, 8).map((c) => [(c.args[1] as number) - x, (c.args[2] as number) - y])).toEqual([
      [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
    ]);
    expect(calls.slice(0, 8).every((c) => c.state.fillStyle === HALO && c.state.globalAlpha === 0.85)).toBe(true);
    expect(calls.at(-1)?.state.fillStyle).toBe(MANOR_CLARITY_PALETTE.redL);
  });

  it.each([30, 50, 70])('keeps clarity landmark spans at least 20 CSS px at zoom 0.05 and t=%i', (t) => {
    const ctx = new MockCanvas2DContext();
    const { renderer, payload } = scene(ctx);
    renderer.setCamera({ zoom: 0.05 });
    renderer.render(t);
    const { ciphers, hatch, exit_gates, chests, chairs, windows, pallets } = payload.entities;
    for (const entity of [ciphers[0]!, hatch!]) {
      const p = renderer.project(entity.pos);
      expect(ctx.ops('arc').some((c) => c.args[0] === p.x && c.args[1] === p.y && Number(c.args[2]) >= 10)).toBe(true);
    }
    const arcs = ctx.ops('arc');
    expect(arcs.some((c) => c.state.strokeStyle === MANOR_CLARITY_PALETTE.blue && Number(c.args[2]) >= 10)).toBe(true);
    for (const entity of [exit_gates[0]!, chests[0]!]) {
      const p = renderer.project(entity.pos);
      expect(ctx.ops('rect').some(({ args: [x, y, w, h] }) =>
        Number(x) + Number(w) / 2 === p.x && Number(y) + Number(h) / 2 === p.y && Number(w) >= 20)).toBe(true);
    }
    const palette = MANOR_CLARITY_PALETTE;
    const palletColor = t < 40 ? palette.goldD : t < 60 ? palette.redL : palette.dim;
    for (const [entity, color] of [[chairs[1]!, palette.goldD], [windows[0]!, palette.ice], [pallets[0]!, palletColor]] as const) {
      const p = renderer.project(entity.pos);
      const endpoints = ctx.calls.filter((c) =>
        (c.op === 'moveTo' || c.op === 'lineTo') && c.state.strokeStyle === color &&
        Math.abs(Number(c.args[1]) - p.y) <= 10 && Math.abs(Number(c.args[0]) - p.x) <= 11,
      );
      expect(endpoints.some((c) => Number(c.args[0]) <= p.x - 10)).toBe(true);
      expect(endpoints.some((c) => Number(c.args[0]) >= p.x + 10)).toBe(true);
    }
  });

  it('honors glyphScale and draws the rounded path halo 3 px wider', () => {
    const ctx = new TextCanvas();
    const { renderer, payload } = scene(ctx, { visualPreset: 'original', glyphScale: 2 });
    renderer.render(0);
    const p = renderer.project(payload.entities.ciphers[0]!.pos);
    const arc = ctx.calls.findIndex((c) => c.op === 'arc' && c.args[0] === p.x && c.args[1] === p.y && c.args[2] === 18);
    expect(arc).toBeGreaterThan(0);
    const [halo, foreground] = ctx.calls.slice(arc).filter((c) => c.op === 'stroke');
    expect(halo?.state).toMatchObject({ strokeStyle: HALO, lineJoin: 'round', globalAlpha: 0.85 });
    expect(halo?.state.lineWidth).toBe(foreground!.state.lineWidth + 3);
  });

  it('draws one stair emblem per basement group and follows surface visibility', () => {
    const ctx = new TextCanvas();
    const { renderer, payload } = scene(ctx);
    const chair = payload.entities.chairs[0]!;
    payload.entities.chairs.push({ ...chair, uid: 202, pos: [-160, -80, 100] });
    renderer.render(10);
    const badges = ctx.ops('strokeText').filter((c) => c.args[0] === '\u5730\u4e0b\u5ba4');
    const surface = renderer.project([-180, 0, 100]);
    expect(badges).toHaveLength(1);
    expect(badges[0]?.args[1]).toBe(surface.x);
    const tread = 21.6 / 3;
    const stairY = surface.y - 21.6 - 23;
    const segments = ctx.ops('lineTo').filter((c) =>
      c.state.strokeStyle === MANOR_CLARITY_PALETTE.gold &&
      Number(c.args[0]) >= surface.x - 11 && Number(c.args[0]) <= surface.x + 11 &&
      Number(c.args[1]) >= stairY && Number(c.args[1]) <= stairY + 3 * tread + 1e-6,
    );
    expect(segments).toHaveLength(6);
    expect(segments[1]?.args[1]).toBeCloseTo(stairY + tread);
    ctx.reset();
    renderer.setLayers({ visibleFloors: { B1: true, '1F': false, '2F': true } });
    renderer.render(10);
    expect(ctx.texts()).not.toContain('\u5730\u4e0b\u5ba4');
    expect(ctx.texts()).toContain('B1');
  });
});

describe('camera fit with HUD inset', () => {
  it('preserves the legacy fit when the inset is omitted or zero', () => {
    const legacy = scene(new MockCanvas2DContext(), {}).renderer;
    const explicit = scene(new MockCanvas2DContext(), { topSafeInset: 0 }).renderer;
    expect(explicit.fitToView()).toEqual(legacy.fitToWorld());
  });

  it.each([false, true])('fits the projected world below the top inset (oblique=%s)', (oblique) => {
    const { renderer, payload } = scene(new MockCanvas2DContext(), { topSafeInset: 120 });
    if (oblique) renderer.setCamera({ yawDeg: 35, pitchDeg: 45, yScale: 2 });
    renderer.fitToView(0.08);
    const b = payload.world.bounds;
    const pts = [b.min_x, b.max_x].flatMap((x) => [b.min_y, b.max_y].flatMap((y) =>
      [b.min_z, b.max_z].map((z) => renderer.project([x, y, z])),
    ));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(80 - 1e-6);
    expect(Math.max(...xs)).toBeLessThanOrEqual(920 + 1e-6);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(120 + 680 * 0.08 - 1e-6);
    expect(Math.max(...ys)).toBeLessThanOrEqual(800 - 680 * 0.08 + 1e-6);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(460);
  });
});
