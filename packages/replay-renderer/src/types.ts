/**
 * @idv/replay-renderer — canonical types.
 *
 * The data-contract section (FloorId .. MatchAnalyticsPayload) mirrors
 * Workflow/PLAN.md D1 verbatim. The renderer section adds zero-DOM structural
 * canvas types so the engine runs on browser canvas and WeChat Mini Program
 * `<canvas type="2d">` alike, without any platform globals.
 */

// ---------------------------------------------------------------------------
// D1 canonical data contract (verbatim)
// ---------------------------------------------------------------------------

export type FloorId = 'B1' | '1F' | '2F';

export interface MatchSummary {
  match_id: string;                  // 24-hex room_guuid
  mode_id: number;                   // 1=匹配, 2=排位, 4=自定义
  mode_name: string;
  scene_id: number;                  // 6, 11, 18, 39, 40, 75, ...
  map_name: string;
  map_asset_url: string | null;      // e.g. "/assets/maps/唐人街_grid.jpg"
  save_time_utc8: string;            // "YYYY-MM-DD HH:MM:SS"
  save_time_float: number;
  duration_s: number;
  recorder_uid: number | null;
  recorder_name: string;
  recorder_camp: 1 | 2;
  result_code: number;               // 7=监管胜, 9=监管负, 3=自退, etc.
  result_label: string;
  self_wdf: number;
  by_share_get: boolean;
  is_bot_match: boolean;
  survivor_escape_count: number;
  survivor_elim_count: number;
  survivor_surrender_count: number;
  hunter: {
    uid: number;
    player_name: string;
    pid: number;
    support_skill_ids: number[];
  };
  survivors: Array<{
    uid: number;
    player_name: string;
    pid: number;
    res_type: number;
    res_label: string;
    is_bot: boolean;
  }>;
  source: 'preloaded' | 'uploaded';
}

export interface ReplayPlayer {
  uid: number;
  unique_id: string | null;
  player_name: string;
  camp: 1 | 2;                       // 1 = Hunter, 2 = Survivor
  pid: number;
  cloth_id: number | null;
  zone_id: number | null;
  is_bot: boolean;
  is_self: boolean;
  res_type: number;
  res_label: string;
  spawn_pos: [number, number, number];
  // IMPORTANT: talent name ONLY mapped for camp === 2 via REF_SURVIVOR_GENIUS_NAMES; null for camp === 1
  talents: Array<{ talent_id: number; level: number; name: string | null }>;
  support_skill_ids: number[];
}

export interface StaticSceneEntity {
  uid: number;
  unit_type: number;
  pos: [number, number, number];     // [x, y, z] from UnitManager Comp 17 pos fallback entity.pos
  dir: [number, number, number];     // [dx, dy, dz] from UnitManager Comp 17 dir fallback angle->[sin,0,cos]
  floor: FloorId;                    // B1: y < -20; 1F: -20 <= y < 25; 2F: y >= 25
  model_name: string;
}

export interface StaticCipherEntity extends StaticSceneEntity {
  pos_id: number | null;
  final_progress: number;            // 0..100
  completed_at: number | null;       // relative seconds or null
  // [t_rel_s, progress_pct (0..100), active_fixer_count]
  progress_curve: Array<[number, number, number]>;
}

export interface StaticChairEntity extends StaticSceneEntity {
  is_basement: boolean;              // true when basement_idx in (1, 2) or y < -20
  basement_idx: number | null;
  hang_intervals: Array<{
    start_t: number;
    end_t: number;
    victim_uid: number;
    rescued: boolean;
    // [t_rel_s, elimination_pct (0..100, increasing toward 100 = eliminated)]
    progress_curve: Array<[number, number]>;
  }>;
}

export interface StaticPalletEntity extends StaticSceneEntity {
  dropped_at: number | null;
  broken_at: number | null;
  dropped_by_uid: number | null;
  broken_by_uid: number | null;
}

export interface StaticGateEntity extends StaticSceneEntity {
  door_idx: string | null;
  powered_at: number | null;
  opened_at: number | null;
  opened_by_uid: number | null;
}

export type ReplayEventType =
  | 'hit_attack'
  | 'health_state_change'
  | 'fear_change'
  | 'presence_change'
  | 'chair_hang'
  | 'chair_progress'
  | 'rescue_attempt'
  | 'rescue_complete'
  | 'pallet_drop'
  | 'pallet_break'
  | 'vault_window'
  | 'vault_pallet'
  | 'cipher_progress'
  | 'cipher_complete'
  | 'door_powered'
  | 'door_opened'
  | 'chase_state'
  | 'skill_cast'
  | 'tag_add'
  | 'window_block'
  | 'player_eliminated_or_surrender'
  | 'player_escaped';

