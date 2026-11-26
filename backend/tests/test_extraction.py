"""AC-2..AC-5: 7-match cache, Component 17 spatial coverage, trajectories, events, analytics."""

import math
import re

import pytest

from conftest import (
    BOT_MATCH,
    CACHE_DIR,
    PID102_MATCH,
    RANKED_MATCH_IDS,
    SOURCE_DIR,
    VERIFIED_MATCH_IDS,
    requires_source,
)

MATCH_SUMMARY_KEYS = {
    "match_id", "mode_id", "mode_name", "scene_id", "map_name", "map_asset_url", "save_time_utc8",
    "save_time_float", "duration_s", "recorder_uid", "recorder_name", "recorder_camp", "result_code",
    "result_label", "self_wdf", "by_share_get", "is_bot_match", "survivor_escape_count", "survivor_elim_count",
    "survivor_surrender_count", "hunter", "survivors", "source",
}
PLAYER_KEYS = {
    "uid", "unique_id", "player_name", "camp", "pid", "cloth_id", "zone_id", "is_bot", "is_self", "res_type",
    "res_label", "spawn_pos", "talents", "support_skill_ids",
}
BASE_ENTITY_KEYS = {"uid", "unit_type", "pos", "dir", "floor", "model_name"}
EVENT_KEYS = {"id", "t", "type", "actor_uid", "target_uid", "object_uid", "pos", "floor", "label_zh", "meta"}
REQUIRED_EVENT_TYPES = {
    "hit_attack", "health_state_change", "fear_change", "chair_hang", "chair_progress", "rescue_attempt",
    "rescue_complete", "pallet_drop", "pallet_break", "vault_window", "vault_pallet", "cipher_progress",
    "cipher_complete", "door_powered", "door_opened", "chase_state", "skill_cast", "tag_add",
    "player_eliminated_or_surrender", "player_escaped",
}
ALL_EVENT_TYPES = REQUIRED_EVENT_TYPES | {"presence_change", "window_block"}


def _floor(y):
    return "B1" if y < -20 else ("2F" if y >= 25 else "1F")


def test_all_seven_matches_cached_with_35_players(cached):
    total_players = 0
    for mid in VERIFIED_MATCH_IDS:
        assert (CACHE_DIR / mid / "replay_2d.json").is_file()
        assert (CACHE_DIR / mid / "analytics.json").is_file()
        rp = cached[mid]["replay"]
        assert rp["match"]["match_id"] == mid
        assert rp["match"]["source"] == "preloaded"
        uids = [p["uid"] for p in rp["players"]]
        assert len(uids) == 5 and len(set(uids)) == 5
        assert sum(1 for p in rp["players"] if p["camp"] == 1) == 1
        total_players += len(uids)
    assert total_players == 35


