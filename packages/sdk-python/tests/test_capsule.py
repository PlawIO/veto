"""Tests for the Python spend-capsule mirror — parity with the TS reference."""

from __future__ import annotations

import base64
import datetime as dt
import json
from pathlib import Path

import pytest

from veto.capsule import (
    CapsuleVerificationError,
    GENESIS_MERKLE_ROOT,
    GENESIS_PREV_RECEIPT_HASH,
    build_receipt,
    canonicalize,
    compute_merkle_root,
    hash_beneficiary,
    hash_canonical,
    hash_receipt,
    normalize_beneficiary,
    public_jwk_from_private,
    sha256_prefixed,
    sign_capsule,
    verify_capsule,
    verify_receipt_chain,
)


# RFC 8032 §7.1 TEST 1 — same deterministic key the TS tests use.
TEST_PRIVATE_SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"


def _b64url(bytes_: bytes) -> str:
    return base64.urlsafe_b64encode(bytes_).rstrip(b"=").decode("ascii")


def _build_test_key(kid: str = "veto-gateway-test") -> dict:
    private_bytes = bytes.fromhex(TEST_PRIVATE_SEED_HEX)
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    priv = Ed25519PrivateKey.from_private_bytes(private_bytes)
    from cryptography.hazmat.primitives import serialization

    pub_bytes = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return {
        "kid": kid,
        "jwk": {
            "kty": "OKP",
            "crv": "Ed25519",
            "x": _b64url(pub_bytes),
            "d": _b64url(private_bytes),
        },
    }


def _fixed_capsule(**overrides) -> dict:
    base = {
        "version": "veto.capsule/1",
        "capsule_id": "cap_01hy2z3abcdefghijklmnop",
        "issuer": "https://gateway.veto.so",
        "entity_id": "ent_abc",
        "agent_id": "claude-code-ci-bot",
        "session_id": "sess_01hy2z3qrstuvwx",
        "rail_allowlist": ["ach"],
        "counterparty_hash": "sha256:3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e",
        "amount_ceiling": {"currency": "USD", "amount": "12500.00"},
        "memo_template": "Invoice {{invoice_number}}",
        "invoice_hash": "sha256:84a0c6f1a1f8b80ec5d3abaf22b9c9e00000000000000000000000000000000",
        "workflow_id": "wf_01hy2z3abcdefghijklmnop",
        "policy_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "approval_ref": None,
        "dual_control_ref": None,
        "issued_at": "2026-04-17T14:00:00Z",
        "expires_at": "2026-04-17T14:15:00Z",
        "max_uses": 1,
        "nonce": "7f3d9b2e1c8a4f60",
    }
    base.update(overrides)
    return base


REFERENCE_NOW = dt.datetime(2026, 4, 17, 14, 5, 0, tzinfo=dt.timezone.utc)


# --- canonicalize + genesis -------------------------------------------------


def test_canonicalize_is_deterministic():
    a = canonicalize({"b": 1, "a": 2, "c": {"y": 1, "x": 2}})
    b = canonicalize({"c": {"x": 2, "y": 1}, "a": 2, "b": 1})
    assert a == b == '{"a":2,"b":1,"c":{"x":2,"y":1}}'


def test_genesis_prev_receipt_hash_matches_spec_A5():
    assert sha256_prefixed(b"") == GENESIS_PREV_RECEIPT_HASH


# --- beneficiary hashing ----------------------------------------------------


def test_bank_us_normalization():
    n = normalize_beneficiary(
        {
            "type": "bank_us",
            "name": "  Acme   Supplies LLC  ",
            "routing": "121-000-248",
            "account_last4": "000004821",
        }
    )
    assert n == {
        "type": "bank_us",
        "name": "acme supplies llc",
        "routing": "121000248",
        "account_last4": "4821",
    }
    a = hash_beneficiary(
        {"type": "bank_us", "name": "Acme Supplies LLC", "routing": "121000248", "account_last4": "4821"}
    )
    b = hash_beneficiary(
        {
            "type": "bank_us",
            "name": "  ACME supplies   llc ",
            "routing": "121 000 248",
            "account_last4": "00004821",
        }
    )
    assert a == b
    assert a.startswith("sha256:")


def test_bank_intl_normalization():
    n = normalize_beneficiary(
        {
            "type": "bank_intl",
            "name": " Acme Europe GmbH ",
            "iban": "DE89 3704 0044 0532 0130 00",
            "swift_bic": "cobadeff",
            "country_iso": "de",
        }
    )
    assert n == {
        "type": "bank_intl",
        "name": "acme europe gmbh",
        "iban": "DE89370400440532013000",
        "swift_bic": "COBADEFF",
        "country_iso": "DE",
    }


