"""AC-1 + Pack B: pickle + ZIP security hardening + literal STACK_GLOBAL & duck-type pose tests."""

import ast
import collections
import io
import logging
import pickle
import zipfile

import pytest

from conftest import BACKEND_DIR
from app import archive
from app.archive import UnsafeArchiveError, safe_extract_zip
from app.extractor import build_replay, unit_manager_comp17, unit_manager_duck_pose_comp
from app.safe_pickle import SafeObjectId, SafePickleAuditError, audit_pickle_bytes, safe_unpickle_bytes


def _py_files():
    return [p for p in BACKEND_DIR.rglob("*.py") if "__pycache__" not in p.parts]


def test_no_unrestricted_pickle_load_anywhere_in_backend():
    offenders = []
    for path in _py_files():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr in ("load", "loads"):
                if isinstance(node.value, ast.Name) and node.value.id in ("pickle", "cPickle", "_pickle"):
                    offenders.append(f"{path}:{node.lineno}")
            if isinstance(node, ast.ImportFrom) and node.module in ("pickle", "cPickle", "_pickle"):
                if any(a.name in ("load", "loads", "Unpickler") for a in node.names):
                    offenders.append(f"{path}:{node.lineno} from-import")
    assert offenders == []


def test_rejects_os_system_global_with_reduce():
    # protocol 2: GLOBAL 'os system' ; MARK 'echo pwned' TUPLE ; REDUCE ; STOP
    payload = b"\x80\x02cos\nsystem\nq\x00X\n\x00\x00\x00echo pwnedq\x01\x85q\x02Rq\x03."
    info = audit_pickle_bytes(payload)
    assert info["disallowed_items"] and info["disallowed_items"][0]["module"] == "os"
    with pytest.raises(SafePickleAuditError, match="Disallowed"):
        safe_unpickle_bytes(payload)


def test_rejects_reduce_with_non_whitelisted_builtin():
    payload = b"\x80\x02cbuiltins\neval\nq\x00X\x03\x00\x00\x001+1q\x01\x85q\x02Rq\x03."
    with pytest.raises(SafePickleAuditError, match="builtins"):
        safe_unpickle_bytes(payload)


def test_rejects_stack_global_opcode():
    data = pickle.dumps(collections.OrderedDict(a=1), protocol=4)
    info = audit_pickle_bytes(data)
    assert any(d["opcode"] == "STACK_GLOBAL" for d in info["disallowed_items"])
    with pytest.raises(SafePickleAuditError):
        safe_unpickle_bytes(data)


def test_accepts_safe_literal_stack_global_and_rejects_malicious_stack_global():
    # 1. Safe literal STACK_GLOBAL (raw SHORT_BINUNICODE + SHORT_BINUNICODE + STACK_GLOBAL -> builtins.set([1, 2]))
    raw_safe = b"\x80\x04\x8c\x08builtins\x8c\x03set\x93]\x94(K\x01K\x02e\x85R."
    out_set, info_set = safe_unpickle_bytes(raw_safe)
    assert out_set == {1, 2}
    assert not info_set["disallowed_items"]
    assert any(g["opcode"] == "STACK_GLOBAL" and g["module"] == "builtins" and g["name"] == "set" for g in info_set["globals_found"])

    # 2. Safe literal STACK_GLOBAL with standard Pickle Protocol 4 MEMOIZE between strings (bson.objectid.ObjectId)
    oid_raw = bytes.fromhex("6b04323a84b889718100f507")
    proto4_oid = (
        b"\x80\x04"
        b"\x8c\rbson.objectid\x94"
        b"\x8c\x08ObjectId\x94"
        b"\x93\x94"
        b"C\x0c" + oid_raw + b"\x94"
        b"\x85\x94R\x94."
    )
    out_oid, info_oid = safe_unpickle_bytes(proto4_oid)
    assert isinstance(out_oid, SafeObjectId) and out_oid.hex_str() == "6b04323a84b889718100f507"
    assert not info_oid["disallowed_items"]

    # 3. Malicious literal STACK_GLOBAL targeting os.system -> rejected!
    evil_literal = b"\x80\x04\x8c\x02os\x94\x8c\x06system\x94\x93\x8c\x04exit\x85R."
    info_evil = audit_pickle_bytes(evil_literal)
    assert any(d["opcode"] == "STACK_GLOBAL" and d.get("module") == "os" for d in info_evil["disallowed_items"])
    with pytest.raises(SafePickleAuditError, match="STACK_GLOBAL"):
        safe_unpickle_bytes(evil_literal)

    # 4. Non-literal STACK_GLOBAL (operand fetched via BINGET from memo instead of literal string opcode) -> rejected!
    non_literal_memo = b"\x80\x04\x8c\x08builtins\x940h\x00\x8c\x03set\x93."
    info_non_lit = audit_pickle_bytes(non_literal_memo)
    assert any(d["opcode"] == "STACK_GLOBAL" for d in info_non_lit["disallowed_items"])
    with pytest.raises(SafePickleAuditError, match="STACK_GLOBAL"):
        safe_unpickle_bytes(non_literal_memo)