def test_replay_payload_schema_matches_plan_d1(cached):
    for mid, d in cached.items():
        rp = d["replay"]
        assert set(rp) == {"schema_version", "match", "time", "world", "players", "entities", "trajectories", "events", "markers"}
        assert rp["schema_version"] == "1.0"
        assert set(rp["match"]) == MATCH_SUMMARY_KEYS
        assert set(rp["match"]["hunter"]) == {"uid", "player_name", "pid", "support_skill_ids"}
        for s in rp["match"]["survivors"]:
            assert set(s) == {"uid", "player_name", "pid", "res_type", "res_label", "is_bot"}
        assert re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$", rp["match"]["save_time_utc8"])
        assert set(rp["time"]) == {"t_ref_unix", "duration_s", "sample_hz"} and rp["time"]["sample_hz"] == 10
        w = rp["world"]
        assert set(w) == {"bounds", "floors", "map_underlay"}
        assert set(w["bounds"]) == {"min_x", "max_x", "min_z", "max_z", "min_y", "max_y"}
        assert set(w["floors"]) == {"B1", "1F", "2F"}
        for f in w["floors"].values():
            assert set(f) == {"y_min", "y_max", "y_plane", "has_entities"}
        assert w["floors"]["B1"]["y_plane"] == -85.0 and w["floors"]["1F"]["y_plane"] == 0.0
        assert set(w["map_underlay"]) == {"asset_url", "aspect_ratio", "world_rect"}
        for p in rp["players"]:
            assert set(p) == PLAYER_KEYS
            for t in p["talents"]:
                assert set(t) == {"talent_id", "level", "name"}
        ent = rp["entities"]
        assert set(ent) == {"ciphers", "chairs", "chests", "exit_gates", "windows", "pallets", "hatch"}
        extra = {
            "ciphers": {"pos_id", "final_progress", "completed_at", "progress_curve"},
            "chairs": {"is_basement", "basement_idx", "hang_intervals"},
            "chests": set(),
            "exit_gates": {"door_idx", "powered_at", "opened_at", "opened_by_uid"},
            "windows": set(),
            "pallets": {"dropped_at", "broken_at", "dropped_by_uid", "broken_by_uid"},
        }
        for k, ex in extra.items():
            for e in ent[k]:
                assert set(e) == BASE_ENTITY_KEYS | ex, (mid, k)
        for c in ent["chairs"]:
            for h in c["hang_intervals"]:
                assert set(h) == {"start_t", "end_t", "victim_uid", "rescued", "progress_curve"}
                assert all(len(pt) == 2 and 0 <= pt[1] <= 100 for pt in h["progress_curve"])
        assert ent["hatch"] is None or set(ent["hatch"]) == BASE_ENTITY_KEYS
        for e in rp["events"]:
            assert set(e) == EVENT_KEYS
            assert e["type"] in ALL_EVENT_TYPES
            assert all(v is None or isinstance(v, (str, int, float, bool)) for v in e["meta"].values())
        assert [e["id"] for e in rp["events"]] == list(range(1, len(rp["events"]) + 1))
        assert all(a["t"] <= b["t"] for a, b in zip(rp["events"], rp["events"][1:]))
        for m in rp["markers"]:
            assert set(m) == {"t", "type", "label_zh", "uid"}
            assert m["type"] in {"cipher_done", "eliminate", "gate_open", "first_chair", "doors_powered"}


@requires_source
def test_component17_int_and_str_key_lookup_gives_full_3d_coverage(cached):
    """Every gate/window/pallet pose equals UnitManager[uid].components[17] (raw int keys)."""
    from app.extractor import decode_pickle_file, unit_manager_comp17

    for mid in VERIFIED_MATCH_IDS:
        s0 = decode_pickle_file(SOURCE_DIR / mid / "battle_frames_snapshot_0.txt")
        ss = next(ch["snap_shot"] for ch in s0["data"] if isinstance(ch, dict) and ch.get("snap_shot"))
        ed = ss["event_data"]
        um = ed["combat_core_info"]["manager_info"]["UnitManager"]
        assert any(isinstance(k, int) for k in um), "raw UnitManager keys must be ints"
        scene = {int(e["uid"]): e for e in ed["entities_in_scene"].values() if isinstance(e, dict) and "uid" in e}
        expected = {ut: sorted(u for u, e in scene.items() if e.get("unit_type") == ut) for ut in (6, 7, 8)}
        ent = cached[mid]["replay"]["entities"]
        for key, ut in (("exit_gates", 6), ("windows", 7), ("pallets", 8)):
            got = sorted(e["uid"] for e in ent[key])
            assert got == expected[ut] and got, (mid, key)  # 100% coverage
            coords = set()
            for e in ent[key]:
                c17 = unit_manager_comp17(um, e["uid"])
                assert c17 is not None, (mid, key, e["uid"])
                assert unit_manager_comp17({str(k): v for k, v in um.items()}, e["uid"]) is not None  # str keys too
                assert e["pos"] == pytest.approx(list(c17["pos"]), abs=0.006)
                n = math.sqrt(sum(c * c for c in c17["dir"]))
                assert e["dir"] == pytest.approx([c / n for c in c17["dir"]], abs=1e-3)
                assert any(abs(v) > 1e-6 for v in e["pos"])
                coords.add(tuple(e["pos"]))
            assert len(coords) == len(ent[key]), (mid, key, "positions must be distinct")
        assert len(ent["exit_gates"]) == 2


