"""Receipt chain + merkle root primitives."""

from __future__ import annotations

import datetime as _dt
import hashlib
import re
from dataclasses import dataclass
from typing import Any

from .hash import canonicalize, sha256_prefixed
from .rfc3339 import parse_rfc3339_strict
from .types import (
    GENESIS_PREV_RECEIPT_HASH,
    RECEIPT_VERSION,
    ChainVerifyResult,
    ReceiptPayload,
)
from .validate import ValidationError, validate_receipt_payload

MERKLE_BLOCK_SIZE = 1024

# Domain tags — see merkle.ts for rationale. Without domain separation a
# 32-byte value that equals a leaf hash could be reinterpreted as an internal
# node digest and change the computed root.
_DOMAIN_LEAF = 0x00
_DOMAIN_NODE = 0x01
_DOMAIN_ANCHOR = 0x02
_DOMAIN_ROOT = 0x03


def _tagged_hash(domain: int, *parts: bytes) -> bytes:
    return hashlib.sha256(bytes([domain]) + b"".join(parts)).digest()


def _u64_bytes(n: int) -> bytes:
    if n < 0 or n > 2**64 - 1:
        raise ValueError(f"_u64_bytes requires 0 <= n < 2^64; got {n}")
    return n.to_bytes(8, "big")


GENESIS_MERKLE_ROOT: str = "sha256:" + _tagged_hash(
    _DOMAIN_ANCHOR, b"veto.merkle.genesis/1"
).hex()

_RE_SHA256_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def hash_receipt(receipt: ReceiptPayload) -> str:
    return sha256_prefixed(canonicalize(receipt))


def _strip_prefix(h: str) -> bytes:
    if not h.startswith("sha256:"):
        raise ValueError(f"digest must be sha256:<hex>, got {h[:16]}...")
    hex_str = h[7:]
    if not _RE_SHA256_HEX64.match(hex_str):
        raise ValueError(
            f"digest must be exactly 64 lowercase hex chars; got length {len(hex_str)}"
        )
    return bytes.fromhex(hex_str)


def compute_merkle_root(leaves: list[str]) -> str:
    """Compute merkle root with leaf count bound into the output.

    The DOMAIN_ROOT wrapper closes CVE-2012-2459-style duplicate-last
    ambiguity: `[a, b, c]` and `[a, b, c, c]` would otherwise produce
    identical inner roots.
    """
    if not leaves:
        return GENESIS_MERKLE_ROOT
    level = [_tagged_hash(_DOMAIN_LEAF, _strip_prefix(leaf)) for leaf in leaves]
    while len(level) > 1:
        nxt: list[bytes] = []
        for i in range(0, len(level), 2):
            left = level[i]
            right = level[i + 1] if i + 1 < len(level) else left
            nxt.append(_tagged_hash(_DOMAIN_NODE, left, right))
        level = nxt
    inner = level[0]
    root = _tagged_hash(_DOMAIN_ROOT, _u64_bytes(len(leaves)), inner)
    return "sha256:" + root.hex()


def combine_anchors(prev: str, nxt: str) -> str:
    return "sha256:" + _tagged_hash(
        _DOMAIN_ANCHOR, _strip_prefix(prev), _strip_prefix(nxt)
    ).hex()


def build_receipt(
    draft: dict[str, Any],
    prev: ReceiptPayload | None,
    *,
    merkle_root: str | None = None,
) -> ReceiptPayload:
    """Build a receipt, setting version, prev_receipt_hash, and merkle_root.

    Schema-validates the result so bad drafts fail loudly.
    """
    prev_hash = hash_receipt(prev) if prev else GENESIS_PREV_RECEIPT_HASH
    resolved_root = (
        merkle_root
        if merkle_root is not None
        else (prev["merkle_root"] if prev else GENESIS_MERKLE_ROOT)
    )
    receipt: ReceiptPayload = {
        "version": RECEIPT_VERSION,
        **draft,  # type: ignore[misc]
        "prev_receipt_hash": prev_hash,
        "merkle_root": resolved_root,
    }
    try:
        validate_receipt_payload(receipt)
    except ValidationError as err:
        raise ValueError(f"build_receipt produced invalid receipt: {err}") from err
    return receipt


