import { describe, expect, it } from 'vitest';
import { MANOR_DOSSIER_PALETTE, TacticalReplayRenderer, createDefaultLayers } from '../src/renderer';
import { projectWorldToScreen } from '../src/projection';
import type { CameraState, LayerVisibilityState, Vec3 } from '../src/types';
import { MockCanvas2DContext, type RecordedCall } from './helpers/mockCanvas';
import { makePayload } from './helpers/fixtures';

const VP = { width: 1000, height: 800, dpr: 2 };
const P = MANOR_DOSSIER_PALETTE;
const OBLIQUE: Partial<CameraState> = { centerX: 0, centerZ: 0, zoom: 0.8, yawDeg: 30, pitchDeg: 50, yScale: 2 };
const TOPDOWN: Partial<CameraState> = { centerX: 0, centerZ: 0, zoom: 0.8, yawDeg: 0, pitchDeg: 90, yScale: 1 };

function setup(cam: Partial<CameraState> = OBLIQUE, layers: Partial<LayerVisibilityState> = {}) {
  const ctx = new MockCanvas2DContext();
  const r = new TacticalReplayRenderer(ctx, VP);
  r.setPayload(makePayload());
  r.setCamera(cam);
  r.setLayers(layers);
  return { ctx, r, cam: r.getCamera() };
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
function hasPoint(calls: RecordedCall[], op: 'moveTo' | 'lineTo', x: number, y: number, pred: (c: RecordedCall) => boolean = () => true) {
  return calls.some((c) => c.op === op && near(c.args[0] as number, x) && near(c.args[1] as number, y) && pred(c));
}

const ALL_OFF: Partial<LayerVisibilityState> = {
  grid: false, floorPlanes: false, dropLines: false, trails: false, viewCones: false, dirArrows: false,
  ciphers: false, pallets: false, windows: false, chairs: false, gates: false, chests: false, hatch: false, pulses: false, labels: false,
};

describe('renderer basics', () => {
  it('applies DPR transform, Manor Dossier background and palette defaults', () => {
    const { ctx, r } = setup();
    r.render(10);
    expect(ctx.calls[1]).toMatchObject({ op: 'setTransform', args: [2, 0, 0, 2, 0, 0] });
    const bg = ctx.ops('fillRect')[0]!;
    expect(bg.args).toEqual([0, 0, 1000, 800]);
    expect(bg.state.fillStyle).toBe('#0b0a09');
    expect(P).toMatchObject({ bg: '#0b0a09', gold: '#c9a25f', red: '#8e2f3c', redL: '#b04a58', blue: '#6f8fb8' });
    expect(ctx.texts()).toContain('Hunter');
  });

  it('balances save/restore and works without optional measureText (Mini Program safe)', () => {
    const { ctx, r } = setup();
    (ctx as unknown as { measureText?: unknown }).measureText = undefined;
    r.setRuler({ a: [0, 0, 0], b: [135, 0, 0] });
    r.render(21.1);
    expect(ctx.ops('save').length).toBe(ctx.ops('restore').length);
  });
});

describe('AC-3 floor planes, floor filter and drop lines', () => {
  it('draws semi-transparent B1/1F/2F reference planes in 2.5D only', () => {
    const o = setup(OBLIQUE);
    o.r.render(10);
    const labels = o.ctx.texts();
    expect(labels).toEqual(expect.arrayContaining(['B1 · y=-85', '1F · y=0', '2F · y=60']));
    const planeFills = o.ctx.ops('fill').filter((c) => near(c.state.globalAlpha, 0.08));
    expect(planeFills.length).toBe(3);
    const t = setup(TOPDOWN);
    t.r.render(10);
    expect(t.ctx.texts().some((s) => s.includes(' · y='))).toBe(false);
  });

  it('draws dashed drop lines to Y=0 for B1 (y=-85) and 2F (y=65) entities in 2.5D', () => {
    const { ctx, r, cam } = setup(OBLIQUE);
    r.render(10);
    const dashed = (c: RecordedCall) => c.state.lineDash.length === 2 && c.state.lineDash[0] === 3;
    for (const w of [[-200, -85, 100], [100, 65, -100], [-200, -80, 100]] as Vec3[]) {
      const top = projectWorldToScreen(w, cam, VP);
      const ground = projectWorldToScreen([w[0], 0, w[2]], cam, VP);
      expect(hasPoint(ctx.calls, 'moveTo', top.x, top.y, dashed)).toBe(true);
      expect(hasPoint(ctx.calls, 'lineTo', ground.x, ground.y, dashed)).toBe(true);
    }
    // ground-level 1F entities never get drop lines
    const g = projectWorldToScreen([200, 0, 0], cam, VP);
    expect(hasPoint(ctx.calls, 'moveTo', g.x, g.y, dashed)).toBe(false);
    const td = setup(TOPDOWN);
    td.r.render(10);
    expect(td.ctx.calls.some((c) => c.op === 'lineTo' && dashed(c))).toBe(false);
  });

  it('floor visibility filter hides filtered-out floors entities, players, planes and trails', () => {
    const all = setup(OBLIQUE);
    const before = all.r.computeDrawOrder(10).map((d) => `${d.kind}:${d.uid}`);
    expect(before).toEqual(expect.arrayContaining(['player:3', 'chair:200', 'player:4']));
    all.r.setLayers({ visibleFloors: { B1: false, '1F': true, '2F': true } });
    const after = all.r.computeDrawOrder(10).map((d) => `${d.kind}:${d.uid}`);
    expect(after).not.toContain('player:3');
    expect(after).not.toContain('chair:200');
    expect(after).toContain('player:4');
    all.r.render(10);
    expect(all.ctx.texts()).not.toContain('B1 · y=-85');
    expect(all.ctx.texts()).not.toContain('SurvB1');

    const trailStrokes = (ctx: MockCanvas2DContext) =>
      ctx.ops('stroke').filter((c) => c.state.strokeStyle === P.blue && c.state.globalAlpha < 0.95 && c.state.lineDash.length === 0).length;
    const a = setup(OBLIQUE, { ...ALL_OFF, trails: true });
    a.r.render(10);
    const b = setup(OBLIQUE, { ...ALL_OFF, trails: true, visibleFloors: { B1: false, '1F': false, '2F': true } });
    b.r.render(10);
    const c = setup(OBLIQUE, { ...ALL_OFF, trails: true, visibleFloors: { B1: false, '1F': false, '2F': false } });
    c.r.render(10);
    expect(trailStrokes(a.ctx)).toBeGreaterThan(trailStrokes(b.ctx));
    expect(trailStrokes(b.ctx)).toBeGreaterThan(0);
    expect(trailStrokes(c.ctx)).toBe(0);
  });

  it('focusFloor dims non-focused floors without hiding them', () => {
    const { r } = setup(OBLIQUE, { focusFloor: '2F' });
    expect(r.floorAlpha('2F')).toBe(1);
    expect(r.floorAlpha('1F')).toBeCloseTo(0.28, 9);
    expect(r.computeDrawOrder(10).some((d) => d.uid === 3)).toBe(true);
  });
});

describe('AC-4 ruler overlay', () => {
  it('renders line, pins and "135.0u · 3.0s" midpoint label', () => {
    const { ctx, r, cam } = setup(TOPDOWN, ALL_OFF);
    r.setRuler({ a: [0, 0, 0], b: [135, 0, 0] });
    r.render(0);
    expect(ctx.texts()).toContain('135.0u · 3.0s');
    const a = projectWorldToScreen([0, 0, 0], cam, VP);
    const b = projectWorldToScreen([135, 0, 0], cam, VP);
    expect(hasPoint(ctx.calls, 'moveTo', a.x, a.y, (c) => c.state.strokeStyle === P.gold)).toBe(true);
    expect(hasPoint(ctx.calls, 'lineTo', b.x, b.y)).toBe(true);
    expect(ctx.ops('arc').filter((c) => c.args[2] === 4.5).length).toBe(2);
  });

  it('renders cross-floor badge for B1 -> 1F measurements', () => {
    const { ctx, r } = setup(OBLIQUE, ALL_OFF);
    r.setRuler({ a: [90, -85, 0], b: [0, 0, 0] });
    r.render(0);
    const eff = Math.hypot(90, 85) + 90;
    expect(ctx.texts()).toContain(`${eff.toFixed(1)}u · ${(eff / 45).toFixed(1)}s`);
    expect(ctx.texts()).toContain('B1→1F +90u');
  });
});

describe('AC-5 underlay drawing', () => {
  it('invokes transform + drawImage only when the underlay is enabled', () => {
    const { ctx, r, cam } = setup(OBLIQUE);
    const img = { width: 1024, height: 820 };
    r.setUnderlay({ enabled: false, image: img });
    r.render(0);
    expect(ctx.ops('drawImage').length).toBe(0);
    ctx.reset();
    r.setUnderlay({ enabled: true, opacity: 0.6 });
    r.render(0);
    const draw = ctx.ops('drawImage');
    expect(draw.length).toBe(1);
    expect(draw[0]!.args).toEqual([img, 0, 0, 1024, 820]);
    expect(draw[0]!.state.globalAlpha).toBeCloseTo(0.6, 12);
    const tr = ctx.ops('transform')[0]!.args as number[];
    const p00 = projectWorldToScreen([-500, 0, -400], cam, VP);
    expect(tr[4]).toBeCloseTo(p00.x, 9);
    expect(tr[5]).toBeCloseTo(p00.y, 9);
  });
});

describe('AC-6 tactical overlays', () => {
  it('draws body-facing dir chevron along the projected heading', () => {
    const { ctx, r, cam } = setup(TOPDOWN);
    r.render(10); // SurvA moves +X at 45 u/s -> (450, 0, 0)
    const sp = projectWorldToScreen([450, 0, 0], cam, VP);
    expect(hasPoint(ctx.calls, 'moveTo', sp.x + 17, sp.y, (c) => c.state.fillStyle === P.blue)).toBe(true);
  });

  it('projects the et=304 cam_yaw view cone in world space on the player plane', () => {
    const { ctx, r, cam } = setup(OBLIQUE);
    r.render(10);
    // SurvA cam_yaw = 0 -> cone axis +Z : (x + sin(0)*60, y, z + cos(0)*60)
    const tip = projectWorldToScreen([450, 0, 60], cam, VP);
    expect(hasPoint(ctx.calls, 'lineTo', tip.x, tip.y)).toBe(true);
    // 2F survivor cone sits on Y = 65 and points -Z (yaw 180)
    const tip2 = projectWorldToScreen([100 + Math.sin(Math.PI) * 60, 65, -100 + Math.cos(Math.PI) * 60], cam, VP);
    expect(hasPoint(ctx.calls, 'lineTo', tip2.x, tip2.y)).toBe(true);
    const poly = r.computeViewConePolygon([0, 0, 0], 90);
    expect(poly.length).toBe(14);
    // pitch foreshortening: cone depth extent shrinks in 2.5D vs 2D
    const flat = setup({ ...OBLIQUE, pitchDeg: 90 }).r.computeViewConePolygon([0, 0, 0], 0);
    const obl = r.computeViewConePolygon([0, 0, 0], 0);
    const extent = (pts: Array<{ y: number }>) => Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
    expect(extent(obl)).toBeLessThan(extent(flat));
  });

  it('draws 5 s fading trails with alpha decreasing by age', () => {
    const { ctx, r } = setup(TOPDOWN, { ...ALL_OFF, trails: true });
    r.render(10);
    const strokes = ctx.ops('stroke').filter((c) => c.state.strokeStyle === P.blue && c.state.globalAlpha < 0.95);
    expect(strokes.length).toBeGreaterThan(40);
    const alphas = strokes.slice(0, 50).map((c) => c.state.globalAlpha);
    expect(alphas[alphas.length - 1]!).toBeGreaterThan(alphas[0]!);
    const hunter = ctx.ops('stroke').filter((c) => c.state.strokeStyle === P.redL && c.state.globalAlpha < 0.95);
    expect(hunter.length).toBeGreaterThan(40);
  });

  it('draws dynamic cipher progress ring arcs and completed badge', () => {
    const { ctx, r } = setup(TOPDOWN, { ...ALL_OFF, ciphers: true });
    r.render(60);
    const ring = ctx.ops('arc').find((c) => c.args[2] === 11.5)!;
    expect(ring.args[3]).toBeCloseTo(-Math.PI / 2, 12);
    expect(ring.args[4]).toBeCloseTo(-Math.PI / 2 + Math.PI * 2 * 0.65, 9);
    expect(ring.state.strokeStyle).toBe(P.gold);
    expect(ctx.texts()).toContain('65');
    ctx.reset();
    r.render(85);
    expect(ctx.texts()).toContain('✓');
    expect(ctx.ops('arc').some((c) => c.args[2] === 11.5)).toBe(false);
  });

  it('renders pallet upright -> dropped -> broken visuals', () => {
    const { ctx, r } = setup(TOPDOWN, { ...ALL_OFF, pallets: true });
    r.render(30);
    expect(ctx.ops('stroke').some((c) => c.state.lineWidth === 3 && c.state.strokeStyle === P.gold)).toBe(true);
    ctx.reset();
    r.render(50);
    expect(ctx.ops('stroke').some((c) => c.state.lineWidth === 7)).toBe(true);
    ctx.reset();
    r.render(70);
    const s = ctx.ops('stroke').filter((c) => c.state.strokeStyle === P.dim);
    expect(s.length).toBe(1);
    expect(s[0]!.state.globalAlpha).toBeCloseTo(0.35, 12);
    expect(ctx.ops('stroke').some((c) => c.state.lineWidth === 7 || (c.state.lineWidth === 3 && c.state.strokeStyle === P.gold))).toBe(false);
  });

  it('renders basement chair tag and elimination countdown bar with 50% tick', () => {
    const { ctx, r, cam } = setup(TOPDOWN, { ...ALL_OFF, chairs: true });
    r.render(115);
    expect(ctx.texts()).toContain('B1');
    const bar = ctx.ops('fillRect').find((c) => c.state.fillStyle === P.redL)!;
    expect(bar.args[2]).toBeCloseTo(28 * 0.25, 9);
    const sp = projectWorldToScreen([-200, -80, 100], cam, VP);
    expect(hasPoint(ctx.calls, 'moveTo', sp.x, sp.y - 7 - 9 - 1.5)).toBe(true);
    ctx.reset();
    r.render(170);
    expect(ctx.ops('fillRect').some((c) => c.state.fillStyle === P.redL)).toBe(false);
  });

  it('renders gate power states and window seal markers', () => {
    const { ctx, r } = setup(TOPDOWN, { ...ALL_OFF, gates: true, windows: true });
    r.render(100);
    expect(ctx.texts()).toContain('门');
    ctx.reset();
    r.render(155);
    expect(ctx.texts()).toContain('开');
    ctx.reset();
    r.render(35);
    expect(ctx.ops('fill').some((c) => c.state.fillStyle === P.red)).toBe(true);
    ctx.reset();
    r.render(55);
    expect(ctx.ops('fill').some((c) => c.state.fillStyle === P.red)).toBe(false);
  });

  it('renders hit_attack / skill_cast / Flywheel expanding pulse rings', () => {
    const { ctx, r } = setup(TOPDOWN, { ...ALL_OFF, pulses: true });
    r.render(21.1);
    // pulse rings fade (globalAlpha < 1); player token rings are drawn at full alpha
    const arcs = ctx.ops('arc').filter((c) => c.state.globalAlpha < 0.999);
    const hit = arcs.find((c) => c.state.strokeStyle === P.red)!;
    expect(hit.args[2]).toBeCloseTo(8 + (1.1 / 1.2) * 28, 9);
    expect(hit.state.globalAlpha).toBeCloseTo(1 - 1.1 / 1.2, 9);
    expect(arcs.some((c) => c.state.strokeStyle === P.gold)).toBe(true);
    ctx.reset();
    r.render(22.6);
    // Flywheel pulse has no pos -> anchored on the actor (SurvA), ice-blue double ring
    expect(ctx.ops('arc').filter((c) => c.state.strokeStyle === P.ice || c.state.strokeStyle === P.text).length).toBe(2);
  });

  it('draws chase highlight ring and fear_state badge', () => {
    const { ctx, r } = setup(TOPDOWN);
    r.render(45);
    expect(ctx.ops('arc').some((c) => c.state.strokeStyle === P.redL && c.state.lineDash[0] === 4)).toBe(true);
    expect(ctx.texts()).toContain('椅'); // SurvB1 fear_state 3 = chaired
  });

  it('sorts drawables back-to-front by projected depth in 2.5D', () => {
    const { r } = setup(OBLIQUE);
    const order = r.computeDrawOrder(10);
    for (let i = 1; i < order.length; i++) expect(order[i]!.depth).toBeGreaterThanOrEqual(order[i - 1]!.depth);
    const idx = (k: string) => order.findIndex((d) => `${d.kind}:${d.uid}` === k);
    // B1 survivor (same XZ as basement chair but lower) draws before the elevated 2F survivor
    expect(idx('player:3')).toBeLessThan(idx('player:4'));
  });

  it('pickEntityAtScreen returns nearest visible entity within radius, players win ties', () => {
    const { r, cam } = setup(OBLIQUE);
    const c = projectWorldToScreen([200, 0, 0], cam, VP);
    expect(r.pickEntityAtScreen(c.x + 3, c.y - 2, 10)).toMatchObject({ kind: 'cipher', uid: 100, floor: '1F' });
    // SurvA at t=10 stands exactly on the gate (450,0,0): player wins the tie
    const g = projectWorldToScreen([450, 0, 0], cam, VP);
    expect(r.pickEntityAtScreen(g.x, g.y, 10)).toMatchObject({ kind: 'player', uid: 2 });
    expect(r.pickEntityAtScreen(g.x, g.y, 100)).toMatchObject({ kind: 'gate', uid: 400 });
    const w = projectWorldToScreen([0, 0, 300], cam, VP);
    expect(r.pickEntityAtScreen(w.x, w.y, 10)).toMatchObject({ kind: 'window', uid: 500 });
    expect(r.pickEntityAtScreen(5, 5, 10)).toBeNull();
    const b1 = projectWorldToScreen([-200, -85, 100], cam, VP);
    expect(r.pickEntityAtScreen(b1.x, b1.y, 10)).toMatchObject({ kind: 'player', uid: 3, floor: 'B1' });
    r.setLayers({ visibleFloors: { B1: false, '1F': true, '2F': true } });
    expect(r.pickEntityAtScreen(b1.x, b1.y, 10)).toBeNull();
  });

  it('createDefaultLayers enables every layer and all floors', () => {
    const l = createDefaultLayers();
    expect(l.visibleFloors).toEqual({ B1: true, '1F': true, '2F': true });
    expect(l.focusFloor).toBeNull();
  });
});
