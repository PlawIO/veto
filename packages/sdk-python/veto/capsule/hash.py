"""Canonicalization + beneficiary hashing.

Uses RFC 8785 JSON Canonicalization Scheme via the `jcs` PyPI package.
Must produce byte-identical output to the TypeScript `canonicalize` package.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Any, cast

import base58
import jcs

from .types import Beneficiary

_WS_RE = re.compile(r"\s+")
_ZERO_WIDTH_RE = re.compile(r"[\u200B-\u200D\uFEFF]")
_EVM_CHAINS = {"eth", "ethereum", "base", "arbitrum", "arb", "optimism", "polygon"}


def _normalize_name(raw: str) -> str:
    """NFC + strip zero-width joiners + lowercase + whitespace-collapse.

    Matches the TypeScript `normalizeName` in sign-capsule-protocol. Applied
    to every beneficiary name so NFC/NFD variants or zero-width-joiner attacks
    can't produce distinct hashes for visually identical counterparties.
    """
    nfc = unicodedata.normalize("NFC", raw)
    stripped = _ZERO_WIDTH_RE.sub("", nfc)
    return _WS_RE.sub(" ", stripped.lower()).strip()


def canonicalize(value: Any) -> str:
    """Return the RFC 8785 canonical JSON string for `value`."""
    out = jcs.canonicalize(value)
    if isinstance(out, bytes):
        return out.decode("utf-8")
    return cast(str, out)


def sha256_hex(data: str | bytes) -> str:
    """SHA-256 hex of `data`. Strings are UTF-8 encoded first."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def sha256_prefixed(data: str | bytes) -> str:
    """`sha256:<hex>` of `data`."""
    return f"sha256:{sha256_hex(data)}"


def hash_canonical(value: Any) -> str:
    """Canonical-JSON-then-sha256 of `value`."""
    return sha256_prefixed(canonicalize(value))


# --- beneficiary normalization ---------------------------------------------


def _normalize_bank_us(name: str, routing: str, account_last4: str) -> dict[str, str]:
    return {
        "type": "bank_us",
        "name": _normalize_name(name),
        "routing": re.sub(r"\D", "", routing),
        "account_last4": account_last4[-4:],
    }


