import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

REPO_ROOT = BACKEND_DIR.parent
CACHE_DIR = BACKEND_DIR / "data" / "cache"
ASSETS_DIR = REPO_ROOT / "frontend" / "public" / "assets"
SOURCE_DIR = Path(
    r"i:\geminiiii\idv_demo_audit_20261124_002337\work_copy\input_0_media_1795446603161_b0c41fc3\323292579"
)

VERIFIED_MATCH_IDS = [
    "6aff067e1ffac0fc9666d563",
    "6b0014eb54fd12fd2b16667d",
    "6b04323a84b889718100f507",
    "6b04349384b8897181051f2a",
    "6b04364084b889718108247f",
    "6b043a0d84b88971810ec20b",
    "6b043c0584b889718112042a",
]
RANKED_MATCH_IDS = [m for m in VERIFIED_MATCH_IDS if m.startswith("6b04")]
PID102_MATCH = "6b04364084b889718108247f"
BOT_MATCH = "6b0014eb54fd12fd2b16667d"

requires_source = pytest.mark.skipif(not SOURCE_DIR.is_dir(), reason="read-only audit replay source not present")


@pytest.fixture(scope="session")
def cached():
    import json

    out = {}
    for mid in VERIFIED_MATCH_IDS:
        d = CACHE_DIR / mid
        out[mid] = {
            "replay": json.loads((d / "replay_2d.json").read_text(encoding="utf-8")),
            "analytics": json.loads((d / "analytics.json").read_text(encoding="utf-8")),
        }
    return out


@pytest.fixture(scope="session")
def pid102_fresh():
    from app.analytics import build_analytics
    from app.extractor import build_replay

    ctx, replay = build_replay(SOURCE_DIR / PID102_MATCH)
    return ctx, replay, build_analytics(ctx)
