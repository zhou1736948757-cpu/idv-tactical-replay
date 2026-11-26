"""Disk cache store for extracted matches with multi-worker atomic writes, summary index cache, and LRU quota."""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CACHE_DIR = BACKEND_DIR / "data" / "cache"
MATCH_ID_RE = re.compile(r"^[0-9a-f]{24}$")
DEFAULT_MAX_UPLOADED_MATCHES = 500


def default_cache_dir() -> Path:
    env = os.environ.get("IDV_CACHE_DIR")
    return Path(env) if env else DEFAULT_CACHE_DIR


def _max_uploaded_matches(explicit: Optional[int] = None) -> int:
    if explicit is not None:
        return explicit
    raw = os.environ.get("IDV_MAX_UPLOADED_MATCHES")
    if raw is not None and raw.strip():
        try:
            return int(raw.strip())
        except ValueError:
            pass
    return DEFAULT_MAX_UPLOADED_MATCHES


def dump_compact(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class MatchStore:
    """``<cache>/<match_id>/{replay_2d.json, analytics.json, summary.json}``."""

    def __init__(self, cache_dir: Optional[Path] = None, max_uploaded_matches: Optional[int] = None) -> None:
        self.cache_dir = Path(cache_dir) if cache_dir else default_cache_dir()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._explicit_max_uploaded = max_uploaded_matches
        self._lock = threading.RLock()
        self._summary_cache: Dict[Tuple[str, int], Dict[str, Any]] = {}
        self._summary_mtime_by_id: Dict[str, int] = {}
        self._last_access_ns: Dict[str, int] = {}
        self._hlc_ns: int = 0

    def _next_access_ns(self, floor_ns: int = 0) -> int:
        cand = max(time.time_ns(), floor_ns, self._hlc_ns + 1)
        self._hlc_ns = cand
        return cand

    @staticmethod
    def valid_id(match_id: str) -> bool:
        return bool(MATCH_ID_RE.match(match_id or ""))

    def match_dir(self, match_id: str) -> Path:
        if not self.valid_id(match_id):
            raise KeyError(match_id)
        return self.cache_dir / match_id

    def touch(self, match_id: str) -> None:
        if not self.valid_id(match_id):
            return
        with self._lock:
            floor = self._summary_mtime_by_id.get(match_id, 0)
            self._last_access_ns[match_id] = self._next_access_ns(floor)

    def _atomic_write_json(self, target_dir: Path, name: str, obj: Any) -> Path:
        tmp_name = f".{name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
        tmp_path = target_dir / tmp_name
        payload = dump_compact(obj)
        try:
            tmp_path.write_text(payload, encoding="utf-8")
            os.replace(tmp_path, target_dir / name)
        except Exception:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        return target_dir / name

    def save(self, replay: Dict[str, Any], analytics: Dict[str, Any]) -> Dict[str, Any]:
        match_id = replay["match"]["match_id"]
        d = self.match_dir(match_id)
        with self._lock:
            existing = self.get_summary(match_id)
            if existing and existing.get("source") == "preloaded":
                raise PermissionError(f"Refusing to overwrite preloaded match: {match_id}")
            d.mkdir(parents=True, exist_ok=True)
            summary_path: Optional[Path] = None
            for name, obj in (
                ("replay_2d.json", replay),
                ("analytics.json", analytics),
                ("summary.json", replay["match"]),
            ):
                written_path = self._atomic_write_json(d, name, obj)
                if name == "summary.json":
                    summary_path = written_path
            mtime_ns = 0
            if summary_path is not None:
                try:
                    mtime_ns = summary_path.stat().st_mtime_ns
                except OSError:
                    mtime_ns = time.time_ns()
                old_mtime = self._summary_mtime_by_id.get(match_id)
                if old_mtime is not None and old_mtime != mtime_ns:
                    self._summary_cache.pop((match_id, old_mtime), None)
                self._summary_mtime_by_id[match_id] = mtime_ns
                self._summary_cache[(match_id, mtime_ns)] = dict(replay["match"])
            self._last_access_ns[match_id] = self._next_access_ns(mtime_ns)
            if replay["match"].get("source") == "uploaded":
                self._enforce_upload_quota(protect_id=match_id)
        return dict(replay["match"])

    def _evict_cache_entries(self, match_id: str) -> None:
        old_mtime = self._summary_mtime_by_id.pop(match_id, None)
        if old_mtime is not None:
            self._summary_cache.pop((match_id, old_mtime), None)
        stale_keys = [k for k in self._summary_cache if k[0] == match_id]
        for k in stale_keys:
            self._summary_cache.pop(k, None)
        self._last_access_ns.pop(match_id, None)

    def _enforce_upload_quota(self, protect_id: Optional[str] = None) -> List[str]:
        quota = _max_uploaded_matches(self._explicit_max_uploaded)
        if quota <= 0 or not self.cache_dir.is_dir():
            return []
        uploaded_candidates: List[Tuple[bool, int, str, Path]] = []
        try:
            entries = list(os.scandir(self.cache_dir))
        except OSError:
            return []
        for entry in entries:
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if not is_dir or not self.valid_id(entry.name):
                continue
            mid = entry.name
            d = Path(entry.path)
            s = self._get_cached_summary_for_dir(mid, d)
            if not s or s.get("source") != "uploaded":
                continue
            mtime_ns = self._summary_mtime_by_id.get(mid, 0)
            recency = max(self._last_access_ns.get(mid, 0), mtime_ns)
            uploaded_candidates.append((mid == protect_id, recency, mid, d))

        if len(uploaded_candidates) <= quota:
            return []

        uploaded_candidates.sort(key=lambda item: (item[0], item[1], item[2]))
        evict_count = len(uploaded_candidates) - quota
        evicted: List[str] = []
        for _is_protected, _recency, mid, d in uploaded_candidates[:evict_count]:
            shutil.rmtree(d, ignore_errors=True)
            self._evict_cache_entries(mid)
            evicted.append(mid)
            logger.info("Evicted LRU uploaded match %s (max_uploaded_matches=%d)", mid, quota)
        return evicted

    def get_file_path(self, match_id: str, name: str) -> Optional[Path]:
        try:
            p = self.match_dir(match_id) / name
        except KeyError:
            return None
        if not p.is_file():
            return None
        self.touch(match_id)
        return p

    def get_replay_path(self, match_id: str) -> Optional[Path]:
        return self.get_file_path(match_id, "replay_2d.json")

    def get_analytics_path(self, match_id: str) -> Optional[Path]:
        return self.get_file_path(match_id, "analytics.json")

    def _read(self, match_id: str, name: str) -> Optional[Dict[str, Any]]:
        try:
            p = self.match_dir(match_id) / name
        except KeyError:
            return None
        if not p.is_file():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Failed reading %s/%s: %s", match_id, name, exc)
            return None
        if name in ("replay_2d.json", "analytics.json"):
            self.touch(match_id)
        return data

    def get_replay(self, match_id: str) -> Optional[Dict[str, Any]]:
        return self._read(match_id, "replay_2d.json")

    def get_analytics(self, match_id: str) -> Optional[Dict[str, Any]]:
        return self._read(match_id, "analytics.json")

    def _get_cached_summary_for_dir(self, match_id: str, d: Path) -> Optional[Dict[str, Any]]:
        summary_path = d / "summary.json"
        is_full_replay = False
        try:
            st = summary_path.stat()
            src_path = summary_path
        except OSError:
            replay_path = d / "replay_2d.json"
            try:
                st = replay_path.stat()
                src_path = replay_path
                is_full_replay = True
            except OSError:
                return None

        key = (match_id, st.st_mtime_ns)
        with self._lock:
            hit = self._summary_cache.get(key)
            if hit is not None:
                self._last_access_ns.setdefault(match_id, st.st_mtime_ns)
                return dict(hit)

        try:
            parsed = json.loads(src_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Failed to parse summary for %s from %s: %s", match_id, src_path.name, exc)
            return None

        summary = parsed.get("match") if is_full_replay and isinstance(parsed, dict) else parsed
        if not isinstance(summary, dict):
            return None

        with self._lock:
            old_mtime = self._summary_mtime_by_id.get(match_id)
            if old_mtime is not None and old_mtime != st.st_mtime_ns:
                self._summary_cache.pop((match_id, old_mtime), None)
            self._summary_mtime_by_id[match_id] = st.st_mtime_ns
            self._summary_cache[key] = dict(summary)
            self._last_access_ns.setdefault(match_id, st.st_mtime_ns)
        return dict(summary)

    def get_summary(self, match_id: str) -> Optional[Dict[str, Any]]:
        try:
            d = self.match_dir(match_id)
        except KeyError:
            return None
        if not d.is_dir():
            return None
        return self._get_cached_summary_for_dir(match_id, d)

    def list_summaries(self, include_uploaded: bool = True) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        if not self.cache_dir.is_dir():
            return out
        seen_ids = set()
        try:
            entries = list(os.scandir(self.cache_dir))
        except OSError:
            return out
        for entry in entries:
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if not is_dir or not self.valid_id(entry.name):
                continue
            mid = entry.name
            d = Path(entry.path)
            if not (d / "replay_2d.json").is_file() or not (d / "analytics.json").is_file():
                continue
            seen_ids.add(mid)
            s = self._get_cached_summary_for_dir(mid, d)
            if s:
                if not include_uploaded and s.get("source") == "uploaded":
                    continue
                out.append(s)

        with self._lock:
            missing_ids = [mid for mid in list(self._summary_mtime_by_id) if mid not in seen_ids]
            for mid in missing_ids:
                self._evict_cache_entries(mid)

        out.sort(key=lambda m: (-float(m.get("save_time_float") or 0.0), m.get("match_id", "")))
        return out
