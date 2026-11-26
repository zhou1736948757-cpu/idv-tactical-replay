"""Shared fixtures for the live full-stack E2E suite (T-004).

Nothing here is mocked:

* ``backend_server`` boots the real FastAPI app with ``python -m uvicorn app.main:app``
  on a free localhost port. It serves a *temporary copy* of ``backend/data/cache`` via
  ``IDV_CACHE_DIR`` so live uploads never touch tracked repository files.
* ``frontend_server`` builds the real Vue 3 app with Vite into a temporary ``--outDir``
  (``frontend/dist`` is left alone) and serves it with ``vite preview``, proxying ``/api`` to
  the live backend via ``VITE_API_PROXY_TARGET``.
* Child process trees are always terminated with ``taskkill /F /T /PID`` in ``finally``.

Run from the project root:  ``python -m pytest -p no:asyncio tests -v``
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
FRONTEND_DIR = REPO_ROOT / "frontend"
RENDERER_DIR = REPO_ROOT / "packages" / "replay-renderer"
REPO_CACHE_DIR = BACKEND_DIR / "data" / "cache"
ASSETS_DIR = FRONTEND_DIR / "public" / "assets"

AUDIT_DIR = Path(r"i:\geminiiii\idv_demo_audit_20261124_002337")
SOURCE_DIR = AUDIT_DIR / "work_copy" / "input_0_media_1795446603161_b0c41fc3" / "323292579"

VERIFIED_MATCH_IDS = [
    "6aff067e1ffac0fc9666d563",
    "6b0014eb54fd12fd2b16667d",
    "6b04323a84b889718100f507",
    "6b04349384b8897181051f2a",
    "6b04364084b889718108247f",
    "6b043a0d84b88971810ec20b",
    "6b043c0584b889718112042a",
]
CHINATOWN_MATCH = "6b04323a84b889718100f507"  # 唐人街, ranked, B1/1F/2F
PID102_MATCH = "6b04364084b889718108247f"
BOT_MATCH = "6b0014eb54fd12fd2b16667d"

IS_WINDOWS = os.name == "nt"


# --------------------------------------------------------------------------- helpers
def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def kill_tree(proc: Optional[subprocess.Popen]) -> None:
    """Terminate a child process and all its descendants (Windows-safe)."""
    if proc is None or proc.poll() is not None:
        return
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, check=False)
    else:  # pragma: no cover - non-Windows fallback
        proc.kill()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:  # pragma: no cover
        proc.kill()


def spawn(cmd: List[str], cwd: Path, env: Dict[str, str], log_path: Path) -> subprocess.Popen:
    log = open(log_path, "wb")  # noqa: SIM115 - closed by the OS when the child exits
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if IS_WINDOWS else 0
    return subprocess.Popen(cmd, cwd=str(cwd), env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)


def wait_http(url: str, proc: subprocess.Popen, log_path: Path, timeout: float = 120.0) -> httpx.Response:
    deadline = time.time() + timeout
    last: Optional[str] = None
    with httpx.Client(trust_env=False, timeout=5.0) as c:
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"process exited ({proc.returncode}) before {url} answered:\n{tail(log_path)}")
            try:
                r = c.get(url)
                if r.status_code == 200:
                    return r
                last = f"HTTP {r.status_code}"
            except httpx.HTTPError as exc:
                last = repr(exc)
            time.sleep(0.5)
    raise RuntimeError(f"timeout waiting for {url} ({last}):\n{tail(log_path)}")


def tail(path: Path, n: int = 4000) -> str:
    try:
        return path.read_bytes()[-n:].decode("utf-8", errors="replace")
    except OSError:
        return "<no log>"


def tree_fingerprint(root: Path) -> Dict[str, Tuple[int, int, str]]:
    """{relative path: (size, mtime_ns, sha256)} for every file under ``root``."""
    out: Dict[str, Tuple[int, int, str]] = {}
    for p in sorted(root.rglob("*")):
        if p.is_file():
            st = p.stat()
            h = hashlib.sha256()
            with open(p, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            out[p.relative_to(root).as_posix()] = (st.st_size, st.st_mtime_ns, h.hexdigest())
    return out


def build_replay_zip(match_id: str, prefix: str = "323292579/") -> bytes:
    """Package a verified replay folder into an in-memory ZIP (source is only read)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted((SOURCE_DIR / match_id).iterdir()):
            zf.write(p, f"{prefix}{match_id}/{p.name}")
    return buf.getvalue()


# --------------------------------------------------------------------------- read-only guards
@pytest.fixture(scope="session")
def audit_fingerprint_before() -> Dict[str, Tuple[int, int, str]]:
    assert AUDIT_DIR.is_dir(), f"read-only audit dir missing: {AUDIT_DIR}"
    return tree_fingerprint(AUDIT_DIR)


