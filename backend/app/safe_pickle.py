"""Safe, restricted Python pickle auditing and decoding utilities.

Adapted from the read-only audit reference
``idv_demo_audit_20261124_002337/scripts/safe_pickle.py``.

Security contract
-----------------
* This module NEVER calls the unrestricted module-level ``pickle`` load
  functions. Every stream is first statically inspected with
  ``pickletools.genops`` (opcode + global whitelist audit) and only then
  handed to :class:`SafeUnpickler`, whose ``find_class`` resolves exclusively
  to passive stand-ins for a tiny whitelist of globals.
* Disallowed opcodes (``INST``, ``OBJ``, ``EXT*``, ``PERSID``/``BINPERSID``),
  non-literal ``STACK_GLOBAL``, and any ``GLOBAL`` / ``STACK_GLOBAL`` outside
  the whitelist are rejected before any object construction happens, so
  ``REDUCE`` can only ever be applied to whitelisted callables
  (``_codecs.encode`` replacement, ``set``, passive ``ObjectId`` stand-in).
"""

from __future__ import annotations

import collections
import hashlib
import io
import pickle
import pickletools
from typing import Any, Dict, List, Optional, Set, Tuple

#: Hard ceiling for a single pickle stream (bytes).
MAX_PICKLE_BYTES = 64 * 1024 * 1024

ALLOWED_GLOBALS: Set[Tuple[str, str]] = {
    ("bson.objectid", "ObjectId"),
    ("_codecs", "encode"),
    ("__builtin__", "set"),
    ("builtins", "set"),
}

LITERAL_STR_OPCODES: Set[str] = {
    "SHORT_BINUNICODE",
    "BINUNICODE",
    "SHORT_BINSTRING",
    "BINSTRING",
}

PASSIVE_MEMO_PUT_OPCODES: Set[str] = {
    "MEMOIZE",
    "PUT",
    "BINPUT",
    "LONG_BINPUT",
}

DISALLOWED_OPCODES: Set[str] = {
    "INST",
    "OBJ",
    "EXT1",
    "EXT2",
    "EXT4",
    "PERSID",
    "BINPERSID",
}

ALLOWED_ENCODINGS: Set[str] = {"latin1", "latin-1", "utf-8", "ascii"}


