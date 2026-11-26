#!/usr/bin/env python3
"""Pre-load verified replay folders into ``backend/data/cache``.

Usage:
    python backend/scripts/preload_cache.py [--source DIR] [--cache-dir DIR]

The source directory is only read, never modified.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.extractor import extract_match, find_replay_dirs  # noqa: E402
from app.store import MatchStore  # noqa: E402

DEFAULT_SOURCE = Path(
    r"i:\geminiiii\idv_demo_audit_20261124_002337\work_copy\input_0_media_1795446603161_b0c41fc3\323292579"
)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", default=str(DEFAULT_SOURCE))
    ap.add_argument("--cache-dir", default=None)
    ap.add_argument("--only", action="append", default=[], help="Restrict to match id(s)")
    args = ap.parse_args()

    store = MatchStore(Path(args.cache_dir) if args.cache_dir else None)
    dirs = find_replay_dirs(Path(args.source))
    if args.only:
        dirs = [d for d in dirs if d.name in set(args.only)]
    results = []
    errors = 0
    for d in dirs:
        t0 = time.time()
        try:
            replay, analytics = extract_match(d, source="preloaded")
            store.save(replay, analytics)
            results.append(
                {
                    "match_id": replay["match"]["match_id"],
                    "map": replay["match"]["map_name"],
                    "players": len(replay["players"]),
                    "events": len(replay["events"]),
                    "seconds": round(time.time() - t0, 2),
                }
            )
        except Exception as exc:  # noqa: BLE001
            errors += 1
            results.append({"match_id": d.name, "error": f"{type(exc).__name__}: {exc}"})
    print(json.dumps({"cache_dir": str(store.cache_dir), "results": results, "errors": errors}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
