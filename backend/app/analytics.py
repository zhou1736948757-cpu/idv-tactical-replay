"""Phase / player analytics -> canonical ``MatchAnalyticsPayload`` (PLAN.md D1)."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from .extractor import FEAR_ESCAPED, FEAR_OUT, MatchContext, r

KEY_EVENT_EXCLUDE = {"presence_change", "fear_change", "chair_progress", "cipher_progress"}


def merge_intervals(ivs: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
    out: List[Tuple[float, float]] = []
    for s, e in sorted(ivs):
        if e < s:
            continue
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def _first_t(events: List[Dict[str, Any]], pred) -> Optional[float]:
    for e in events:
        if pred(e):
            return e["t"]
    return None


def _attack_swings(ctx: MatchContext, hunter: Optional[Dict[str, Any]]) -> int:
    """Total attack swings (hits + misses).

    The replay RPC stream only carries *hit* confirmations
    (``handle_attack_event``); misses are not observable. When the recorder is
    the hunter, the server-authoritative ``battle_result_extra_info.attack_count``
    is used; otherwise fall back to the RPC-observed normal hits plus non-hit
    attack RPC options.
    """
    rep = ctx.stats.get("reported_attack_count")
    if hunter is not None and hunter.get("is_self") and isinstance(rep, (int, float)) and not isinstance(rep, bool):
        return int(rep)
    non_hit = sum(v for k, v in ctx.attack_opt_counts.items() if k != 2)
    return int(ctx.normal_hits + non_hit)


def build_analytics(ctx: MatchContext) -> Dict[str, Any]:
    ev = ctx.events
    dur = float(ctx.duration)
    hunter = ctx.players.get(ctx.hunter_uid) if ctx.hunter_uid is not None else None

    # ---------------- phases ----------------
    first_chair_t = _first_t(ev, lambda e: e["type"] == "chair_hang")
    first_cipher_t = _first_t(ev, lambda e: e["type"] == "cipher_complete")
    door_powered_t = _first_t(ev, lambda e: e["type"] == "door_powered")
    opening_end = min(x for x in (first_chair_t, first_cipher_t, dur) if x is not None)
    opening_end = max(0.0, min(opening_end, dur))
    mid_end = min(door_powered_t if door_powered_t is not None else dur, dur)
    mid_end = max(mid_end, opening_end)
    bounds = [
        ("opening", "开局博弈", 0.0, opening_end),
        ("midgame", "中期运营", opening_end, mid_end),
        ("endgame", "开门战/残局", mid_end, dur),
    ]
    phases = []
    for i, (pid, label, s, e) in enumerate(bounds):
        last = i == len(bounds) - 1

        def in_phase(t: float, s=s, e=e, last=last) -> bool:
            return s <= t < e or (last and t == e)

        pe = [x for x in ev if in_phase(x["t"])]
        phases.append(
            {
                "phase_id": pid,
                "label_zh": label,
                "start_t": r(s, 3),
                "end_t": r(e, 3),
                "duration_s": r(e - s, 3),
                "ciphers_completed_in_phase": sum(1 for x in pe if x["type"] == "cipher_complete"),
                "hits_in_phase": sum(1 for x in pe if x["type"] == "hit_attack"),
                "chairs_in_phase": sum(1 for x in pe if x["type"] == "chair_hang"),
                "rescues_in_phase": sum(1 for x in pe if x["type"] == "rescue_complete"),
                "key_events_count": sum(1 for x in pe if x["type"] not in KEY_EVENT_EXCLUDE),
            }
        )

    # ---------------- hunter ----------------
    all_segs = [(s, e) for segs in ctx.chase_segments.values() for s, e in segs]
    raw_sum = sum(e - s for s, e in all_segs)
    union_sum = sum(e - s for s, e in merge_intervals(all_segs))
    switches = 0
    last_tgt = None
    for _, su in ctx.chase_target_seq:
        if last_tgt is not None and su != last_tgt:
            switches += 1
        last_tgt = su
    hu = ctx.hunter_uid
    hunter_metrics = {
        "uid": hu,
        "player_name": hunter["player_name"] if hunter else "",
        "pid": hunter["pid"] if hunter else 0,
        "first_chase_t": _first_t(ev, lambda e: e["type"] == "chase_state" and e["meta"].get("flag") is True),
        "first_hit_t": _first_t(ev, lambda e: e["type"] == "hit_attack"),
        "first_down_t": _first_t(ev, lambda e: e["type"] == "health_state_change" and e["meta"].get("fear_state") == 2),
        "first_chair_t": first_chair_t,
        "chase_total_s": r(union_sum, 2),
        "chase_raw_et47_s": r(raw_sum, 2),
        "reported_pursuit_s": r(ctx.reported_pursuit_s, 2) if (ctx.reported_pursuit_s is not None and hunter and hunter["is_self"]) else None,
        "target_switches": switches,
        "normal_hits": ctx.normal_hits,
        "total_attack_swings": _attack_swings(ctx, hunter),
        "pallet_breaks": ctx.pallet_breaks.get(hu, 0) if hu is not None else 0,
        "distance_xz_u": r(ctx.tracks[hu].distance_xz(), 2) if hu in ctx.tracks else 0.0,
    }

    # ---------------- 1Hz distance curve ----------------
    secs = list(range(int(math.floor(dur)) + 1))
    by_surv: Dict[str, List[float]] = {}
    min_dist: Dict[int, Optional[float]] = {}
    htr = ctx.tracks.get(hu) if hu is not None else None
    hpos = [htr.at(float(t)) for t in secs] if htr else []
    for su in ctx.survivor_uids:
        tr = ctx.tracks.get(su)
        if tr is None or not hpos:
            by_surv[str(su)] = [0.0 for _ in secs]
            min_dist[su] = None
            continue
        vals = []
        alive_vals = []
        for i, t in enumerate(secs):
            sp = tr.at(float(t))
            d = math.hypot(sp[0] - hpos[i][0], sp[2] - hpos[i][2])
            vals.append(r(d, 1))
            if sp[7] not in (FEAR_OUT, FEAR_ESCAPED):
                alive_vals.append(d)
        by_surv[str(su)] = vals
        min_dist[su] = r(min(alive_vals), 2) if alive_vals else None

    # ---------------- survivors ----------------
    survivor_metrics = []
    chase_segments_out = []
    for su in ctx.survivor_uids:
        p = ctx.players[su]
        segs = ctx.chase_segments.get(su, [])
        for s, e in sorted(segs):
            chase_segments_out.append(
                {"survivor_uid": su, "survivor_name": p["player_name"], "start_t": r(s, 3), "end_t": r(e, 3), "duration_s": r(e - s, 3)}
            )
        resc_iv = [iv for _victim, rescuer, iv in ctx.rescue_intervals if rescuer == su]
        survivor_metrics.append(
            {
                "uid": su,
                "player_name": p["player_name"],
                "pid": p["pid"],
                "is_bot": p["is_bot"],
                "res_type": p["res_type"],
                "res_label": p["res_label"],
                "cipher_contrib_pct": r(ctx.cipher_contrib.get(su, 0.0), 2),
                "cipher_active_time_s": r(ctx.cipher_decode_time.get(su, 0.0), 2),
                "ciphers_finished": int(ctx.ciphers_finished.get(su, 0)),
                "chased_time_s": r(sum(e - s for s, e in merge_intervals(segs)), 2),
                "rescues_attempted": int(ctx.rescue_attempts.get(su, 0)),
                "rescues_completed": int(ctx.rescue_completes.get(su, 0)),
                "avg_chair_to_rescue_s": r(sum(resc_iv) / len(resc_iv), 2) if resc_iv else None,
                "heals_completed": int(ctx.heals.get(su, 0)),
                "pallet_drops": int(ctx.pallet_drops.get(su, 0)),
                "window_vaults": int(ctx.window_vaults.get(su, 0)),
                "pallet_vaults": int(ctx.pallet_vaults.get(su, 0)),
                "flywheel_uses": int(ctx.flywheel_uses.get(su, 0)),
                "times_chaired": int(ctx.times_chaired.get(su, 0)),
                "distance_xz_u": r(ctx.tracks[su].distance_xz(), 2) if su in ctx.tracks else 0.0,
                "min_dist_to_hunter_u": min_dist.get(su),
            }
        )
    chase_segments_out.sort(key=lambda x: (x["start_t"], x["survivor_uid"]))

    return {
        "match_id": ctx.match_id,
        "phases": phases,
        "hunter_metrics": hunter_metrics,
        "survivor_metrics": survivor_metrics,
        "chase_segments": chase_segments_out,
        "distance_curve_1hz": {"t": secs, "by_survivor_uid": by_surv},
    }