def _normalize_bank_intl(b: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {
        "type": "bank_intl",
        "name": _normalize_name(b["name"]),
    }
    if "iban" in b and b["iban"]:
        out["iban"] = re.sub(r"\s+", "", b["iban"]).upper()
    if "swift_bic" in b and b["swift_bic"]:
        out["swift_bic"] = re.sub(r"\s+", "", b["swift_bic"]).upper()
    if "country_iso" in b and b["country_iso"]:
        out["country_iso"] = b["country_iso"].upper()
    return out


def _keccak256_hex(data: bytes) -> str:
    # EIP-55 uses Keccak-256 (NOT SHA3-256). cryptography's hashes module
    # provides it under Hash / SHA3_256 — but that's SHA3, not Keccak. Use the
    # cryptography.hazmat backend primitive via `hashlib` only if available,
    # else fall back to a tiny pure-python implementation.
    try:
        from Crypto.Hash import keccak  # type: ignore[import-not-found]

        k = keccak.new(digest_bits=256)
        k.update(data)
        return k.hexdigest()
    except Exception:  # pragma: no cover — pycryptodome not installed
        pass
    # cryptography package provides Keccak via backends in some versions.
    try:
        from cryptography.hazmat.primitives import hashes  # type: ignore[import-not-found]

        if hasattr(hashes, "Keccak256"):
            digest = hashes.Hash(hashes.Keccak256())
            digest.update(data)
            return digest.finalize().hex()
    except Exception:  # pragma: no cover
        pass
    # Pure-python fallback (slow, but correct) for environments without
    # pycryptodome or a cryptography build with Keccak.
    return _keccak256_pure_python(data)


def _keccak256_pure_python(data: bytes) -> str:  # pragma: no cover — fallback only
    # Minimal Keccak-f[1600] implementation for EIP-55 addresses. Not
    # performance-optimized; addresses are 40 hex chars so this runs once per
    # normalization call on a tiny input.
    RC = [
        0x0000000000000001, 0x0000000000008082, 0x800000000000808A,
        0x8000000080008000, 0x000000000000808B, 0x0000000080000001,
        0x8000000080008081, 0x8000000000008009, 0x000000000000008A,
        0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
        0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
        0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
        0x000000000000800A, 0x800000008000000A, 0x8000000080008081,
        0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
    ]
    R = [
        [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
        [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
    ]

    def rol(x: int, n: int) -> int:
        return ((x << n) | (x >> (64 - n))) & 0xFFFFFFFFFFFFFFFF

    state = [[0] * 5 for _ in range(5)]
    rate = 136  # 1088 bits / 8 for Keccak-256

    # Pad: append 0x01, zeros, final byte 0x80 at end of block.
    msg = bytearray(data) + b"\x01"
    while len(msg) % rate != rate - 1:
        msg.append(0x00)
    msg.append(0x80)

    for offset in range(0, len(msg), rate):
        block = msg[offset : offset + rate]
        for i in range(rate // 8):
            lane = int.from_bytes(block[i * 8 : i * 8 + 8], "little")
            x, y = i % 5, i // 5
            state[x][y] ^= lane

        for rnd in range(24):
            # Theta
            C = [state[x][0] ^ state[x][1] ^ state[x][2] ^ state[x][3] ^ state[x][4] for x in range(5)]
            D = [C[(x - 1) % 5] ^ rol(C[(x + 1) % 5], 1) for x in range(5)]
            for x in range(5):
                for y in range(5):
                    state[x][y] ^= D[x]
            # Rho + Pi
            B = [[0] * 5 for _ in range(5)]
            for x in range(5):
                for y in range(5):
                    B[y][(2 * x + 3 * y) % 5] = rol(state[x][y], R[x][y])
            # Chi
            for x in range(5):
                for y in range(5):
                    state[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y]) & 0xFFFFFFFFFFFFFFFF
            # Iota
            state[0][0] ^= RC[rnd]

    out = bytearray()
    while len(out) < 32:
        for y in range(5):
            for x in range(5):
                if len(out) >= 32:
                    break
                out.extend(state[x][y].to_bytes(8, "little"))
    return bytes(out[:32]).hex()


def _to_eip55(address: str) -> str:
    lower = address.lower().removeprefix("0x")
    if not re.fullmatch(r"[0-9a-f]{40}", lower):
        raise ValueError(f"invalid EVM address: {address}")
    hash_hex = _keccak256_hex(lower.encode("ascii"))
    out: list[str] = []
    for i, c in enumerate(lower):
        if c.isdigit():
            out.append(c)
        else:
            out.append(c.upper() if int(hash_hex[i], 16) >= 8 else c)
    return "0x" + "".join(out)


def _normalize_solana(address: str) -> str:
    # Solana addresses are base58-encoded 32-byte Ed25519 keys. Proper
    # validation decodes and checks byte length — a regex would let random
    # 32-44 char base58 strings pass.
    try:
        decoded = base58.b58decode(address)
    except Exception as err:
        raise ValueError(f"invalid Solana (base58) address: {address}: {err}") from err
    if len(decoded) != 32:
        raise ValueError(
            f"invalid Solana address: decoded to {len(decoded)} bytes, expected 32"
        )
    return address


def _normalize_crypto(chain: str, address: str) -> dict[str, str]:
    chain_norm = chain.lower()
    if chain_norm in _EVM_CHAINS:
        addr_norm = _to_eip55(address)
    elif chain_norm in ("solana", "sol"):
        addr_norm = _normalize_solana(address)
    else:
        addr_norm = address
    return {"type": "crypto", "chain": chain_norm, "address": addr_norm}


def normalize_beneficiary(b: Beneficiary) -> dict[str, Any]:
    btype = b.get("type")  # type: ignore[union-attr]
    if btype == "bank_us":
        return _normalize_bank_us(b["name"], b["routing"], b["account_last4"])  # type: ignore[typeddict-item]
    if btype == "bank_intl":
        return _normalize_bank_intl(cast(dict[str, Any], b))
    if btype == "crypto":
        return _normalize_crypto(b["chain"], b["address"])  # type: ignore[typeddict-item]
    raise ValueError(f"unknown beneficiary type: {btype}")


def hash_beneficiary(b: Beneficiary) -> str:
    return hash_canonical(normalize_beneficiary(b))
