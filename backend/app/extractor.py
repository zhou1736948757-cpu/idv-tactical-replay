"""Identity V native replay -> canonical ``Replay2DPayload`` extractor.

Implements ``Workflow/PLAN.md`` D1 verbatim. All pickle decoding goes through
``safe_pickle.safe_unpickle_bytes`` (static ``pickletools`` audit +
``SafeUnpickler``); unrestricted ``pickle`` loading is never used.

Key raw-data facts honoured here (see MEMORY.md):
* ``UnitManager`` keys (uids) and ``components`` keys (``17``) are Python
  ``int`` in raw unpickled snapshots (``str`` only in JSON dumps) -> both key
  types are checked.
* NeoX yaw maps to world XZ via ``dx = sin(yaw), dz = cos(yaw)``.
* Non-gameplay props may carry sentinel ``y = -65536`` -> ``abs(y) > 500`` is
  rejected.
* Hunter ``pid=102`` movement arrives as ``et=1110`` (``target_pos``).
* AI bots have ``unique_id=None`` in ``all_player_result`` -> fallback join on
  ``(player_name, pid, utype)``.
"""

from __future__ import annotations

import bisect
import collections
import datetime
import logging
import math
import re
import statistics
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from .field_metadata import REF_MAP_NAMES, REF_MODE_NAMES, REF_SURVIVOR_GENIUS_NAMES
from .safe_pickle import SafeObjectId, safe_unpickle_bytes

logger = logging.getLogger(__name__)

SCHEMA_VERSION = "1.0"
SAMPLE_HZ = 10
SNAP_RE = re.compile(r"^battle_frames_snapshot_(\d+)\.txt$")
UTC8 = datetime.timezone(datetime.timedelta(hours=8))
SENTINEL_ABS_Y = 500.0
GAMEPLAY_UNIT_TYPES = {3, 4, 5, 6, 7, 8, 10}
WORLD_RECT_PADDING = 0.07

#: ``GEO[map].ar`` from zhou1736948757-cpu/notes/template.html
MAP_ASPECT_RATIOS: Dict[str, float] = {
    "军工厂": 1.1441,
    "红教堂": 1.062,
    "圣心医院": 1.0795,
    "湖景村": 1.1603,
    "月亮河公园": 1.7179,
    "里奥的回忆": 1.1381,
    "永眠镇": 1.3076,
    "唐人街": 1.1493,
    "不归林": 1.0322,
}

RESULT_LABELS: Dict[int, str] = {
    1: "淘汰",
    2: "人机结束",
    3: "自退/未分胜负",
    5: "逃脱",
    6: "投降",
    7: "监管胜",
    9: "监管负",
}

FLOOR_NOMINAL = {"B1": (-200.0, -20.0), "1F": (-20.0, 25.0), "2F": (25.0, 200.0)}

EVENT_LABELS_ZH: Dict[str, str] = {
    "hit_attack": "攻击命中",
    "health_state_change": "健康状态变化",
    "fear_change": "恐惧值变化",
    "presence_change": "存在感变化",
    "chair_hang": "挂上狂欢之椅",
    "chair_progress": "椅子进度",
    "rescue_attempt": "开始救援",
    "rescue_complete": "救援成功",
    "pallet_drop": "下板",
    "pallet_break": "踩板",
    "vault_window": "翻窗",
    "vault_pallet": "翻板",
    "cipher_progress": "破译进度",
    "cipher_complete": "密码机破译完成",
    "door_powered": "大门通电",
    "door_opened": "大门开启",
    "chase_state": "追击状态",
    "skill_cast": "技能释放",
    "tag_add": "战斗标签",
    "window_block": "封窗",
    "player_eliminated_or_surrender": "淘汰/投降",
    "player_escaped": "逃脱",
}

FEAR_HEALTHY, FEAR_INJURED, FEAR_DOWNED, FEAR_CHAIRED, FEAR_OUT, FEAR_ESCAPED = 0, 1, 2, 3, 4, 5


class ReplayExtractionError(ValueError):
    """Raised when a replay folder is structurally invalid."""


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def to_int_uid(val: Any) -> Optional[int]:
    if isinstance(val, bool):
        return None
    if isinstance(val, int):
        return val
    if isinstance(val, float) and val.is_integer():
        return int(val)
    if isinstance(val, str) and val.lstrip("-").isdigit():
        return int(val)
    return None


def _finite(*vals: Any) -> bool:
    try:
        return all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in vals)
    except TypeError:
        return False


def vec3(v: Any) -> Optional[Tuple[float, float, float]]:
    if isinstance(v, (list, tuple)) and len(v) >= 3 and _finite(v[0], v[1], v[2]):
        return (float(v[0]), float(v[1]), float(v[2]))
    return None


def dir3(v: Any) -> Optional[Tuple[float, float, float]]:
    if isinstance(v, (list, tuple)):
        if len(v) >= 3 and _finite(v[0], v[1], v[2]):
            return (float(v[0]), float(v[1]), float(v[2]))
        if len(v) == 2 and _finite(v[0], v[1]):
            return (float(v[0]), 0.0, float(v[1]))
    return None


def normalize3(d: Optional[Tuple[float, float, float]]) -> Optional[Tuple[float, float, float]]:
    if d is None:
        return None
    n = math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2)
    if n < 1e-9:
        return None
    return (d[0] / n, d[1] / n, d[2] / n)


def yaw_to_dir(deg: float) -> Tuple[float, float, float]:
    rad = math.radians(float(deg))
    return (math.sin(rad), 0.0, math.cos(rad))


def classify_floor(y: float) -> str:
    if y < -20.0:
        return "B1"
    if y >= 25.0:
        return "2F"
    return "1F"


def r(v: Optional[float], nd: int = 2) -> Optional[float]:
    if v is None:
        return None
    out = round(float(v), nd)
    return 0.0 if out == 0 else out


def r3(p: Sequence[float], nd: int = 2) -> List[float]:
    return [r(p[0], nd), r(p[1], nd), r(p[2], nd)]  # type: ignore[list-item]


def _prim(v: Any) -> Any:
    """Coerce a value into a JSON primitive allowed in ``meta``."""
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, SafeObjectId):
        return v.hex_str()
    return str(v)


def decode_pickle_file(path: Path) -> Any:
    obj, _audit = safe_unpickle_bytes(Path(path).read_bytes())
    return obj


def snapshot_sort_key(path: Path) -> Tuple[int, str]:
    m = SNAP_RE.match(path.name)
    return (int(m.group(1)) if m else 10**9, path.name)


def is_replay_dir(path: Path) -> bool:
    return (
        path.is_dir()
        and (path / "game_info.txt").is_file()
        and (path / "total_info.txt").is_file()
        and any(SNAP_RE.match(p.name) for p in path.iterdir() if p.is_file())
    )


def find_replay_dirs(root: Path) -> List[Path]:
    root = Path(root)
    found = []
    if is_replay_dir(root):
        found.append(root)
    for p in sorted(root.rglob("game_info.txt")):
        if p.parent != root and is_replay_dir(p.parent):
            found.append(p.parent)
    return sorted(set(found), key=lambda d: d.name)


def build_sid_map(combat_core_info: Dict[str, Any]) -> Dict[int, Tuple[str, Any, Any]]:
    """shadow_instance_id -> (scope, entity_id, component_or_instance_type)."""
    sid_map: Dict[int, Tuple[str, Any, Any]] = {}

    def walk(node: Any, ctx: str) -> None:
        if isinstance(node, dict):
            sid = node.get("shadow_instance_id")
            if isinstance(sid, int):
                sid_map[sid] = (ctx, node.get("entity_id"), node.get("instance_type"))
            comps = node.get("components")
            if isinstance(comps, dict):
                eid = node.get("entity_id")
                for ck, cv in comps.items():
                    if isinstance(cv, dict) and isinstance(cv.get("shadow_instance_id"), int):
                        sid_map[cv["shadow_instance_id"]] = ("unit_comp", eid, ck)
            for k, v in node.items():
                if k != "components":
                    walk(v, f"{ctx}.{k}")

    walk(combat_core_info or {}, "cc")
    return sid_map


