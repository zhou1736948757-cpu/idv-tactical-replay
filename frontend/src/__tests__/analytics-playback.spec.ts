import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AnalyticsView from '@/components/AnalyticsView.vue';
import { focusEvent, openMatch, pause, play, resetStore, seek, setSpeed, stepBy, store } from '@/store/app';
import { installFetch, jsonResponse, makeAnalytics, makeReplay, MATCHES } from './fixtures';

beforeEach(() => {
  resetStore();
});
afterEach(() => {
  pause();
  vi.unstubAllGlobals();
});

describe('playback store', () => {
  it('seeks with clamping, steps ±5s, validates speed and plays/pauses on an animation loop', async () => {
    store.replay = makeReplay();
    seek(500);
    expect(store.t).toBe(120);
    seek(-3);
    expect(store.t).toBe(0);
    stepBy(5);
    stepBy(5);
    expect(store.t).toBe(10);
    setSpeed(3);
    expect(store.speed).toBe(1);
    setSpeed(2);
    expect(store.speed).toBe(2);

    play();
    expect(store.playing).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(store.t).toBeGreaterThan(10);
    pause();
    expect(store.playing).toBe(false);

    seek(119.95);
    setSpeed(4);
    play();
    await new Promise((r) => setTimeout(r, 150));
    expect(store.t).toBe(120);
    expect(store.playing).toBe(false);

    focusEvent({ t: 33, pos: [1, 2, 3], actor_uid: 1000008 });
    expect(store.t).toBe(33);
    expect(store.focus).toMatchObject({ t: 33, pos: [1, 2, 3], uid: 1000008 });
  });

  it('openMatch loads replay + analytics and ignores stale responses', async () => {
    const { fn } = installFetch({
      [`GET /api/matches/${MATCHES[0]!.match_id}/replay`]: () => jsonResponse(makeReplay()),
      [`GET /api/matches/${MATCHES[0]!.match_id}/analytics`]: () => jsonResponse(makeAnalytics()),
    });
    vi.stubGlobal('fetch', fn);
    await openMatch(MATCHES[0]!.match_id, { step: 2, t: 42 });
    expect(store.step).toBe(2);
    expect(store.replay?.schema_version).toBe('1.0');
    expect(store.analytics?.phases).toHaveLength(3);
    expect(store.t).toBe(42);

    await openMatch('000000000000000000000000');
    expect(store.replay).toBeNull();
    expect(store.replayError).toContain('404');
  });
});

