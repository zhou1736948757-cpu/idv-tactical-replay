/**
 * Formatting + data-honesty helpers shared by every view.
 */
import type { FloorId, MatchSummary, ReplayPlayer, ReplayTimelineEvent } from '@idv/replay-renderer';
import { withBaseUrl } from './assetUrl';

// ------------------------------------------------------------------ assets

export const BG_URL = withBaseUrl('/assets/bg.jpg');
export const SEAL_URL = withBaseUrl('/assets/seal.jpg');

/** Hunter portraits shipped by zhou1736948757-cpu/notes (assets/hunters/*.png). */
export const HUNTER_PORTRAITS: readonly string[] = Object.freeze([
  '26号守卫', '使徒', '博士', '厂长', '台球手', '喧嚣', '噩梦', '女王蜂', '孽蜥',
  '守夜人', '宿伞之魂', '小丑', '小提琴家', '心兽', '愚人金', '摄影师', '时空之影', '杂货商',
  '杰克', '梦之女巫', '歌剧演员', '渔女', '爱哭鬼', '牙医', '疯眼', '破轮', '红夫人',
  '红蝶', '蜘蛛', '蜡像师', '记录员', '跛脚羊', '隐士', '雕刻家', '鹿头', '黄衣之主',
]);

export function mapGridUrl(mapName: string | null | undefined): string | null {
  if (!mapName) return null;
  return withBaseUrl(encodeURI(`/assets/maps/${mapName}_grid.jpg`));
}

/** Prefer the server-provided asset url, otherwise derive from map_name. */
export function matchMapUrl(m: Pick<MatchSummary, 'map_asset_url' | 'map_name'>): string | null {
  if (m.map_asset_url) {
    try {
      return withBaseUrl(encodeURI(decodeURI(m.map_asset_url)));
    } catch {
      return withBaseUrl(encodeURI(m.map_asset_url));
    }
  }
  return mapGridUrl(m.map_name);
}

export function hunterPortraitUrl(name: string | null | undefined): string {
  if (!name) return SEAL_URL;
  return withBaseUrl(encodeURI(`/assets/hunters/${name}.png`));
}

// ------------------------------------------------------------------ labels

/** Character names for pids are not verified — display raw pid honestly. */
export function pidLabel(pid: number | null | undefined): string {
  return pid === null || pid === undefined ? 'PID #?' : `PID #${pid}`;
}

/**
 * Talent label. REF_SURVIVOR_GENIUS_NAMES applies ONLY to survivors (camp 2);
 * hunter (camp 1) talents always show their raw id.
 */
export function talentLabel(camp: 1 | 2, talent: { talent_id: number; name: string | null; level?: number }): string {
  if (camp === 1) return `监管天赋 #${talent.talent_id}`;
  return talent.name ? talent.name : `天赋 #${talent.talent_id}`;
}

export function campLabel(camp: 1 | 2): string {
  return camp === 1 ? '监管者' : '求生者';
}

export const FEAR_STATE_ZH: Readonly<Record<number, string>> = Object.freeze({
  0: '健康',
  1: '受伤',
  2: '倒地',
  3: '上椅',
  4: '淘汰',
  5: '逃脱',
});

export function fearStateLabel(state: number | null | undefined): string {
  if (state === null || state === undefined) return '—';
  return FEAR_STATE_ZH[state] ?? `状态 ${state}`;
}

export type ModeKey = 'all' | 'rank' | 'match' | 'custom';
export const MODE_OPTIONS: ReadonlyArray<{ key: ModeKey; label: string }> = [
  { key: 'all', label: '全部模式' },
  { key: 'rank', label: '排位' },
  { key: 'match', label: '匹配' },
  { key: 'custom', label: '自定义' },
];

export function modeKey(modeId: number): ModeKey {
  if (modeId === 2) return 'rank';
  if (modeId === 1) return 'match';
  if (modeId === 4) return 'custom';
  return 'custom';
}

export function modeShort(m: Pick<MatchSummary, 'mode_id' | 'mode_name'>): string {
  const k = modeKey(m.mode_id);
  if (k === 'rank') return '排位';
  if (k === 'match') return '匹配';
  return m.mode_name ? m.mode_name.replace(/模式$/, '') : '自定义';
}

export type ResultKey = 'all' | 'hunter_win' | 'hunter_loss';
export const RESULT_OPTIONS: ReadonlyArray<{ key: ResultKey; label: string }> = [
  { key: 'all', label: '全部结果' },
  { key: 'hunter_win', label: '监管胜' },
  { key: 'hunter_loss', label: '监管负' },
];

/** result_code 7 = 监管胜; everything else counts as a hunter loss/draw. */
export function isHunterWin(m: Pick<MatchSummary, 'result_code' | 'result_label'>): boolean {
  if (m.result_code === 7) return true;
  if (m.result_code === 9) return false;
  return /监管胜/.test(m.result_label ?? '');
}

export function resultKey(m: Pick<MatchSummary, 'result_code' | 'result_label'>): Exclude<ResultKey, 'all'> {
  return isHunterWin(m) ? 'hunter_win' : 'hunter_loss';
}

