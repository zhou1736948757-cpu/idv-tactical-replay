import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TacticalReplayRenderer, type CssRect, type TrajectorySampleTuple, type Vec3 } from '../src/index';
import { MockCanvas2DContext, type RecordedCall } from './helpers/mockCanvas';
import { makePayload, player } from './helpers/fixtures';

const art = new URL('../../../Workflow/results/T-019-art/', import.meta.url);
const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const area = (a: CssRect, b: CssRect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const union = (a: CssRect, b: CssRect) => rect(Math.min(a.left, b.left), Math.min(a.top, b.top), Math.max(a.right, b.right), Math.max(a.bottom, b.bottom));

function fontMetrics(text: string, font: string, align: string, baseline: string) {
  const size = Number(/([\d.]+)px/.exec(font)![1]);
  const width = [...text].reduce((w, c) => w + (c.codePointAt(0)! > 255 ? size : size * .55), 0);
  const left = align === 'center' ? width / 2 : 0;
  return {
    width, actualBoundingBoxLeft: left + 1.25, actualBoundingBoxRight: width - left + .75,
    actualBoundingBoxAscent: size * (baseline === 'middle' ? .5 : .85), actualBoundingBoxDescent: size * .12
  };
}
class Probe extends MockCanvas2DContext {
  constructor(readonly widthOnly = false) { super(); }
  inkMetrics = fontMetrics;
  override measureText(s: string) {
    const metrics = this.inkMetrics(s, this.font, this.textAlign, this.textBaseline);
    return this.widthOnly ? { width: metrics.width } : metrics;
  }
  strokeText(...args: unknown[]) { this.rec('strokeText', args); }
}

function transformed(r: CssRect, c: RecordedCall, dpr: number) {
  const [a, b, cc, d, e, f] = c.state.transform;
  const xs: number[] = [], ys: number[] = [];
  for (const x of [r.left, r.right]) for (const y of [r.top, r.bottom]) {
    xs.push((a * x + cc * y + e) / dpr);
    ys.push((b * x + d * y + f) / dpr);
  }
  return rect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}
type Paint = { text: string; plate: CssRect; ink: CssRect; baseline: number[]; font: string; color: string; back: string };

// Decode painted paths in order, including both caps, every outline offset
// and the actual CTM. No rectangles or measurements from the layout pass.
function paints(ctx: Probe, dpr = 1): Paint[] {
  const out: Paint[] = [];
  let start: number[] = [], end: number[] = [];
  let plate: CssRect | undefined, ink: CssRect | undefined, back = '';
  for (const c of ctx.calls) {
    const s = c.state;
    if (c.op === 'beginPath') {
      start = [];
      end = [];
    }
    if (c.op === 'moveTo') start = c.args as number[];
    if (c.op === 'lineTo') end = c.args as number[];
    if (c.op === 'stroke' && s.lineCap === 'round' && s.strokeStyle === '#0b0a09' && start.length && end.length && s.lineWidth >= 12) {
      expect(end[0]).toBeGreaterThanOrEqual(start[0]);
      expect(end[1]).toBe(start[1]);
      const h = s.lineWidth / 2;
      plate = transformed(rect(start[0] - h, start[1] - h, end[0] + h, end[1] + h), c, dpr);
      back = s.strokeStyle;
      ink = undefined;
    }
    if (!plate || !['strokeText', 'fillText'].includes(c.op)) continue;
    const [text, x, y] = c.args as [string, number, number];
    const m = ctx.inkMetrics(text, s.font, s.textAlign, s.textBaseline);
    const pad = c.op === 'strokeText' ? s.lineWidth / 2 : 0;
    const glyph = transformed(rect(x - m.actualBoundingBoxLeft - pad, y - m.actualBoundingBoxAscent - pad,
      x + m.actualBoundingBoxRight + pad, y + m.actualBoundingBoxDescent + pad), c, dpr);
    ink = ink ? union(ink, glyph) : glyph;
    if (c.op === 'fillText' && s.fillStyle !== back) {
      expect(s.textAlign).toBe('center');
      expect(s.textBaseline).toBe('bottom');
      out.push({ text, plate, ink, baseline: [x, y], font: s.font, color: s.fillStyle, back });
      plate = undefined;
    }
  }
  return out;
}
function maxima(rows: Paint[], reserved: readonly CssRect[]) {
  let plates = 0, inks = 0, mixed = 0, protectedArea = 0;
  for (const [i, row] of rows.entries()) {
    for (const other of rows.slice(i + 1)) {
      plates = Math.max(plates, area(row.plate, other.plate));
      inks = Math.max(inks, area(row.ink, other.ink));
      mixed = Math.max(mixed, area(row.ink, other.plate), area(other.ink, row.plate));
    }
    for (const r of reserved) protectedArea = Math.max(protectedArea, area(row.ink, r), area(row.plate, r));
  }
  return { plates, inks, mixed, protectedArea };
}
const zero = { plates: 0, inks: 0, mixed: 0, protectedArea: 0 };
const screens = [[830.58, 648], [1346, 648], [873.2, 780], [1416, 780], [1167.6, 960], [1888, 960]];
const base = makePayload();
type Actor = { uid: number; camp: 1 | 2; player_name: string; tuple: TrajectorySampleTuple; screen?: { x: number; y: number } };
type Frame = { id: string; t: number; world: typeof base.world; players: Actor[] };
// Workflow/ is a local review-artifact directory, not part of a clean checkout.
const frameFile = new URL('frames.json', art);
const beforeFile = new URL('before.json', art);
const fullScenesFile = new URL('full-scenes.json', art);
const captureBase = process.env.T019_CAPTURE_BASE_MODULE;
const replayCache = process.env.T019_REPLAY_CACHE;
const captureAfter = process.env.T019_CAPTURE_AFTER;
const frames: Frame[] | undefined = existsSync(frameFile) || captureBase || replayCache
  ? JSON.parse(readFileSync(frameFile, 'utf8'))
  : undefined;
if (frames && frames.length !== 10) throw new Error('Expected ten T-019 frozen frames');
const needsReplayEvidence = captureBase && replayCache;
function actors(names = ['同名', '同名', '一位很长的中文全名测试', '猎', 'W']) {
  return names.map((player_name, i): Actor => ({ player_name, uid: [12, 2, 21, 7, 10][i], camp: i === 3 ? 1 : 2, tuple: [0, 0, 0, 0, 0, 1, 0, 0, i] }));
}
function scene(list: Actor[], width: number, height: number, dpr = 1, ctx = new Probe(), world = base.world, Renderer = TacticalReplayRenderer) {
  const payload = {
    ...base, world, players: list.map(a => player(a.uid, a.camp, a.player_name)),
    trajectories: Object.fromEntries(list.map(a => [a.uid, [a.tuple]]))
  };
  const r = new Renderer(ctx, { width, height, dpr }, { visualPreset: 'clarity', topSafeInset: 48 });
  r.setPayload(payload);
  r.setLayers({
    grid: false, trails: false, viewCones: false, dropLines: false, ciphers: false, chairs: false, gates: false,
    windows: false, pallets: false, chests: false, hatch: false, pulses: false
  });
  return { r, ctx, payload };
}
function luminance(hex: string) {
  return hex.slice(1).match(/../g)!.map(s => parseInt(s, 16) / 255).reduce((sum, v, i) =>
    sum + [.2126, .7152, .0722][i] * (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4), 0);
}
function verify(rows: Paint[], names: string[], width: number, height: number, obstacles: readonly CssRect[]) {
  expect(rows.map(p => p.text).sort()).toEqual([...names].sort());
  expect(maxima(rows, obstacles)).toEqual(zero);
  for (const p of rows) {
    expect(Number(/([\d.]+)px/.exec(p.font)![1])).toBeGreaterThanOrEqual(12);
    expect((luminance(p.color) + .05) / (luminance(p.back) + .05)).toBeGreaterThanOrEqual(4.5);
    for (const b of [p.plate, p.ink]) {
      expect(b.left).toBeGreaterThanOrEqual(2 - 1e-9);
      expect(b.top).toBeGreaterThanOrEqual(2 - 1e-9);
      expect(b.right).toBeLessThanOrEqual(width - 2 + 1e-9);
      expect(b.bottom).toBeLessThanOrEqual(height - 2 + 1e-9);
    }
  }
}

type Snapshot = { width: number; height: number; t: number; match: string; models: Paint[]; uids: number[]; centers: number[][]; max: ReturnType<typeof maxima> };
function chinatownSnapshot(Renderer = TacticalReplayRenderer): Snapshot[] {
  const f = frames!.find(f => f.t === 120)!;
  return screens.map(([width, height]) => {
    const { ctx, r } = scene(f.players, width, height, 1, new Probe(), f.world, Renderer);
    r.fitToWorld();
    r.render(120);
    const models = paints(ctx);
    const centers = f.players.map(a => {
      const projected = r.project(a.tuple.slice(1, 4) as Vec3);
      const arc = ctx.ops('arc').find(c => c.args[0] === projected.x && c.args[1] === projected.y);
      expect(arc).toBeDefined();
      return arc!.args.slice(0, 2) as number[];
    });
    return {
      width, height, t: 120, match: f.id, models, centers, centerUids: f.players.map(a => a.uid),
      // Preserve the literal path commands and text state for the paused fixture.
      // The other sizes retain the independently reconstructed rectangles.
      commands: width === 873.2 ? ctx.calls.filter(c =>
        ['beginPath', 'moveTo', 'lineTo', 'arc', 'stroke', 'fillText', 'strokeText'].includes(c.op)
      ).map(({ op, args, state: s }) => ({
        op, args, ctm: s.transform, width: s.lineWidth, cap: s.lineCap, stroke: s.strokeStyle,
        fill: s.fillStyle, alpha: s.globalAlpha, font: s.font, align: s.textAlign, baseline: s.textBaseline
      })) : undefined,
      uids: models.map(row => f.players.find(a => a.player_name === row.text)!.uid), max: maxima(models, [])
    };
  });
}

function sceneObstacles(ctx: Probe, dpr: number, centers: number[][]): CssRect[] {
  const obstacles: CssRect[] = [];
  const firstName = ctx.calls.findIndex(c => c.op === 'stroke' && c.state.lineCap === 'round' && c.state.lineWidth >= 12 && c.state.strokeStyle === '#0b0a09');
  const lastName = ctx.calls.findLastIndex(c => c.op === 'strokeText' && c.state.textBaseline === 'bottom');
  let arc: number[] | undefined;
  for (const [i, c] of ctx.calls.entries()) {
    if (c.op === 'beginPath') arc = undefined;
    if (c.op === 'arc') arc = c.args as number[];
    if (c.op === 'stroke' && arc && (i > lastName || centers.some(p => p[0] === arc![0] && p[1] === arc![1]))) {
      const [x, y, r] = arc, extent = r + c.state.lineWidth / 2;
      obstacles.push(transformed(rect(x - extent, y - extent, x + extent, y + extent), c, dpr));
    }
    if (i >= firstName || !['fillText', 'strokeText'].includes(c.op)) continue;
    const [text, x, y] = c.args as [string, number, number];
    const m = fontMetrics(text, c.state.font, c.state.textAlign, c.state.textBaseline);
    const pad = c.op === 'strokeText' ? c.state.lineWidth / 2 : 0;
    obstacles.push(transformed(rect(x - m.actualBoundingBoxLeft - pad, y - m.actualBoundingBoxAscent - pad,
      x + m.actualBoundingBoxRight + pad, y + m.actualBoundingBoxDescent + pad), c, dpr));
  }
  return obstacles;
}
type ReplayCheck = {
  match: string; t: number; width: number; height: number; dpr: number; uids: number[]; drawn: number; protectedCount: number;
  max: ReturnType<typeof maxima>; degraded: number; maxTokenError: number; exportEqual: boolean; reverseSeekEqual: boolean;
  minFont: number; minContrast: number; plateReserved: number; inkReserved: number
};
function fullReplayChecks(cache: string, Legacy: typeof TacticalReplayRenderer): ReplayCheck[] {
  const checks: ReplayCheck[] = [];
  const payloads = new Map<string, typeof base>();
  for (const f of frames!) {
    if (!payloads.has(f.id)) payloads.set(f.id, JSON.parse(readFileSync(join(cache, f.id, 'replay_2d.json'), 'utf8')));
    const payload = payloads.get(f.id)!;
    for (const [width, height] of screens) for (const dpr of [1, 2]) {
      const viewport = { width, height, dpr };
      const draw = (Renderer: typeof TacticalReplayRenderer) => {
        const ctx = new Probe();
        const r = new Renderer(ctx, viewport, { visualPreset: 'clarity', topSafeInset: 48 });
        r.setPayload(payload);
        r.fitToWorld();
        r.render(f.t);
        const centers = f.players.map(a => {
          const p = r.project(a.tuple.slice(1, 4) as Vec3);
          const arc = ctx.ops('arc').find(c => c.args[0] === p.x && c.args[1] === p.y);
          expect(arc).toBeDefined();
          return arc!.args.slice(0, 2) as number[];
        });
        return { r, ctx, centers };
      };
      const previous = draw(Legacy);
      const { r, ctx, centers } = draw(TacticalReplayRenderer);
      const rows = paints(ctx, dpr);
      const protectedRects = sceneObstacles(ctx, dpr, centers);
      verify(rows, f.players.map(a => a.player_name), width, height, protectedRects);
      const exported = new Probe();
      r.setContext(exported);
      r.render(f.t);
      const maxTokenError = Math.max(...centers.map(([x, y], i) => Math.hypot(x - previous.centers[i][0], y - previous.centers[i][1])));
      const exportEqual = JSON.stringify(rows) === JSON.stringify(paints(exported, dpr));
      r.setPayload({ ...payload, players: [...payload.players].reverse() });
      r.render(f.t + 1);
      exported.reset();
      r.render(f.t);
      const reverseSeekEqual = JSON.stringify(rows) === JSON.stringify(paints(exported, dpr));
      checks.push({
        match: f.id, t: f.t, width, height, dpr, uids: f.players.map(a => a.uid), drawn: rows.length,
        protectedCount: protectedRects.length, max: maxima(rows, protectedRects), degraded: r.getLabelDegradationCount(), maxTokenError,
        exportEqual, reverseSeekEqual,
        minFont: Math.min(...rows.map(row => parseFloat(row.font))),
        minContrast: Math.min(...rows.map(row => (luminance(row.color) + .05) / (luminance(row.back) + .05))),
        plateReserved: Math.max(0, ...rows.flatMap(p => protectedRects.map(r => area(r, p.plate)))),
        inkReserved: Math.max(0, ...rows.flatMap(p => protectedRects.map(r => area(r, p.ink))))
      });
    }
  }
  return checks;
}

describe('player name paint geometry', () => {
  const width = 830.58, height = 648;
  function at(x: number, y: number, name = '边角外的玩家'): Actor {
    return { uid: 2, camp: 2, player_name: name, tuple: [0, x - width / 2, 0, y - height / 2, 1, 0, 0, null, 0] };
  }
  function capture(id: string, record: unknown) {
    if (captureAfter) {
      mkdirSync(art, { recursive: true });
      writeFileSync(new URL(`repair-${id}.json`, art), JSON.stringify(record, null, 2));
    }
  }
  it('admits only painted player geometry at DPR 2, including attached pulse strokes', () => {
    const cases: [string, number, number, boolean][] = [
      ['outside', -12, -12, false], ['corner', -9, -9, true], ['left', -9, 100, true],
      ['top', 100, -9, true], ['right', width + 9, 100, true], ['bottom', 100, height + 9, true],
      ['halo', -13, 100, true], ['selected', -20, 100, true], ['pursuit', -18, 100, true],
      ['heading', -20.5, 100, true], ['away', -20.5, 100, false], ['attached', -22, 100, true],
      ['detached', -22, 100, false], ['expired', -22, 100, false], ['hidden pulse', -22, 100, false],
    ];
    const evidence = [];
    for (const [kind, x, y, eligible] of cases) {
      const actor = at(x, y);
      if (kind === 'away') actor.tuple[4] = -1;
      const { r, ctx, payload } = scene([actor], width, height, 2);
      r.setLayers({ dirArrows: kind === 'heading' || kind === 'away', pulses: true,
        visibleFloors: { B1: false, '1F': true, '2F': true } });
      if (kind === 'selected') r.setSelectedUid(actor.uid);
      const event = { ...base.events[0], actor_uid: actor.uid, t: 0, pos: null as Vec3 | null };
      if (kind === 'detached') event.pos = [0, 0, 0];
      if (kind === 'hidden pulse') event.floor = 'B1';
      const pulses = ['attached', 'detached', 'expired', 'hidden pulse'].includes(kind);
      r.setPayload({ ...payload, events: kind === 'pursuit' ? [{ ...base.events[5], t: 0 }] : pulses ? [event] : [] });
      r.render(kind === 'expired' ? 1.2 : .6);
      const rows = paints(ctx, 2);
      const circle = ctx.ops('arc').find(c => Math.abs(Number(c.args[0]) - x) < 1e-8 && c.args[2] === 10.8)!;
      expect(circle, kind).toBeDefined();
      expect(circle.args[1]).toBeCloseTo(y, 10);
      expect(circle.state.transform).toEqual([2, 0, 0, 2, 0, 0]);
      expect(rows.map(p => p.text), kind).toEqual(eligible ? [actor.player_name] : []);
      expect(r.getLabelDegradationCount()).toBe(0);
      evidence.push({ kind, x, y, rows, commands: ctx.calls.filter(c => ['arc', 'fill', 'stroke', 'moveTo', 'lineTo', 'fillText'].includes(c.op)) });
    }
    capture('visibility', evidence);
  });
  it('distinguishes the flywheel inner stroke from the empty interior of an attached pulse', () => {
    const actor = actors(['甲'])[0];
    actor.tuple[1] = -21;
    const { r, ctx, payload } = scene([actor], 4, 4);
    r.setLayers({ dirArrows: false, pulses: true });
    for (const flywheel of [false, true]) {
      const event = { ...(flywheel ? base.events[2] : base.events[0]), t: 0, actor_uid: actor.uid, pos: null };
      r.setPayload({ ...payload, events: [event] });
      ctx.reset();
      r.render(.9);
      // Outer pulse radius 29 encloses the entire board. Only the flywheel's
      // inner stroke (radius 20.3) intersects. An eligible name cannot fit here.
      expect(ctx.ops('arc').some(c => c.args[2] === 29)).toBe(true);
      expect(r.getLabelDegradationCount()).toBe(Number(flywheel));
      expect(paints(ctx)).toHaveLength(0);
    }
  });
  for (const selected of [null, 2]) it(`retains both unnumbered names with five R1 obstacles, selected=${selected}`, () => {
    const list = [at(414, 324, '猎'), at(414, 324, '需要较宽槽位的完整中文名字')];
    list[0].uid = 1;
    list[0].camp = 1;
    const hud = [rect(0, 0, width, 273), rect(0, 328, width, height), rect(0, 273, 120, 328),
      rect(185, 273, 330, 328), rect(545, 273, width, 328)];
    function reviewProbe() {
      const ctx = new Probe();
      ctx.inkMetrics = (text, font) => {
        const size = parseFloat(font), width = [...text].reduce((w, c) => w + size * (c.codePointAt(0)! > 255 ? 1.02 : .55), 0);
        return { width, actualBoundingBoxLeft: width / 2 + size * .09, actualBoundingBoxRight: width / 2 + size * .035,
          actualBoundingBoxAscent: size * .93, actualBoundingBoxDescent: size * .105 };
      };
      return ctx;
    }
    const { ctx, r, payload } = scene(list, width, height, 1, reviewProbe());
    r.setLayers({ dirArrows: false });
    r.setSelectedUid(selected);
    r.render(0, hud);
    const rows = paints(ctx);
    const obstacles = [...sceneObstacles(ctx, 1, [[414, 324]]), ...hud];
    expect(obstacles.length).toBeGreaterThan(hud.length);
    verify(rows, list.map(a => a.player_name), width, height, obstacles);
    const clearance = (a: CssRect, b: CssRect) => Math.max(a.left - b.right, b.left - a.right, a.top - b.bottom, b.top - a.bottom);
    const minimumGap = Math.min(clearance(rows[0].plate, rows[1].plate), ...rows.flatMap(p => obstacles.map(b => clearance(p.plate, b))));
    expect(minimumGap).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(r.getLabelDegradationCount()).toBe(0);
    for (const c of ctx.ops('arc')) expect(c.args.slice(0, 2)).toEqual([414, 324]);
    capture(`crowded-${selected ?? 'none'}`, { selected, hud, rows, minimumGap, overlaps: maxima(rows, obstacles),
      degradation: r.getLabelDegradationCount(), commands: ctx.calls.filter(c => ['arc', 'moveTo', 'lineTo', 'stroke', 'strokeText', 'fillText'].includes(c.op)) });
    // Leaders and caps as well as glyph positions must replay identically.
    function labelCommands(target: Probe) {
      const first = target.calls.findIndex(c => c.op === 'stroke' && c.state.lineCap === 'butt' &&
        c.state.lineWidth === 1 && ['#8fb3e0', '#e0626f'].includes(c.state.strokeStyle));
      return target.calls.slice(first).filter(c => ['moveTo', 'lineTo', 'stroke', 'strokeText', 'fillText'].includes(c.op));
    }
    const commands = labelCommands(ctx);
    for (const operation of ['repeat', 'reverse', 'seek', 'export']) {
      if (operation === 'reverse') r.setPayload({ ...payload, players: [...payload.players].reverse() });
      if (operation === 'seek') r.render(80);
      const target = operation === 'export' ? reviewProbe() : ctx;
      r.setContext(target);
      target.reset();
      r.render(0, hud);
      expect(paints(target), operation).toEqual(rows);
      expect(labelCommands(target), operation).toEqual(commands);
      expect(r.getLabelDegradationCount()).toBe(0);
    }
  });

  it.skipIf(!frames || (!existsSync(fullScenesFile) && !needsReplayEvidence))('checks the complete-scene replay evidence for every frozen time, board size and DPR', async () => {
    if (replayCache && captureBase) {
      const legacy = await import(/* @vite-ignore */ captureBase);
      const checks = fullReplayChecks(replayCache, legacy.TacticalReplayRenderer);
      writeFileSync(fullScenesFile, JSON.stringify(checks, null, 2));
    }
    const checks: ReplayCheck[] = JSON.parse(readFileSync(fullScenesFile, 'utf8'));
    expect(checks).toHaveLength(frames!.length * screens.length * 2);
    for (const c of checks) {
      expect(c.protectedCount).toBeGreaterThanOrEqual(5);
      expect(c.drawn).toBe(c.uids.length);
      expect(c.drawn).toBe(5);
      expect(c.maxTokenError).toBeLessThanOrEqual(.01);
      expect(c.max).toEqual(zero);
      expect(c.degraded).toBe(0);
      expect(c.exportEqual && c.reverseSeekEqual).toBe(true);
      expect(c.minFont).toBeGreaterThanOrEqual(12);
      expect(c.minContrast).toBeGreaterThanOrEqual(4.5);
      expect(c.plateReserved).toBe(0);
      expect(c.inkReserved).toBe(0);
    }
  });
  it.skipIf(!frames || (!existsSync(beforeFile) && !captureBase))('reproduces the old Chinatown intersection and compares all five token centers on each board', async () => {
    // Opt-in evidence capture uses a separate build of the unchanged base revision.
    if (captureBase) {
      const legacy = await import(/* @vite-ignore */ captureBase);
      writeFileSync(beforeFile, JSON.stringify(chinatownSnapshot(legacy.TacticalReplayRenderer), null, 2));
    }
    const before: Snapshot[] = JSON.parse(readFileSync(beforeFile, 'utf8'));
    const after = chinatownSnapshot();
    if (captureAfter) writeFileSync(new URL('after.json', art), JSON.stringify(after, null, 2));
    expect(before.length).toBe(screens.length);
    for (const [i, f] of before.entries()) {
      const a = f.models.find(p => p.text === '汽修二班秦晓萌')!, b = f.models.find(p => p.text === '泠泠莹心')!;
      expect(area(a.plate, b.plate)).toBeGreaterThan(0);
      expect(area(a.ink, b.ink)).toBeGreaterThan(0);
      expect(after[i].max).toEqual(zero);
      expect(after[i].uids.slice().sort()).toEqual(f.uids.slice().sort());
      expect(after[i].centers).toHaveLength(5);
      for (const [j, c] of f.centers.entries()) expect(Math.hypot(c[0] - after[i].centers[j][0], c[1] - after[i].centers[j][1])).toBeLessThanOrEqual(.01);
    }
  });
  for (const pitch of [90, 53]) it(`reverses input and seeks back to identical export redraw operations at pitch ${pitch}`, () => {
    const list = actors(), w = 873.2, h = 780;
    const { r, ctx, payload } = scene(list, w, h);
    r.setSelectedUid(2);
    r.setCamera({ pitchDeg: pitch, yawDeg: 28, zoom: 1.8, centerX: 28, centerZ: -16 });
    const hud = [rect(150, 180, 350, 500)];
    r.render(20, hud);
    const first = paints(ctx);
    verify(first, list.map(p => p.player_name), w, h, hud);
    r.setPayload({ ...payload, players: [...payload.players].reverse() });
    ctx.reset();
    r.render(83, []);
    ctx.reset();
    r.render(20, hud);
    expect(paints(ctx)).toEqual(first);
    const exported = new Probe();
    r.setContext(exported);
    r.render(20, hud);
    expect(exported.calls).toEqual(ctx.calls);
  });
  for (const [sx, sy] of [[1, 1], [799, 1], [1, 599], [799, 599]]) it(`fits an edge cluster at ${sx},${sy}`, () => {
    const list = actors();
    for (const a of list) {
      a.tuple[1] = sx - 400;
      a.tuple[3] = sy - 300;
    }
    const { r, ctx } = scene(list, 800, 600);
    r.render(0);
    verify(paints(ctx), list.map(p => p.player_name), 800, 600, []);
  });
  it('keeps two identical display strings attached to their own numeric UIDs when selection changes', () => {
    const list = actors(['同名', '同名']);
    list[0].tuple[1] = -200;
    list[1].tuple[1] = 200;
    const { ctx, r } = scene(list, 800, 600);
    for (const selected of list) {
      r.setSelectedUid(selected.uid);
      ctx.reset();
      r.render(0);
      const rows = paints(ctx);
      expect(rows).toHaveLength(2);
      const x = r.project(selected.tuple.slice(1, 4) as Vec3).x;
      expect((rows[0].plate.left + rows[0].plate.right) / 2).toBeCloseTo(x, 8);
      expect(r.pickEntityAtScreen(x, 300, 0)?.uid).toBe(selected.uid);
    }
  });
  it('reserves unnamed tokens and excludes missing samples, offscreen players and hidden floors', () => {
    const list = actors(['', '地下', '高层', '缺样本', '太远']);
    list[1].tuple[2] = -85;
    list[2].tuple[2] = 65;
    list[4].tuple[1] = 5000;
    const { r, ctx, payload } = scene(list, 800, 600);
    delete payload.trajectories[list[3].uid];
    r.setLayers({ visibleFloors: { B1: false, '1F': true, '2F': true }, focusFloor: '1F' });
    r.render(0);
    const ring = ctx.ops('arc').find(c => c.args[0] === 400 && c.args[1] === 300)!;
    const radius = Number(ring.args[2]) + 2.5;
    verify(paints(ctx), ['高层'], 800, 600, [rect(400 - radius, 300 - radius, 400 + radius, 300 + radius)]);
    const paint = ctx.ops('fillText').find(c => c.args[0] === '高层')!;
    expect(paint.state.globalAlpha).toBe(1);
    r.setLayers({ labels: false });
    ctx.reset();
    r.render(0);
    expect(paints(ctx)).toEqual([]);
  });
  for (const mode of ['width', 'none', 'partial']) it(`supports ${mode} metrics and eight offset fallback fills`, () => {
    const list = actors(), ctx = new Probe(true);
    Object.defineProperty(ctx, 'strokeText', { value: undefined });
    if (mode === 'none') Object.defineProperty(ctx, 'measureText', { value: undefined });
    if (mode === 'partial') ctx.measureText = (s) => {
      const { width, actualBoundingBoxLeft } = fontMetrics(s, ctx.font, ctx.textAlign, ctx.textBaseline);
      return { width, actualBoundingBoxLeft };
    };
    const { r } = scene(list, 800, 600, 1, ctx);
    r.render(0);
    verify(paints(ctx), list.map(a => a.player_name), 800, 600, []);
    expect(ctx.ops('fillText').filter(c => c.args[0] === 'W')).toHaveLength(9);
  });
  it('withdraws a centered greedy plate and fits both unnumbered names into a thin pocket', () => {
    const list = actors(['第一名字', '第二名字']);
    for (const a of list) a.tuple[1] = -50;
    const { r, ctx } = scene(list, 800, 600);
    const hud = [rect(0, 0, 200, 600), rect(334, 0, 800, 600), rect(0, 0, 800, 276), rect(0, 324, 800, 600)];
    r.render(0, hud);
    verify(paints(ctx), list.map(a => a.player_name), 800, 600, hud);
    expect(r.getLabelDegradationCount()).toBe(0);
  });
  it('keeps four unnumbered names in two independent pockets', () => {
    const list = actors(['第一名字', '第二名字', '第三名字', '第四名字']);
    for (const a of list) a.tuple[1] = -50;
    const { r, ctx } = scene(list, 800, 600);
    const hud = [rect(0, 0, 60, 600), rect(181, 0, 200, 600), rect(334, 0, 800, 600), rect(0, 0, 800, 276), rect(0, 324, 800, 600)];
    r.render(0, hud);
    const rows = paints(ctx);
    verify(rows, list.map(a => a.player_name), 800, 600, hud);
    expect(rows.filter(row => row.plate.right < 181)).toHaveLength(2);
    expect(r.getLabelDegradationCount()).toBe(0);
  });
  it('reserves drawn pulse, ruler boxes, chase/selection rings and heading vertices before painting names', () => {
    const list = actors(), { r, ctx, payload } = scene(list, 800, 600);
    r.setPayload({
      ...payload, events: [
        { ...base.events[0], t: 0, pos: [0, 0, -43] },
        { ...base.events[5], t: 0, target_uid: list[1].uid },
      ]
    });
    r.setLayers({ pulses: true });
    r.setSelectedUid(21);
    r.setRuler({ a: [-240, 0, 25], b: [240, 65, 25] });
    r.render(.6);
    const rows = paints(ctx);
    const reserved: CssRect[] = [];
    const lastPlate = ctx.calls.findLastIndex(c => c.op === 'stroke' && c.state.lineCap === 'round' && c.state.lineWidth >= 12);
    const foreground = ctx.calls.slice(lastPlate + 1);
    const pulse = foreground.find(c => c.op === 'arc' && Number(c.args[2]) > 8)!;
    expect(pulse).toBeDefined();
    const [px, py, pr] = pulse.args as number[];
    reserved.push(rect(px - pr - 1, py - pr - 1, px + pr + 1, py + pr + 1));
    const boxes = foreground.filter(c => c.op === 'fillRect');
    expect(boxes).toHaveLength(2);
    for (const c of boxes) {
      const [x, y, w, h] = c.args as number[];
      reserved.push(rect(x - .5, y - .5, x + w + .5, y + h + .5));
    }
    reserved.push(rect(160, 324, 640, 326));
    // Read every actually painted circle and chevron in the token pass.
    let arc: number[] | undefined, vertices: number[][] = [];
    for (const c of ctx.calls.slice(0, ctx.calls.findIndex(c => c.op === 'stroke' && c.state.lineCap === 'round'))) {
      if (c.op === 'beginPath') {
        arc = undefined;
        vertices = [];
      }
      if (c.op === 'arc') arc = c.args as number[];
      if (c.op === 'moveTo' || c.op === 'lineTo') vertices.push(c.args as number[]);
      if (c.op === 'stroke' && arc) {
        const [x, y, r] = arc, pad = c.state.lineWidth / 2;
        reserved.push(rect(x - r - pad, y - r - pad, x + r + pad, y + r + pad));
      }
      if (c.op === 'stroke' && vertices.length === 3) {
        const xs = vertices.map(v => v[0]), ys = vertices.map(v => v[1]), pad = c.state.lineWidth / 2;
        reserved.push(rect(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad));
      }
    }
    verify(rows, list.map(a => a.player_name), 800, 600, reserved);
  });
  for (const preset of ['clarity', 'original', 'dossier'] as const) {
    it(`paints opaque camp lettering at readable contrast in ${preset}, even on a dimmed floor`, () => {
      const list = actors();
      const { payload, ctx } = scene(list, 800, 600);
      const r = new TacticalReplayRenderer(ctx, { width: 800, height: 600 }, { visualPreset: preset });
      r.setPayload(payload);
      r.setLayers({ focusFloor: '2F' });
      r.render(0);
      const rows = paints(ctx);
      verify(rows, list.map(a => a.player_name), 800, 600, []);
      const names = new Set(list.map(a => a.player_name));
      const outlines = ctx.ops('strokeText').filter(c => names.has(String(c.args[0])));
      expect(outlines).toHaveLength(list.length);
      for (const [i, c] of outlines.entries()) {
        expect(c.state.lineWidth).toBe(3);
        // Same solid color under the partially transparent outline, so compositing
        // at the stroke center gives exactly the measured plate color.
        expect(c.state.strokeStyle).toBe(rows[i].back);
        expect((luminance(rows[i].color) + .05) / (luminance(c.state.strokeStyle) + .05)).toBeGreaterThanOrEqual(4.5);
      }
      for (const c of ctx.ops('fillText').filter(c => names.has(String(c.args[0])))) expect(c.state.globalAlpha).toBe(1);
      const plateOps = ctx.ops('stroke').filter(c => c.state.lineCap === 'round' && c.state.lineWidth >= 12 && c.state.strokeStyle === '#0b0a09');
      expect(plateOps).toHaveLength(list.length);
      for (const c of plateOps) expect(c.state.globalAlpha).toBe(1);
    });
  }
  it('places an unobstructed label exactly two CSS pixels above the outlined token', () => {
    const { r, ctx } = scene(actors(['甲']), 800, 600);
    r.setLayers({ dirArrows: false });
    r.render(0);
    const rows = paints(ctx);
    expect(rows).toHaveLength(1);
    const radius = Number(ctx.ops('arc')[0].args[2]);
    expect(rows[0].plate.bottom).toBeCloseTo(300 - radius - 2.5 - 2, 8);
    expect((rows[0].plate.left + rows[0].plate.right) / 2).toBeCloseTo(400, 8);
  });
  it('uses nearest legal edge slot when local pockets are blocked', () => {
    const list = actors(['一']), { r, ctx } = scene(list, 800, 600);
    const hud = [rect(120, 0, 800, 600)];
    r.render(0, hud);
    const rows = paints(ctx);
    verify(rows, ['一'], 800, 600, hud);
    expect(rows[0].plate.right).toBeCloseTo(118, 8);
  });
  it('wraps an oversize name before using the stable UID, preserving selection in either case', () => {
    for (const [name, expected] of [['测'.repeat(20), ['测'.repeat(10), '测'.repeat(10)]], ['测'.repeat(120), ['#12']]] as const) {
      const { r, ctx } = scene(actors([name]), 220, 200);
      r.render(0);
      expect(ctx.texts()).toEqual(expected);
      expect(r.getLabelDegradationCount()).toBe(1);
      expect(r.pickEntityAtScreen(110, 100, 0)?.uid).toBe(12);
    }
  });
  it('gives the only micro-board slot to a full name before a selected player’s shortened ID', () => {
    const list = actors(['测'.repeat(40), '甲']);
    const { r, ctx, payload } = scene(list, 72, 100);
    r.setLayers({ dirArrows: false });
    r.setSelectedUid(list[0].uid);
    const hud = [rect(0, 26, 72, 100)];
    for (const players of [payload.players, [...payload.players].reverse()]) {
      r.setPayload({ ...payload, players });
      ctx.reset();
      r.render(0, hud);
      verify(paints(ctx), ['甲'], 72, 100, hud);
      expect(r.getLabelDegradationCount()).toBe(1);
      expect(ctx.ops('arc').length).toBeGreaterThanOrEqual(4);
    }
  });
  it('keeps a selectable token when all usable space disappears, and clears degradation on resize', () => {
    const { r, ctx } = scene(actors(['超长名']), 8, 8);
    r.render(0);
    expect(paints(ctx)).toEqual([]);
    expect(r.getLabelDegradationCount()).toBe(1);
    expect(r.pickEntityAtScreen(4, 4, 0)?.kind).toBe('player');
    r.resize({ width: 800, height: 600 });
    ctx.reset();
    r.render(0);
    expect(r.getLabelDegradationCount()).toBe(0);
    expect(paints(ctx)).toHaveLength(1);
  });
  for (const [w, h] of screens) for (const dpr of [1, 2]) {
    it(`places five coincident tokens at ${w}×${h} @${dpr}, including asymmetric ink and duplicate names`, () => {
      const list = actors(), { ctx, r } = scene(list, w, h, dpr);
      r.setSelectedUid(21);
      const hud = Object.freeze([Object.freeze(rect(w / 2 - 80, h / 2 - 110, w / 2 + 80, h / 2 - 32))]);
      r.render(0, hud);
      const rows = paints(ctx, dpr);
      expect(rows.map(p => p.text)).toEqual([list[2], list[3], list[1], list[4], list[0]].map(a => a.player_name));
      verify(rows, list.map(a => a.player_name), w, h, [...hud, rect(w / 2 - 16, h / 2 - 16, w / 2 + 16, h / 2 + 16)]);
      expect(r.getLabelDegradationCount()).toBe(0);
      const selected = ctx.ops('arc').find(c => Number(c.args[2]) > 18)!;
      expect(selected.args.slice(0, 2)).toEqual([w / 2, h / 2]);
      const leaders = ctx.ops('stroke').filter(c => c.state.lineCap === 'butt' && c.state.lineWidth === 1 && ['#8fb3e0', '#e0626f'].includes(c.state.strokeStyle));
      expect(leaders.length).toBeGreaterThan(0);
      expect(ctx.calls.indexOf(leaders.at(-1)!)).toBeLessThan(ctx.calls.findIndex(c => c.op === 'stroke' && c.state.lineCap === 'round'));
      const hit = r.pickEntityAtScreen(w / 2, h / 2, 0);
      expect(hit?.kind).toBe('player');
      for (const row of rows) expect(r.pickEntityAtScreen(...row.baseline as [number, number], 0)?.kind).not.toBe('player');
    });
  }

  // Clean-checkout coverage: render a five-player cluster at each supported board size
  // and pixel density, without needing local screenshots or player data.
  for (const [w, h] of screens) it(`renders a crowded five-player board at ${w}×${h}`, () => {
    for (const dpr of [1, 2]) {
      const list = actors();
      const { r, ctx, payload } = scene(list, w, h, dpr);
      r.render(0);
      const first = paints(ctx, dpr);
      verify(first, list.map(a => a.player_name), w, h, []);
      expect(r.getLabelDegradationCount()).toBe(0);
      r.setPayload({ ...payload, players: [...payload.players].reverse() });
      ctx.reset();
      r.render(0);
      expect(paints(ctx, dpr)).toEqual(first);
    }
  });
  for (const [w, h] of screens) it.skipIf(!frames)(`replays all ten frozen crowded frames at ${w}×${h}`, () => {
    for (const f of frames!) {
      const { r, ctx } = scene(f.players, w, h, 1, new Probe(), f.world);
      r.fitToWorld();
      r.render(f.t);
      const rows = paints(ctx);
      verify(rows, f.players.map(a => a.player_name), w, h, []);
      expect(r.getLabelDegradationCount()).toBe(0);
      if (w === 873.2) for (const a of f.players) {
        const sp = r.project(a.tuple.slice(1, 4) as Vec3);
        expect(Math.hypot(sp.x - a.screen!.x, sp.y - a.screen!.y)).toBeLessThanOrEqual(.01);
      }
      ctx.reset();
      r.render(f.t);
      expect(paints(ctx)).toEqual(rows);
    }
  });
});