describe('03 对比分析 (AnalyticsView)', () => {
  function setup() {
    const { fn } = installFetch({
      [`GET /api/matches/${MATCHES[1]!.match_id}/analytics`]: () =>
        jsonResponse(makeAnalytics({ match_id: MATCHES[1]!.match_id, hunter_metrics: { ...makeAnalytics().hunter_metrics, first_chair_t: 95 } })),
      [`GET /api/matches/${MATCHES[2]!.match_id}/analytics`]: () => jsonResponse(makeAnalytics({ match_id: MATCHES[2]!.match_id })),
    });
    vi.stubGlobal('fetch', fn);
    store.matches = MATCHES;
    store.selectedId = MATCHES[0]!.match_id;
    store.replay = makeReplay();
    store.analytics = makeAnalytics();
    store.analyticsById[MATCHES[0]!.match_id] = store.analytics;
    store.step = 3;
  }

  it('renders phase cards, hunter tempo KPIs (null-safe), survivor opt=4/opt=3 table, chart and gantt', async () => {
    setup();
    const w = mount(AnalyticsView);
    expect(w.find('#analysis.paper-folio').exists()).toBe(true);
    await flushPromises();
    const phases = w.findAll('.phase');
    expect(phases.map((p) => p.attributes('data-phase'))).toEqual(['opening', 'midgame', 'endgame']);
    expect(phases[0]!.text()).toContain('开局博弈');
    expect(phases[2]!.text()).toContain('开门战/残局');

    const kpi = w.find('[data-test="hunter-kpis"]').text();
    for (const label of ['首追', '首刀', '首倒', '首挂', '合并追击时长', '原始 et=47', '换追次数', '踩板']) expect(kpi).toContain(label);
    expect(kpi).toContain('42.3s');
    expect(kpi).toContain('50.1s');
    expect(kpi).toContain('PID #126');

    const table = w.find('[data-test="survivor-table"]');
    expect(table.text()).toContain('摸椅 opt=4');
    expect(table.text()).toContain('救下 opt=3');
    const row = table.find('tr[data-uid="1000008"]').findAll('td');
    expect(row[2]!.text()).toContain('143.6%');
    expect(row[2]!.find('.pbar i').attributes('style')).toContain('width: 100%');
    expect(row[5]!.text()).toBe('3');
    expect(row[6]!.text()).toContain('1');
    expect(row[9]!.text()).toBe('6.0u');

    expect(w.find('[data-test="distance-chart"] path').attributes('d')).toMatch(/^M/);
    expect(w.findAll('[data-test="gantt"] .seg')).toHaveLength(1);
  });

  it('restores Phase 6 medallions, script watermark, exact 12 SVG axis nodes, and parchment ledger cards without clutter (D-026 §4.3)', async () => {
    setup();
    const w = mount(AnalyticsView);
    await flushPromises();

    // Calligraphic English map script watermark & subtitle
    expect(w.find('.header-map-script').text()).toBe('Chinatown');
    expect(w.find('.analytics-heading em').text()).toContain('Chinatown');

    // 3 phase circular bronze medallion icons & 4 overview KPI SVG icons
    expect(w.findAll('.phase .phase-medallion svg.phase-icon')).toHaveLength(3);
    expect(w.findAll('.overview-values svg')).toHaveLength(4);

    // Exact 12 SVG text axis nodes at font-size="13" across the entire #analysis view
    const svgTexts = w.findAll('#analysis svg text');
    expect(svgTexts).toHaveLength(12);
    expect(svgTexts.every((el) => el.attributes('font-size') === '13')).toBe(true);
    expect(w.findAll('[data-test="chart-jumps"] button')).toHaveLength(4);

    // Below-the-fold cards use Manor Parchment Ledger styling (zero legacy .dark mud)
    expect(w.findAll('#analysis .dark')).toHaveLength(0);
    expect(w.find('[data-test="hunter-kpis"]').classes()).toContain('ledger-card');
    expect(w.find('[data-test="survivor-table"]').classes()).toContain('ledger-card');
    expect(w.find('[data-test="matrix"]').classes()).toContain('ledger-card');

    // Zero clutter or removed desk props
    expect(w.findAll('.folio-corner, .plate-corner, .phase-corner, .board-flourish, .desk-photo, .desk-watch, .desk-nib, .photo-pin')).toHaveLength(0);
    w.unmount();
  });

  it('preserves raw contribution over 100% and leaves an empty roster unknown', async () => {
    setup();
    const rows = store.analytics!.survivor_metrics;
    rows[0]!.cipher_contrib_pct = 143.64;
    const w = mount(AnalyticsView);
    expect(w.get('.contributor span').text()).toBe('143.64%');
    rows.splice(0);
    await flushPromises();
    expect(w.get('.overview-values p:nth-child(2) b').text()).toBe('—');
    w.unmount();
  });

  it('normalizes known contributions within the current roster and distinguishes zero from missing', async () => {
    setup();
    const rows = store.analytics!.survivor_metrics;
    const sample = rows[0]!;
    rows.splice(0, rows.length, ...[143.64, 284.32, 72.04, 2.50].map((pct, uid) => ({
      ...sample, uid, cipher_contrib_pct: pct,
    })));
    const w = mount(AnalyticsView);
    const shares = () => w.findAll('.contributor .share').map(el => el.text());
    const widths = () => w.findAll('.contributor rect:last-child').map(el => parseFloat(el.attributes('width') ?? ''));
    expect(w.get('.contribution-key').text()).toContain('数值：个人破译贡献　条长：占全队');
    expect(shares()[1]).toBe('占全队 56.58%');
    expect(widths()[1]).toBeCloseTo(56.58, 2);
    // Historical payloads can omit the numeric field declared by today's schema.
    Reflect.deleteProperty(rows[0]!, 'cipher_contrib_pct');
    rows[1]!.cipher_contrib_pct = 0;
    await flushPromises();
    expect(w.get('.overview-values p:nth-child(2) b').text()).toBe('—');
    expect(shares().slice(0, 2)).toEqual(['占全队 —', '占全队 0%']);
    expect(widths().slice(0, 2)).toEqual([0, 0]);
    expect(widths()[2]).toBeCloseTo(100 * 72.04 / 74.54);
    rows.forEach(row => { row.cipher_contrib_pct = 0; });
    await flushPromises();
    expect(shares()).toEqual(Array(4).fill('占全队 —'));
    expect(widths()).toEqual([0, 0, 0, 0]);
    store.analytics = makeAnalytics();
    await flushPromises();
    expect(widths()).toEqual([100]);
    w.unmount();
  });

  it('click-to-jump from phases / gantt into 02 战术沙盘 and multi-match matrix compares all matches', async () => {
    setup();
    const w = mount(AnalyticsView);
    await flushPromises();
    await w.find('[data-phase="midgame"]').trigger('click');
    expect(store.step).toBe(2);
    expect(store.t).toBe(60);

    store.step = 3;
    await w.find('[data-test="gantt"] .seg').trigger('click');
    expect(store.step).toBe(2);
    expect(store.t).toBe(5);
    expect(store.focus?.uid).toBe(1000008);

    const rows = w.findAll('[data-test="matrix"] tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.classes()).toContain('cur');
    expect(rows[1]!.text()).toContain('01:35'); // first chair from loaded analytics
    expect(rows[1]!.text()).toContain('监管负');
    await w.find('[data-test="matrix"] select').setValue('军工厂');
    expect(w.findAll('[data-test="matrix"] tbody tr')).toHaveLength(1);
  });
});
