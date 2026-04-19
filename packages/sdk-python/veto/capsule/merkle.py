"""Receipt chain + merkle root primitives."""

from __future__ import annotations

import datetime as _dt
import hashlib
from dataclasses import dataclass
from typing import Any

from .hash import canonicalize, sha256_prefixed
from .types import (
    GENESIS_PREV_RECEIPT_HASH,
    RECEIPT_VERSION,
    ChainVerifyResult,
    ReceiptPayload,
)

MERKLE_BLOCK_SIZE = 1024
GENESIS_MERKLE_ROOT = sha256_prefixed("veto.merkle.genesis/1")


def hash_receipt(receipt: ReceiptPayload) -> str:
    return sha256_prefixed(canonicalize(receipt))


def _strip_prefix(h: str) -> bytes:
    hexstr = h[7:] if h.startswith("sha256:") else h
    return bytes.fromhex(hexstr)


def _concat_sha256(a: bytes, b: bytes) -> bytes:
    return hashlib.sha256(a + b).digest()


def compute_merkle_root(leaves: list[str]) -> str:
    if not leaves:
        return GENESIS_MERKLE_ROOT
    level = [_strip_prefix(leaf) for leaf in leaves]
    while len(level) > 1:
        nxt: list[bytes] = []
        for i in range(0, len(level), 2):
            left = level[i]
            right = level[i + 1] if i + 1 < len(level) else left
            nxt.append(_concat_sha256(left, right))
        level = nxt
    return "sha256:" + level[0].hex()


def combine_anchors(prev: str, nxt: str) -> str:
    return "sha256:" + _concat_sha256(_strip_prefix(prev), _strip_prefix(nxt)).hex()


def build_receipt(
    draft: dict[str, Any],
    prev: ReceiptPayload | None,
    *,
    merkle_root: str | None = None,
) -> ReceiptPayload:
    """Build a receipt, setting version, prev_receipt_hash, and merkle_root.

    `draft` is a dict with every ReceiptPayload field except those three.
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
    now = now or _dt.datetime.now(_dt.timezone.utc)
    block_root = compute_merkle_root([hash_receipt(r) for r in receipts])
    rolling_root = (
        combine_anchors(prev_anchor.rolling_root, block_root) if prev_anchor else block_root
    )
    return MerkleAnchor(
        entity_id=entity_id,
        chain_index_start=start_index,
        chain_index_end=start_index + len(receipts) - 1,
        block_root=block_root,
        rolling_root=rolling_root,
        issued_at=now.isoformat().replace("+00:00", "Z"),
    )