export interface ReplayTimelineEvent {
  id: number;
  t: number;                         // relative seconds from time.t_ref_unix
  type: ReplayEventType;
  actor_uid: number | null;
  target_uid: number | null;
  object_uid: number | null;
  pos: [number, number, number] | null;
  floor: FloorId | null;
  label_zh: string;
  meta: Record<string, string | number | boolean | null>;
}

export interface ReplayHighlightMarker {
  t: number;
  type: 'cipher_done' | 'eliminate' | 'gate_open' | 'first_chair' | 'doors_powered';
  label_zh: string;
  uid: number | null;
}

/**
 * Trajectory sample tuple (length 9):
 * [t, x, y, z, dx, dz, speed, cam_yaw_deg, fear_state]
 * fear_state (survivors): 0=healthy, 1=injured, 2=downed, 3=chaired, 4=eliminated/surrendered, 5=escaped (hunter: 0)
 */
export type TrajectorySampleTuple = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number | null,
  number,
];

export interface Replay2DPayload {
  schema_version: '1.0';
  match: MatchSummary;
  time: {
    t_ref_unix: number;
    duration_s: number;
    sample_hz: number;               // 10 (0.1s uniform grid + exact event/teleport keyframes)
  };
  world: {
    bounds: {
      min_x: number;
      max_x: number;
      min_z: number;
      max_z: number;
      min_y: number;
      max_y: number;
    };
    floors: Record<FloorId, { y_min: number; y_max: number; y_plane: number; has_entities: boolean }>;
    map_underlay: {
      asset_url: string | null;
      aspect_ratio: number;          // From template.html GEO[map].ar (fallback 1.0)
      world_rect: { min_x: number; max_x: number; min_z: number; max_z: number };
    };
  };
  players: ReplayPlayer[];
  entities: {
    ciphers: StaticCipherEntity[];
    chairs: StaticChairEntity[];
    chests: StaticSceneEntity[];
    exit_gates: StaticGateEntity[];
    windows: StaticSceneEntity[];
    pallets: StaticPalletEntity[];
    hatch: StaticSceneEntity | null;
  };
  trajectories: Record<string, TrajectorySampleTuple[]>;
  events: ReplayTimelineEvent[];
  markers: ReplayHighlightMarker[];
}

// ---------------------------------------------------------------------------
// D1 canonical MatchAnalyticsPayload (GET /api/matches/{match_id}/analytics)
// ---------------------------------------------------------------------------

export type MatchPhaseId = 'opening' | 'midgame' | 'endgame';

export interface MatchPhase {
  phase_id: MatchPhaseId;
  label_zh: string;
  start_t: number;
  end_t: number;
  duration_s: number;
  ciphers_completed_in_phase: number;
  hits_in_phase: number;
  chairs_in_phase: number;
  rescues_in_phase: number;
  key_events_count: number;
}

export interface HunterMetrics {
  uid: number;
  player_name: string;
  pid: number;
  first_chase_t: number | null;
  first_hit_t: number | null;
  first_down_t: number | null;
  first_chair_t: number | null;
  chase_total_s: number;
  chase_raw_et47_s: number;
  reported_pursuit_s: number;
  target_switches: number;
  normal_hits: number;
  total_attack_swings: number;
  pallet_breaks: number;
  distance_xz_u: number;
}

export interface SurvivorMetrics {
  uid: number;
  player_name: string;
  pid: number;
  is_bot: boolean;
  res_type: number;
  res_label: string;
  cipher_contrib_pct: number;
  cipher_active_time_s: number;
  ciphers_finished: number;
  chased_time_s: number;
  rescues_attempted: number;
  rescues_completed: number;
  avg_chair_to_rescue_s: number | null;
  heals_completed: number;
  pallet_drops: number;
  window_vaults: number;
  pallet_vaults: number;
  flywheel_uses: number;
  times_chaired: number;
  distance_xz_u: number;
  min_dist_to_hunter_u: number | null;
}

export interface ChaseSegment {
  survivor_uid: number;
  survivor_name: string;
  start_t: number;
  end_t: number;
  duration_s: number;
}

export interface MatchAnalyticsPayload {
  match_id: string;
  phases: MatchPhase[];
  hunter_metrics: HunterMetrics;
  survivor_metrics: SurvivorMetrics[];
  chase_segments: ChaseSegment[];
  distance_curve_1hz: { t: number[]; by_survivor_uid: Record<string, number[]> };
}

// ---------------------------------------------------------------------------
// Zero-DOM canvas abstraction (browser canvas 2d + WeChat <canvas type="2d">)
// ---------------------------------------------------------------------------

/** Any drawable image source (browser image/bitmap or Mini Program canvas.createImage()). */
export interface CanvasImageSourceLike {
  readonly width?: number;
  readonly height?: number;
}

/** Canvas-local CSS pixels, before device-pixel scaling. */
export interface CssRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface CanvasTextMetricsLike {
  width: number;
  actualBoundingBoxLeft?: number;
  actualBoundingBoxRight?: number;
  actualBoundingBoxAscent?: number;
  actualBoundingBoxDescent?: number;
}