@pytest.fixture(scope="session")
def repo_cache_fingerprint_before() -> Dict[str, Tuple[int, int, str]]:
    return tree_fingerprint(REPO_CACHE_DIR)


# --------------------------------------------------------------------------- live servers
@pytest.fixture(scope="session")
def e2e_tmp(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("idv_e2e")


@pytest.fixture(scope="session")
def backend_server(e2e_tmp, audit_fingerprint_before, repo_cache_fingerprint_before) -> Iterator[Dict[str, object]]:
    cache = e2e_tmp / "cache"
    shutil.copytree(REPO_CACHE_DIR, cache)
    port = free_port()
    env = dict(os.environ, IDV_CACHE_DIR=str(cache), PYTHONIOENCODING="utf-8", NO_PROXY="127.0.0.1,localhost")
    log = e2e_tmp / "backend.log"
    cmd = [sys.executable, "-m", "uvicorn", "app.main:app", "--app-dir", "backend", "--host", "127.0.0.1", "--port", str(port)]
    proc = spawn(cmd, REPO_ROOT, env, log)
    try:
        base = f"http://127.0.0.1:{port}"
        wait_http(f"{base}/api/health", proc, log, timeout=90)
        yield {"base": base, "cache": cache, "proc": proc, "log": log, "port": port}
    finally:
        kill_tree(proc)


def _node() -> str:
    exe = shutil.which("node")
    if not exe:
        pytest.fail("node is not on PATH; the frontend E2E needs Node.js")
    return exe


@pytest.fixture(scope="session")
def frontend_server(e2e_tmp, backend_server) -> Iterator[Dict[str, object]]:
    node = _node()
    vite = FRONTEND_DIR / "node_modules" / "vite" / "bin" / "vite.js"
    assert vite.is_file(), "frontend/node_modules missing: run `npm --prefix frontend install`"
    # @idv/replay-renderer dist/ is gitignored; build it only if a fresh checkout lacks it.
    if not (RENDERER_DIR / "dist" / "index.js").is_file():
        npm = shutil.which("npm") or "npm"
        subprocess.run([npm, "--prefix", str(RENDERER_DIR), "run", "build"], check=True, shell=IS_WINDOWS)

    out_dir = e2e_tmp / "web_dist"
    env = dict(os.environ, VITE_API_PROXY_TARGET=str(backend_server["base"]), NO_PROXY="127.0.0.1,localhost")
    build = subprocess.run(
        [node, str(vite), "build", "--outDir", str(out_dir), "--emptyOutDir", "--logLevel", "warn"],
        cwd=str(FRONTEND_DIR), env=env, capture_output=True, timeout=300,
    )
    assert build.returncode == 0, build.stdout.decode("utf-8", "replace") + build.stderr.decode("utf-8", "replace")
    assert (out_dir / "index.html").is_file()

    port = free_port()
    log = e2e_tmp / "frontend.log"
    proc = spawn(
        [node, str(vite), "preview", "--outDir", str(out_dir), "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
        FRONTEND_DIR, env, log,
    )
    try:
        base = f"http://127.0.0.1:{port}"
        wait_http(f"{base}/", proc, log, timeout=90)
        wait_http(f"{base}/api/health", proc, log, timeout=30)  # proxy is live
        yield {"base": base, "proc": proc, "log": log, "out_dir": out_dir}
    finally:
        kill_tree(proc)


@pytest.fixture(scope="session")
def api(backend_server) -> Iterator[httpx.Client]:
    with httpx.Client(base_url=str(backend_server["base"]), trust_env=False, timeout=120.0) as c:
        yield c


@pytest.fixture(scope="session")
def web(frontend_server) -> Iterator[httpx.Client]:
    with httpx.Client(base_url=str(frontend_server["base"]), trust_env=False, timeout=60.0) as c:
        yield c


@pytest.fixture(scope="session")
def cached_payloads() -> Dict[str, Dict[str, dict]]:
    out: Dict[str, Dict[str, dict]] = {}
    for mid in VERIFIED_MATCH_IDS:
        d = REPO_CACHE_DIR / mid
        out[mid] = {
            "replay": json.loads((d / "replay_2d.json").read_text(encoding="utf-8")),
            "analytics": json.loads((d / "analytics.json").read_text(encoding="utf-8")),
        }
    return out


@pytest.fixture(scope="session")
def screenshot_dir(e2e_tmp) -> Path:
    env = os.environ.get("IDV_E2E_SCREENSHOT_DIR")
    d = Path(env) if env else e2e_tmp / "screenshots"
    d.mkdir(parents=True, exist_ok=True)
    return d
