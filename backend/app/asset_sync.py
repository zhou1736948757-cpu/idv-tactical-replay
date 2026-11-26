"""Real visual asset sync from GitHub repo ``zhou1736948757-cpu/notes``.

Binary bytes are always handled in Python (``subprocess`` stdout bytes /
base64 blob decode) and written with ``open(..., 'wb')`` -- never through a
shell text redirection, which would corrupt images on Windows PowerShell.
Every written file is verified by magic header (JPEG ``FF D8 FF`` / PNG
``89 50 4E 47 0D 0A 1A 0A``) and recorded with size + SHA-256 in
``manifest.json``.
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Dict, List, Optional

REPO = "zhou1736948757-cpu/notes"
JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
EXPECTED_COUNTS = {"bg": 1, "seal": 1, "maps": 9, "hunters": 36}
UTC8 = datetime.timezone(datetime.timedelta(hours=8))


class AssetSyncError(RuntimeError):
    pass


def detect_image_type(data: bytes) -> Optional[str]:
    if data.startswith(JPEG_MAGIC):
        return "jpeg"
    if data.startswith(PNG_MAGIC):
        return "png"
    return None


def safe_rel_path(rel: str) -> PurePosixPath:
    p = PurePosixPath(rel.replace("\\", "/"))
    if p.is_absolute() or ".." in p.parts or any(":" in part for part in p.parts) or not p.parts:
        raise AssetSyncError(f"Unsafe asset path: {rel!r}")
    return p


def write_verified(dest_root: Path, rel: str, data: bytes) -> Dict[str, Any]:
    """Verify magic header then atomically write raw bytes under ``dest_root``."""
    rp = safe_rel_path(rel)
    kind = detect_image_type(data)
    if not data or kind is None:
        raise AssetSyncError(f"{rel}: not a JPEG/PNG (head={data[:8].hex()}, size={len(data)})")
    target = Path(dest_root).joinpath(*rp.parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".part")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, target)
    written = target.read_bytes()
    if written != data:
        raise AssetSyncError(f"{rel}: byte mismatch after write")
    return entry_for(rp.as_posix(), written)


def entry_for(rel: str, data: bytes) -> Dict[str, Any]:
    return {
        "path": rel,
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "image_type": detect_image_type(data),
        "header_hex": data[:8].hex(),
    }


def category_of(rel: str) -> Optional[str]:
    p = PurePosixPath(rel)
    if p.as_posix() == "bg.jpg":
        return "bg"
    if p.as_posix() == "seal.jpg":
        return "seal"
    if len(p.parts) == 2 and p.parts[0] == "maps" and p.name.endswith("_grid.jpg"):
        return "maps"
    if len(p.parts) == 2 and p.parts[0] == "hunters" and p.suffix.lower() == ".png":
        return "hunters"
    return None


def verify_asset_dir(dest_root: Path) -> Dict[str, Any]:
    """Verify ``manifest.json`` against on-disk files. Returns a report dict."""
    dest_root = Path(dest_root)
    man_path = dest_root / "manifest.json"
    report: Dict[str, Any] = {"ok": False, "errors": [], "counts": {k: 0 for k in EXPECTED_COUNTS}}
    if not man_path.is_file():
        report["errors"].append("manifest.json missing")
        return report
    manifest = json.loads(man_path.read_text(encoding="utf-8"))
    for e in manifest.get("files", []):
        rel = e.get("path", "")
        try:
            rp = safe_rel_path(rel)
        except AssetSyncError as exc:
            report["errors"].append(str(exc))
            continue
        f = dest_root.joinpath(*rp.parts)
        if not f.is_file():
            report["errors"].append(f"{rel}: missing on disk")
            continue
        data = f.read_bytes()
        kind = detect_image_type(data)
        if kind is None or len(data) == 0:
            report["errors"].append(f"{rel}: invalid image header {data[:8].hex()}")
        if len(data) != e.get("size_bytes") or hashlib.sha256(data).hexdigest() != e.get("sha256"):
            report["errors"].append(f"{rel}: size/sha256 mismatch with manifest")
        cat = category_of(rel)
        if cat:
            report["counts"][cat] += 1
    for k, n in EXPECTED_COUNTS.items():
        if report["counts"][k] < n:
            report["errors"].append(f"expected >= {n} {k} images, found {report['counts'][k]}")
    report["ok"] = not report["errors"]
    return report


# ---------------------------------------------------------------------------
# GitHub transport
# ---------------------------------------------------------------------------


def _retry(fn: Callable[[], Any], attempts: int = 4, base_delay: float = 1.5) -> Any:
    last: Optional[BaseException] = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            last = exc
            if i + 1 < attempts:
                time.sleep(base_delay * (2**i))
    raise AssetSyncError(f"gave up after {attempts} attempts: {last}")


def gh_api_bytes(endpoint: str, accept: Optional[str] = None, timeout: int = 90) -> bytes:
    cmd = ["gh", "api", endpoint]
    if accept:
        cmd += ["-H", f"Accept: {accept}"]
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if proc.returncode != 0:
        raise AssetSyncError(f"gh api {endpoint} failed: {proc.stderr.decode('utf-8', 'replace').strip()[:300]}")
    return proc.stdout


def gh_api_json(endpoint: str) -> Any:
    return json.loads(gh_api_bytes(endpoint).decode("utf-8"))


def list_dir(repo: str, path: str) -> List[Dict[str, Any]]:
    data = _retry(lambda: gh_api_json(f"repos/{repo}/contents/{path}"))
    if not isinstance(data, list):
        raise AssetSyncError(f"contents/{path} did not return a directory listing")
    return data


def fetch_file_bytes(repo: str, item: Dict[str, Any]) -> bytes:
    """Blob API (base64) -> raw media type -> download_url fallback."""
    sha = item.get("sha")
    path = item.get("path")

    def via_blob() -> bytes:
        blob = gh_api_json(f"repos/{repo}/git/blobs/{sha}")
        if blob.get("encoding") != "base64":
            raise AssetSyncError(f"unexpected blob encoding {blob.get('encoding')}")
        return base64.b64decode(blob["content"])

    def via_raw() -> bytes:
        return gh_api_bytes(f"repos/{repo}/contents/{path}", accept="application/vnd.github.raw")

    def via_download() -> bytes:
        url = item.get("download_url")
        if not url:
            raise AssetSyncError("no download_url")
        with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310 - fixed https GitHub URL
            return resp.read()

    errors = []
    for fn in (via_blob, via_raw, via_download):
        try:
            data = _retry(fn, attempts=3)
            if detect_image_type(data) is not None and (item.get("size") in (None, len(data))):
                return data
            errors.append(f"{fn.__name__}: bad header/size ({len(data)} bytes, head={data[:8].hex()})")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{fn.__name__}: {exc}")
    raise AssetSyncError(f"{path}: all transports failed: {errors}")


def sync_assets(dest_root: Path, repo: str = REPO, log: Callable[[str], None] = print) -> Dict[str, Any]:
    dest_root = Path(dest_root)
    dest_root.mkdir(parents=True, exist_ok=True)
    wanted: List[tuple] = []
    top = list_dir(repo, "assets")
    for it in top:
        if it.get("type") == "file" and it.get("name") in ("bg.jpg", "seal.jpg"):
            wanted.append((it["name"], it))
    for sub, pred in (("maps", lambda n: n.endswith("_grid.jpg")), ("hunters", lambda n: n.lower().endswith(".png"))):
        for it in list_dir(repo, f"assets/{sub}"):
            if it.get("type") == "file" and pred(it.get("name", "")):
                wanted.append((f"{sub}/{it['name']}", it))
    entries = []
    for rel, it in sorted(wanted, key=lambda x: x[0]):
        data = fetch_file_bytes(repo, it)
        e = write_verified(dest_root, rel, data)
        e["source_path"] = it.get("path")
        e["git_sha"] = it.get("sha")
        entries.append(e)
        log(f"ok {rel} {e['size_bytes']}B {e['image_type']}")
    counts = {k: sum(1 for e in entries if category_of(e["path"]) == k) for k in EXPECTED_COUNTS}
    manifest = {
        "repo": repo,
        "generated_at": datetime.datetime.now(UTC8).isoformat(),
        "transport": "gh api (blob base64 / raw media type) with Python byte writes",
        "counts": counts,
        "files": entries,
    }
    (dest_root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    report = verify_asset_dir(dest_root)
    manifest["verify"] = report
    return manifest