def test_crypto_evm_eip55_is_case_stable():
    a = hash_beneficiary(
        {"type": "crypto", "chain": "ethereum", "address": "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"}
    )
    b = hash_beneficiary(
        {"type": "crypto", "chain": "Ethereum", "address": "0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED"}
    )
    assert a == b


def test_crypto_solana_rejects_non_base58():
    with pytest.raises(ValueError, match="base58"):
        hash_beneficiary({"type": "crypto", "chain": "solana", "address": "0xnotbase58"})


def test_hash_canonical_is_order_independent():
    a = hash_canonical({"entity": "ent_abc", "amount": "100.00", "currency": "USD"})
    b = hash_canonical({"currency": "USD", "amount": "100.00", "entity": "ent_abc"})
    assert a == b


# --- sign + verify (happy path) --------------------------------------------


def test_round_trip_sign_and_verify():
    key = _build_test_key()
    payload = _fixed_capsule()
    jws = sign_capsule(payload, key)
    assert jws.count(".") == 2

    jwks = {"keys": [public_jwk_from_private(key)]}
    result = verify_capsule(jws, jwks, now=REFERENCE_NOW)
    assert result.payload == payload
    assert result.protected_header == {
        "alg": "EdDSA",
        "typ": "veto.capsule+jws",
        "kid": "veto-gateway-test",
    }


def test_sign_is_deterministic_across_calls():
    key = _build_test_key()
    a = sign_capsule(_fixed_capsule(), key)
    b = sign_capsule(_fixed_capsule(), key)
    assert a == b


# --- REGRESSION class -------------------------------------------------------


def test_reject_after_skew_window_past_expiry():
    key = _build_test_key()
    jws = sign_capsule(_fixed_capsule(), key)
    jwks = {"keys": [public_jwk_from_private(key)]}
    with pytest.raises(CapsuleVerificationError) as exc:
        verify_capsule(jws, jwks, now=dt.datetime(2026, 4, 17, 14, 16, 0, tzinfo=dt.timezone.utc))
    assert exc.value.code == "capsule_expired"


def test_accept_within_default_30s_skew():
    key = _build_test_key()
    jws = sign_capsule(_fixed_capsule(), key)
    jwks = {"keys": [public_jwk_from_private(key)]}
    # expiry + 20s, still inside 30s window
    verify_capsule(jws, jwks, now=dt.datetime(2026, 4, 17, 14, 15, 20, tzinfo=dt.timezone.utc))


def test_reject_capsule_issued_in_future():
    key = _build_test_key()
    jws = sign_capsule(_fixed_capsule(), key)
    jwks = {"keys": [public_jwk_from_private(key)]}
    with pytest.raises(CapsuleVerificationError) as exc:
        verify_capsule(jws, jwks, now=dt.datetime(2026, 4, 17, 13, 59, 0, tzinfo=dt.timezone.utc))
    assert exc.value.code == "capsule_issued_in_future"


def test_reject_unknown_kid():
    unknown_key = _build_test_key("unknown-kid")
    known_key = _build_test_key()
    jws = sign_capsule(_fixed_capsule(), unknown_key)
    jwks = {"keys": [public_jwk_from_private(known_key)]}
    with pytest.raises(CapsuleVerificationError) as exc:
        verify_capsule(jws, jwks, now=REFERENCE_NOW)
    assert exc.value.code == "signature_kid_unknown"


def test_reject_tampered_signature():
    key = _build_test_key()
    jws = sign_capsule(_fixed_capsule(), key)
    jwks = {"keys": [public_jwk_from_private(key)]}
    parts = jws.split(".")
    last = parts[2]
    parts[2] = ("B" + last[1:]) if last.startswith("A") else ("A" + last[1:])
    with pytest.raises(CapsuleVerificationError) as exc:
        verify_capsule(".".join(parts), jwks, now=REFERENCE_NOW)
    assert exc.value.code == "signature_invalid"


