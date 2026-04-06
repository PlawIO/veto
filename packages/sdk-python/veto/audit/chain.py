"""
Cryptographic audit chain for append-only tamper detection.

Each record's hash is computed over the previous hash + the record's
deterministic JSON serialization, forming a hash chain. Any mutation
to a historical record invalidates all subsequent hashes.
"""

import hashlib
import json
from typing import Any

GENESIS_HASH = ""


def sorted_stringify(obj: Any, seen: set[int] | None = None) -> str:
    """Deterministic JSON serialization with sorted keys."""
    if seen is None:
        seen = set()
    if obj is None:
        return "null"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if isinstance(obj, (int, float)):
        return json.dumps(obj)
    if isinstance(obj, str):
        return json.dumps(obj)

    obj_id = id(obj)
    if obj_id in seen:
        return '"[Circular]"'
    seen.add(obj_id)

    if isinstance(obj, list):
        return "[" + ",".join(sorted_stringify(v, seen) for v in obj) + "]"
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        return (
            "{"
            + ",".join(
                json.dumps(k) + ":" + sorted_stringify(obj[k], seen)
                for k in keys
            )
            + "}"
        )
    return json.dumps(str(obj))


def compute_chain_hash(prev_hash: str, record: Any) -> str:
    """SHA256 hash of prev_hash + sorted_stringify(record)."""
    payload = prev_hash + sorted_stringify(record)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
