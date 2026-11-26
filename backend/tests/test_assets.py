"""AC-7: real GitHub asset sync helpers + on-disk verification."""

import json

import pytest

from conftest import ASSETS_DIR
from app.asset_sync import (
    AssetSyncError,
    category_of,
    detect_image_type,
    safe_rel_path,
    verify_asset_dir,
    write_verified,
)


def test_detect_image_type_magic_bytes():
    assert detect_image_type(b"\xff\xd8\xff\xe0rest") == "jpeg"
    assert detect_image_type(b"\x89PNG\r\n\x1a\nrest") == "png"
    # UTF-16LE-corrupted JPEG header (what PowerShell '>' redirection produces) must be rejected
    assert detect_image_type(b"\xff\xfe\xfd\xff") is None
    assert detect_image_type(b"") is None


def test_write_verified_rejects_non_images(tmp_path):
    with pytest.raises(AssetSyncError):
        write_verified(tmp_path, "maps/x_grid.jpg", b"<html>not an image</html>")
    assert not (tmp_path / "maps" / "x_grid.jpg").exists()


@pytest.mark.parametrize("rel", ["../escape.jpg", "/abs.jpg", "C:/x.jpg", "maps/../../x.jpg"])
def test_safe_rel_path_rejects_traversal(rel):
    with pytest.raises(AssetSyncError):
        safe_rel_path(rel)


def test_category_mapping():
    assert category_of("bg.jpg") == "bg"
    assert category_of("seal.jpg") == "seal"
    assert category_of("maps/永眠镇_grid.jpg") == "maps"
    assert category_of("hunters/x.png") == "hunters"
    assert category_of("maps/notes.txt") is None


def test_verify_reports_missing_manifest(tmp_path):
    rep = verify_asset_dir(tmp_path)
    assert rep["ok"] is False and "manifest.json missing" in rep["errors"]


@pytest.mark.skipif(not (ASSETS_DIR / "manifest.json").is_file(), reason="assets not synced yet (run backend/scripts/sync_github_assets.py)")
def test_real_github_assets_valid():
    rep = verify_asset_dir(ASSETS_DIR)
    assert rep["ok"], rep["errors"]
    assert rep["counts"] == {"bg": 1, "seal": 1, "maps": 9, "hunters": 36} or all(
        rep["counts"][k] >= n for k, n in {"bg": 1, "seal": 1, "maps": 9, "hunters": 36}.items()
    )
    manifest = json.loads((ASSETS_DIR / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["repo"] == "zhou1736948757-cpu/notes"
    for e in manifest["files"]:
        data = (ASSETS_DIR / e["path"]).read_bytes()
        assert len(data) > 0
        if e["path"].endswith(".png"):
            assert data.startswith(b"\x89PNG\r\n\x1a\n")
        else:
            assert data.startswith(b"\xff\xd8\xff")


@pytest.mark.skipif(not (ASSETS_DIR / "manifest.json").is_file(), reason="assets not synced yet")
def test_cached_map_asset_urls_resolve_to_synced_files():
    from conftest import CACHE_DIR, VERIFIED_MATCH_IDS

    for mid in VERIFIED_MATCH_IDS:
        summary = json.loads((CACHE_DIR / mid / "summary.json").read_text(encoding="utf-8"))
        url = summary["map_asset_url"]
        assert url and url.startswith("/assets/maps/")
        assert (ASSETS_DIR / url[len("/assets/"):]).is_file(), url
