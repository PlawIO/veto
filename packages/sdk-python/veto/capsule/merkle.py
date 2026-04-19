"""Receipt chain + merkle root primitives."""

from __future__ import annotations

import datetime as _dt
import hashlib
import re
from dataclasses import dataclass
from typing import Any

from .hash import canonicalize, sha256_prefixed
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


def _tagged_hash(domain: int, *parts: bytes) -> bytes:
    return hashlib.sha256(bytes([domain]) + b"".join(parts)).digest()


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
    return "sha256:" + level[0].hex()


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


def verify_receipt_chain(receipts: list[ReceiptPayload]) -> ChainVerifyResult:
    if not receipts:
        return {"ok": True}

    for i, r in enumerate(receipts):
        if r.get("version") != RECEIPT_VERSION:
            return {
                "ok": False,
                "breakAt": i,
                "reason": f"receipt[{i}] has unsupported version {r.get('version')}",
            }
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