def verify_receipt_chain(
    receipts: list[ReceiptPayload],
    *,
    timestamp_skew_seconds: int = 5,
) -> ChainVerifyResult:
    """Verify a per-entity receipt chain end-to-end.

    Enforces: structural validation, version, hash-link continuity,
    monotonic issued_at (tolerating `timestamp_skew_seconds` backward drift),
    and merkle_root progression (root only changes at block boundaries).
    """
    if not receipts:
        return {"ok": True}
    skew_ms = timestamp_skew_seconds * 1000
    prev_issued_ms: float = float("-inf")
    prev_root: str | None = None

    for i, r in enumerate(receipts):
        # (1) Structural validation.
        try:
            validate_receipt_payload(r)
        except ValidationError as err:
            return {"ok": False, "breakAt": i, "reason": f"receipt[{i}] invalid: {err}"}

        # (2) Version.
        if r.get("version") != RECEIPT_VERSION:
            return {
                "ok": False,
                "breakAt": i,
                "reason": f"receipt[{i}] has unsupported version {r.get('version')}",
            }

        # (3) Hash-link continuity.
        expected_prev = GENESIS_PREV_RECEIPT_HASH if i == 0 else hash_receipt(receipts[i - 1])
        if r["prev_receipt_hash"] != expected_prev:
            return {
                "ok": False,
                "breakAt": i,
                "reason": (
                    "receipt[0] prev_receipt_hash must be the genesis hash"
                    if i == 0
                    else f"receipt[{i}] prev_receipt_hash does not match sha256 of receipt[{i - 1}]"
                ),
            }

        # (4) Monotonic issued_at.
        issued_ms = parse_rfc3339_strict(r["issued_at"]).epoch_ms
        if issued_ms + skew_ms < prev_issued_ms:
            return {
                "ok": False,
                "breakAt": i,
                "reason": (
                    f"receipt[{i}] issued_at {r['issued_at']} precedes "
                    f"receipt[{i - 1}].issued_at beyond tolerated skew"
                ),
            }
        prev_issued_ms = max(prev_issued_ms, issued_ms)

        # (5) Merkle root progression.
        if prev_root is not None and r["merkle_root"] != prev_root:
            at_boundary = i % MERKLE_BLOCK_SIZE == 0
            if not at_boundary:
                return {
                    "ok": False,
                    "breakAt": i,
                    "reason": (
                        f"receipt[{i}] merkle_root changed mid-block "
                        f"(position {i % MERKLE_BLOCK_SIZE})"
                    ),
                }
        prev_root = r["merkle_root"]

    return {"ok": True}


@dataclass
class MerkleAnchor:
    entity_id: str
    chain_index_start: int
    chain_index_end: int
    block_root: str
    rolling_root: str
    issued_at: str


def anchor_block(
    entity_id: str,
    start_index: int,
    receipts: list[ReceiptPayload],
    prev_anchor: MerkleAnchor | None,
    *,
    now: _dt.datetime | None = None,
) -> MerkleAnchor:
    if not receipts:
        raise ValueError("anchor_block requires at least one receipt")
    if not isinstance(start_index, int) or start_index < 0:
        raise ValueError("anchor_block start_index must be a non-negative integer")

    now = now or _dt.datetime.now(_dt.timezone.utc)
    issued_at = now.isoformat().replace("+00:00", "Z")
    end_index = start_index + len(receipts) - 1
    block_root = compute_merkle_root([hash_receipt(r) for r in receipts])

    # Bind anchor identity into the rolling root. Without this, two chains
    # with identical block_roots under different entity_ids would produce
    # identical anchors — a replay/relabel attack.
    bound_input = canonicalize(
        {
            "entity_id": entity_id,
            "chain_index_start": start_index,
            "chain_index_end": end_index,
            "block_root": block_root,
            "issued_at": issued_at,
        }
    )
    block_bound = sha256_prefixed(bound_input)

    prev_seed = prev_anchor.rolling_root if prev_anchor else GENESIS_MERKLE_ROOT
    rolling_root = combine_anchors(prev_seed, block_bound)

    return MerkleAnchor(
        entity_id=entity_id,
        chain_index_start=start_index,
        chain_index_end=end_index,
        block_root=block_root,
        rolling_root=rolling_root,
        issued_at=issued_at,
    )
