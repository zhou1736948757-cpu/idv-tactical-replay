import { mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import ArchiveView from '@/components/ArchiveView.vue';
import PracticeHistoryDrawer from '@/components/flow/PracticeHistoryDrawer.vue';
import { resetStore, store } from '@/store/app';
import { makeSummary } from './fixtures';

it('keeps neutral outcomes, original names and missing photos readable after filtering', async () => {
  resetStore();
  const match = makeSummary({ result_label: '人机自退', is_bot_match: true });
  match.hunter.player_name = '监管者的长名字'.repeat(12);
  store.matches = [match];
  const view = mount(ArchiveView);
  const card = view.get('.mapcard');
  expect(card.findAll('.wax-seal text').map(t => t.text())).toEqual(['自退', 'Quit']);
  expect(card.text()).toContain('人机自退');
  expect(card.text()).toContain(match.hunter.player_name);
  await card.get('img').trigger('error');
  expect(card.get('figure').text()).toContain('暂无地图照片');
  await view.get('[data-test=f-q]').setValue('无此玩家');
  expect(view.get('#mapGrid').text()).toContain('无符合筛选条件');
  expect(view.get('.count').text()).toContain('0 / 1');
  expect(view.findAll('.folio-corner, .board-flourish, .card-flourish, .foot-corner, .well-corner, .folio-edge-flourish')).toHaveLength(0);
  expect(view.find('.import-stack > .binder-clip').exists()).toBe(true);
  view.unmount();
});

it('restores Stage 01 concept-art controls, laurel crest, folded .zip SVG, bilingual folder CTA, and zero desk-prop clutter (D-026 §4.1)', () => {
  resetStore();
  store.matches = [makeSummary()];
  const view = mount(ArchiveView);

  // Exact 6 direct children of #filters + labeled select controls
  expect(view.findAll('#filters > *')).toHaveLength(6);
  expect(view.findAll('#filters .filter-lbl').map((el) => el.text())).toEqual(['地图', '模式', '结果']);
  expect(view.find('.heading-sub em').text()).toBe('Match Archive — Match Library & Dual-Path Hub');
  expect(view.find('.count em').text()).toBe('1');

  // Card metadata antique icons + brass rivet
  expect(view.findAll('.mapcard .meta-ic')).toHaveLength(5);
  expect(view.find('.mapcard .folio-rivet').exists()).toBe(true);

  // Import Folio laurel crest, folded .zip document SVG, — 或 — divider, bilingual folder CTA
  const dropZone = view.get('#dropZone');
  expect(dropZone.find('header .folio-laurel').exists()).toBe(true);
  expect(dropZone.find('.import-copy-en').text()).toContain('Import a match file');
  expect(dropZone.find('.drop-well svg.zip-doc-icon').exists()).toBe(true);
  expect(dropZone.find('.drop-well svg.zip-doc-icon text').text()).toBe('.zip');
  expect(dropZone.find('.import-or').text()).toBe('或');
  const pickBtn = dropZone.get('[data-test="pick-btn"]');
  expect(pickBtn.find('svg.pick-folder-icon').exists()).toBe(true);
  expect(pickBtn.text()).toContain('选择文件');
  expect(pickBtn.text()).toContain('Select .zip File');

  // Zero clutter or removed desk props
  expect(view.findAll('.desk-photo, .desk-watch, .desk-nib, .photo-pin, .manor-photo')).toHaveLength(0);
  expect(view.findAll('.folio-corner, .board-flourish, .card-flourish, .foot-corner, .well-corner, .folio-edge-flourish')).toHaveLength(0);
  view.unmount();

  // PracticeHistoryDrawer parchment ledger header
  const drawer = mount(PracticeHistoryDrawer);
  expect(drawer.find('[data-test="practice-history"].paper-folio').exists()).toBe(true);
  expect(drawer.find('.history-head em').text()).toBe('Blind Practice Ledger');
  drawer.unmount();
});

it.each([
  ['监管胜', 9, '胜利', 'Win', 'win'],
  ['监管负', 7, '失败', 'Lose', 'lose'],
  ['平局', 9, '平局', 'Tie', 'neutral'],
  ['自退/未分胜负', 7, '自退', 'Quit', 'neutral'],
  ['未知(8)', 8, '未知', 'N/A', 'neutral'],
  ['人机结束', 2, '未知', 'N/A', 'neutral'],
  ['', 7, '胜利', 'Win', 'win'],
  ['', 9, '失败', 'Lose', 'lose'],
  ['', 3, '自退', 'Quit', 'neutral'],
  ['', 8, '未知', 'N/A', 'neutral'],
] as const)('uses the public outcome %s before code %i', (label, code, zh, en, kind) => {
  resetStore();
  store.matches = [makeSummary({ result_label: label, result_code: code })];
  const view = mount(ArchiveView);
  expect(view.findAll('.wax-seal text').map(t => t.text())).toEqual([zh, en]);
  const result = view.get('.card-copy strong');
  expect(result.classes()).toContain(kind);
  if (label) expect(result.text()).toBe(label);
  view.unmount();
});