@pytest.mark.parametrize("data", [b"", b"PK\x03\x04garbage", b"\x80\x02\xff\xff\xff"])
def test_rejects_empty_non_pickle_and_corrupt(data):
    with pytest.raises(SafePickleAuditError):
        safe_unpickle_bytes(data)


def test_accepts_whitelisted_passive_stream():
    obj = {"uid": 1000037, "tags": {1, 2}, "raw": b"\x00\xffabc", 17: [1.5, None, True]}
    data = pickle.dumps(obj, protocol=2)  # uses _codecs.encode + builtins.set
    out, info = safe_unpickle_bytes(data)
    assert out == obj
    assert info["protocol"] == 2 and not info["disallowed_items"]


def _zip_bytes(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data, mode in entries:
            zi = zipfile.ZipInfo(name)
            if mode is not None:
                zi.external_attr = mode << 16
            zf.writestr(zi, data)
    return buf.getvalue()


@pytest.mark.parametrize("name", ["../evil.txt", "a/../../evil.txt", "/abs/evil.txt", "C:/evil.txt", "..\\evil.txt"])
def test_zip_traversal_and_absolute_paths_rejected(tmp_path, name):
    data = _zip_bytes([(name, b"x", None)])
    with pytest.raises(UnsafeArchiveError):
        safe_extract_zip(data, tmp_path / "out")
    assert not (tmp_path / "evil.txt").exists()


def test_zip_symlink_rejected(tmp_path):
    data = _zip_bytes([("link", b"/etc/passwd", 0o120777)])
    with pytest.raises(UnsafeArchiveError, match="Symlink"):
        safe_extract_zip(data, tmp_path / "out")


def test_zip_oversized_entry_and_total_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(archive, "MAX_ENTRY_BYTES", 1000)
    with pytest.raises(UnsafeArchiveError, match="max size"):
        safe_extract_zip(_zip_bytes([("big.bin", b"\0" * 5000, None)]), tmp_path / "a")
    monkeypatch.setattr(archive, "MAX_ENTRY_BYTES", 10_000)
    monkeypatch.setattr(archive, "MAX_TOTAL_UNCOMP_BYTES", 6000)
    with pytest.raises(UnsafeArchiveError, match="total"):
        safe_extract_zip(_zip_bytes([("a.bin", b"\0" * 4000, None), ("b.bin", b"\0" * 4000, None)]), tmp_path / "b")
    assert not (tmp_path / "b" / "a.bin").exists(), "nothing may be written before full validation"


def test_zip_valid_archive_extracts_from_bytes_path_and_stream(tmp_path):
    data = _zip_bytes([("m/game_info.txt", b"abc", None), ("m/sub/", b"", None)])

    # 1. From bytes
    info1 = safe_extract_zip(data, tmp_path / "ok_bytes")
    assert (tmp_path / "ok_bytes" / "m" / "game_info.txt").read_bytes() == b"abc"
    assert info1["files_written"] == 1

    # 2. From Path on disk
    zfile = tmp_path / "sample.zip"
    zfile.write_bytes(data)
    info2 = safe_extract_zip(zfile, tmp_path / "ok_path")
    assert (tmp_path / "ok_path" / "m" / "game_info.txt").read_bytes() == b"abc"
    assert info2["files_written"] == 1

    # 3. From open BinaryIO handle (must not close caller's stream)
    with open(zfile, "rb") as fh:
        info3 = safe_extract_zip(fh, tmp_path / "ok_stream")
        assert not fh.closed
    assert info3["files_written"] == 1


def test_extractor_duck_type_pose_fallback_and_unresolved_player_warning(tmp_path, caplog):
    # Renumber component 17 -> 99 and include 1 unresolved player in all_player_result
    um = {
        3001: {
            "components": {
                5: {"pos": [0.0, -65536.0, 0.0]},  # sentinel y rejected
                99: {"pos": [12.5, 0.0, -34.0], "dir": [0.0, 0.0, 2.0]},
            }
        }
    }
    assert unit_manager_comp17(um, 3001) is None
    duck = unit_manager_duck_pose_comp(um, 3001)
    assert duck is not None and duck["pos"] == [12.5, 0.0, -34.0]

    t0 = 1700000000.0
    rdir = tmp_path / "duck_match"
    rdir.mkdir()
    gi = {
        "room_guuid": "abcdef0123456789abcdef99",
        "scene_id_copy": 101,
        "match_type": 1,
        "game_save_time_float": t0 + 30.0,
        "self_result": {"base_info": {"start_time": t0}},
        "all_player_result": [
            {"unique_id": "99990001", "player_name": "SurvA", "pid": 201, "utype": 2, "res_type": 5, "is_self": True},
            {"unique_id": "ghost_missing", "player_name": "Ghost", "pid": 999, "utype": 2, "res_type": 1, "is_self": False},
        ],
    }
    ti = {"room_guuid": "abcdef0123456789abcdef99", "first_happen_time": t0}
    snap0 = {
        "data": [
            {
                "snap_shot": {
                    "event_data": {
                        "scene_id": 101,
                        "start_game_time": t0,
                        "combat_core_info": {"manager_info": {"UnitManager": um}},
                        "entities": {
                            1001: {"uid": 1001, "unit_type": 2, "unique_id": "99990001", "player_name": "SurvA", "pid": 201, "pos": [0.0, 0.0, 0.0]},
                        },
                        "entities_in_scene": {
                            3001: {"uid": 3001, "unit_type": 8, "model_name": "pallet_duck"},
                        },
                    }
                },
                "battle_event": [
                    [t0 + 2.0, {"et": 201, "uid": 1001, "pos": [3.0, 0.0, 4.0], "dir": [0.0, 0.0, 1.0], "speed": 45.0}],
                ],
            }
        ]
    }
    (rdir / "game_info.txt").write_bytes(pickle.dumps(gi, protocol=2))
    (rdir / "total_info.txt").write_bytes(pickle.dumps(ti, protocol=2))
    (rdir / "battle_frames_snapshot_0.txt").write_bytes(pickle.dumps(snap0, protocol=2))

    with caplog.at_level(logging.WARNING):
        ctx, replay = build_replay(rdir, "uploaded")

    assert ctx.stats["unresolved_players"] == 1
    assert ctx.stats["pose_sources"]["pos_comp_duck"] == 1
    assert replay["entities"]["pallets"][0]["pos"] == [12.5, 0.0, -34.0]
    assert replay["entities"]["pallets"][0]["dir"] == [0.0, 0.0, 1.0]
    assert any("unresolved player" in rec.message for rec in caplog.records)
    assert any("duck-typed component fallback" in rec.message for rec in caplog.records)
