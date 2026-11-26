import type { MatchAnalyticsPayload, MatchSummary, Replay2DPayload, TrajectorySampleTuple } from '@idv/replay-renderer';

export function makeSummary(over: Partial<MatchSummary> = {}): MatchSummary {
  return {
    match_id: '6b04323a84b889718100f507',
    mode_id: 2,
    mode_name: '排位模式',
    scene_id: 40,
    map_name: '唐人街',
    map_asset_url: '/assets/maps/唐人街_grid.jpg',
    save_time_utc8: '2026-11-23 20:41:41',
    save_time_float: 1795437701.1,
    duration_s: 120,
    recorder_uid: 1000006,
    recorder_name: '天才少女桃丶',
    recorder_camp: 1,
    result_code: 7,
    result_label: '监管胜',
    self_wdf: 1,
    by_share_get: true,
    is_bot_match: false,
    survivor_escape_count: 0,
    survivor_elim_count: 2,
    survivor_surrender_count: 2,
    hunter: { uid: 1000006, player_name: '天才少女桃丶', pid: 126, support_skill_ids: [1] },
    survivors: [
      { uid: 1000008, player_name: '秦晓萌', pid: 90, res_type: 6, res_label: '投降', is_bot: false },
      { uid: 1000009, player_name: '过估', pid: 36, res_type: 1, res_label: '淘汰', is_bot: false },
    ],
    source: 'preloaded',
    ...over,
  };
}

export const MATCHES: MatchSummary[] = [
  makeSummary(),
  makeSummary({
    match_id: '6b04349384b8897181051f2a',
    map_name: '军工厂',
    map_asset_url: '/assets/maps/军工厂_grid.jpg',
    mode_id: 1,
    mode_name: '匹配模式',
    result_code: 9,
    result_label: '监管负',
    by_share_get: false,
    save_time_utc8: '2026-11-23 19:00:00',
    hunter: { uid: 2000001, player_name: '红夫人玩家', pid: 102, support_skill_ids: [] },
  }),
  makeSummary({
    match_id: '6b0014eb54fd12fd2b16667d',
    mode_id: 4,
    mode_name: '自定义模式',
    is_bot_match: true,
    source: 'uploaded',
    by_share_get: false,
    result_code: 9,
    result_label: '监管负',
    save_time_utc8: '2026-11-22 10:00:00',
  }),
];

function traj(points: Array<[number, number, number, number]>, fear = 0): TrajectorySampleTuple[] {
  return points.map(([t, x, y, z]) => [t, x, y, z, 0, 1, 45, 0, fear]);
}

export function makeReplay(over: Partial<Replay2DPayload> = {}): Replay2DPayload {
  return {
    schema_version: '1.0',
    match: makeSummary(),
    time: { t_ref_unix: 1795437000, duration_s: 120, sample_hz: 10 },
    world: {
      bounds: { min_x: -100, max_x: 100, min_z: -100, max_z: 100, min_y: -85, max_y: 70 },
      floors: {
        B1: { y_min: -85, y_max: -40, y_plane: -85, has_entities: true },
        '1F': { y_min: 0, y_max: 20, y_plane: 0, has_entities: true },
        '2F': { y_min: 30, y_max: 70, y_plane: 60, has_entities: true },
      },
      map_underlay: {
        asset_url: '/assets/maps/唐人街_grid.jpg',
        aspect_ratio: 1.1493,
        world_rect: { min_x: -120, max_x: 130, min_z: -110, max_z: 115 },
      },
    },
    players: [
      {
        uid: 1000006, unique_id: 'h', player_name: '天才少女桃丶', camp: 1, pid: 126, cloth_id: null, zone_id: null,
        is_bot: false, is_self: true, res_type: 0, res_label: '', spawn_pos: [0, 0, 0],
        talents: [{ talent_id: 24, level: 1, name: null }, { talent_id: 4, level: 2, name: null }],
        support_skill_ids: [1],
      },
      {
        uid: 1000008, unique_id: 's1', player_name: '秦晓萌', camp: 2, pid: 90, cloth_id: null, zone_id: null,
        is_bot: false, is_self: false, res_type: 6, res_label: '投降', spawn_pos: [50, 0, 50],
        talents: [{ talent_id: 8, level: 1, name: '飞轮效应' }, { talent_id: 99, level: 1, name: null }],
        support_skill_ids: [],
      },
    ],
    entities: {
      ciphers: [
        {
          uid: 501, unit_type: 3, pos: [40, 0, -40], dir: [0, 0, 1], floor: '1F', model_name: 'cipher', pos_id: 1,
          final_progress: 100, completed_at: 60, progress_curve: [[10, 0, 1], [60, 100, 0]],
        },
      ],
      chairs: [
        {
          uid: 601, unit_type: 4, pos: [-60, -80, 20], dir: [0, 0, 1], floor: 'B1', model_name: 'chair', is_basement: true,
          basement_idx: 1, hang_intervals: [{ start_t: 70, end_t: 100, victim_uid: 1000008, rescued: false, progress_curve: [[70, 0], [100, 100]] }],
        },
      ],
      chests: [],
      exit_gates: [
        { uid: 701, unit_type: 6, pos: [0, 0, -95], dir: [0, 0, 1], floor: '1F', model_name: 'gate', door_idx: '1', powered_at: 90, opened_at: 110, opened_by_uid: 1000008 },
      ],
      windows: [],
      pallets: [
        { uid: 801, unit_type: 8, pos: [20, 0, 20], dir: [1, 0, 0], floor: '1F', model_name: 'pallet', dropped_at: 30, broken_at: 40, dropped_by_uid: 1000008, broken_by_uid: 1000006 },
      ],
      hatch: null,
    },
    trajectories: {
      '1000006': traj([[0, 0, 0, 0], [60, 60, 0, 0], [120, 60, 0, 60]]),
      '1000008': traj([[0, 50, 0, 50], [60, 50, 60, -50], [120, -50, 0, -50]]),
    },
    events: [
      { id: 1, t: 12.5, type: 'hit_attack', actor_uid: 1000006, target_uid: 1000008, object_uid: null, pos: [10, 0, 10], floor: '1F', label_zh: '天才少女桃丶 命中 秦晓萌', meta: { is_normal_attack: true } },
      { id: 2, t: 30, type: 'pallet_drop', actor_uid: 1000008, target_uid: null, object_uid: 801, pos: [20, 0, 20], floor: '1F', label_zh: '秦晓萌 放下木板', meta: {} },
      { id: 3, t: 31, type: 'skill_cast', actor_uid: 1000008, target_uid: null, object_uid: null, pos: [20, 0, 20], floor: '1F', label_zh: '秦晓萌 释放技能 3034', meta: { skill_id: 3034 } },
      { id: 4, t: 75, type: 'rescue_attempt', actor_uid: 1000008, target_uid: 1000008, object_uid: 601, pos: [-60, -80, 20], floor: 'B1', label_zh: '开始救援', meta: {} },
    ],
    markers: [
      { t: 60, type: 'cipher_done', label_zh: '密码机破译完成', uid: 501 },
      { t: 70, type: 'first_chair', label_zh: '首次上椅', uid: 1000008 },
    ],
    ...over,
  };
}