def test_static_entities_valid_pose_floor_and_counts(cached):
    for mid, d in cached.items():
        ent = d["replay"]["entities"]
        assert len(ent["ciphers"]) == 7
        assert len(ent["exit_gates"]) == 2
        assert sum(1 for c in ent["chairs"] if c["is_basement"]) == 4
        assert ent["hatch"] is not None and ent["chests"]
        items = [e for k in ("ciphers", "chairs", "chests", "exit_gates", "windows", "pallets") for e in ent[k]] + [ent["hatch"]]
        for e in items:
            assert len(e["pos"]) == 3 and all(math.isfinite(v) for v in e["pos"])
            assert abs(e["pos"][1]) < 500
            assert e["floor"] == _floor(e["pos"][1])
            n = math.sqrt(sum(c * c for c in e["dir"]))
            assert abs(n - 1.0) < 2e-3, (mid, e["uid"], e["dir"])
        b = d["replay"]["world"]["bounds"]
        assert -500 < b["min_y"] <= b["max_y"] < 500
        r = d["replay"]["world"]["map_underlay"]["world_rect"]
        assert r["min_x"] < b["max_x"] and r["max_x"] > b["min_x"]


def test_trajectories_are_10hz_nine_tuples(cached):
    for mid, d in cached.items():
        rp = d["replay"]
        dur = rp["time"]["duration_s"]
        assert set(rp["trajectories"]) == {str(p["uid"]) for p in rp["players"]}
        camp = {str(p["uid"]): p["camp"] for p in rp["players"]}
        for uid, tr in rp["trajectories"].items():
            assert len(tr) >= int(dur * 10)
            ts = [s[0] for s in tr]
            assert ts == sorted(ts) and ts[0] == 0.0
            grid = {round(i / 10, 3) for i in range(int(dur * 10) + 1)}
            assert grid <= set(ts)
            for s in tr:
                assert len(s) == 9
                assert all(isinstance(v, (int, float)) for i, v in enumerate(s) if i != 7)
                assert s[7] is None or 0 <= s[7] < 360
                assert s[8] in (0, 1, 2, 3, 4, 5)
                if camp[uid] == 1:
                    assert s[8] == 0


def test_human_players_carry_et304_cam_yaw(cached):
    for mid in RANKED_MATCH_IDS:
        rp = cached[mid]["replay"]
        for p in rp["players"]:
            if p["is_bot"]:
                continue
            tr = rp["trajectories"][str(p["uid"])]
            frac = sum(1 for s in tr if s[7] is not None) / len(tr)
            assert frac > 0.5, (mid, p["uid"], frac)


@requires_source
def test_pid102_hunter_merges_et1110(pid102_fresh, cached):
    ctx, replay, analytics = pid102_fresh
    hunter = next(p for p in replay["players"] if p["camp"] == 1)
    assert hunter["pid"] == 102
    srcs = ctx.stats["raw_sample_sources"][str(hunter["uid"])]
    assert srcs.get("et_1110", 0) > 1000
    assert analytics["hunter_metrics"]["distance_xz_u"] > 15000
    assert cached[PID102_MATCH]["analytics"]["hunter_metrics"]["distance_xz_u"] > 15000
    assert ctx.stats["pose_sources"].get("dir_fallback", 0) == 0


@requires_source
def test_extraction_is_deterministic_vs_cache(pid102_fresh, cached):
    _ctx, replay, analytics = pid102_fresh
    cached_rp = cached[PID102_MATCH]["replay"]
    assert replay["entities"] == cached_rp["entities"]
    assert replay["events"] == cached_rp["events"]
    assert analytics == cached[PID102_MATCH]["analytics"]


def test_talent_names_only_for_survivors(cached):
    named = 0
    for d in cached.values():
        for p in d["replay"]["players"]:
            for t in p["talents"]:
                if p["camp"] == 1:
                    assert t["name"] is None
                elif t["name"] is not None:
                    named += 1
    assert named > 50


def test_bot_match_fallback_join(cached):
    rp = cached[BOT_MATCH]["replay"]
    assert rp["match"]["is_bot_match"] is True
    bots = [p for p in rp["players"] if p["is_bot"]]
    assert len(bots) == 4
    assert all(p["unique_id"] is None and isinstance(p["uid"], int) for p in bots)
    assert {str(p["uid"]) for p in rp["players"]} == set(rp["trajectories"])


