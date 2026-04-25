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

from .types import (
    BankInternationalBeneficiary,
    BankUsBeneficiary,
    Beneficiary,
    CryptoBeneficiary,
)

_WS_RE = re.compile(r"\s+")
# Default-ignorable code points that are invisible to humans but change the
# hash input. Covers ZWSP/ZWNJ/ZWJ/ZWNBSP, BOM variants, bidi formatting and
# isolate controls, Mongolian vowel separator, variation selectors, tag
# characters, and soft hyphen. Without bidi stripping,
# "ACME\u202EinvoiceCORP\u202C" and "ACMEinvoiceCORP" hash differently even
# though they render identically.
_DEFAULT_IGNORABLE_RE = re.compile(
    "["
    "\u00AD"              # soft hyphen
    "\u061C"              # arabic letter mark
    "\u180E"              # mongolian vowel separator
    "\u200B-\u200F"       # ZW*, LRM, RLM
    "\u202A-\u202E"       # bidi formatting
    "\u2066-\u2069"       # bidi isolates
    "\uFEFF"              # BOM / ZWNBSP
    "\uFE00-\uFE0F"       # variation selectors
    "]"
    "|[\U000E0000-\U000E007F]"   # tag characters
    "|[\U000E0100-\U000E01EF]"   # variation selector supplement
)


def _normalize_name(raw: str) -> str:
    """NFC + strip default-ignorable code points + lowercase + ws-collapse.

    Matches the TypeScript `normalizeName` in sign-capsule-protocol. Applied
    to every beneficiary name so NFC/NFD variants, zero-width joiners, and
    bidi controls can't produce distinct hashes for visually identical
    counterparties.
    """
    nfc = unicodedata.normalize("NFC", raw)
    stripped = _DEFAULT_IGNORABLE_RE.sub("", nfc)
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


def _is_valid_aba_routing(routing: str) -> bool:
    """ABA weighted 3/7/1 mod-10 checksum."""
    if not re.fullmatch(r"[0-9]{9}", routing):
        return False
    weights = (3, 7, 1, 3, 7, 1, 3, 7, 1)
    total = sum(int(d) * w for d, w in zip(routing, weights))
    return total % 10 == 0


def _is_valid_iban_checksum(iban: str) -> bool:
    """ISO 13616 mod-97 check."""
    if not re.fullmatch(r"[A-Z0-9]{5,34}", iban):
        return False
    rearranged = iban[4:] + iban[:4]
    remainder = 0
    for ch in rearranged:
        code = ord(ch)
        digit = code - 55 if code >= 65 else code - 48
        if digit < 0 or digit > 35:
            return False
        remainder = (remainder * (100 if digit > 9 else 10) + digit) % 97
    return remainder == 1


def _normalize_bank_us(name: str, routing: str, account_last4: str) -> dict[str, str]:
    # Cleanup limited to whitespace/hyphens/dots; arbitrary non-digit junk
    # must fail loudly rather than collapse into a valid-looking field.
    cleaned_routing = re.sub(r"[\s\-.]", "", routing)
    if not re.fullmatch(r"[0-9]{9}", cleaned_routing):
        raise ValueError(
            f"invalid US routing number: must be exactly 9 digits after trimming "
            f"whitespace/dashes; got {routing!r}"
        )
    if not _is_valid_aba_routing(cleaned_routing):
        raise ValueError(
            f"invalid US routing number: ABA checksum failed for {cleaned_routing!r}"
        )
    cleaned_last4 = re.sub(r"[\s\-]", "", account_last4)
    if not re.fullmatch(r"[0-9]{4}", cleaned_last4):
        raise ValueError(
            f"invalid account_last4: must be exactly 4 digits; got {account_last4!r}"
        )
    return {
        "type": "bank_us",
        "name": _normalize_name(name),
        "routing": cleaned_routing,
        "account_last4": cleaned_last4,
    }