def update_sid_map_from_rpc(sid_map: Dict[int, Tuple[str, Any, Any]], func: str, rpc: Dict[str, Any]) -> None:
    args = rpc.get("args") or []
    if func in ("on_server_create_instance", "on_effect_added") and args and isinstance(args[0], dict):
        a0 = args[0]
        sid, eid = a0.get("shadow_instance_id"), a0.get("entity_id")
        if isinstance(sid, int):
            sid_map[sid] = ("dyn_instance", eid, a0.get("instance_type"))
        comps = a0.get("components")
        if isinstance(comps, dict):
            for ck, cv in comps.items():
                if isinstance(cv, dict) and isinstance(cv.get("shadow_instance_id"), int):
                    sid_map[cv["shadow_instance_id"]] = ("dyn_comp", eid, ck)
    elif func == "on_sync_create_dynamic_component" and len(args) >= 3 and isinstance(args[2], dict):
        sid = args[2].get("shadow_instance_id")
        if isinstance(sid, int):
            sid_map[sid] = ("dyn_add_comp", rpc.get("eid"), args[0])
    elif func == "sync_add_component" and len(args) >= 2 and isinstance(args[1], dict):
        sid = args[1].get("shadow_instance_id")
        if isinstance(sid, int):
            owner = sid_map.get(rpc.get("id"))
            sid_map[sid] = ("sync_add_comp", owner[1] if owner else None, args[0])


def unit_manager_comp17(unit_manager: Any, uid: int) -> Optional[Dict[str, Any]]:
    """Return ``UnitManager[uid].components[17]`` checking both int and str keys."""
    if not isinstance(unit_manager, dict):
        return None
    rec = unit_manager.get(uid)
    if rec is None:
        rec = unit_manager.get(str(uid))
    if not isinstance(rec, dict):
        return None
    comps = rec.get("components")
    if not isinstance(comps, dict):
        return None
    c17 = comps.get(17)
    if c17 is None:
        c17 = comps.get("17")
    return c17 if isinstance(c17, dict) else None


def unit_manager_duck_pose_comp(unit_manager: Any, uid: int) -> Optional[Dict[str, Any]]:
    """Duck-type fallback when ``components[17]`` is absent in future game versions."""
    if not isinstance(unit_manager, dict):
        return None
    rec = unit_manager.get(uid)
    if rec is None:
        rec = unit_manager.get(str(uid))
    if not isinstance(rec, dict):
        return None
    comps = rec.get("components")
    if not isinstance(comps, dict):
        return None
    best_pos_only: Optional[Dict[str, Any]] = None
    for _ck, cv in sorted(comps.items(), key=lambda kv: str(kv[0])):
        if not isinstance(cv, dict):
            continue
        p = vec3(cv.get("pos"))
        if p is None or abs(p[1]) > SENTINEL_ABS_Y:
            continue
        if normalize3(dir3(cv.get("dir"))) is not None:
            return cv
        if best_pos_only is None:
            best_pos_only = cv
    return best_pos_only


# ---------------------------------------------------------------------------
# per-player continuous track
# ---------------------------------------------------------------------------


@dataclass
class RawSample:
    t: float
    x: float
    y: float
    z: float
    dx: Optional[float]
    dz: Optional[float]
    speed: Optional[float]
    teleport: bool
    src: str


class PlayerTrack:
    """Interpolates raw movement samples, camera yaw and fear state."""

    def __init__(
        self,
        samples: List[RawSample],
        yaw_samples: List[Tuple[float, float]],
        state_fn: Callable[[float], int],
        spawn_dir: Tuple[float, float],
    ) -> None:
        self.samples = sorted(samples, key=lambda s: s.t)
        self.ts = [s.t for s in self.samples]
        # Forward-fill horizontal direction
        self.dirs: List[Tuple[float, float]] = []
        last = spawn_dir
        for s in self.samples:
            if s.dx is not None and s.dz is not None:
                n = math.hypot(s.dx, s.dz)
                if n > 1e-9:
                    last = (s.dx / n, s.dz / n)
            self.dirs.append(last)
        ys = sorted(yaw_samples)
        self.yaw_ts = [t for t, _ in ys]
        self.yaw_vals = [v for _, v in ys]
        self.state_fn = state_fn

    def at(self, t: float) -> Tuple[float, float, float, float, float, float, Optional[float], int]:
        n = len(self.samples)
        idx = bisect.bisect_right(self.ts, t) - 1
        if idx < 0:
            idx = 0
        s = self.samples[idx]
        x, y, z = s.x, s.y, s.z
        if idx + 1 < n and t > s.t:
            nx = self.samples[idx + 1]
            gap = nx.t - s.t
            if 0 < gap <= 1.0 and not nx.teleport:
                f = (t - s.t) / gap
                x = s.x + (nx.x - s.x) * f
                y = s.y + (nx.y - s.y) * f
                z = s.z + (nx.z - s.z) * f
        age = t - s.t
        speed = float(s.speed) if (s.speed is not None and age <= 1.0) else 0.0
        dx, dz = self.dirs[idx]
        yi = bisect.bisect_right(self.yaw_ts, t) - 1
        yaw = self.yaw_vals[yi] if yi >= 0 else None
        return (x, y, z, dx, dz, speed, yaw, self.state_fn(t))

    def distance_xz(self) -> float:
        tot = 0.0
        for a, b in zip(self.samples, self.samples[1:]):
            tot += math.hypot(b.x - a.x, b.z - a.z)
        return tot


# ---------------------------------------------------------------------------
# context shared with analytics
# ---------------------------------------------------------------------------


@dataclass
class MatchContext:
    match_id: str
    t_ref: float
    duration: float
    hunter_uid: Optional[int]
    survivor_uids: List[int]
    players: Dict[int, Dict[str, Any]]
    tracks: Dict[int, PlayerTrack]
    events: List[Dict[str, Any]]
    chase_segments: Dict[int, List[Tuple[float, float]]]
    chase_target_seq: List[Tuple[float, int]]
    cipher_contrib: Dict[int, float]
    cipher_decode_time: Dict[int, float]
    ciphers_finished: Dict[int, int]
    cipher_pre_gate_prog: Dict[int, float]
    rescue_attempts: Dict[int, int]
    rescue_completes: Dict[int, int]
    rescue_intervals: List[Tuple[int, int, float]]
    heals: Dict[int, int]
    pallet_drops: Dict[int, int]
    pallet_breaks: Dict[int, int]
    window_vaults: Dict[int, int]
    pallet_vaults: Dict[int, int]
    flywheel_uses: Dict[int, int]
    times_chaired: Dict[int, int]
    normal_hits: int
    attack_opt_counts: Dict[Any, int]
    reported_pursuit_s: Optional[float]
    generator_status: List[float]
    stats: Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# main extraction
# ---------------------------------------------------------------------------


def _load_match_files(replay_dir: Path) -> Tuple[Dict[str, Any], Dict[str, Any], List[Any], List[Path]]:
    replay_dir = Path(replay_dir)
    if not is_replay_dir(replay_dir):
        raise ReplayExtractionError(f"Not a replay folder (needs game_info/total_info/snapshots): {replay_dir.name}")
    gi = decode_pickle_file(replay_dir / "game_info.txt")
    ti = decode_pickle_file(replay_dir / "total_info.txt")
    if not isinstance(gi, dict) or not isinstance(ti, dict):
        raise ReplayExtractionError("game_info/total_info did not decode to dicts")
    snap_paths = sorted(
        [p for p in replay_dir.iterdir() if p.is_file() and SNAP_RE.match(p.name)], key=snapshot_sort_key
    )
    snaps = [decode_pickle_file(p) for p in snap_paths]
    return gi, ti, snaps, snap_paths


