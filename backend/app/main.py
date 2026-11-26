"""FastAPI application: canonical REST API from Workflow/PLAN.md D1.

Run:  uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
import time
import weakref
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .archive import UnsafeArchiveError, safe_extract_zip
from .extractor import ReplayExtractionError, extract_match, find_replay_dirs
from .safe_pickle import SafePickleAuditError
from .store import MatchStore, default_cache_dir

logger = logging.getLogger("idv.api")

MAX_UPLOAD_BYTES = 256 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 64 * 1024
MULTIPART_WIRE_OVERHEAD_BYTES = 64 * 1024
DEFAULT_MAX_MATCHES_PER_UPLOAD = 5
DEFAULT_MAX_CONCURRENT_EXTRACTS = 2
ZIP_MAGIC = (b"PK\x03\x04", b"PK\x05\x06")


class _UploadTooLargeError(Exception):
    """Raised when a streaming upload exceeds the configured byte cap."""


def _error(status: int, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"detail": detail})


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is not None and raw.strip():
        try:
            return int(raw.strip())
        except ValueError:
            pass
    return default


def _is_production() -> bool:
    return os.environ.get("IDV_ENV", "development").strip().lower() == "production"


def _max_upload_bytes() -> int:
    return max(1, _env_int("IDV_MAX_UPLOAD_BYTES", MAX_UPLOAD_BYTES))


def _max_matches_per_upload() -> int:
    return max(1, _env_int("IDV_MAX_MATCHES_PER_UPLOAD", DEFAULT_MAX_MATCHES_PER_UPLOAD))


def _public_uploads_enabled() -> bool:
    return _env_bool("IDV_PUBLIC_UPLOADS", True)


def _redact_uid_enabled() -> bool:
    return _env_bool("IDV_REDACT_UID", False)


def _resolve_tmp_base() -> Optional[Path]:
    raw = os.environ.get("IDV_TMP_DIR")
    if not raw or not raw.strip():
        return None
    p = Path(raw.strip())
    p.mkdir(parents=True, exist_ok=True)
    return p


def _mask_unique_id(val: Optional[str]) -> Optional[str]:
    if val is None:
        return None
    s = str(val)
    if not s:
        return s
    if len(s) <= 4:
        return "***"
    return f"***{s[-2:]}"


def _redact_replay_uids(replay: Dict[str, Any]) -> None:
    for p in replay.get("players") or []:
        if isinstance(p, dict) and p.get("unique_id") is not None:
            p["unique_id"] = _mask_unique_id(p["unique_id"])


def _etag_matches(inm_header: Optional[str], etag: str) -> bool:
    if not inm_header:
        return False
    raw = inm_header.strip()
    if raw == "*":
        return True
    for token in raw.split(","):
        cand = token.strip()
        if cand.startswith("W/"):
            cand = cand[2:].strip()
        if cand == etag:
            return True
    return False


def _serve_json_file(request: Request, path: Optional[Path], match_id: str) -> Response:
    if path is None:
        return _error(404, f"Match not found: {match_id}")
    try:
        st = path.stat()
    except OSError:
        return _error(404, f"Match not found: {match_id}")
    etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
    headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=60",
    }
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    return FileResponse(path=path, media_type="application/json", headers=headers)


async def _stream_upload_to_file(request: Request, dest_path: Path, max_bytes: int) -> int:
    """Stream multipart ``file`` field or raw binary body in 64 KiB chunks to ``dest_path``."""
    ctype = (request.headers.get("content-type") or "").lower()
    if ctype.startswith("multipart/form-data"):
        wire_seen = 0
        wire_limit = max_bytes + MULTIPART_WIRE_OVERHEAD_BYTES
        orig_receive = request._receive

        async def bounded_receive():
            nonlocal wire_seen
            message = await orig_receive()
            if message.get("type") == "http.request":
                body_chunk = message.get("body", b"")
                wire_seen += len(body_chunk)
                if wire_seen > wire_limit:
                    raise _UploadTooLargeError()
            return message

        bounded_req = Request(request.scope, bounded_receive)
        try:
            form = await bounded_req.form()
        except _UploadTooLargeError:
            raise
        except Exception as exc:  # noqa: BLE001 - python-multipart missing or malformed body
            raise ValueError(f"Could not parse multipart body: {exc}") from exc

        try:
            upload = form.get("file")
            if upload is None:
                raise ValueError("Multipart upload requires a 'file' field")
            if isinstance(upload, str):
                raw = upload.encode("latin-1", errors="ignore")
                if len(raw) > max_bytes:
                    raise _UploadTooLargeError()
                dest_path.write_bytes(raw)
                return len(raw)

            total = 0
            with open(dest_path, "wb") as out:
                while True:
                    chunk = await upload.read(UPLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise _UploadTooLargeError()
                    out.write(chunk)
            return total
        finally:
            await form.close()

    total = 0
    with open(dest_path, "wb") as out:
        async for raw_chunk in request.stream():
            if not raw_chunk:
                continue
            for offset in range(0, len(raw_chunk), UPLOAD_CHUNK_BYTES):
                piece = raw_chunk[offset : offset + UPLOAD_CHUNK_BYTES]
                total += len(piece)
                if total > max_bytes:
                    raise _UploadTooLargeError()
                out.write(piece)
    return total


def create_app(cache_dir: Optional[Path] = None) -> FastAPI:
    store = MatchStore(cache_dir or default_cache_dir())
    is_prod = _is_production()
    disable_docs = _env_bool("IDV_DISABLE_DOCS", is_prod)

    app = FastAPI(
        title="IDV Tactical Replay API",
        version="1.0.0",
        docs_url=None if disable_docs else "/docs",
        redoc_url=None if disable_docs else "/redoc",
        openapi_url=None if disable_docs else "/openapi.json",
    )
    app.state.store = store

    raw_cors = os.environ.get("IDV_CORS_ORIGINS")
    if raw_cors is not None and raw_cors.strip():
        cors_origins = [o.strip() for o in raw_cors.split(",") if o.strip()]
    elif is_prod:
        cors_origins = []
    else:
        cors_origins = ["*"]

    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    loop_semaphores: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
        weakref.WeakKeyDictionary()
    )

    def _get_extract_semaphore() -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        sem = loop_semaphores.get(loop)
        if sem is None:
            limit = max(1, _env_int("IDV_MAX_CONCURRENT_EXTRACTS", DEFAULT_MAX_CONCURRENT_EXTRACTS))
            sem = asyncio.Semaphore(limit)
            loop_semaphores[loop] = sem
        return sem

    @app.get("/api/health")
    def health() -> Dict[str, Any]:
        summaries = store.list_summaries()
        resp: Dict[str, Any] = {
            "status": "ok",
            "preloaded_matches": sum(1 for s in summaries if s.get("source") == "preloaded"),
        }
        if not _is_production():
            resp["cache_dir"] = str(store.cache_dir)
        return resp

    @app.get("/api/matches")
    def list_matches() -> Dict[str, Any]:
        return {"matches": store.list_summaries(include_uploaded=_public_uploads_enabled())}

    @app.get("/api/matches/{match_id}/replay")
    def get_replay(match_id: str, request: Request) -> Response:
        return _serve_json_file(request, store.get_replay_path(match_id), match_id)

    @app.get("/api/matches/{match_id}/analytics")
    def get_analytics(match_id: str, request: Request) -> Response:
        return _serve_json_file(request, store.get_analytics_path(match_id), match_id)

    @app.post("/api/replays/upload")
    async def upload_replay(request: Request):
        t_start = time.perf_counter()
        max_bytes = _max_upload_bytes()
        declared = request.headers.get("content-length")
        if declared and declared.strip().isdigit() and int(declared.strip()) > max_bytes:
            logger.warning("Rejected upload via Content-Length=%s (> %d)", declared, max_bytes)
            return _error(413, f"Upload exceeds maximum size limit ({max_bytes} bytes)")

        tmp_base = _resolve_tmp_base()
        tmp = Path(tempfile.mkdtemp(prefix="idv_upload_", dir=str(tmp_base) if tmp_base else None))
        zip_path = tmp / "upload.zip"
        try:
            try:
                size_bytes = await _stream_upload_to_file(request, zip_path, max_bytes)
            except _UploadTooLargeError:
                logger.warning("Aborted streaming upload exceeding %d bytes", max_bytes)
                return _error(413, f"Upload exceeds maximum size limit ({max_bytes} bytes)")
            except ValueError as exc:
                return _error(400, str(exc))

            if size_bytes == 0:
                return _error(400, "Empty upload body")

            with open(zip_path, "rb") as zf_head:
                magic = zf_head.read(4)
            if not magic.startswith(ZIP_MAGIC):
                return _error(400, "Upload is not a ZIP archive")

            try:
                await run_in_threadpool(safe_extract_zip, zip_path, tmp / "x")
            except UnsafeArchiveError as exc:
                logger.warning("Rejected unsafe/invalid ZIP upload: %s", exc)
                return _error(400, f"Unsafe or invalid ZIP: {exc}")

            dirs = await run_in_threadpool(find_replay_dirs, tmp / "x")
            if not dirs:
                return _error(
                    422,
                    "No Identity V replay folder (game_info.txt + total_info.txt + battle_frames_snapshot_*.txt) found in ZIP",
                )

            max_matches = _max_matches_per_upload()
            if len(dirs) > max_matches:
                logger.warning("Rejected upload with %d replay folders (> %d)", len(dirs), max_matches)
                return _error(400, f"Upload contains {len(dirs)} replays, exceeding maximum of {max_matches}")

            sem = _get_extract_semaphore()
            extracted_batch: List[Tuple[Path, Dict[str, Any], Dict[str, Any]]] = []
            for d in dirs:
                t_ext = time.perf_counter()
                try:
                    async with sem:
                        replay, analytics = await run_in_threadpool(extract_match, d, "uploaded")
                except SafePickleAuditError as exc:
                    logger.warning("Rejected unsafe pickle stream in %s: %s", d.name, exc)
                    return _error(422, f"Unsafe pickle stream rejected in {d.name}: {exc}")
                except ReplayExtractionError as exc:
                    logger.warning("Invalid replay folder %s: %s", d.name, exc)
                    return _error(422, f"Invalid replay folder {d.name}: {exc}")
                except Exception as exc:  # noqa: BLE001
                    logger.exception("Failed decoding replay folder %s", d.name)
                    return _error(422, f"Failed to decode replay {d.name}: {type(exc).__name__}: {exc}")

                match_id = str((replay.get("match") or {}).get("match_id") or "")
                if not store.valid_id(match_id):
                    logger.warning("Rejected invalid room_guuid %r in %s", match_id, d.name)
                    return _error(422, f"Invalid match_id (room_guuid must be 24-hex): {match_id!r}")

                logger.info(
                    "Decoded replay match_id=%s folder=%s in %.1f ms",
                    match_id,
                    d.name,
                    (time.perf_counter() - t_ext) * 1000.0,
                )
                extracted_batch.append((d, replay, analytics))

            has_non_preloaded = any(
                not ((ex := store.get_summary(r["match"]["match_id"])) and ex.get("source") == "preloaded")
                for _, r, _ in extracted_batch
            )

            saved: List[Dict[str, Any]] = []
            redact_uid = _redact_uid_enabled()
            prod_mode = _is_production()

            for _d, replay, analytics in extracted_batch:
                match_id = replay["match"]["match_id"]
                existing = store.get_summary(match_id)
                if existing and existing.get("source") == "preloaded":
                    # Never overwrite canonical preloaded match files on disk.
                    if has_non_preloaded:
                        logger.info("Skipping preloaded match %s in mixed upload batch", match_id)
                        continue
                    if prod_mode:
                        logger.warning("Blocked upload attempting to overwrite preloaded match %s", match_id)
                        return _error(409, f"Cannot overwrite preloaded match: {match_id}")
                    existing_replay = store.get_replay(match_id)
                    as_preloaded = {**replay, "match": {**replay["match"], "source": "preloaded"}}
                    if existing_replay is None or existing_replay != as_preloaded:
                        logger.warning("Blocked tampered overwrite attempt on preloaded match %s", match_id)
                        return _error(409, f"Cannot overwrite preloaded match: {match_id}")
                    saved.append(existing)
                    continue

                if redact_uid:
                    _redact_replay_uids(replay)
                saved.append(store.save(replay, analytics))

            total_ms = (time.perf_counter() - t_start) * 1000.0
            logger.info(
                "Completed upload (%d bytes, %d saved) in %.1f ms",
                size_bytes,
                len(saved),
                total_ms,
            )
            return {
                "uploaded_count": len(saved),
                "match_ids": [s["match_id"] for s in saved],
                "matches": saved,
            }
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    return app


app = create_app()