def _normalize_bank_intl(b: BankInternationalBeneficiary) -> dict[str, str]:
    out: dict[str, str] = {
        "type": "bank_intl",
        "name": _normalize_name(b["name"]),
    }
    iban = b.get("iban")
    if iban:
        cleaned = re.sub(r"\s+", "", iban).upper()
        if not _is_valid_iban_checksum(cleaned):
            raise ValueError(f"invalid IBAN: checksum failed for {b['iban']!r}")
        out["iban"] = cleaned
    swift_bic = b.get("swift_bic")
    if swift_bic:
        cleaned = re.sub(r"\s+", "", swift_bic).upper()
        if not re.fullmatch(r"[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?", cleaned):
            raise ValueError(f"invalid SWIFT/BIC: {b['swift_bic']!r}")
        out["swift_bic"] = cleaned
    country_iso = b.get("country_iso")
    if country_iso:
        cleaned = country_iso.upper()
        if not re.fullmatch(r"[A-Z]{2}", cleaned):
            raise ValueError(
                f"invalid ISO 3166-1 alpha-2 country code: {b['country_iso']!r}"
            )
        out["country_iso"] = cleaned
    return out


def _keccak256_hex(data: bytes) -> str:
    # EIP-55 uses Keccak-256 (NOT SHA3-256). cryptography's hashes module
    # provides it under Hash / SHA3_256 — but that's SHA3, not Keccak. Use the
    # cryptography.hazmat backend primitive via `hashlib` only if available,
    # else fall back to a tiny pure-python implementation.
    try:
        from Crypto.Hash import keccak

        k = keccak.new(digest_bits=256)
        k.update(data)
        return cast(str, k.hexdigest())
    except Exception:  # pragma: no cover — pycryptodome not installed
        pass
    # cryptography package provides Keccak via backends in some versions.
    try:
        from cryptography.hazmat.primitives import hashes

        keccak_cls = getattr(hashes, "Keccak256", None)
        if keccak_cls is not None:
            digest = hashes.Hash(keccak_cls())
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


# Closed-world chain registry. A typo in `chain` MUST fail closed; silently
# passing the raw address through for an unknown chain would make two
# visually-identical beneficiaries hash differently without any warning.
_CHAIN_REGISTRY: dict[str, tuple[str, str]] = {
    "eth": ("eth", "evm"),
    "ethereum": ("eth", "evm"),
    "base": ("base", "evm"),
    "arb": ("arb", "evm"),
    "arbitrum": ("arb", "evm"),
    "optimism": ("optimism", "evm"),
    "op": ("optimism", "evm"),
    "polygon": ("polygon", "evm"),
    "matic": ("polygon", "evm"),
    "sol": ("sol", "solana"),
    "solana": ("sol", "solana"),
}


def _normalize_crypto(chain: str, address: str) -> dict[str, str]:
    key = chain.lower().strip()
    entry = _CHAIN_REGISTRY.get(key)
    if entry is None:
        raise ValueError(
            f"unsupported crypto chain: {chain!r}. "
            f"Known chains: {', '.join(sorted(_CHAIN_REGISTRY.keys()))}"
        )
    canonical, kind = entry
    if kind == "evm":
        addr_norm = _to_eip55(address)
    else:
        addr_norm = _normalize_solana(address)
    return {"type": "crypto", "chain": canonical, "address": addr_norm}


def normalize_beneficiary(b: Beneficiary) -> dict[str, Any]:
    btype = b.get("type")
    if btype == "bank_us":
        bank_us = cast(BankUsBeneficiary, b)
        return _normalize_bank_us(
            bank_us["name"], bank_us["routing"], bank_us["account_last4"]
        )
    if btype == "bank_intl":
        return _normalize_bank_intl(cast(BankInternationalBeneficiary, b))
    if btype == "crypto":
        crypto = cast(CryptoBeneficiary, b)
        return _normalize_crypto(crypto["chain"], crypto["address"])
    raise ValueError(f"unknown beneficiary type: {btype}")


def hash_beneficiary(b: Beneficiary) -> str:
    return hash_canonical(normalize_beneficiary(b))