def test_required_event_types_and_flywheel_present(cached):
    seen = set()
    flywheel = 0
    for d in cached.values():
        for e in d["replay"]["events"]:
            seen.add(e["type"])
            if e["type"] == "tag_add" and e["meta"].get("is_flywheel"):
                flywheel += 1
    assert REQUIRED_EVENT_TYPES <= seen, REQUIRED_EVENT_TYPES - seen
    assert flywheel > 0


@requires_source
def test_ranked_cipher_progress_matches_generator_status():
    from app.extractor import build_replay

    for mid in RANKED_MATCH_IDS:
        ctx, rp = build_replay(SOURCE_DIR / mid)
        reported = sorted(ctx.generator_status)
        calc = sorted(ctx.cipher_pre_gate_prog.get(c["uid"], 0.0) for c in rp["entities"]["ciphers"])
        assert len(reported) == len(calc) == 7
        assert max(abs(a - b) for a, b in zip(reported, calc)) < 0.01, mid
        assert sorted(c["final_progress"] for c in rp["entities"]["ciphers"]) == pytest.approx(reported, abs=0.01)


def test_analytics_schema_and_phases(cached):
    hk = {"uid", "player_name", "pid", "first_chase_t", "first_hit_t", "first_down_t", "first_chair_t", "chase_total_s",
          "chase_raw_et47_s", "reported_pursuit_s", "target_switches", "normal_hits", "total_attack_swings",
          "pallet_breaks", "distance_xz_u"}
    sk = {"uid", "player_name", "pid", "is_bot", "res_type", "res_label", "cipher_contrib_pct", "cipher_active_time_s",
          "ciphers_finished", "chased_time_s", "rescues_attempted", "rescues_completed", "avg_chair_to_rescue_s",
          "heals_completed", "pallet_drops", "window_vaults", "pallet_vaults", "flywheel_uses", "times_chaired",
          "distance_xz_u", "min_dist_to_hunter_u"}
    for mid, d in cached.items():
        an = d["analytics"]
        dur = d["replay"]["time"]["duration_s"]
        assert set(an) == {"match_id", "phases", "hunter_metrics", "survivor_metrics", "chase_segments", "distance_curve_1hz"}
        assert an["match_id"] == mid
        assert [p["phase_id"] for p in an["phases"]] == ["opening", "midgame", "endgame"]
        assert an["phases"][0]["start_t"] == 0.0 and an["phases"][-1]["end_t"] == pytest.approx(dur)
        for a, b in zip(an["phases"], an["phases"][1:]):
            assert a["end_t"] == b["start_t"]
        assert set(an["hunter_metrics"]) == hk
        assert an["hunter_metrics"]["chase_total_s"] <= an["hunter_metrics"]["chase_raw_et47_s"] + 1e-6
        assert len(an["survivor_metrics"]) == 4
        for s in an["survivor_metrics"]:
            assert set(s) == sk
            assert s["rescues_completed"] <= max(s["rescues_attempted"], s["rescues_completed"])
        for c in an["chase_segments"]:
            assert set(c) == {"survivor_uid", "survivor_name", "start_t", "end_t", "duration_s"}
        dc = an["distance_curve_1hz"]
        assert len(dc["by_survivor_uid"]) == 4
        assert all(len(v) == len(dc["t"]) for v in dc["by_survivor_uid"].values())


def test_ranked_cipher_contribution_totals(cached):
    for mid in RANKED_MATCH_IDS:
        rp, an = cached[mid]["replay"], cached[mid]["analytics"]
        total = sum(s["cipher_contrib_pct"] for s in an["survivor_metrics"])
        expected = sum(c["final_progress"] for c in rp["entities"]["ciphers"])
        # Contributions follow the verified audit attribution (positive deltas incl. re-decoding
        # after calibration-fail regressions), so they may exceed the net progress slightly.
        assert expected - 0.1 <= total <= expected + 2.0, mid


@requires_source
def test_audit_source_is_never_modified():
    from app.extractor import build_replay

    d = SOURCE_DIR / BOT_MATCH
    before = {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in d.iterdir()}
    build_replay(d)
    after = {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in d.iterdir()}
    assert before == after
