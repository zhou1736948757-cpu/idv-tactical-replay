#!/usr/bin/env python3
"""Download real visual assets from GitHub ``zhou1736948757-cpu/notes``.

    python backend/scripts/sync_github_assets.py            # download + verify
    python backend/scripts/sync_github_assets.py --verify-only

Writes ``frontend/public/assets/{bg.jpg,seal.jpg,maps/*_grid.jpg,hunters/*.png,manifest.json}``.
Requires an authenticated ``gh`` CLI (``gh auth status``). Image bytes are
written by Python only (never via PowerShell ``>`` redirection).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.asset_sync import REPO, AssetSyncError, sync_assets, verify_asset_dir  # noqa: E402

DEFAULT_DEST = BACKEND_DIR.parent / "frontend" / "public" / "assets"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dest", default=str(DEFAULT_DEST))
    ap.add_argument("--repo", default=REPO)
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()
    dest = Path(args.dest)
    if args.verify_only:
        report = verify_asset_dir(dest)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report["ok"] else 1
    try:
        manifest = sync_assets(dest, args.repo)
    except AssetSyncError as exc:
        print(f"ASSET SYNC FAILED: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"counts": manifest["counts"], "verify": manifest["verify"]}, ensure_ascii=False, indent=2))
    return 0 if manifest["verify"]["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