/** Minimal structural subset of the Canvas 2D context used by the renderer. */
export interface Canvas2DContextLike {
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  lineCap: string;
  lineJoin: string;
  filter?: string;
  globalCompositeOperation?: string;
  shadowColor?: string;
  shadowBlur?: number;
  strokeText?(text: string, x: number, y: number, maxWidth?: number): void;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  setLineDash(segments: number[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drawImage(image: any, dx: number, dy: number, dw: number, dh: number): void;
  measureText?(text: string): CanvasTextMetricsLike;
}

export interface ViewportSize {
  /** CSS-pixel width. */
  width: number;
  /** CSS-pixel height. */
  height: number;
  /** Device pixel ratio (backing store = width * dpr). Defaults to 1. */
  dpr?: number;
}

export interface CameraState {
  centerX: number;
  centerZ: number;
  /** Screen CSS pixels per world unit (> 0). */
  zoom: number;
  /** Wrapped to [0, 360). */
  yawDeg: number;
  /** Clamped to [35, 90]; 90 = exact 2D top-down. */
  pitchDeg: number;
  /** Vertical Y stretch, clamped to [1.0, 3.0]. */
  yScale: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** Painter's sort key: larger = closer to the viewer (draw later). */
  depth: number;
}

export type Vec3 = [number, number, number];

export interface WorldRect {
  min_x: number;
  max_x: number;
  min_z: number;
  max_z: number;
}

export interface UnderlayTransformOptions {
  rotationQuadrants?: 0 | 1 | 2 | 3;
  flipX?: boolean;
  flipZ?: boolean;
}

export interface UnderlayConfig extends UnderlayTransformOptions {
  enabled: boolean;
  image: CanvasImageSourceLike | null;
  /** Natural pixel size; falls back to image.width/height. */
  imageWidth?: number;
  imageHeight?: number;
  worldRect: WorldRect | null;
  /** 0..1, default 0.92 without a preset */
  opacity?: number;
  /** Unitless multipliers. Null skips renderer-side tone processing. */
  tone?: { brightness?: number; contrast?: number; saturation?: number } | null;
  backing?: string | null;
}

export interface LayerVisibilityState {
  visibleFloors: Record<FloorId, boolean>;
  focusFloor: FloorId | null;
  grid: boolean;
  floorPlanes: boolean;
  dropLines: boolean;
  trails: boolean;
  viewCones: boolean;
  dirArrows: boolean;
  ciphers: boolean;
  pallets: boolean;
  windows: boolean;
  chairs: boolean;
  gates: boolean;
  chests: boolean;
  hatch: boolean;
  pulses: boolean;
  labels: boolean;
}

export interface TacticalDistanceOptions {
  stairPenaltyU?: number;
  sprintSpeedUPerS?: number;
}

export interface RulerMeasurement {
  planarDistanceU: number;
  verticalDeltaU: number;
  euclidean3dU: number;
  floorA: FloorId;
  floorB: FloorId;
  crossFloor: boolean;
  stairPenaltyU: number;
  effectiveDistanceU: number;
  survivorSprintEtaS: number;
}

export interface RulerState {
  a: Vec3;
  b: Vec3;
}

export type PickEntityKind =
  | 'player'
  | 'cipher'
  | 'chair'
  | 'pallet'
  | 'window'
  | 'gate'
  | 'chest'
  | 'hatch';

export interface PickResult {
  kind: PickEntityKind;
  uid: number;
  /** World position at the pick time. */
  pos: Vec3;
  floor: FloorId;
  screen: { x: number; y: number };
  distancePx: number;
}

// ---------------------------------------------------------------------------
// Sampler outputs
// ---------------------------------------------------------------------------

export interface PlayerSample {
  t: number;
  pos: Vec3;
  /** Normalized body facing on XZ. */
  dir: [number, number];
  speed: number;
  camYawDeg: number | null;
  fearState: number;
  /** True when the bracketing samples are a teleport (> 60u) and no lerp was applied. */
  teleported: boolean;
}

export interface TrailPoint {
  t: number;
  pos: Vec3;
  /** 0 = current (newest), 1 = oldest (trailSeconds ago). */
  age: number;
}

export interface CipherSample {
  progressPct: number;
  activeFixerCount: number;
  isCompleted: boolean;
}

export type PalletState = 'upright' | 'dropped' | 'broken';

export interface ChairSample {
  isOccupied: boolean;
  victimUid: number | null;
  eliminationPct: number;
}

export type GateState = 'unpowered' | 'powered' | 'opened';

export type PulseKind = 'hit_attack' | 'skill_cast' | 'flywheel';

export interface ActivePulse {
  event: ReplayTimelineEvent;
  kind: PulseKind;
  /** 0 at event time, 1 at the end of the pulse duration. */
  progress: number;
  pos: Vec3 | null;
}
