"""Safe ZIP extraction (path traversal / symlink / bomb guards)."""

from __future__ import annotations

import io
import os
import zipfile
from pathlib import Path
from typing import Any, BinaryIO, Dict, Union

MAX_TOTAL_UNCOMP_BYTES = 512 * 1024 * 1024
MAX_ENTRY_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 20000

ZipSource = Union[Path, str, os.PathLike[str], bytes, bytearray, BinaryIO]


class UnsafeArchiveError(ValueError):
    """Raised when a ZIP archive violates the extraction safety policy."""


def _validate_member_name(name: str) -> list[str]:
    rel = name.replace("\\", "/")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if rel.startswith("/") or ":" in rel or ".." in parts:
        raise UnsafeArchiveError(f"Unsafe path in ZIP: {name!r}")
    return parts


def safe_extract_zip(source: ZipSource, dest_dir: Path) -> Dict[str, Any]:
    """Validate every entry first, then extract ``source`` into ``dest_dir``.

    Accepts a file ``Path`` / path string, a seekable ``BinaryIO`` stream
    (without copying into ``io.BytesIO``), or ``bytes`` for unit tests.

    Blocks ``..`` traversal, absolute paths, drive prefixes (``:``), symlinks
    (unix mode ``0o120000``), entries ``> 64 MiB``, totals ``> 512 MiB`` and
    archives with an excessive entry count. Nothing is written unless the whole
    archive passes validation.
    """
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_root = dest_dir.resolve()

    close_handle = False
    if isinstance(source, (bytes, bytearray)):
        handle: BinaryIO = io.BytesIO(source)
        close_handle = True
    elif isinstance(source, (str, os.PathLike)):
        handle = open(source, "rb")  # noqa: SIM115 - closed in finally
        close_handle = True
    elif hasattr(source, "read") and hasattr(source, "seek"):
        source.seek(0)
        handle = source  # type: ignore[assignment]
    else:
        raise UnsafeArchiveError(f"Unsupported ZIP source type: {type(source).__name__}")

    try:
        try:
            zf = zipfile.ZipFile(handle, "r")
        except (zipfile.BadZipFile, OSError, ValueError) as exc:
            raise UnsafeArchiveError(f"Not a valid ZIP archive: {exc}") from exc
        with zf:
            infos = zf.infolist()
            if len(infos) > MAX_ENTRIES:
                raise UnsafeArchiveError(f"Too many entries in ZIP ({len(infos)})")
            total = 0
            plan = []
            for info in infos:
                parts = _validate_member_name(info.filename)
                unix_mode = (info.external_attr >> 16) & 0o170000
                if unix_mode == 0o120000:
                    raise UnsafeArchiveError(f"Symlink entry blocked in ZIP: {info.filename!r}")
                if info.file_size > MAX_ENTRY_BYTES:
                    raise UnsafeArchiveError(
                        f"Entry exceeds max size limit: {info.filename!r} ({info.file_size} bytes)"
                    )
                total += info.file_size
                if total > MAX_TOTAL_UNCOMP_BYTES:
                    raise UnsafeArchiveError(f"Archive uncompressed total exceeds limit ({total} bytes)")
                if not parts:
                    continue
                target = (dest_root.joinpath(*parts)).resolve()
                if dest_root != target and dest_root not in target.parents:
                    raise UnsafeArchiveError(f"Escaping target path blocked: {info.filename!r}")
                plan.append((info, target))

            written = 0
            actual_total = 0
            for info, target in plan:
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info, "r") as src, open(target, "wb") as out:
                    remaining = MAX_ENTRY_BYTES + 1
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        actual_total += len(chunk)
                        if remaining <= 0:  # declared size lied (zip bomb)
                            raise UnsafeArchiveError(f"Entry inflated beyond limit: {info.filename!r}")
                        if actual_total > MAX_TOTAL_UNCOMP_BYTES:
                            raise UnsafeArchiveError(
                                f"Archive inflated total exceeds limit ({actual_total} bytes)"
                            )
                        out.write(chunk)
                written += 1
            return {"entry_count": len(infos), "files_written": written, "total_uncompressed_bytes": actual_total or total}
    finally:
        if close_handle:
            handle.close()