export function sourceBadge(m: Pick<MatchSummary, 'source' | 'by_share_get'>): string {
  if (m.source === 'uploaded') return '上传导入';
  if (m.by_share_get) return '分享录像';
  return '预置档案';
}

export function outcomeSummary(m: Pick<MatchSummary, 'survivor_escape_count' | 'survivor_elim_count' | 'survivor_surrender_count'>): string {
  return `逃脱 ${m.survivor_escape_count} · 淘汰 ${m.survivor_elim_count} · 投降 ${m.survivor_surrender_count}`;
}

// ------------------------------------------------------------------ numbers

/** 482.36 -> "08:02" (or "08:02.4" with tenths). */
export function formatClock(seconds: number | null | undefined, tenths = false): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const mm = String(m).padStart(2, '0');
  if (tenths) {
    const r = rest.toFixed(1).padStart(4, '0');
    return `${mm}:${r === '60.0' ? '59.9' : r}`;
  }
  return `${mm}:${String(Math.floor(rest)).padStart(2, '0')}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`;
}

export function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function fmtSec(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)}s`;
}

export function floorOf(y: number): FloorId {
  if (y < -20) return 'B1';
  if (y >= 25) return '2F';
  return '1F';
}

// ------------------------------------------------------------------ events

export type EventGroupKey = 'key' | 'all' | 'combat' | 'chair' | 'pallet' | 'objective' | 'skill';

export const EVENT_GROUPS: ReadonlyArray<{ key: EventGroupKey; label: string; types: readonly string[] | null }> = [
  {
    key: 'key',
    label: '关键',
    types: [
      'hit_attack', 'chair_hang', 'rescue_attempt', 'rescue_complete', 'pallet_drop', 'pallet_break',
      'vault_window', 'cipher_complete', 'door_powered', 'door_opened', 'tag_add', 'window_block',
      'player_eliminated_or_surrender', 'player_escaped',
    ],
  },
  { key: 'combat', label: '交战', types: ['hit_attack', 'health_state_change', 'chase_state'] },
  { key: 'chair', label: '上椅/救援', types: ['chair_hang', 'rescue_attempt', 'rescue_complete', 'player_eliminated_or_surrender', 'player_escaped'] },
  { key: 'pallet', label: '板窗', types: ['pallet_drop', 'pallet_break', 'vault_window', 'vault_pallet', 'window_block'] },
  { key: 'objective', label: '密码机/大门', types: ['cipher_complete', 'door_powered', 'door_opened'] },
  { key: 'skill', label: '飞轮/技能', types: ['tag_add', 'skill_cast'] },
  { key: 'all', label: '全部', types: null },
];

export function filterEvents(events: readonly ReplayTimelineEvent[], group: EventGroupKey): ReplayTimelineEvent[] {
  const g = EVENT_GROUPS.find((x) => x.key === group);
  if (!g || !g.types) return [...events];
  const set = new Set(g.types);
  return events.filter((e) => set.has(e.type));
}

export const EVENT_TYPE_ZH: Readonly<Record<string, string>> = Object.freeze({
  hit_attack: '命中',
  health_state_change: '状态',
  fear_change: '恐惧值',
  presence_change: '存在感',
  chair_hang: '上椅',
  chair_progress: '椅进度',
  rescue_attempt: '救援 opt=4',
  rescue_complete: '救下 opt=3',
  pallet_drop: '下板',
  pallet_break: '踩板',
  vault_window: '翻窗',
  vault_pallet: '翻板',
  cipher_progress: '破译',
  cipher_complete: '密码机',
  door_powered: '通电',
  door_opened: '开门',
  chase_state: '追击',
  skill_cast: '技能',
  tag_add: '飞轮',
  window_block: '封窗',
  player_eliminated_or_surrender: '淘汰',
  player_escaped: '逃脱',
});

export function eventTypeLabel(e: ReplayTimelineEvent): string {
  if (e.type === 'tag_add') return e.meta?.is_flywheel ? '飞轮 Flywheel' : '标签';
  return EVENT_TYPE_ZH[e.type] ?? e.type;
}

/** Severity class for colouring the feed rows. */
export function eventTone(e: ReplayTimelineEvent): 'red' | 'gold' | 'blue' | 'dim' {
  switch (e.type) {
    case 'hit_attack':
    case 'chair_hang':
    case 'player_eliminated_or_surrender':
    case 'pallet_break':
      return 'red';
    case 'cipher_complete':
    case 'door_powered':
    case 'door_opened':
    case 'player_escaped':
      return 'gold';
    case 'rescue_attempt':
    case 'rescue_complete':
    case 'pallet_drop':
    case 'vault_window':
    case 'vault_pallet':
    case 'tag_add':
      return 'blue';
    default:
      return 'dim';
  }
}

export function playerName(players: readonly ReplayPlayer[], uid: number | null | undefined): string {
  if (uid === null || uid === undefined) return '—';
  return players.find((p) => p.uid === uid)?.player_name ?? `UID ${uid}`;
}