def test_reject_tampered_payload():
    key = _build_test_key()
    jws = sign_capsule(_fixed_capsule(), key)
    jwks = {"keys": [public_jwk_from_private(key)]}
    parts = jws.split(".")
    tampered = _fixed_capsule(amount_ceiling={"currency": "USD", "amount": "99999.00"})
    parts[1] = _b64url(json.dumps(tampered).encode("utf-8"))
    with pytest.raises(CapsuleVerificationError) as exc:
        verify_capsule(".".join(parts), jwks, now=REFERENCE_NOW)
    assert exc.value.code == "signature_invalid"


def test_reject_wrong_alg():
    key = _build_test_key()
    jwks = {"keys": [public_jwk_from_private(key)]}
    header_b64 = _b64url(json.dumps({"alg": "HS256", "typ": "veto.capsule+jws", "kid": "x"}).encode())
    body_b64 = _b64url(json.dumps(_fixed_capsule()).encode())
    jws = f"{header_b64}.{body_b64}.AAAA"
    with pytest.raises(CapsuleVerificationError) as exc:
        verify_capsule(jws, jwks, now=REFERENCE_NOW)
    assert exc.value.code == "signature_alg_not_supported"


# --- merkle chain -----------------------------------------------------------


def _draft(n: int) -> dict:
    return {
        "receipt_id": f"rcp_01hy2z3{str(n).zfill(17)}",
        "entity_id": "ent_abc",
        "agent_id": "claude-code-ci-bot",
        "tool": "meow.pay",
        "decision": "allow",
        "reason_code": "ok",
        "args_hash": "sha256:" + str(n).zfill(64)[:64].replace("0", "a"),
        "result_hash": "sha256:" + str(n).zfill(64)[:64].replace("0", "b"),
        "policy_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "policy_pack_id": "ap_strict_v1",
        "issued_at": f"2026-04-17T14:0{n % 10}:00Z",
    }


def test_genesis_receipt_uses_correct_hash():
    r = build_receipt(_draft(0), None)
    assert r["prev_receipt_hash"] == GENESIS_PREV_RECEIPT_HASH
    assert r["merkle_root"] == GENESIS_MERKLE_ROOT
    assert r["version"] == "veto.receipt/1"


def test_chain_continuity_and_tamper_detection():
    r0 = build_receipt(_draft(0), None)
    r1 = build_receipt(_draft(1), r0)
    r2 = build_receipt(_draft(2), r1)
    assert verify_receipt_chain([r0, r1, r2]) == {"ok": True}

    # Tamper r1 post-hoc; r2's prev hash no longer matches.
    tampered = {**r1, "reason_code": "maliciously_changed"}
    result = verify_receipt_chain([r0, tampered, r2])
    assert result["ok"] is False
    assert result["breakAt"] == 2


def test_verify_empty_chain():
    assert verify_receipt_chain([]) == {"ok": True}


def test_compute_merkle_root_is_deterministic_and_hex():
    leaves = [f"sha256:{str(i) * 64}" for i in (1, 2, 3, 4)]
    root = compute_merkle_root(leaves)
    assert root == compute_merkle_root(leaves)
    assert root.startswith("sha256:") and len(root) == len("sha256:") + 64


def test_empty_merkle_root_is_genesis():
    assert compute_merkle_root([]) == GENESIS_MERKLE_ROOT


# --- cross-language contract ------------------------------------------------


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "contract-capsule.json"


def _load_contract_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


def test_contract_python_verifies_ts_signed_jws():
    fx = _load_contract_fixture()
    now = dt.datetime.fromisoformat(fx["now_for_verify"].replace("Z", "+00:00"))
    result = verify_capsule(fx["jws"], fx["jwks"], now=now)
    assert result.payload == fx["payload"]
    assert result.protected_header["kid"] == fx["kid"]


def test_contract_byte_identical_jws_ts_and_python():
    fx = _load_contract_fixture()
    # Recreate the TS-signing key from the fixture seed
    key = _build_test_key(fx["kid"])
    # Sign the same payload in Python
    py_jws = sign_capsule(fx["payload"], key)
    # With JCS-canonicalized payload and Ed25519 determinism, the JWS bytes
    # must match byte-for-byte across languages.
    assert py_jws == fx["jws"], (
        "Cross-language JWS divergence — Python signed != TypeScript signed."
    )


def test_contract_hash_receipt_parity():
    # Simple smoke: building a receipt chain in Python, the hash of each
    # receipt must follow the same JCS canonicalization rules.
    r0 = build_receipt(_draft(0), None)
    h = hash_receipt(r0)
    # The hash is deterministic: regenerating r0 from the same draft must
    # produce the same hash.
    assert hash_receipt(build_receipt(_draft(0), None)) == h