def extract_match(replay_dir: Path, source: str = "preloaded") -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Decode one replay folder into ``(Replay2DPayload, MatchAnalyticsPayload)``."""
    from .analytics import build_analytics  # local import avoids a cycle

    ctx, replay = build_replay(replay_dir, source)
    return replay, build_analytics(ctx)


def build_replay(replay_dir: Path, source: str = "preloaded") -> Tuple[MatchContext, Dict[str, Any]]:  # noqa: C901
    gi, ti, snaps, _snap_paths = _load_match_files(Path(replay_dir))

    # ---------------- initial snapshot ----------------
    init_ss: Dict[str, Any] = {}
    for s in snaps:
        chunks = s.get("data", []) if isinstance(s, dict) else []
        for ch in chunks:
            if isinstance(ch, dict) and isinstance(ch.get("snap_shot"), dict):
                init_ss = ch["snap_shot"]
                break
        if init_ss:
            break
    ed = init_ss.get("event_data") or {}
    if not ed:
        raise ReplayExtractionError("No initial snap_shot.event_data found in snapshots")
    cc = ed.get("combat_core_info") or {}
    unit_manager = (cc.get("manager_info") or {}).get("UnitManager") or {}
    sid_map = build_sid_map(cc)

    entities: Dict[int, Dict[str, Any]] = {}
    for group in ("entities", "entities_in_scene"):
        gd = ed.get(group) or {}
        if not isinstance(gd, dict):
            continue
        for raw_k, ent in gd.items():
            if not isinstance(ent, dict):
                continue
            uid = to_int_uid(ent.get("uid"))
            if uid is None:
                uid = to_int_uid(raw_k)
            if uid is None:
                continue
            merged = dict(entities.get(uid, {}))
            merged.update(ent)
            merged["uid"] = uid
            entities[uid] = merged

    def utype_of(uid: Optional[int]) -> Optional[int]:
        if uid is None or uid not in entities:
            return None
        return to_int_uid(entities[uid].get("unit_type"))

    # ---------------- time reference ----------------
    sr = gi.get("self_result") or {}
    bi = sr.get("base_info") or {} if isinstance(sr, dict) else {}
    si = sr.get("spec_info") or {} if isinstance(sr, dict) else {}
    bre = sr.get("battle_result_extra_info") or {} if isinstance(sr, dict) else {}
    first_happen = ti.get("first_happen_time")
    start_time = bi.get("start_time") or ed.get("start_game_time")

    all_events: List[Tuple[float, Dict[str, Any]]] = []
    for s in snaps:
        for ch in (s.get("data", []) if isinstance(s, dict) else []):
            if not isinstance(ch, dict):
                continue
            for item in ch.get("battle_event") or []:
                if isinstance(item, (list, tuple)) and len(item) == 2 and isinstance(item[1], dict) and _finite(item[0]):
                    all_events.append((float(item[0]), item[1]))
    if not all_events:
        raise ReplayExtractionError("Replay contains no battle events")
    min_ts = min(t for t, _ in all_events)
    max_ts = max(t for t, _ in all_events)
    t_ref = float(first_happen or start_time or min_ts)
    duration = round(max(0.0, max_ts - t_ref), 3)

    def rel(ts: float) -> float:
        return ts - t_ref

    # ---------------- static entities ----------------
    pose_stats = collections.Counter()

    def static_pose(uid: int, ent: Dict[str, Any]) -> Tuple[Optional[Tuple[float, float, float]], Tuple[float, float, float]]:
        pos = None
        d = None
        c17 = unit_manager_comp17(unit_manager, uid)
        if c17 is not None:
            p = vec3(c17.get("pos"))
            if p is not None and abs(p[1]) <= SENTINEL_ABS_Y:
                pos = p
                pose_stats["pos_comp17"] += 1
            d = normalize3(dir3(c17.get("dir")))
            if d is not None:
                pose_stats["dir_comp17"] += 1
        else:
            c_duck = unit_manager_duck_pose_comp(unit_manager, uid)
            if c_duck is not None:
                p = vec3(c_duck.get("pos"))
                if p is not None and abs(p[1]) <= SENTINEL_ABS_Y:
                    pos = p
                    pose_stats["pos_comp_duck"] += 1
                d = normalize3(dir3(c_duck.get("dir")))
                if d is not None:
                    pose_stats["dir_comp_duck"] += 1
        if pos is None:
            p = vec3(ent.get("pos"))
            if p is not None and abs(p[1]) <= SENTINEL_ABS_Y:
                pos = p
                pose_stats["pos_entity"] += 1
        if d is None:
            d = normalize3(dir3(ent.get("direction")))
            if d is None and _finite(ent.get("angle")):
                d = yaw_to_dir(float(ent["angle"]))
            if d is None:
                d = (0.0, 0.0, 1.0)
            pose_stats["dir_fallback"] += 1
        return pos, d

    ciphers: List[Dict[str, Any]] = []
    chairs: List[Dict[str, Any]] = []
    chests: List[Dict[str, Any]] = []
    gates: List[Dict[str, Any]] = []
    windows: List[Dict[str, Any]] = []
    pallets: List[Dict[str, Any]] = []
    hatch: Optional[Dict[str, Any]] = None
    static_by_uid: Dict[int, Dict[str, Any]] = {}
    static_pos: Dict[int, Tuple[float, float, float]] = {}

    for uid in sorted(entities):
        ent = entities[uid]
        ut = to_int_uid(ent.get("unit_type"))
        if ut not in GAMEPLAY_UNIT_TYPES:
            continue
        pos, d = static_pose(uid, ent)
        if pos is None:
            pose_stats[f"missing_pos_ut{ut}"] += 1
            continue
        base = {
            "uid": uid,
            "unit_type": ut,
            "pos": r3(pos),
            "dir": r3(d, 4),
            "floor": classify_floor(pos[1]),
            "model_name": str(ent.get("model_name") or ""),
        }
        static_pos[uid] = pos
        if ut == 3:
            base.update(
                {
                    "pos_id": to_int_uid(ent.get("pos_id")),
                    "final_progress": 0.0,
                    "completed_at": None,
                    "progress_curve": [],
                }
            )
            ciphers.append(base)
        elif ut == 4:
            bidx = to_int_uid(ent.get("basement_idx"))
            base.update(
                {
                    "is_basement": bool(bidx in (1, 2) or pos[1] < -20.0),
                    "basement_idx": bidx,
                    "hang_intervals": [],
                }
            )
            chairs.append(base)
        elif ut == 5:
            chests.append(base)
        elif ut == 6:
            didx = ent.get("door_idx")
            base.update(
                {
                    "door_idx": None if didx is None else str(didx),
                    "powered_at": None,
                    "opened_at": None,
                    "opened_by_uid": None,
                }
            )
            gates.append(base)
        elif ut == 7:
            windows.append(base)
        elif ut == 8:
            base.update({"dropped_at": None, "broken_at": None, "dropped_by_uid": None, "broken_by_uid": None})
            pallets.append(base)
        elif ut == 10:
            if hatch is None:
                hatch = base
        static_by_uid[uid] = base

    cipher_by_uid = {c["uid"]: c for c in ciphers}
    chair_by_uid = {c["uid"]: c for c in chairs}
    gate_by_uid = {g["uid"]: g for g in gates}
    pallet_by_uid = {p["uid"]: p for p in pallets}

    # ---------------- players ----------------
    player_ents = {uid: e for uid, e in entities.items() if to_int_uid(e.get("unit_type")) in (1, 2)}
    hunter_uid = next((uid for uid, e in sorted(player_ents.items()) if to_int_uid(e.get("unit_type")) == 1), None)
    all_pr = [p for p in (gi.get("all_player_result") or []) if isinstance(p, dict)]
    zsi = {
        (pi.get("name"), pi.get("role_id"), pi.get("unit_type")): pi
        for pi in ((ti.get("zone_select_info") or {}).get("player_info") or [])
        if isinstance(pi, dict)
    }
    ent_by_unique = {
        str(e["unique_id"]): e for e in player_ents.values() if e.get("unique_id") is not None
    }
    ent_by_tuple = {(e.get("player_name"), e.get("pid"), e.get("unit_type")): e for e in player_ents.values()}

    players: Dict[int, Dict[str, Any]] = {}
    unresolved_players = 0
    for pl in all_pr:
        uq = pl.get("unique_id")
        ent = ent_by_unique.get(str(uq)) if uq is not None else None
        if ent is None:
            ent = ent_by_tuple.get((pl.get("player_name"), pl.get("pid"), pl.get("utype")))
        if ent is None:
            unresolved_players += 1
            continue
        uid = ent["uid"]
        camp = to_int_uid(ent.get("unit_type")) or to_int_uid(pl.get("utype")) or 2
        zinfo = zsi.get((pl.get("player_name"), pl.get("pid"), pl.get("utype")), {})
        spawn = vec3(ent.get("pos")) or (0.0, 0.0, 0.0)
        talents = []
        for item in ent.get("genius_id_lvs") or []:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                tid, lv = to_int_uid(item[0]), to_int_uid(item[1])
                if tid is None:
                    continue
                talents.append(
                    {
                        "talent_id": tid,
                        "level": lv if lv is not None else 0,
                        # Survivor-only dictionary: NEVER applied to Hunter (camp 1) talents.
                        "name": REF_SURVIVOR_GENIUS_NAMES.get(tid) if camp == 2 else None,
                    }
                )
        res_type = to_int_uid(pl.get("res_type")) or 0
        cloth = to_int_uid(ent.get("cloth_id"))
        if cloth is None:
            cloth = to_int_uid(zinfo.get("cloth_id"))
        players[uid] = {
            "uid": uid,
            "unique_id": None if uq is None else str(uq),
            "player_name": str(pl.get("player_name") or ent.get("player_name") or ""),
            "camp": 1 if camp == 1 else 2,
            "pid": to_int_uid(pl.get("pid")) or to_int_uid(ent.get("pid")) or 0,
            "cloth_id": cloth,
            "zone_id": to_int_uid(zinfo.get("zone_id")),
            "is_bot": bool(ent.get("is_bot")),
            "is_self": bool(pl.get("is_self")),
            "res_type": res_type,
            "res_label": RESULT_LABELS.get(res_type, f"未知({res_type})"),
            "spawn_pos": r3(spawn),
            "talents": talents,
            "support_skill_ids": [x for x in (to_int_uid(v) for v in (ent.get("support_skill_id") or [])) if x is not None],
        }
    # players present in snapshot but missing from all_player_result (defensive)
    for uid, ent in player_ents.items():
        if uid not in players:
            camp = to_int_uid(ent.get("unit_type")) or 2
            players[uid] = {
                "uid": uid,
                "unique_id": None if ent.get("unique_id") is None else str(ent.get("unique_id")),
                "player_name": str(ent.get("player_name") or ""),
                "camp": 1 if camp == 1 else 2,
                "pid": to_int_uid(ent.get("pid")) or 0,
                "cloth_id": to_int_uid(ent.get("cloth_id")),
                "zone_id": None,
                "is_bot": bool(ent.get("is_bot")),
                "is_self": False,
                "res_type": 0,
                "res_label": "未知(0)",
                "spawn_pos": r3(vec3(ent.get("pos")) or (0.0, 0.0, 0.0)),
                "talents": [
                    {"talent_id": int(a), "level": int(b), "name": REF_SURVIVOR_GENIUS_NAMES.get(int(a)) if camp == 2 else None}
                    for a, b in (ent.get("genius_id_lvs") or [])
                ],
                "support_skill_ids": [int(x) for x in (ent.get("support_skill_id") or [])],
            }
    player_uids: Set[int] = set(players)
    survivor_uids = sorted(u for u, p in players.items() if p["camp"] == 2)
    name_of = {u: p["player_name"] for u, p in players.items()}

    # ---------------- event pass ----------------
    raw_samples: Dict[int, List[RawSample]] = collections.defaultdict(list)
    yaw_samples: Dict[int, List[Tuple[float, float]]] = collections.defaultdict(list)
    last_pos: Dict[int, Tuple[float, float, float]] = {}
    for uid in player_uids:
        ent = player_ents.get(uid, {})
        sp = vec3(ent.get("pos"))
        if sp is not None:
            ang = ent.get("angle")
            dd = yaw_to_dir(float(ang)) if _finite(ang) else (0.0, 0.0, 1.0)
            raw_samples[uid].append(RawSample(0.0, sp[0], sp[1], sp[2], dd[0], dd[2], 0.0, True, "spawn"))
            last_pos[uid] = sp

    health_changes: Dict[int, List[Tuple[float, int]]] = collections.defaultdict(list)
    keyframes: Dict[int, Set[float]] = collections.defaultdict(set)
    elim_t: Dict[int, float] = {}
    escape_t: Dict[int, float] = {}

    events: List[Dict[str, Any]] = []

    def pos_for(actor: Optional[int], obj: Optional[int], target: Optional[int] = None) -> Optional[Tuple[float, float, float]]:
        for u in (actor, target):
            if u is not None and u in last_pos:
                return last_pos[u]
        if obj is not None and obj in static_pos:
            return static_pos[obj]
        return None

    def add_event(
        ts: float,
        etype: str,
        actor: Optional[int] = None,
        target: Optional[int] = None,
        obj: Optional[int] = None,
        meta: Optional[Dict[str, Any]] = None,
        label: Optional[str] = None,
        pos: Optional[Tuple[float, float, float]] = None,
    ) -> None:
        p = pos if pos is not None else pos_for(actor, obj, target)
        if etype in ("pallet_drop", "pallet_break", "vault_window", "vault_pallet", "window_block", "cipher_complete",
                     "cipher_progress", "door_powered", "door_opened", "chair_progress") and obj in static_pos:
            p = static_pos[obj]
        if p is not None and abs(p[1]) > SENTINEL_ABS_Y:
            p = None
        events.append(
            {
                "id": 0,
                "t": r(rel(ts), 3),
                "type": etype,
                "actor_uid": actor,
                "target_uid": target,
                "object_uid": obj,
                "pos": r3(p) if p is not None else None,
                "floor": classify_floor(p[1]) if p is not None else None,
                "label_zh": label or EVENT_LABELS_ZH[etype],
                "meta": {k: _prim(v) for k, v in (meta or {}).items()},
            }
        )

    def nm(u: Optional[int]) -> str:
        if u is None:
            return "?"
        return name_of.get(u, str(u))

    # chase
    chase_open: Dict[int, float] = {}
    chase_segments: Dict[int, List[Tuple[float, float]]] = collections.defaultdict(list)
    chase_target_seq: List[Tuple[float, int]] = []
    # rescue / heal / pallets / vaults
    rescue_attempts: Dict[int, int] = collections.Counter()
    rescue_completes: Dict[int, int] = collections.Counter()
    rescue_intervals: List[Tuple[int, int, float]] = []
    heals: Dict[int, int] = collections.Counter()
    pallet_drops: Dict[int, int] = collections.Counter()
    pallet_breaks: Dict[int, int] = collections.Counter()
    window_vaults: Dict[int, int] = collections.Counter()
    pallet_vaults: Dict[int, int] = collections.Counter()
    flywheel_uses: Dict[int, int] = collections.Counter()
    flywheel_last: Dict[int, float] = {}
    times_chaired: Dict[int, int] = collections.Counter()
    normal_hits = 0
    attack_opt_counts: Dict[Any, int] = collections.Counter()
    # chairs
    open_hang: Dict[int, Dict[str, Any]] = {}
    hang_open_time: Dict[int, float] = {}
    closed_hangs: List[Tuple[int, Dict[str, Any]]] = []
    # ciphers (mirrors the verified audit attribution algorithm)
    gates_powered = False
    cipher_uids = [c["uid"] for c in ciphers]
    cipher_last_prog: Dict[int, float] = {cid: 0.0 for cid in cipher_uids}
    cipher_pre_gate_prog: Dict[int, float] = {cid: 0.0 for cid in cipher_uids}
    cipher_contrib: Dict[int, float] = collections.defaultdict(float)
    cipher_decode_time: Dict[int, float] = collections.defaultdict(float)
    cipher_last_active: Dict[int, Tuple[float, Dict[int, float]]] = {}
    ciphers_finished: Dict[int, int] = collections.Counter()
    cipher_raw_curve: Dict[int, List[Tuple[float, float, float, int]]] = collections.defaultdict(list)
    cipher_active_state: Dict[int, bool] = {}
    cipher_milestone: Dict[int, int] = collections.defaultdict(int)
    unresolved_sid = 0
    et_counts: collections.Counter = collections.Counter()

    def add_sample(uid: int, ts: float, p: Tuple[float, float, float], d: Optional[Tuple[float, float, float]], spd: Any, src: str, teleport: bool = False) -> None:
        if abs(p[1]) > SENTINEL_ABS_Y:
            return
        t = rel(ts)
        raw_samples[uid].append(
            RawSample(
                t, p[0], p[1], p[2],
                d[0] if d else None, d[2] if d else None,
                float(spd) if _finite(spd) else None,
                teleport, src,
            )
        )
        last_pos[uid] = p
        if teleport:
            keyframes[uid].add(round(t, 3))

    def close_hang(victim: int, ts: float, rescued: bool) -> None:
        h = open_hang.pop(victim, None)
        if h is None:
            return
        h["end_t"] = rel(ts)
        h["rescued"] = rescued
        closed_hangs.append((victim, h))
        keyframes[victim].add(round(rel(ts), 3))

    for ts, payload in all_events:
        et = payload.get("et")
        et_counts[et] += 1
        if et in (201, 89, 1110, 442):
            u = to_int_uid(payload.get("uid"))
            if u in player_uids:
                if et == 1110:
                    rp, rd, spd = payload.get("target_pos"), payload.get("target_dir"), payload.get("target_speed")
                elif et == 442:
                    rp, rd, spd = payload.get("position"), payload.get("direction"), payload.get("speed")
                else:
                    rp, rd, spd = payload.get("pos"), payload.get("dir"), payload.get("speed")
                p = vec3(rp)
                if p is not None:
                    add_sample(u, ts, p, dir3(rd), spd, f"et_{et}", teleport=(et == 89))
        elif et == 304:
            u = to_int_uid(payload.get("uid"))
            ang = payload.get("ang_tuple")
            if u in player_uids and isinstance(ang, (list, tuple)) and len(ang) >= 3 and _finite(ang[2]):
                yaw_samples[u].append((rel(ts), round(float(ang[2]) % 360.0, 1) % 360.0))
        elif et == 41:
            u = to_int_uid(payload.get("uid"))
            rt = (payload.get("data") or {}).get("res_type")
            if u is not None:
                elim_t.setdefault(u, rel(ts))
                keyframes[u].add(round(rel(ts), 3))
                if u in open_hang:
                    close_hang(u, ts, rescued=False)
                else:
                    # chair elimination usually drops the civilian right before et=41
                    for vic, h in reversed(closed_hangs):
                        if vic == u and abs(h["end_t"] - rel(ts)) <= 1.5:
                            h["rescued"] = False
                            break
            add_event(ts, "player_eliminated_or_surrender", u, None, None, {"res_type": rt},
                      f"{nm(u)} {'投降' if rt == 6 else '被淘汰'}")
        elif et == 42:
            u = to_int_uid(payload.get("uid"))
            rt = (payload.get("data") or {}).get("res_type")
            if u is not None:
                escape_t.setdefault(u, rel(ts))
                keyframes[u].add(round(rel(ts), 3))
            add_event(ts, "player_escaped", u, None, None, {"res_type": rt}, f"{nm(u)} 逃脱")
        elif et == 47 and payload.get("key") == "sync_state":
            su = to_int_uid(payload.get("uid"))
            hu = to_int_uid(payload.get("chase_uid"))
            flag = bool(payload.get("flag"))
            if su is not None:
                if flag:
                    if su not in chase_open:
                        chase_open[su] = rel(ts)
                    chase_target_seq.append((rel(ts), su))
                elif su in chase_open:
                    chase_segments[su].append((chase_open.pop(su), rel(ts)))
            add_event(ts, "chase_state", hu, su, None, {"flag": flag},
                      f"{nm(hu)} {'开始追击' if flag else '结束追击'} {nm(su)}")
        elif et == 54 and payload.get("opt") == 8:
            u = to_int_uid(payload.get("uid"))
            add_event(ts, "skill_cast", u, None, None, {"skill_id": payload.get("skill_id"), "source": "et54"},
                      f"{nm(u)} 释放技能 {payload.get('skill_id')}")
        elif et == 2023:
            u = to_int_uid(payload.get("uid"))
            add_event(ts, "skill_cast", u, None, None, {"skill_id": payload.get("skill_id"), "source": "et2023",
                                                         "opt": payload.get("opt")},
                      f"{nm(u)} 使用技能/道具 {payload.get('skill_id')}")
        elif et == 79:
            u = to_int_uid(payload.get("uid"))
            fs = to_int_uid(payload.get("fear_state"))
            if u is not None and fs is not None:
                health_changes[u].append((rel(ts), fs))
                keyframes[u].add(round(rel(ts), 3))
            add_event(ts, "health_state_change", u, None, None,
                      {"fear_state": fs, "die_percent": payload.get("die_percent"), "die_speed": payload.get("die_speed")},
                      f"{nm(u)} {['健康', '受伤', '倒地'][fs] if fs in (0, 1, 2) else '状态' + str(fs)}")
        elif et == 81:
            u = to_int_uid(payload.get("uid"))
            add_event(ts, "fear_change", u, None, None,
                      {"fear_num": payload.get("fear_num"), "min_fear_num": payload.get("min_fear_num")})
        elif et == 82 and "presence_num" in payload:
            u = to_int_uid(payload.get("uid"))
            add_event(ts, "presence_change", u, None, None,
                      {"presence_num": r(payload.get("presence_num"), 2) if _finite(payload.get("presence_num")) else None,
                       "is_direct": payload.get("is_direct")})
        elif et == 414:
            fu, wu = to_int_uid(payload.get("from_uid")), to_int_uid(payload.get("uid"))
            add_event(ts, "window_block", fu, None, wu, {"key": payload.get("key"), "block_type": payload.get("type")},
                      f"{nm(fu)} 封窗")
        elif et == 10999 and isinstance(payload.get("data"), dict):
            rd = payload["data"]
            fn = str(rd.get("func") or "")
            args = rd.get("args") or []
            update_sid_map_from_rpc(sid_map, fn, rd)
            owner: Optional[int] = None
            if rd.get("channel") == 13:
                sid = rd.get("id")
                if sid in sid_map:
                    owner = to_int_uid(sid_map[sid][1])
                else:
                    unresolved_sid += 1
            elif "eid" in rd:
                owner = to_int_uid(rd.get("eid"))
            a0 = args[0] if args and isinstance(args[0], dict) else None

            if fn in ("handle_joystick_move_self_event", "handle_joystick_move_all_event") and a0 is not None:
                u = to_int_uid(a0.get("uid")) or owner
                if u in player_uids:
                    p = vec3(a0.get("pos"))
                    if p is not None:
                        add_sample(u, ts, p, dir3(a0.get("dir")), a0.get("speed"), fn)
            elif fn == "handle_attack_event" and a0 is not None:
                opt = a0.get("opt")
                attack_opt_counts[opt] += 1
                if opt == 2:
                    if a0.get("is_normal_attack") is True:
                        normal_hits += 1
                    tgt = to_int_uid(a0.get("hit_uid"))
                    add_event(ts, "hit_attack", owner, tgt, None,
                              {"skill_id": a0.get("skill_id"), "is_normal_attack": a0.get("is_normal_attack"),
                               "is_shock_hit": a0.get("is_shock_hit")},
                              f"{nm(owner)} 命中 {nm(tgt)}")
            elif fn == "broadcast_hang_param" and a0 is not None:
                victim = to_int_uid(a0.get("hang_uid"))
                butcher = to_int_uid(a0.get("butcher_uid"))
                chair_uid = owner if owner in chair_by_uid else None
                if chair_uid is None and victim in last_pos and chairs:
                    vp = last_pos[victim]
                    chair_uid = min(chairs, key=lambda c: (c["pos"][0] - vp[0]) ** 2 + (c["pos"][2] - vp[2]) ** 2 + (c["pos"][1] - vp[1]) ** 2)["uid"]
                if victim is not None:
                    if victim in open_hang:
                        close_hang(victim, ts, rescued=False)
                    open_hang[victim] = {"chair_uid": chair_uid, "start_t": rel(ts), "end_t": None, "rescued": False,
                                         "raw": [], "victim_uid": victim}
                    hang_open_time[victim] = ts
                    times_chaired[victim] += 1
                    keyframes[victim].add(round(rel(ts), 3))
                add_event(ts, "chair_hang", butcher, victim, chair_uid,
                          {"basement": bool(chair_by_uid[chair_uid]["is_basement"]) if chair_uid in chair_by_uid else None},
                          f"{nm(butcher)} 将 {nm(victim)} 挂上狂欢之椅",
                          pos=static_pos.get(chair_uid) if chair_uid is not None else None)
            elif fn == "client_update_attack_normal" and len(args) >= 3:
                victim = to_int_uid(args[0])
                spd = float(args[1]) if _finite(args[1]) else 0.0
                remain = float(args[2]) if _finite(args[2]) else None
                h = open_hang.get(victim) if victim is not None else None
                if h is not None and remain is not None:
                    elim_pct = max(0.0, min(100.0, 100.0 - remain))
                    prev = h["raw"][-1] if h["raw"] else None
                    h["raw"].append((rel(ts), elim_pct, spd))
                    if prev is None or (prev[2] > 0) != (spd > 0):
                        add_event(ts, "chair_progress", None, victim, h["chair_uid"],
                                  {"elimination_pct": r(elim_pct, 2), "speed": r(spd, 4),
                                   "state": "running" if spd > 0 else "paused"},
                                  f"{nm(victim)} 椅子进度 {elim_pct:.0f}%{'' if spd > 0 else '(暂停)'}")
            elif fn == "client_on_drop_civilian" and args:
                victim = to_int_uid(args[0])
                if victim is not None and victim in open_hang:
                    close_hang(victim, ts, rescued=victim not in elim_t)
            elif fn == "handle_rescure_event" and a0 is not None:
                opt = a0.get("opt")
                saved = to_int_uid(a0.get("saved_uid"))
                if opt == 4:
                    if owner is not None:
                        rescue_attempts[owner] += 1
                    add_event(ts, "rescue_attempt", owner, saved, None,
                              {"save_speed": a0.get("save_speed"), "save_percent": a0.get("save_percent")},
                              f"{nm(owner)} 开始救援 {nm(saved)}")
                elif opt == 3:
                    if owner is not None:
                        rescue_completes[owner] += 1
                    if saved is not None and saved in hang_open_time:
                        rescue_intervals.append((saved, owner if owner is not None else -1, ts - hang_open_time.pop(saved)))
                    hook = to_int_uid(a0.get("hook_uid"))
                    add_event(ts, "rescue_complete", owner, saved, hook, {}, f"{nm(owner)} 救下 {nm(saved)}")
            elif fn == "handle_cure_event" and a0 is not None:
                if a0.get("opt") == 3 and owner is not None:
                    heals[owner] += 1
            elif fn == "client_update_process" and len(args) >= 4 and owner is not None:
                if not _finite(args[0]):
                    continue
                prog = float(args[0])
                spd = float(args[1]) if _finite(args[1]) else 0.0
                fixers = args[2] if isinstance(args[2], dict) else {}
                if not gates_powered:
                    prev_p = cipher_last_prog.get(owner, 0.0)
                    delta_p = prog - prev_p
                    if delta_p > 0 and prev_p < 100.0:
                        active_fix = cipher_last_active.get(owner, (ts, {}))[1] or {
                            to_int_uid(k): float(v) for k, v in fixers.items() if to_int_uid(k) is not None
                        }
                        tot_w = sum(max(0.0, float(w)) for w in active_fix.values())
                        if tot_w > 0:
                            for fu, fw in active_fix.items():
                                cipher_contrib[fu] += delta_p * (max(0.0, float(fw)) / tot_w)
                    if owner in cipher_last_active:
                        t_prev, prev_fix = cipher_last_active[owner]
                        dt_fix = ts - t_prev
                        if 0 < dt_fix < 30.0 and prev_fix:
                            for fu in prev_fix:
                                cipher_decode_time[fu] += dt_fix
                    cur_fix = {to_int_uid(k): float(v) for k, v in fixers.items() if to_int_uid(k) is not None and _finite(v) and float(v) > 0}
                    if cur_fix:
                        cipher_last_active[owner] = (ts, cur_fix)
                    else:
                        cipher_last_active.pop(owner, None)
                    cipher_last_prog[owner] = prog
                    cipher_pre_gate_prog[owner] = prog
                active_cnt = sum(1 for v in fixers.values() if _finite(v) and float(v) > 0)
                if owner in cipher_by_uid:
                    cipher_raw_curve[owner].append((rel(ts), prog, spd, active_cnt))
                    was_active = cipher_active_state.get(owner, False)
                    now_active = active_cnt > 0 and spd > 0
                    first_fixer = next((to_int_uid(k) for k, v in fixers.items() if _finite(v) and float(v) > 0), None)
                    milestone = int(min(prog, 99.999) // 25) * 25
                    if now_active != was_active:
                        add_event(ts, "cipher_progress", first_fixer, None, owner,
                                  {"progress_pct": r(prog, 2), "fixer_count": active_cnt, "state": "start" if now_active else "stop"},
                                  f"密码机{'开始' if now_active else '停止'}破译 {prog:.0f}%")
                    elif milestone > cipher_milestone[owner] and milestone > 0:
                        add_event(ts, "cipher_progress", first_fixer, None, owner,
                                  {"progress_pct": r(prog, 2), "fixer_count": active_cnt, "state": "milestone", "milestone": milestone},
                                  f"密码机破译进度 {milestone}%")
                    cipher_milestone[owner] = max(cipher_milestone[owner], milestone)
                    cipher_active_state[owner] = now_active
            elif fn == "process_fix_compete" and len(args) >= 2:
                fixers_list = [x for x in (to_int_uid(v) for v in (args[0] or [])) if x is not None]
                rem_gen = to_int_uid(args[1])
                if owner is not None:
                    prev_p = cipher_last_prog.get(owner, 0.0)
                    delta_p = max(0.0, 100.0 - prev_p)
                    if delta_p > 0 and fixers_list:
                        share = delta_p / len(fixers_list)
                        for fu in fixers_list:
                            cipher_contrib[fu] += share
                    cipher_last_prog[owner] = 100.0
                    cipher_pre_gate_prog[owner] = 100.0
                for fu in fixers_list:
                    ciphers_finished[fu] += 1
                if rem_gen == 0:
                    gates_powered = True
                if owner in cipher_by_uid:
                    c = cipher_by_uid[owner]
                    if c["completed_at"] is None:
                        c["completed_at"] = r(rel(ts), 3)
                    cipher_raw_curve[owner].append((rel(ts), 100.0, 0.0, 0))
                    cipher_active_state[owner] = False
                add_event(ts, "cipher_complete", fixers_list[0] if fixers_list else None, None, owner,
                          {"remaining_generators": rem_gen, "fixers": ",".join(str(f) for f in fixers_list)},
                          f"密码机破译完成(剩余{rem_gen}台)")
            elif fn == "handle_panel_event" and a0 is not None:
                opt = a0.get("opt")
                obj_u = to_int_uid(a0.get("wood_uid") or a0.get("panel_uid"))
                if opt == 2:
                    if owner is not None:
                        pallet_drops[owner] += 1
                    pl_ = pallet_by_uid.get(obj_u)
                    if pl_ is not None and pl_["dropped_at"] is None:
                        pl_["dropped_at"] = r(rel(ts), 3)
                        pl_["dropped_by_uid"] = owner
                    add_event(ts, "pallet_drop", owner, None, obj_u, {}, f"{nm(owner)} 下板")
                elif opt == 3:
                    if owner is not None:
                        pallet_breaks[owner] += 1
                    pl_ = pallet_by_uid.get(obj_u)
                    if pl_ is not None and pl_["broken_at"] is None:
                        pl_["broken_at"] = r(rel(ts), 3)
                        pl_["broken_by_uid"] = owner
                    add_event(ts, "pallet_break", owner, None, obj_u, {}, f"{nm(owner)} 踩碎木板")
            elif fn == "handle_span_check_event" and a0 is not None:
                obj_u = to_int_uid(a0.get("wood_uid"))
                sut = utype_of(obj_u)
                if sut == 7:
                    if owner is not None:
                        window_vaults[owner] += 1
                    add_event(ts, "vault_window", owner, None, obj_u, {}, f"{nm(owner)} 翻窗")
                elif sut == 8:
                    if owner is not None:
                        pallet_vaults[owner] += 1
                    add_event(ts, "vault_pallet", owner, None, obj_u, {}, f"{nm(owner)} 翻板")
            elif fn == "process_root_motion_event" and a0 is not None and str(a0.get("anim_name") or "").startswith("slide"):
                # Pallet vault (翻板): survivors' 'slide*' root-motion always ends beside an
                # already-dropped pallet (empirically verified across the 7 sample matches).
                ep = vec3(a0.get("end_pos"))
                now = rel(ts)
                cands = [
                    p_ for p_ in pallets
                    if p_["dropped_at"] is not None and p_["dropped_at"] <= now + 0.05
                    and (p_["broken_at"] is None or p_["broken_at"] >= now - 0.05)
                ]
                if ep is not None and cands:
                    best = min(cands, key=lambda p_: math.hypot(p_["pos"][0] - ep[0], p_["pos"][2] - ep[2]))
                    if math.hypot(best["pos"][0] - ep[0], best["pos"][2] - ep[2]) <= 30.0:
                        actor = owner if owner in player_uids else None
                        if actor is not None:
                            pallet_vaults[actor] += 1
                        add_event(ts, "vault_pallet", actor, None, best["uid"],
                                  {"anim_name": str(a0.get("anim_name")), "source": "root_motion"},
                                  f"{nm(actor)} 翻板")
            elif fn == "door_set_can_open":
                gates_powered = True
                targets = [gate_by_uid[owner]] if owner in gate_by_uid else gates
                for g in targets:
                    if g["powered_at"] is None:
                        g["powered_at"] = r(rel(ts), 3)
                add_event(ts, "door_powered", None, None, owner if owner in gate_by_uid else None,
                          {"value": args[0] if args else None, "door_idx": gate_by_uid[owner]["door_idx"] if owner in gate_by_uid else None},
                          "大门通电")
            elif fn == "on_open_door_success" and args:
                opener = to_int_uid(args[0])
                gate_uid = owner if owner in gate_by_uid else None
                if gate_uid is None and gates and opener in last_pos:
                    op = last_pos[opener]
                    gate_uid = min(gates, key=lambda g: (g["pos"][0] - op[0]) ** 2 + (g["pos"][2] - op[2]) ** 2)["uid"]
                if gate_uid is not None:
                    g = gate_by_uid[gate_uid]
                    if g["opened_at"] is None:
                        g["opened_at"] = r(rel(ts), 3)
                        g["opened_by_uid"] = opener
                add_event(ts, "door_opened", opener, None, gate_uid,
                          {"door_idx": gate_by_uid[gate_uid]["door_idx"] if gate_uid in gate_by_uid else None},
                          f"{nm(opener)} 开启大门")
            elif fn == "on_tag_add" and args:
                tag = str(args[0])
                is_fly = "Flywheel" in tag
                if is_fly and owner is not None:
                    if owner not in flywheel_last or ts - flywheel_last[owner] > 1.0:
                        flywheel_uses[owner] += 1
                    flywheel_last[owner] = ts
                add_event(ts, "tag_add", owner, None, None, {"tag": tag, "is_flywheel": is_fly},
                          f"{nm(owner)} 飞轮效应" if is_fly else f"{nm(owner)} 标签 {tag}")

    # close open intervals at match end
    end_abs = t_ref + duration
    for su, st in list(chase_open.items()):
        chase_segments[su].append((st, duration))
    chase_open.clear()
    for victim in list(open_hang):
        close_hang(victim, end_abs, rescued=False)

    # ---------------- dynamic entity curves ----------------
    for cid, raw in cipher_raw_curve.items():
        curve: List[List[float]] = []
        for i, (t, prog, spd, cnt) in enumerate(raw):
            curve.append([r(t, 2), r(prog, 3), cnt])
            if i + 1 < len(raw) and spd > 0 and prog < 100.0:
                nt, nprog = raw[i + 1][0], raw[i + 1][1]
                k = math.floor(t) + 1
                while k < nt:
                    est = min(100.0, prog + spd * (k - t))
                    if nprog >= prog:
                        est = min(est, nprog)
                    curve.append([r(float(k), 2), r(est, 3), cnt])
                    k += 1
        cipher_by_uid[cid]["progress_curve"] = curve
    for cid, c in cipher_by_uid.items():
        c["final_progress"] = r(min(100.0, max(0.0, cipher_pre_gate_prog.get(cid, 0.0))), 4)
        if c["completed_at"] is not None:
            c["final_progress"] = 100.0

    for victim, h in sorted(closed_hangs, key=lambda x: x[1]["start_t"]):
        curve2: List[List[float]] = []
        raw = h["raw"]
        if raw and raw[0][0] > h["start_t"]:
            # hanging animation: bar holds its starting value until the first server tick
            curve2.append([r(h["start_t"], 2), r(raw[0][1], 3)])
        for i, (t, pct, spd) in enumerate(raw):
            curve2.append([r(t, 2), r(pct, 3)])
            nt = raw[i + 1][0] if i + 1 < len(raw) else h["end_t"]
            if spd > 0:
                k = math.floor(t) + 1
                while k < nt:
                    curve2.append([r(float(k), 2), r(min(100.0, pct + spd * (k - t)), 3)])
                    k += 1
        if raw:
            lt, lp, ls = raw[-1]
            endp = min(100.0, lp + max(0.0, ls) * max(0.0, h["end_t"] - lt))
            if h["end_t"] > lt:
                curve2.append([r(h["end_t"], 2), r(endp, 3)])
        rec = {
            "start_t": r(h["start_t"], 3),
            "end_t": r(h["end_t"], 3),
            "victim_uid": victim,
            "rescued": bool(h["rescued"]),
            "progress_curve": curve2,
        }
        if h["chair_uid"] in chair_by_uid:
            chair_by_uid[h["chair_uid"]]["hang_intervals"].append(rec)

    # ---------------- fear state + tracks ----------------
    hang_iv_by_victim: Dict[int, List[Tuple[float, float]]] = collections.defaultdict(list)
    for victim, h in closed_hangs:
        hang_iv_by_victim[victim].append((h["start_t"], h["end_t"]))

    def make_state_fn(uid: int) -> Callable[[float], int]:
        if players[uid]["camp"] == 1:
            return lambda t: 0
        hc = sorted(health_changes.get(uid, []))
        hts = [t for t, _ in hc]
        hvs = [v for _, v in hc]
        ivs = hang_iv_by_victim.get(uid, [])
        e_t = elim_t.get(uid)
        x_t = escape_t.get(uid)

        def fn(t: float) -> int:
            if x_t is not None and t >= x_t:
                return FEAR_ESCAPED
            if e_t is not None and t >= e_t:
                return FEAR_OUT
            for s, e in ivs:
                if s <= t < e:
                    return FEAR_CHAIRED
            i = bisect.bisect_right(hts, t) - 1
            if i < 0:
                return FEAR_HEALTHY
            v = hvs[i]
            return v if v in (0, 1, 2) else FEAR_HEALTHY

        return fn

    tracks: Dict[int, PlayerTrack] = {}
    for uid in sorted(player_uids):
        ent = player_ents.get(uid, {})
        ang = ent.get("angle")
        sd = yaw_to_dir(float(ang)) if _finite(ang) else (0.0, 0.0, 1.0)
        samples = raw_samples.get(uid) or [RawSample(0.0, 0.0, 0.0, 0.0, sd[0], sd[2], 0.0, True, "none")]
        tracks[uid] = PlayerTrack(samples, yaw_samples.get(uid, []), make_state_fn(uid), (sd[0], sd[2]))

    n_steps = int(math.floor(duration * SAMPLE_HZ + 1e-9))
    grid = [round(i / SAMPLE_HZ, 3) for i in range(n_steps + 1)]
    trajectories: Dict[str, List[List[Any]]] = {}
    for uid, tr in tracks.items():
        times = sorted(set(grid) | {k for k in keyframes.get(uid, set()) if 0 <= k <= duration})
        out = []
        for t in times:
            x, y, z, dx, dz, spd, yaw, fs = tr.at(t)
            out.append([r(t, 3), r(x, 2), r(y, 2), r(z, 2), r(dx, 3), r(dz, 3), r(spd, 2), r(yaw, 1), fs])
        trajectories[str(uid)] = out

    # ---------------- world ----------------
    static_pts = [p for p in static_pos.values() if abs(p[1]) <= SENTINEL_ABS_Y]
    move_pts = [(s.x, s.y, s.z) for tr in tracks.values() for s in tr.samples if abs(s.y) <= SENTINEL_ABS_Y]
    all_pts = static_pts + move_pts
    if not all_pts:
        all_pts = [(0.0, 0.0, 0.0)]
    bounds = {
        "min_x": r(min(p[0] for p in all_pts)),
        "max_x": r(max(p[0] for p in all_pts)),
        "min_z": r(min(p[2] for p in all_pts)),
        "max_z": r(max(p[2] for p in all_pts)),
        "min_y": r(min(p[1] for p in all_pts)),
        "max_y": r(max(p[1] for p in all_pts)),
    }
    rect_pts = static_pts or all_pts
    sx0, sx1 = min(p[0] for p in rect_pts), max(p[0] for p in rect_pts)
    sz0, sz1 = min(p[2] for p in rect_pts), max(p[2] for p in rect_pts)
    padx = (sx1 - sx0) * WORLD_RECT_PADDING or 50.0
    padz = (sz1 - sz0) * WORLD_RECT_PADDING or 50.0
    world_rect = {"min_x": r(sx0 - padx), "max_x": r(sx1 + padx), "min_z": r(sz0 - padz), "max_z": r(sz1 + padz)}

    floors: Dict[str, Dict[str, Any]] = {}
    for fid in ("B1", "1F", "2F"):
        ys_static = [p[1] for p in static_pts if classify_floor(p[1]) == fid]
        ys_all = ys_static + [p[1] for p in move_pts if classify_floor(p[1]) == fid]
        lo, hi = FLOOR_NOMINAL[fid]
        if fid == "B1":
            plane = -85.0
        elif fid == "1F":
            plane = 0.0
        else:
            plane = round(statistics.median(ys_static), 1) if ys_static else 60.0
        floors[fid] = {
            "y_min": r(min(ys_all)) if ys_all else lo,
            "y_max": r(max(ys_all)) if ys_all else hi,
            "y_plane": plane,
            "has_entities": bool(ys_static),
        }

    # ---------------- match summary ----------------
    scene_id = to_int_uid(gi.get("scene_id_copy"))
    if scene_id is None:
        scene_id = to_int_uid(ed.get("scene_id")) or 0
    mode_id = to_int_uid(gi.get("match_type"))
    if mode_id is None:
        mode_id = to_int_uid(ti.get("match_type")) or 0
    map_name = REF_MAP_NAMES.get(scene_id, f"未知地图({scene_id})")
    map_asset_url = f"/assets/maps/{map_name}_grid.jpg" if map_name in MAP_ASPECT_RATIOS else None
    save_f = gi.get("game_save_time_float")
    save_f = float(save_f) if _finite(save_f) else float(t_ref + duration)
    save_utc8 = datetime.datetime.fromtimestamp(save_f, tz=UTC8).strftime("%Y-%m-%d %H:%M:%S")
    match_id = str(gi.get("room_guuid") or ti.get("room_guuid") or Path(replay_dir).name)
    recorder = next((p for p in players.values() if p["is_self"]), None)
    rec_camp = to_int_uid(gi.get("unit_type")) or (recorder["camp"] if recorder else 1)
    res_code = to_int_uid(gi.get("res_type")) or 0
    surv_res = [players[u]["res_type"] for u in survivor_uids]
    hunter_p = players.get(hunter_uid) if hunter_uid is not None else None
    summary = {
        "match_id": match_id,
        "mode_id": mode_id,
        "mode_name": REF_MODE_NAMES.get(mode_id, f"未知模式({mode_id})"),
        "scene_id": scene_id,
        "map_name": map_name,
        "map_asset_url": map_asset_url,
        "save_time_utc8": save_utc8,
        "save_time_float": save_f,
        "duration_s": r(duration, 3),
        "recorder_uid": recorder["uid"] if recorder else None,
        "recorder_name": recorder["player_name"] if recorder else str(bi.get("player_name") or ""),
        "recorder_camp": 1 if rec_camp == 1 else 2,
        "result_code": res_code,
        "result_label": RESULT_LABELS.get(res_code, f"未知({res_code})"),
        "self_wdf": to_int_uid(gi.get("self_wdf")) or 0,
        "by_share_get": bool((gi.get("video_extra_info") or {}).get("by_share_get", False)),
        "is_bot_match": any(p["is_bot"] for p in players.values()),
        "survivor_escape_count": sum(1 for x in surv_res if x == 5),
        "survivor_elim_count": sum(1 for x in surv_res if x == 1),
        "survivor_surrender_count": sum(1 for x in surv_res if x == 6),
        "hunter": {
            "uid": hunter_p["uid"] if hunter_p else 0,
            "player_name": hunter_p["player_name"] if hunter_p else "",
            "pid": hunter_p["pid"] if hunter_p else 0,
            "support_skill_ids": list(hunter_p["support_skill_ids"]) if hunter_p else [],
        },
        "survivors": [
            {
                "uid": u,
                "player_name": players[u]["player_name"],
                "pid": players[u]["pid"],
                "res_type": players[u]["res_type"],
                "res_label": players[u]["res_label"],
                "is_bot": players[u]["is_bot"],
            }
            for u in survivor_uids
        ],
        "source": source,
    }

    # ---------------- events + markers ----------------
    events.sort(key=lambda e: e["t"])
    for i, e in enumerate(events):
        e["id"] = i + 1

    markers: List[Dict[str, Any]] = []
    offset = float(first_happen) - t_ref if _finite(first_happen) else 0.0
    for m in ti.get("markers") or []:
        if not isinstance(m, dict) or not _finite(m.get("time")):
            continue
        mtype = m.get("type")
        extra = m.get("extra") or {}
        muid = to_int_uid(extra.get("uid"))
        if mtype == "cipher_done":
            label = f"密码机破译完成(剩余{extra.get('generator_num')}台)"
        elif mtype == "eliminate":
            label = f"{nm(muid)} {'投降' if extra.get('res_type') == 6 else '被淘汰'}"
        elif mtype == "gate_open":
            label = "大门开启"
        else:
            continue
        markers.append({"t": r(float(m["time"]) + offset, 3), "type": mtype, "label_zh": label, "uid": muid})
    if not any(m["type"] == "gate_open" for m in markers):
        for g in gates:
            if g["opened_at"] is not None:
                markers.append({"t": g["opened_at"], "type": "gate_open", "label_zh": "大门开启", "uid": g["uid"]})
    first_chair = next((e for e in events if e["type"] == "chair_hang"), None)
    if first_chair is not None:
        markers.append({"t": first_chair["t"], "type": "first_chair", "label_zh": f"首次上椅: {nm(first_chair['target_uid'])}",
                        "uid": first_chair["target_uid"]})
    first_power = next((e for e in events if e["type"] == "door_powered"), None)
    if first_power is not None:
        markers.append({"t": first_power["t"], "type": "doors_powered", "label_zh": "大门通电", "uid": first_power["object_uid"]})
    markers.sort(key=lambda m: m["t"])

    replay = {
        "schema_version": SCHEMA_VERSION,
        "match": summary,
        "time": {"t_ref_unix": t_ref, "duration_s": r(duration, 3), "sample_hz": SAMPLE_HZ},
        "world": {
            "bounds": bounds,
            "floors": floors,
            "map_underlay": {
                "asset_url": map_asset_url,
                "aspect_ratio": MAP_ASPECT_RATIOS.get(map_name, 1.0),
                "world_rect": world_rect,
            },
        },
        "players": [players[u] for u in sorted(players, key=lambda u: (players[u]["camp"], u))],
        "entities": {
            "ciphers": ciphers,
            "chairs": chairs,
            "chests": chests,
            "exit_gates": gates,
            "windows": windows,
            "pallets": pallets,
            "hatch": hatch,
        },
        "trajectories": trajectories,
        "events": events,
        "markers": markers,
    }

    gen_status = [float(x) for x in (si.get("generator_status") or []) if _finite(x)]
    pursuit = bre.get("pursuit_time") if isinstance(bre, dict) else None
    ctx = MatchContext(
        match_id=match_id,
        t_ref=t_ref,
        duration=duration,
        hunter_uid=hunter_uid,
        survivor_uids=survivor_uids,
        players=players,
        tracks=tracks,
        events=events,
        chase_segments=dict(chase_segments),
        chase_target_seq=chase_target_seq,
        cipher_contrib=dict(cipher_contrib),
        cipher_decode_time=dict(cipher_decode_time),
        ciphers_finished=dict(ciphers_finished),
        cipher_pre_gate_prog=dict(cipher_pre_gate_prog),
        rescue_attempts=dict(rescue_attempts),
        rescue_completes=dict(rescue_completes),
        rescue_intervals=rescue_intervals,
        heals=dict(heals),
        pallet_drops=dict(pallet_drops),
        pallet_breaks=dict(pallet_breaks),
        window_vaults=dict(window_vaults),
        pallet_vaults=dict(pallet_vaults),
        flywheel_uses=dict(flywheel_uses),
        times_chaired=dict(times_chaired),
        normal_hits=normal_hits,
        attack_opt_counts=dict(attack_opt_counts),
        reported_pursuit_s=float(pursuit) if _finite(pursuit) else None,
        generator_status=gen_status,
        stats={
            "pose_sources": dict(pose_stats),
            "unresolved_players": unresolved_players,
            "unresolved_sid_events": unresolved_sid,
            "et_counts": {str(k): v for k, v in et_counts.items()},
            "raw_sample_sources": {
                str(u): dict(collections.Counter(s.src for s in tracks[u].samples)) for u in tracks
            },
            "reported_attack_hit": bre.get("attack_hit") if isinstance(bre, dict) else None,
            "reported_attack_count": bre.get("attack_count") if isinstance(bre, dict) else None,
            "reported_move_distance": si.get("total_move_distance"),
        },
    )
    if unresolved_players > 0:
        logger.warning(
            "Replay %s had %d unresolved player(s) in all_player_result (stats=%s)",
            match_id,
            unresolved_players,
            {
                "unresolved_players": unresolved_players,
                "unresolved_sid_events": unresolved_sid,
                "pose_sources": dict(pose_stats),
            },
        )
    if pose_stats.get("pos_comp_duck", 0) > 0:
        logger.warning(
            "Replay %s resolved %d static entity pose(s) via duck-typed component fallback (components[17] missing)",
            match_id,
            pose_stats["pos_comp_duck"],
        )
    return ctx, replay
