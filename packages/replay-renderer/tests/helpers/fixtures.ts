import type {
  FloorId,
  Replay2DPayload,
  ReplayPlayer,
  ReplayTimelineEvent,
  StaticSceneEntity,
  TrajectorySampleTuple,
} from '../../src/types';
import { classifyFloor } from '../../src/ruler';

export function player(uid: number, camp: 1 | 2, name: string): ReplayPlayer {
  return {
    uid,
    unique_id: null,
    player_name: name,
    camp,
    pid: camp === 1 ? 102 : 200 + uid,
    cloth_id: null,
    zone_id: null,
    is_bot: false,
    is_self: uid === 2,
    res_type: 0,
    res_label: '',
    spawn_pos: [0, 0, 0],
    talents: [],
    support_skill_ids: [],
  };
}

export function base(uid: number, unit_type: number, pos: [number, number, number], dir: [number, number, number] = [0, 0, 1]): StaticSceneEntity {
  return { uid, unit_type, pos, dir, floor: classifyFloor(pos[1]) as FloorId, model_name: `m${uid}` };
}

/** Straight line trajectory at 10 Hz from p0 moving with velocity v (u/s). */
export function lineTrajectory(
  p0: [number, number, number],
  v: [number, number],
  t0: number,
  t1: number,
  opts: { camYaw?: number | null; fear?: number } = {},
): TrajectorySampleTuple[] {
  const out: TrajectorySampleTuple[] = [];
  const speed = Math.hypot(v[0], v[1]);
  const dx = speed > 0 ? v[0] / speed : 0;
  const dz = speed > 0 ? v[1] / speed : 1;
  for (let i = 0; t0 + i * 0.1 <= t1 + 1e-9; i++) {
    const t = Math.round((t0 + i * 0.1) * 1000) / 1000;
    const dt = t - t0;
    out.push([t, p0[0] + v[0] * dt, p0[1], p0[2] + v[1] * dt, dx, dz, speed, opts.camYaw === undefined ? 90 : opts.camYaw, opts.fear ?? 0]);
  }
  return out;
}

export function ev(id: number, t: number, type: ReplayTimelineEvent['type'], extra: Partial<ReplayTimelineEvent> = {}): ReplayTimelineEvent {
  return {
    id,
    t,
    type,
    actor_uid: null,
    target_uid: null,
    object_uid: null,
    pos: null,
    floor: null,
    label_zh: type,
    meta: {},
    ...extra,
  };
}

export function makePayload(): Replay2DPayload {
  const players = [player(1, 1, 'Hunter'), player(2, 2, 'SurvA'), player(3, 2, 'SurvB1'), player(4, 2, 'Surv2F')];
  return {
    schema_version: '1.0',
    match: {
      match_id: '6b04323a84b889718100f507',
      mode_id: 2,
      mode_name: '排位',
      scene_id: 40,
      map_name: '唐人街',
      map_asset_url: '/assets/maps/唐人街_grid.jpg',
      save_time_utc8: '2026-11-20 20:00:00',
      save_time_float: 1,
      duration_s: 200,
      recorder_uid: 2,
      recorder_name: 'SurvA',
      recorder_camp: 2,
      result_code: 7,
      result_label: '监管胜',
      self_wdf: 0,
      by_share_get: false,
      is_bot_match: false,
      survivor_escape_count: 0,
      survivor_elim_count: 4,
      survivor_surrender_count: 0,
      hunter: { uid: 1, player_name: 'Hunter', pid: 102, support_skill_ids: [] },
      survivors: [],
      source: 'preloaded',
    },
    time: { t_ref_unix: 0, duration_s: 200, sample_hz: 10 },
    world: {
      bounds: { min_x: -500, max_x: 500, min_z: -400, max_z: 400, min_y: -90, max_y: 70 },
      floors: {
        B1: { y_min: -90, y_max: -77, y_plane: -85, has_entities: true },
        '1F': { y_min: 0, y_max: 15, y_plane: 0, has_entities: true },
        '2F': { y_min: 51, y_max: 75, y_plane: 60, has_entities: true },
      },
      map_underlay: { asset_url: '/assets/maps/唐人街_grid.jpg', aspect_ratio: 1.25, world_rect: { min_x: -500, max_x: 500, min_z: -400, max_z: 400 } },
    },
    players,
    entities: {
      ciphers: [
        {
          ...base(100, 3, [200, 0, 0]),
          pos_id: 1,
          final_progress: 100,
          completed_at: 80,
          progress_curve: [
            [10, 0, 1],
            [30, 40, 0],
            [50, 40, 2],
            [70, 90, 1],
          ],
        },
      ],
      chairs: [
        {
          ...base(200, 4, [-200, -80, 100]),
          is_basement: true,
          basement_idx: 1,
          hang_intervals: [{ start_t: 100, end_t: 160, victim_uid: 3, rescued: false, progress_curve: [[100, 0], [130, 50], [160, 100]] }],
        },
        { ...base(201, 4, [300, 0, 300]), is_basement: false, basement_idx: null, hang_intervals: [] },
      ],
      chests: [base(300, 5, [-300, 0, -300])],
      exit_gates: [{ ...base(400, 6, [450, 0, 0]), door_idx: '1', powered_at: 120, opened_at: 150, opened_by_uid: 2 }],
      windows: [base(500, 7, [0, 0, 300], [1, 0, 0])],
      pallets: [{ ...base(600, 8, [-100, 0, -100], [1, 0, 0]), dropped_at: 40, broken_at: 60, dropped_by_uid: 2, broken_by_uid: 1 }],
      hatch: base(700, 10, [0, 0, -350]),
    },
    trajectories: {
      '1': lineTrajectory([-100, 0, 0], [10, 0], 0, 200, { camYaw: 90 }),
      '2': lineTrajectory([0, 0, 0], [45, 0], 0, 200, { camYaw: 0 }),
      '3': lineTrajectory([-200, -85, 100], [0, 0], 0, 200, { camYaw: 0, fear: 3 }),
      '4': lineTrajectory([100, 65, -100], [0, 0], 0, 200, { camYaw: 180 }),
    },
    events: [
      ev(1, 20, 'hit_attack', { actor_uid: 1, target_uid: 2, pos: [50, 0, 0], floor: '1F' }),
      ev(2, 21, 'skill_cast', { actor_uid: 1, pos: [60, 0, 0], floor: '1F' }),
      ev(3, 22, 'tag_add', { actor_uid: 2, meta: { tag: 'Flywheel' } }),
      ev(4, 22.5, 'tag_add', { actor_uid: 2, meta: { tag: 'Other' } }),
      ev(5, 30, 'window_block', { actor_uid: 1, object_uid: 500 }),
      ev(6, 40, 'chase_state', { actor_uid: 1, target_uid: 2, meta: { active: true } }),
      ev(7, 55, 'chase_state', { actor_uid: 1, target_uid: 2, meta: { active: false } }),
    ],
    markers: [],
  };
}
