"""AC-6 + Pack B: REST API, streaming ZIP upload, ETag/304, env hardening, and multi-worker store safety."""

from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
import pickle
import re
import shutil
import zipfile

import pytest
from fastapi.testclient import TestClient

from conftest import (
    BOT_MATCH,
    CACHE_DIR,
    PID102_MATCH,
    SOURCE_DIR,
    VERIFIED_MATCH_IDS,
    requires_source,
)
from app import archive
from app.main import create_app
from app.store import MatchStore


@pytest.fixture(scope="module")
def client():
    return TestClient(create_app(CACHE_DIR))


@pytest.fixture()
def upload_client(tmp_path):
    return TestClient(create_app(tmp_path / "cache"))


def _replay_zip(mid=BOT_MATCH, prefix="323292579/"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted((SOURCE_DIR / mid).iterdir()):
            zf.write(p, f"{prefix}{mid}/{p.name}")
    return buf.getvalue()


def _synthetic_replay_files(room_guuid: str, map_scene_id: int = 101, player_name: str = "TestSurv", unique_id: str | None = "98765432"):
    """Build minimal valid pickle dicts for game_info, total_info, and snapshot_0."""
    t0 = 1700000000.0
    gi = {
        "room_guuid": room_guuid,
        "scene_id_copy": map_scene_id,
        "match_type": 1,
        "game_save_time_float": t0 + 60.0,
        "unit_type": 2,
        "res_type": 5,
        "self_wdf": 1,
        "self_result": {"base_info": {"start_time": t0, "player_name": player_name}, "spec_info": {}, "battle_result_extra_info": {}},
        "all_player_result": [
            {"unique_id": unique_id, "player_name": player_name, "pid": 201, "utype": 2, "res_type": 5, "is_self": True},
            {"unique_id": "11112222", "player_name": "TestHunter", "pid": 101, "utype": 1, "res_type": 9, "is_self": False},
        ],
    }
    ti = {"room_guuid": room_guuid, "first_happen_time": t0, "match_type": 1, "markers": []}
    snap0 = {
        "data": [
            {
                "snap_shot": {
                    "event_data": {
                        "scene_id": map_scene_id,
                        "start_game_time": t0,
                        "combat_core_info": {
                            "manager_info": {
                                "UnitManager": {
                                    3001: {"components": {17: {"pos": [10.0, 0.0, 20.0], "dir": [0.0, 0.0, 1.0]}}},
                                }
                            }
                        },
                        "entities": {
                            1001: {
                                "uid": 1001,
                                "unit_type": 2,
                                "unique_id": unique_id,
                                "player_name": player_name,
                                "pid": 201,
                                "pos": [0.0, 0.0, 0.0],
                                "angle": 0.0,
                            },
                            1002: {
                                "uid": 1002,
                                "unit_type": 1,
                                "unique_id": "11112222",
                                "player_name": "TestHunter",
                                "pid": 101,
                                "pos": [50.0, 0.0, 50.0],
                                "angle": 90.0,
                            },
                        },
                        "entities_in_scene": {
                            3001: {"uid": 3001, "unit_type": 3, "pos_id": 1, "model_name": "cipher"},
                        },
                    }
                },
                "battle_event": [
                    [t0 + 1.0, {"et": 201, "uid": 1001, "pos": [5.0, 0.0, 5.0], "dir": [1.0, 0.0, 0.0], "speed": 45.0}],
                    [t0 + 10.0, {"et": 42, "uid": 1001, "data": {"res_type": 5}}],
                ],
            }
        ]
    }
    return (
        pickle.dumps(gi, protocol=2),
        pickle.dumps(ti, protocol=2),
        pickle.dumps(snap0, protocol=2),
    )


def _synthetic_zip(folders: list[tuple[str, str]], player_name: str = "TestSurv", unique_id: str | None = "98765432") -> bytes:
    """Create a ZIP containing one or more (folder_name, room_guuid) synthetic replays."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for folder, guuid in folders:
            gi_b, ti_b, s0_b = _synthetic_replay_files(guuid, player_name=player_name, unique_id=unique_id)
            zf.writestr(f"{folder}/game_info.txt", gi_b)
            zf.writestr(f"{folder}/total_info.txt", ti_b)
            zf.writestr(f"{folder}/battle_frames_snapshot_0.txt", s0_b)
    return buf.getvalue()


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["preloaded_matches"] == 7 and body["cache_dir"]
    assert r.headers.get("access-control-allow-origin") is None or True


def test_cors_enabled(client):
    r = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert r.headers.get("access-control-allow-origin") in ("*", "http://localhost:5173")


def test_list_matches_sorted(client):
    r = client.get("/api/matches")
    assert r.status_code == 200
    ms = r.json()["matches"]
    assert sorted(m["match_id"] for m in ms) == sorted(VERIFIED_MATCH_IDS)
    keys = [(-m["save_time_float"], m["match_id"]) for m in ms]
    assert keys == sorted(keys)


def test_get_replay_and_analytics(client):
    r = client.get(f"/api/matches/{PID102_MATCH}/replay")
    assert r.status_code == 200
    rp = r.json()
    assert rp["schema_version"] == "1.0" and rp["match"]["match_id"] == PID102_MATCH
    r2 = client.get(f"/api/matches/{PID102_MATCH}/analytics")
    assert r2.status_code == 200 and r2.json()["match_id"] == PID102_MATCH


def test_etag_and_304_not_modified(client):
    for endpoint in ("replay", "analytics"):
        url = f"/api/matches/{PID102_MATCH}/{endpoint}"
        r1 = client.get(url)
        assert r1.status_code == 200
        etag = r1.headers.get("etag")
        assert etag and re.match(r'^"[0-9a-f]+-[0-9a-f]+"$', etag), etag
        assert r1.headers.get("cache-control") == "private, max-age=60"

        # Exact strong ETag -> 304 Not Modified with empty body
        r304 = client.get(url, headers={"If-None-Match": etag})
        assert r304.status_code == 304
        assert r304.content == b""
        assert r304.headers.get("etag") == etag

        # Weak ETag from reverse proxy gzip -> also honored as 304
        r304_weak = client.get(url, headers={"If-None-Match": f"W/{etag}"})
        assert r304_weak.status_code == 304
        assert r304_weak.content == b""

        # Stale ETag -> full 200 payload
        r200 = client.get(url, headers={"If-None-Match": '"deadbeef-0"'})
        assert r200.status_code == 200
        assert len(r200.content) > 100


@pytest.mark.parametrize(
    "path",
    [
        "/api/matches/ffffffffffffffffffffffff/replay",
        "/api/matches/..%2F..%2Fsecret/analytics",
        "/api/matches/nothex/replay",
    ],
)
def test_missing_match_404(client, path):
    r = client.get(path)
    assert r.status_code == 404
    assert "detail" in r.json()


@requires_source
def test_upload_multipart(upload_client):
    data = _replay_zip()
    r = upload_client.post("/api/replays/upload", files={"file": ("replay.zip", data, "application/zip")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["uploaded_count"] == 1 and body["match_ids"] == [BOT_MATCH]
    assert body["matches"][0]["source"] == "uploaded"
    assert upload_client.get(f"/api/matches/{BOT_MATCH}/replay").status_code == 200
    assert upload_client.get(f"/api/matches/{BOT_MATCH}/analytics").status_code == 200
    assert [m["match_id"] for m in upload_client.get("/api/matches").json()["matches"]] == [BOT_MATCH]


@requires_source
@pytest.mark.parametrize("ctype", ["application/zip", "application/octet-stream"])
def test_upload_raw_binary_body(upload_client, ctype):
    r = upload_client.post("/api/replays/upload", content=_replay_zip(), headers={"Content-Type": ctype})
    assert r.status_code == 200, r.text
    assert r.json()["match_ids"] == [BOT_MATCH]


def test_upload_traversal_zip_rejected(upload_client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("../../escape.txt", b"x")
    r = upload_client.post("/api/replays/upload", files={"file": ("bad.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 400 and "Unsafe" in r.json()["detail"]


def test_upload_oversized_entry_rejected(upload_client, monkeypatch):
    monkeypatch.setattr(archive, "MAX_ENTRY_BYTES", 100)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("big.bin", b"\0" * 10_000)
    r = upload_client.post("/api/replays/upload", content=buf.getvalue(), headers={"Content-Type": "application/zip"})
    assert r.status_code == 400


@pytest.mark.parametrize("payload", [b"", b"not a zip at all"])
def test_upload_non_zip_rejected(upload_client, payload):
    r = upload_client.post("/api/replays/upload", content=payload, headers={"Content-Type": "application/octet-stream"})
    assert r.status_code == 400
    assert isinstance(r.json()["detail"], str)


def test_upload_zip_without_replay_422(upload_client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", b"hello")
    r = upload_client.post("/api/replays/upload", content=buf.getvalue(), headers={"Content-Type": "application/zip"})
    assert r.status_code == 422


def test_upload_malicious_pickle_rejected_422(upload_client):
    evil = b"\x80\x02cos\nsystem\nq\x00X\x04\x00\x00\x00exitq\x01\x85q\x02Rq\x03."
    benign = pickle.dumps({"data": []}, protocol=2)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("m/game_info.txt", evil)
        zf.writestr("m/total_info.txt", benign)
        zf.writestr("m/battle_frames_snapshot_0.txt", benign)
    r = upload_client.post("/api/replays/upload", files={"file": ("evil.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 422
    assert "Unsafe pickle" in r.json()["detail"]
    assert upload_client.get("/api/matches").json()["matches"] == []


def test_upload_multipart_missing_file_field(upload_client):
    r = upload_client.post("/api/replays/upload", files={"other": ("x.zip", b"PK\x03\x04", "application/zip")})
    assert r.status_code == 400


@pytest.mark.parametrize("bad_guuid", ["../../escape_room", "not-hex-at-all", "ABCDEF0123456789abcdef01", "deadbeef"])
def test_upload_malformed_room_guuid_returns_422_not_500(upload_client, bad_guuid):
    payload = _synthetic_zip([("m1", bad_guuid)])
    r = upload_client.post("/api/replays/upload", files={"file": ("bad_id.zip", payload, "application/zip")})
    assert r.status_code == 422, r.text
    assert "Invalid match_id" in r.json()["detail"]
    assert upload_client.get("/api/matches").json()["matches"] == []


def test_preloaded_match_overwrite_rejected_409_and_mixed_batch_skipped(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    preloaded_id = VERIFIED_MATCH_IDS[0]
    shutil.copytree(CACHE_DIR / preloaded_id, cache / preloaded_id)
    orig_replay_bytes = (cache / preloaded_id / "replay_2d.json").read_bytes()
    orig_summary_bytes = (cache / preloaded_id / "summary.json").read_bytes()

    tc = TestClient(create_app(cache))

    # 1. Spoofed replay claiming preloaded match_id -> 409 Conflict (even in dev)
    spoof_zip = _synthetic_zip([("spoof", preloaded_id)], player_name="Defacer")
    r_spoof = tc.post("/api/replays/upload", files={"file": ("spoof.zip", spoof_zip, "application/zip")})
    assert r_spoof.status_code == 409, r_spoof.text
    assert preloaded_id in r_spoof.json()["detail"]
    assert (cache / preloaded_id / "replay_2d.json").read_bytes() == orig_replay_bytes
    assert (cache / preloaded_id / "summary.json").read_bytes() == orig_summary_bytes

    # 2. Mixed batch (1 preloaded + 1 fresh uploaded match) -> skips preloaded, saves fresh
    fresh_id = "0123456789abcdef01234567"
    mixed_zip = _synthetic_zip([("pre", preloaded_id), ("fresh", fresh_id)], player_name="MixedPlayer")
    r_mixed = tc.post("/api/replays/upload", files={"file": ("mixed.zip", mixed_zip, "application/zip")})
    assert r_mixed.status_code == 200, r_mixed.text
    assert r_mixed.json()["match_ids"] == [fresh_id]
    assert (cache / preloaded_id / "replay_2d.json").read_bytes() == orig_replay_bytes

    # 3. Direct MatchStore.save() defense-in-depth refuses to overwrite preloaded match
    store = MatchStore(cache)
    with pytest.raises(PermissionError, match="preloaded"):
        store.save({"match": {"match_id": preloaded_id, "source": "uploaded"}}, {"match_id": preloaded_id})

    # 4. In IDV_ENV=production, any single preloaded upload returns 409 Conflict
    monkeypatch.setenv("IDV_ENV", "production")
    r_prod = tc.post("/api/replays/upload", files={"file": ("spoof2.zip", spoof_zip, "application/zip")})
    assert r_prod.status_code == 409


def test_streaming_upload_413_size_cap_and_tmp_cleanup(tmp_path, monkeypatch):
    tmp_upload_dir = tmp_path / "custom_tmp"
    monkeypatch.setenv("IDV_TMP_DIR", str(tmp_upload_dir))
    monkeypatch.setenv("IDV_MAX_UPLOAD_BYTES", "512")

    tc = TestClient(create_app(tmp_path / "cache"))
    oversized = b"PK\x03\x04" + (b"A" * 2048)

    # Raw binary upload > 512 bytes -> 413
    r_raw = tc.post("/api/replays/upload", content=oversized, headers={"Content-Type": "application/zip"})
    assert r_raw.status_code == 413

    # Multipart upload > 512 bytes (even if Content-Length is stripped/chunked) -> 413
    r_mp = tc.post("/api/replays/upload", files={"file": ("big.zip", oversized, "application/zip")})
    assert r_mp.status_code == 413

    # Verify temporary upload folders under IDV_TMP_DIR were cleaned up
    if tmp_upload_dir.exists():
        assert list(tmp_upload_dir.iterdir()) == []


def test_upload_max_matches_per_upload_guard(tmp_path, monkeypatch):
    monkeypatch.setenv("IDV_MAX_MATCHES_PER_UPLOAD", "2")
    tc = TestClient(create_app(tmp_path / "cache"))
    three_zip = _synthetic_zip(
        [
            ("m1", "111111111111111111111111"),
            ("m2", "222222222222222222222222"),
            ("m3", "333333333333333333333333"),
        ]
    )
    r = tc.post("/api/replays/upload", files={"file": ("three.zip", three_zip, "application/zip")})
    assert r.status_code == 400
    assert "exceeding maximum of 2" in r.json()["detail"]


def test_production_env_controls_health_docs_public_uploads_and_uid_redaction(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    preloaded_id = VERIFIED_MATCH_IDS[0]
    shutil.copytree(CACHE_DIR / preloaded_id, cache / preloaded_id)

    monkeypatch.setenv("IDV_ENV", "production")
    monkeypatch.setenv("IDV_PUBLIC_UPLOADS", "0")
    monkeypatch.setenv("IDV_REDACT_UID", "1")
    monkeypatch.setenv("IDV_CORS_ORIGINS", "https://replay.example.com")

    tc = TestClient(create_app(cache))

    # 1. /api/health omits cache_dir in production
    h = tc.get("/api/health").json()
    assert h == {"status": "ok", "preloaded_matches": 1}
    assert "cache_dir" not in h

    # 2. /docs, /redoc, /openapi.json disabled in production by default
    for doc_path in ("/docs", "/redoc", "/openapi.json"):
        assert tc.get(doc_path).status_code == 404

    # 3. CORS allowlist enforced
    r_ok_origin = tc.get("/api/health", headers={"Origin": "https://replay.example.com"})
    assert r_ok_origin.headers.get("access-control-allow-origin") == "https://replay.example.com"
    r_bad_origin = tc.get("/api/health", headers={"Origin": "https://evil.example.org"})
    assert r_bad_origin.headers.get("access-control-allow-origin") is None

    # 4. Upload new match with IDV_PUBLIC_UPLOADS=0 & IDV_REDACT_UID=1
    up_id = "abcdef0123456789abcdef01"
    raw_uid = "323292579"
    up_zip = _synthetic_zip([("u1", up_id)], player_name="AnonPlayer", unique_id=raw_uid)
    r_up = tc.post("/api/replays/upload", files={"file": ("u.zip", up_zip, "application/zip")})
    assert r_up.status_code == 200, r_up.text

    # Excluded from public GET /api/matches list, while preloaded remains listed
    listed_ids = [m["match_id"] for m in tc.get("/api/matches").json()["matches"]]
    assert listed_ids == [preloaded_id]

    # Direct share link still works, and unique_id is masked
    rp = tc.get(f"/api/matches/{up_id}/replay")
    assert rp.status_code == 200
    rp_json = rp.json()
    surv = next(p for p in rp_json["players"] if p["player_name"] == "AnonPlayer")
    assert surv["unique_id"] != raw_uid
    assert surv["unique_id"].startswith("***")
    assert raw_uid not in rp.text


def test_multiworker_unique_temp_write_summary_index_and_lru_eviction(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    preloaded_id = VERIFIED_MATCH_IDS[0]
    shutil.copytree(CACHE_DIR / preloaded_id, cache / preloaded_id)

    observed_tmp_names: list[str] = []
    real_replace = os.replace

    def spy_replace(src, dst):
        observed_tmp_names.append(os.path.basename(str(src)))
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", spy_replace)
    store = MatchStore(cache, max_uploaded_matches=2)

    def _mk_payload(mid: str, save_t: float):
        summary = {"match_id": mid, "save_time_float": save_t, "source": "uploaded", "map_name": "军工厂"}
        return {"schema_version": "1.0", "match": summary}, {"match_id": mid}

    # 1. Verify unique .<name>.<pid>.<hex8>.tmp atomic write pattern & concurrent thread safety
    m1 = "100000000000000000000001"
    with ThreadPoolExecutor(max_workers=4) as pool:
        futs = [pool.submit(store.save, *_mk_payload(m1, 100.0 + i)) for i in range(8)]
        for f in futs:
            assert f.result()["match_id"] == m1

    assert observed_tmp_names
    pid_str = str(os.getpid())
    for name in observed_tmp_names:
        assert re.match(rf"^\.(replay_2d|analytics|summary)\.json\.{pid_str}\.[0-9a-f]{{8}}\.tmp$", name), name
    # Zero leftover .tmp files
    assert [p.name for p in (cache / m1).iterdir() if p.name.endswith(".tmp")] == []

    # 2. Verify (match_id, summary_mtime_ns) summary index avoids disk JSON re-parsing
    first_list = store.list_summaries()
    assert {m["match_id"] for m in first_list} == {preloaded_id, m1}

    read_calls = 0
    orig_read_text = type(cache).read_text

    def counting_read_text(self, *args, **kwargs):
        nonlocal read_calls
        read_calls += 1
        return orig_read_text(self, *args, **kwargs)

    monkeypatch.setattr(type(cache), "read_text", counting_read_text)
    second_list = store.list_summaries()
    assert read_calls == 0
    assert [m["match_id"] for m in second_list] == [m["match_id"] for m in first_list]
    monkeypatch.setattr(type(cache), "read_text", orig_read_text)

    # 3. Verify LRU quota=2: touch m1 after saving m2 so m2 becomes LRU and gets evicted when m3 is saved
    m2 = "200000000000000000000002"
    m3 = "300000000000000000000003"
    store.save(*_mk_payload(m2, 200.0))
    assert store.get_replay(m1) is not None  # touches m1 -> m2 is now oldest accessed
    store.save(*_mk_payload(m3, 300.0))

    remaining = {m["match_id"] for m in store.list_summaries()}
    assert remaining == {preloaded_id, m1, m3}
    assert not (cache / m2).exists()
    assert (cache / preloaded_id).is_dir()