export function makeAnalytics(over: Partial<MatchAnalyticsPayload> = {}): MatchAnalyticsPayload {
  return {
    match_id: '6b04323a84b889718100f507',
    phases: [
      { phase_id: 'opening', label_zh: '开局博弈', start_t: 0, end_t: 60, duration_s: 60, ciphers_completed_in_phase: 0, hits_in_phase: 1, chairs_in_phase: 0, rescues_in_phase: 0, key_events_count: 5 },
      { phase_id: 'midgame', label_zh: '中期运营', start_t: 60, end_t: 90, duration_s: 30, ciphers_completed_in_phase: 1, hits_in_phase: 2, chairs_in_phase: 1, rescues_in_phase: 1, key_events_count: 7 },
      { phase_id: 'endgame', label_zh: '开门战/残局', start_t: 90, end_t: 120, duration_s: 30, ciphers_completed_in_phase: 0, hits_in_phase: 0, chairs_in_phase: 0, rescues_in_phase: 0, key_events_count: 2 },
    ],
    hunter_metrics: {
      uid: 1000006, player_name: '天才少女桃丶', pid: 126, first_chase_t: 5, first_hit_t: 12.5, first_down_t: 20, first_chair_t: 70,
      chase_total_s: 42.3, chase_raw_et47_s: 50.1, reported_pursuit_s: null as unknown as number, target_switches: 3, normal_hits: 4,
      total_attack_swings: 7, pallet_breaks: 1, distance_xz_u: 1234.5,
    },
    survivor_metrics: [
      {
        uid: 1000008, player_name: '秦晓萌', pid: 90, is_bot: false, res_type: 6, res_label: '投降', cipher_contrib_pct: 143.6,
        cipher_active_time_s: 50, ciphers_finished: 1, chased_time_s: 30, rescues_attempted: 3, rescues_completed: 1,
        avg_chair_to_rescue_s: 31.6, heals_completed: 0, pallet_drops: 1, window_vaults: 2, pallet_vaults: 0, flywheel_uses: 1,
        times_chaired: 1, distance_xz_u: 900, min_dist_to_hunter_u: 6.01,
      },
    ],
    chase_segments: [{ survivor_uid: 1000008, survivor_name: '秦晓萌', start_t: 5, end_t: 25, duration_s: 20 }],
    distance_curve_1hz: { t: [0, 1, 2, 3], by_survivor_uid: { '1000008': [70, 60, 50, 40] } },
    ...over,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Routes fetch() calls to canned D1 API responses. */
export function installFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
    const handler = routes[key];
    if (!handler) return jsonResponse({ detail: `no route ${key}` }, 404);
    return handler();
  };
  return { fn, calls };
}