class SafePickleAuditError(Exception):
    """Raised when a pickle stream fails static audit or whitelist decoding."""

    def __init__(self, message: str, audit_info: Dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.audit_info = audit_info or {}


class SafeObjectId:
    """Passive stand-in for bson.objectid.ObjectId preserving raw bytes."""

    def __init__(self, raw: Any = None) -> None:
        self.raw = raw

    def __setstate__(self, state: Any) -> None:
        self.raw = state

    def hex_str(self) -> str:
        if isinstance(self.raw, (bytes, bytearray)):
            return bytes(self.raw).hex()
        return repr(self.raw)

    def to_tagged_dict(self) -> Dict[str, Any]:
        raw_len = len(self.raw) if isinstance(self.raw, (bytes, bytearray, str)) else None
        return {"__type__": "bson.objectid.ObjectId", "hex": self.hex_str(), "raw_len": raw_len}

    def __repr__(self) -> str:
        return f"SafeObjectId({self.hex_str()!r})"

    def __eq__(self, other: object) -> bool:
        if isinstance(other, SafeObjectId):
            return self.raw == other.raw
        return False

    def __hash__(self) -> int:
        return hash((type(self).__name__, self.raw))


def safe_codecs_encode(s: Any, encoding: str = "latin1") -> bytes:
    """Strict replacement for _codecs.encode used by Pickle v2 bytes encoding."""
    if not isinstance(s, str):
        raise ValueError(f"Blocked _codecs.encode on non-str type: {type(s).__name__}")
    if encoding not in ALLOWED_ENCODINGS:
        raise ValueError(f"Blocked _codecs.encode with disallowed encoding: {encoding!r}")
    return s.encode(encoding)


def _split_global_arg(arg: Any) -> Tuple[str, str]:
    if isinstance(arg, str):
        parts = arg.split(" ", 1)
        if len(parts) == 2:
            return parts[0], parts[1]
    return ("", str(arg))


def _coerce_literal_str(arg: Any) -> Optional[str]:
    if isinstance(arg, str):
        return arg
    if isinstance(arg, (bytes, bytearray)):
        try:
            return bytes(arg).decode("utf-8")
        except UnicodeDecodeError:
            return None
    return None


def audit_pickle_bytes(data: bytes) -> Dict[str, Any]:
    """Statically inspect a pickle byte stream via pickletools.genops."""
    if not data:
        raise SafePickleAuditError("Empty byte stream (not a valid pickle stream)")
    if len(data) > MAX_PICKLE_BYTES:
        raise SafePickleAuditError(f"Pickle stream exceeds size limit ({len(data)} > {MAX_PICKLE_BYTES} bytes)")
    if not data.startswith(b"\x80"):
        raise SafePickleAuditError(
            f"Stream does not start with pickle PROTO opcode 0x80 (head={data[:16].hex()})"
        )

    protocol: int | None = None
    op_counts: collections.Counter[str] = collections.Counter()
    globals_found: List[Dict[str, Any]] = []
    disallowed_items: List[Dict[str, Any]] = []
    stack_producers: List[Tuple[str, Any, int]] = []

    try:
        for op, arg, pos in pickletools.genops(data):
            op_counts[op.name] += 1
            if op.name == "PROTO":
                protocol = int(arg)
            if op.name == "GLOBAL":
                mod, name = _split_global_arg(arg)
                rec = {"pos": pos, "opcode": op.name, "module": mod, "name": name}
                globals_found.append(rec)
                if (mod, name) not in ALLOWED_GLOBALS:
                    disallowed_items.append(rec)
                stack_producers.append((op.name, (mod, name), pos))
            elif op.name == "STACK_GLOBAL":
                if (
                    len(stack_producers) >= 2
                    and stack_producers[-2][0] in LITERAL_STR_OPCODES
                    and stack_producers[-1][0] in LITERAL_STR_OPCODES
                ):
                    mod_s = _coerce_literal_str(stack_producers[-2][1])
                    name_s = _coerce_literal_str(stack_producers[-1][1])
                    stack_producers.pop()
                    stack_producers.pop()
                    if mod_s is not None and name_s is not None:
                        rec = {"pos": pos, "opcode": "STACK_GLOBAL", "module": mod_s, "name": name_s}
                        globals_found.append(rec)
                        if (mod_s, name_s) not in ALLOWED_GLOBALS:
                            disallowed_items.append(rec)
                        stack_producers.append(("STACK_GLOBAL", (mod_s, name_s), pos))
                    else:
                        disallowed_items.append(
                            {"pos": pos, "opcode": "STACK_GLOBAL", "arg": "non-utf8 literal operand"}
                        )
                        stack_producers.append(("STACK_GLOBAL", None, pos))
                else:
                    disallowed_items.append(
                        {"pos": pos, "opcode": "STACK_GLOBAL", "arg": "requires two preceding literal string opcodes"}
                    )
                    if len(stack_producers) >= 2:
                        stack_producers.pop()
                        stack_producers.pop()
                    else:
                        stack_producers.clear()
                    stack_producers.append(("STACK_GLOBAL", None, pos))
            elif op.name in DISALLOWED_OPCODES:
                disallowed_items.append({"pos": pos, "opcode": op.name, "arg": repr(arg)})
                stack_producers.append((op.name, arg, pos))
            elif op.name not in PASSIVE_MEMO_PUT_OPCODES:
                stack_producers.append((op.name, arg, pos))
    except Exception as exc:  # noqa: BLE001 - any genops failure is an audit failure
        raise SafePickleAuditError(
            f"pickletools.genops failed: {exc}",
            {
                "protocol": protocol,
                "opcode_counts": dict(op_counts),
                "globals_found": globals_found,
                "disallowed_items": disallowed_items,
            },
        ) from exc

    return {
        "protocol": protocol,
        "opcode_counts": dict(op_counts),
        "globals_found": globals_found,
        "disallowed_items": disallowed_items,
    }


class SafeUnpickler(pickle.Unpickler):
    """Restricted Unpickler permitting only verified passive data types."""

    def find_class(self, module: str, name: str) -> Any:  # noqa: D401
        key = (module, name)
        if key == ("bson.objectid", "ObjectId"):
            return SafeObjectId
        if key == ("_codecs", "encode"):
            return safe_codecs_encode
        if key in (("builtins", "set"), ("__builtin__", "set")):
            return set
        raise pickle.UnpicklingError(f"Disallowed global reference: {module}.{name}")

    def persistent_load(self, pid: Any) -> Any:  # pragma: no cover - blocked by audit first
        raise pickle.UnpicklingError("Persistent IDs are not allowed")


def safe_unpickle_bytes(data: bytes) -> Tuple[Any, Dict[str, Any]]:
    """Audit and safely unpickle a byte stream using the strict whitelist."""
    audit_info = audit_pickle_bytes(data)
    if audit_info["disallowed_items"]:
        first = audit_info["disallowed_items"][0]
        raise SafePickleAuditError(
            f"Disallowed pickle opcode/global at byte {first.get('pos')}: {first}",
            audit_info,
        )
    try:
        obj = SafeUnpickler(io.BytesIO(data)).load()
    except Exception as exc:  # noqa: BLE001
        raise SafePickleAuditError(f"SafeUnpickler failed: {exc}", audit_info) from exc
    return obj, audit_info


def to_json_safe(obj: Any) -> Any:
    """Convert decoded objects to JSON-safe structures while tagging special types."""
    if isinstance(obj, SafeObjectId):
        return obj.to_tagged_dict()
    if isinstance(obj, set):
        items = [to_json_safe(x) for x in obj]
        items.sort(key=repr)
        return {"__type__": "set", "items": items}
    if isinstance(obj, (bytes, bytearray)):
        b = bytes(obj)
        return {
            "__type__": "bytes",
            "len": len(b),
            "hex_preview": b[:64].hex(),
            "sha256": hashlib.sha256(b).hexdigest(),
        }
    if isinstance(obj, (tuple, list)):
        return [to_json_safe(x) for x in obj]
    if isinstance(obj, dict):
        out: Dict[str, Any] = {}
        for k, v in obj.items():
            sk = k if isinstance(k, str) else str(k)
            if sk in out and k != sk:
                sk = f"{sk}__dup_{type(k).__name__}"
            out[sk] = to_json_safe(v)
        return out
    return obj
