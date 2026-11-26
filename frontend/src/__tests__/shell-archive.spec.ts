import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from '@/App.vue';
import ArchiveView from '@/components/ArchiveView.vue';
import ManorOrnaments from '@/components/tactical/ManorOrnaments.vue';
import ManorMapFrame from '@/components/tactical/ManorMapFrame.vue';
import manorCss from '@/styles/manor.css?raw';
import { resetStore, store } from '@/store/app';
import { getActiveMapId, setActiveMapId } from '@/tactical';
import { installFetch, jsonResponse, makeAnalytics, makeReplay, makeSummary, MATCHES } from './fixtures';
import { installCanvasStub } from './canvas-stub';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pilViewsCss = fs.readFileSync(path.resolve(__dirname, '../styles/pil-views.css'), 'utf8');
const dossierThemeCss = fs.readFileSync(path.resolve(__dirname, '../styles/dossier-theme.css'), 'utf8');
const dossierViewsCss = fs.readFileSync(path.resolve(__dirname, '../styles/dossier-views.css'), 'utf8');

beforeEach(() => {
  localStorage.clear();
  setActiveMapId(0);
  window.location.hash = '';
  resetStore();
});
afterEach(() => {
  window.location.hash = '';
  vi.unstubAllGlobals();
});

describe('Manor Dossier shell', () => {
  it('ships the exact template.html design tokens and primitives', () => {
    for (const token of [
      '--bg:#111722', '--bg3:#1a1714', '--line:#3a332a', '--line2:#5c4e3a', '--text:#ddd3bd', '--muted:#9a8f7a',
      '--dim:#655c4e', '--gold:#c9a25f', '--gold-d:#8e7a4a', '--red:#8e2f3c', '--red-l:#b04a58', '--blue:#6f8fb8', '--cut:10px',
    ]) {
      expect(manorCss).toContain(token);
    }
    expect(manorCss).toContain('"Noto Serif SC"');
    expect(manorCss).toContain('"Ma Shan Zheng"');
    expect(manorCss).toContain('.cut{clip-path:polygon(var(--cut) 0,100% 0,100% calc(100% - var(--cut)),calc(100% - var(--cut)) 100%,0 100%,0 var(--cut))}');
    expect(manorCss).toContain('.fr::before{content:"";position:absolute;inset:0;border:1px solid var(--line2)');
    expect(manorCss).toContain('#fx{position:fixed;inset:0;pointer-events:none;background:url(/assets/bg.jpg) center/cover;background-color:#1a2332;background-blend-mode:soft-light}');
    expect(manorCss).toContain('grid-template-rows:var(--bar-height)');
    expect(manorCss).not.toContain('grid-template-columns:84px');
    expect(manorCss).toContain('box-shadow:0 0 0 2px var(--red),0 0 0 4px rgba(11,10,9,.9),0 0 0 5px var(--gold-d)');
    expect(manorCss).toContain('box-shadow:0 0 0 2px var(--blue)');
  });

  it('renders #bar and 5-step horizontal navigation with 01/02/04/05 unlocked and 03 locked until a match is chosen', async () => {
    const { fn } = installFetch({ 'GET /api/matches': () => jsonResponse({ matches: MATCHES }) });
    vi.stubGlobal('fetch', fn);
    installCanvasStub();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(w.find('#bar .ttl .archive-brand').text()).toBe('庄园战术复盘档案Oletus Manor · Dossiers');
    expect(w.find('#bar .identity').text()).toBe('第五人格VIDENTITY V');
    const steps = w.findAll('#bar #steps button[data-step]');
    expect(steps.map((b) => b.attributes('data-step'))).toEqual(['1', '2', '3', '4', '5']);
    expect(steps.map((b) => b.text().replace(/\s+/g, ''))).toEqual([
      '档案库MatchArchive',
      '战术沙盘TacticalSandbox',
      '对比分析MatchReview',
      '区域选点SpawnRegion',
      '密码机推演CipherDeduction',
    ]);
    expect(steps[0]!.classes()).toContain('on');
    expect(steps[1]!.classes()).not.toContain('lock');
    expect(steps[2]!.classes()).toContain('lock');
    expect(steps[3]!.classes()).not.toContain('lock');
    expect(steps[4]!.classes()).not.toContain('lock');
    expect(w.findAll('.mapcard')).toHaveLength(3);
    expect(w.find('#backBtn').attributes('disabled')).toBeDefined();

    // 03 stays locked without a match
    await steps[2]!.trigger('click');
    expect(store.step).toBe(1);

    // 04 and 05 and 02 open directly without a match
    await steps[3]!.trigger('click');
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(store.step).toBe(4);
    expect(w.find('#s4 #regionView').exists()).toBe(true);
    expect(w.find('#ctx').text()).toBe('军工厂 · 战术演练');

    await steps[4]!.trigger('click');
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(store.step).toBe(5);
    expect(w.find('#s5 #deduceView').exists()).toBe(true);
    expect(w.find('#ctx').text()).toBe('军工厂 · 战术演练');

    await steps[1]!.trigger('click');
    expect(store.step).toBe(2);
    expect(w.find('#s2').exists()).toBe(true);
    expect(w.find('#ctx').text()).toBe('军工厂 · 战术演练');

    await w.find('[data-test="flow-settings"]').trigger('click');
    expect(w.find('#uploadBtn').exists()).toBe(true);
    expect(w.find('#noticeBtn').exists()).toBe(true);
    await w.find('#noticeBtn').trigger('click');
    expect(w.find('#notice').classes()).toContain('show');
    // Bottom-left antique brass desk compass renders without <img> props or text nodes
    const dc = w.find('[data-test="desk-compass"]');
    expect(dc.exists()).toBe(true);
    expect(dc.attributes('aria-hidden')).toBe('true');
    expect(w.findAll('.desk-still > img')).toHaveLength(0);
    expect(dc.findAll('text')).toHaveLength(0);
    w.unmount();
  });

  it('opens a match from #m=<id>&s=<step>&t=<sec>, syncs active PIL map and fills #ctx', async () => {
    const id = MATCHES[0]!.match_id;
    const { fn } = installFetch({
      'GET /api/matches': () => jsonResponse({ matches: MATCHES }),
      [`GET /api/matches/${id}/replay`]: () => jsonResponse(makeReplay()),
      [`GET /api/matches/${id}/analytics`]: () => jsonResponse(makeAnalytics()),
    });
    vi.stubGlobal('fetch', fn);
    installCanvasStub();
    window.location.hash = `#m=${id}&s=3&t=42`;
    const w = mount(App);
    await flushPromises();
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(store.step).toBe(3);
    expect(store.selectedId).toBe(id);
    expect(store.t).toBe(42);
    expect(getActiveMapId()).toBe(7); // 唐人街 synced
    expect(w.find('#ctx').text()).toBe('唐人街 · 排位 · 2026-11-23 20:41:41');
    expect(w.find('[data-phase="opening"]').exists()).toBe(true);
    await w.find('#backBtn').trigger('click');
    expect(store.step).toBe(2);
    expect(window.location.hash).toBe(`#m=${id}&s=2`);
    w.unmount();
  });

  it('supports standalone #s=<2|4|5>&map=<0..8> deep links', async () => {
    const { fn } = installFetch({ 'GET /api/matches': () => jsonResponse({ matches: MATCHES }) });
    vi.stubGlobal('fetch', fn);
    installCanvasStub();
    window.location.hash = '#s=4&map=6';
    const w = mount(App);
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(store.step).toBe(4);
    expect(getActiveMapId()).toBe(6);
    expect(w.find('#ctx').text()).toBe('永眠镇 · 战术演练');
    expect(w.findAll('#s4 [data-zone-idx]')).toHaveLength(10);
    w.unmount();

    resetStore();
    window.location.hash = '#s=5&map=2';
    const w2 = mount(App);
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(store.step).toBe(5);
    expect(getActiveMapId()).toBe(2);
    expect(w2.find('#ctx').text()).toBe('红教堂 · 战术演练');
    expect(w2.find('#s5 #deduceView').exists()).toBe(true);
    w2.unmount();
  });

  it('navigates back across unlocked steps (5 -> 4 -> 2 -> 1 without match) and keeps pil-views.css local-only', async () => {
    expect(pilViewsCss).not.toMatch(/https?:\/\//i);
    expect(pilViewsCss).not.toContain('#steps');

    const { fn } = installFetch({ 'GET /api/matches': () => jsonResponse({ matches: MATCHES }) });
    vi.stubGlobal('fetch', fn);
    installCanvasStub();
    const w = mount(App);
    await flushPromises();

    // Without a match: 5 -> 4 -> 2 (skips locked 3) -> 1
    await w.find('#steps button[data-step="5"]').trigger('click');
    expect(store.step).toBe(5);
    await w.find('#backBtn').trigger('click');
    expect(store.step).toBe(4);
    await w.find('#backBtn').trigger('click');
    expect(store.step).toBe(2);
    await w.find('#backBtn').trigger('click');
    expect(store.step).toBe(1);
    w.unmount();
  });

  it('declutters desk props & folio corners across 01..05 while keeping .bookmark and idv-map-fit-reset intact (D-024 §2)', async () => {
    expect(dossierThemeCss).toContain('--folio-foot: 0px;');
    expect(dossierViewsCss).not.toMatch(/\.folio-stack::(?:before|after)/);
    expect(dossierViewsCss).not.toMatch(/:is\(#stage2,\s*\.pil-stage\):not\(\.folio-closed\)::(?:before|after)/);
    expect(dossierViewsCss).not.toMatch(/\.(?:desk-photo|desk-watch|desk-nib|photo-pin)\b/);

    const id = MATCHES[0]!.match_id;
    const { fn } = installFetch({
      'GET /api/matches': () => jsonResponse({ matches: MATCHES }),
      [`GET /api/matches/${id}/replay`]: () => jsonResponse(makeReplay()),
      [`GET /api/matches/${id}/analytics`]: () => jsonResponse(makeAnalytics()),
    });
    vi.stubGlobal('fetch', fn);
    installCanvasStub();
    const w = mount(App, { attachTo: document.body });
    await flushPromises();

    const clutterSel = '.folio-corner, .folio-edge-flourish, .card-flourish, .foot-corner, .well-corner, .plate-corner, .phase-corner, .board-flourish';
    const removedAssets = /desk-(?:fountain-pen|pocket-watch|vintage-postcard)\.png/i;

    const assertDecluttered = (expectedBookmark: string) => {
      expect(w.findAll('.desk-still > img')).toHaveLength(0);
      expect(w.findAll('.photo-pin')).toHaveLength(0);
      expect(w.findAll('.manor-photo')).toHaveLength(0);
      const leakedImgs = w.findAll('img').filter((img) => removedAssets.test(img.attributes('src') ?? ''));
      expect(leakedImgs).toHaveLength(0);
      expect(w.find('.desk-still > .bookmark').exists()).toBe(true);
      expect(w.find('.desk-still > .bookmark .bookmark-plate').exists()).toBe(true);
      expect(w.find('.desk-still > .bookmark .bookmark-rig').exists()).toBe(true);
      expect(w.find('.desk-still > .bookmark .bookmark-ink').text()).toBe(expectedBookmark);
      expect(w.findAll(clutterSel)).toHaveLength(0);
    };

    // 01 Archive
    assertDecluttered('档案库');

    // Open real match -> 02 Sandbox (replay DossierPanel)
    await w.find(`[data-match="${id}"] [data-test="entry-replay"]`).trigger('click');
    await flushPromises();
    expect(store.step).toBe(2);
    assertDecluttered('唐人街');

    // Verify idv-map-fit-reset dispatch on reset button & step navigation
    let fitResets = 0;
    const onFitReset = () => { fitResets += 1; };
    window.addEventListener('idv-map-fit-reset', onFitReset);
    try {
      await w.find('[data-test="btn-reset"]').trigger('click');
      await flushPromises();
      expect(fitResets).toBeGreaterThanOrEqual(1);

      const beforeStep = fitResets;
      await w.find('#steps button[data-step="3"]').trigger('click');
      await flushPromises();
      expect(store.step).toBe(3);
      expect(fitResets).toBeGreaterThan(beforeStep);
      assertDecluttered('对比分析');

      await w.find('#steps button[data-step="4"]').trigger('click');
      await flushPromises();
      expect(store.step).toBe(4);
      assertDecluttered('唐人街');

      await w.find('#steps button[data-step="5"]').trigger('click');
      await flushPromises();
      expect(store.step).toBe(5);
      assertDecluttered('唐人街');
    } finally {
      window.removeEventListener('idv-map-fit-reset', onFitReset);
    }
    w.unmount();
  });

  it('renders Phase 6 laurel stage crests, map mitre brackets, and zero .folio-corner clutter (D-026 §3)', () => {
    const corner = mount(ManorOrnaments, { props: { kind: 'corner' } });
    expect(corner.find('svg').exists()).toBe(false);
    corner.unmount();

    const s04 = mount(ManorOrnaments, { props: { kind: 'stage', stage: '04' } });
    expect(s04.find('svg.folio-stage').exists()).toBe(true);
    expect(s04.text()).toContain('Stage 04');
    expect(s04.text()).toContain('IV');
    expect(s04.findAll('ellipse').length).toBeGreaterThanOrEqual(8);
    s04.unmount();

    const s05 = mount(ManorOrnaments, { props: { kind: 'stage', stage: '05' } });
    expect(s05.find('svg.folio-stage').exists()).toBe(true);
    expect(s05.text()).toContain('05');
    expect(s05.text()).toContain('Stage');
    s05.unmount();

    const laurel = mount(ManorOrnaments, { props: { kind: 'laurel' } });
    expect(laurel.find('svg.folio-laurel').attributes('viewBox')).toBe('0 0 48 48');
    expect(laurel.text().trim()).toBe('V');
    laurel.unmount();

    const mapFrame = mount(ManorMapFrame, { props: { pxPerMeter: 4, northAngle: 0 } });
    expect(mapFrame.findAll('.map-corner-mitre')).toHaveLength(4);
    expect(mapFrame.findAll('.folio-corner')).toHaveLength(0);
    expect(mapFrame.find('.compass').exists()).toBe(true);
    expect(mapFrame.findAll('.compass line').length).toBeGreaterThanOrEqual(16);
    mapFrame.unmount();
  });
});

describe('01 档案库', () => {
  it('renders dossier cards with real map grid images and filters by map/mode/result/search', async () => {
    const { fn } = installFetch({ 'GET /api/matches': () => jsonResponse({ matches: MATCHES }) });
    vi.stubGlobal('fetch', fn);
    store.matches = MATCHES;
    const w = mount(ArchiveView);
    const cards = w.findAll('.mapcard');
    expect(cards).toHaveLength(3);
    expect(cards[0]!.find('img').attributes('src')).toBe(encodeURI('/assets/maps/唐人街_grid.jpg'));
    expect(cards[0]!.text()).toContain('PID #126');
    expect(cards[0]!.text()).toContain('排位');
    expect(cards[0]!.text()).toContain('分享录像');
    expect(cards[0]!.text()).toContain('2026-11-23 20:41:41');
    expect(cards[2]!.text()).toContain('上传导入');

    // broken image is hidden gracefully
    await cards[0]!.find('img').trigger('error');
    expect(w.findAll('.mapcard')[0]!.find('img').exists()).toBe(false);

    await w.find('[data-test="f-map"]').setValue('军工厂');
    expect(w.findAll('.mapcard')).toHaveLength(1);
    await w.find('[data-test="f-map"]').setValue('all');
    await w.find('[data-test="f-mode"]').setValue('custom');
    expect(w.findAll('.mapcard').map((c) => c.attributes('data-match'))).toEqual(['6b0014eb54fd12fd2b16667d']);
    await w.find('[data-test="f-mode"]').setValue('all');
    await w.find('[data-test="f-result"]').setValue('hunter_win');
    expect(w.findAll('.mapcard')).toHaveLength(1);
    await w.find('[data-test="f-result"]').setValue('hunter_loss');
    expect(w.findAll('.mapcard')).toHaveLength(2);
    await w.find('[data-test="f-result"]').setValue('all');
    await w.find('[data-test="f-q"]').setValue('红夫人');
    expect(w.findAll('.mapcard').map((c) => c.attributes('data-match'))).toEqual(['6b04349384b8897181051f2a']);
  });

  it('uploads a .zip via POST /api/replays/upload, refreshes the list and opens the new match on click', async () => {
    const uploaded = makeSummary({ match_id: 'ffffffffffffffffffffffff', source: 'uploaded', map_name: '永眠镇', map_asset_url: '/assets/maps/永眠镇_grid.jpg' });
    let listCalls = 0;
    const { fn, calls } = installFetch({
      'GET /api/matches': () => {
        listCalls++;
        return jsonResponse({ matches: listCalls > 1 ? [uploaded, ...MATCHES] : MATCHES });
      },
      'POST /api/replays/upload': () => jsonResponse({ uploaded_count: 1, match_ids: [uploaded.match_id], matches: [uploaded] }),
      [`GET /api/matches/${uploaded.match_id}/replay`]: () => jsonResponse(makeReplay({ match: uploaded })),
      [`GET /api/matches/${uploaded.match_id}/analytics`]: () => jsonResponse(makeAnalytics({ match_id: uploaded.match_id })),
    });
    vi.stubGlobal('fetch', fn);
    store.matches = MATCHES;
    listCalls = 1;
    const w = mount(ArchiveView);
    const input = w.find('[data-test="file-input"]');

    // non-zip -> local Chinese error, no request
    Object.defineProperty(input.element, 'files', { value: [new File(['x'], 'a.txt')], configurable: true });
    await input.trigger('change');
    expect(w.find('[data-test="upload-err"]').text()).toContain('仅支持 .zip');
    expect(calls.filter((c) => c.url.includes('upload'))).toHaveLength(0);

    Object.defineProperty(input.element, 'files', { value: [new File([new Uint8Array([0x50, 0x4b])], 'new.zip')], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(calls.some((c) => c.url === '/api/replays/upload' && c.init?.method === 'POST')).toBe(true);
    expect(w.find('[data-test="upload-msg"]').text()).toContain('已导入 1 场对局');
    expect(store.matches[0]!.match_id).toBe(uploaded.match_id);
    const newCard = w.find(`[data-match="${uploaded.match_id}"]`);
    expect(newCard.text()).toContain('新');
    expect(newCard.text()).toContain('上传导入');

    await w.find('[data-test="open-uploaded"]').trigger('click');
    await flushPromises();
    expect(store.step).toBe(2);
    expect(store.selectedId).toBe(uploaded.match_id);
    expect(store.replay?.match.map_name).toBe('永眠镇');
    expect(store.analytics?.match_id).toBe(uploaded.match_id);
    expect(getActiveMapId()).toBe(6);
  });

  it('shows upload server errors in Chinese', async () => {
    const { fn } = installFetch({ 'POST /api/replays/upload': () => jsonResponse({ detail: 'unsafe pickle global' }, 422) });
    vi.stubGlobal('fetch', fn);
    const w = mount(ArchiveView);
    const input = w.find('[data-test="file-input"]');
    Object.defineProperty(input.element, 'files', { value: [new File(['PK'], 'bad.zip')], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(w.find('[data-test="upload-err"]').text()).toContain('导入失败');
    expect(w.find('[data-test="upload-err"]').text()).toContain('unsafe pickle global');
  });
});
