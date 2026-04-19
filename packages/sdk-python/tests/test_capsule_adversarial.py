"""Adversarial regression tests for the Python capsule mirror.

One test per devil's-advocate codex finding. If any of these start passing
without a counterpart fix, the Python mirror has regressed.
"""

from __future__ import annotations

import base64
import datetime as dt
import json

import pytest

from veto.capsule import (
    AuthorizedJwks,
    AuthorizedJwksEntry,
    CapsuleVerificationError,
    Rfc3339ParseError,
    TrustAnchor,
    canonicalize,
    compute_merkle_root,
    jwk_thumbprint,
    parse_rfc3339_strict,
    public_jwk_from_private,
    sign_capsule,
    validate_capsule_payload,
    verify_capsule,
)


TEST_PRIVATE_SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"


def _b64url(bytes_: bytes) -> str:
    return base64.urlsafe_b64encode(bytes_).rstrip(b"=").decode("ascii")


def _build_test_key(kid: str = "veto-gateway-test") -> dict:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization

    priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(TEST_PRIVATE_SEED_HEX))
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
            "d": _b64url(bytes.fromhex(TEST_PRIVATE_SEED_HEX)),
        },
    }


def _fixed_capsule(**overrides) -> dict:
    base = {
        "version": "veto.capsule/1",
        "capsule_id": "cap_01hy2z3abcdefghijklmnop1",
        "issuer": "https://gateway.veto.so",
        "entity_id": "ent_abc",
        "agent_id": "claude-code-ci-bot",
        "session_id": "sess_01hy2z3qrstuvwx",
        "tool": "meow.pay",
        "rail_allowlist": ["ach"],
        "counterparty_hash": "sha256:3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e",
        "amount_ceiling": {"currency": "USD", "amount": "12500.00"},
        "memo_template": "Invoice {{invoice_number}}",
        "invoice_hash": "sha256:84a0c6f1a1f8b80ec5d3abaf22b9c9e0000000000000000000000000000000ff",
        "workflow_id": "wf_01hy2z3abcdefghijklmnop1",
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


# ---- P0: key-to-issuer binding ---------------------------------------------


def test_authorized_jwks_rejects_mismatched_issuer():
    key = _build_test_key()
    jws = sign_capsule(_fixed_capsule(), key)
    trust = AuthorizedJwks(
        keys=[public_jwk_from_private(key)],
        authorizations=[
            AuthorizedJwksEntry(kid=key["kid"], issuer="https://attacker.example"),
        ],
    )
    with pytest.raises(CapsuleVerificationError) as exc:
        verify_capsule(jws, trust, now=REFERENCE_NOW)
    assert exc.value.code == "capsule_issuer_not_authorized"


def test_authorized_jwks_rejects_unlisted_entity():
    key = _build_test_key()
    jws = sign_capsule(_fixed_capsule(entity_id="ent_abc"), key)
    trust = AuthorizedJwks(
        keys=[public_jwk_from_private(key)],
        authorizations=[
            AuthorizedJwksEntry(
                kid=key["kid"],
                issuer="https://gateway.veto.so",
                entity_ids=["ent_xyz"],
            )
        ],
    )
    with pytest.raises(CapsuleVerificationError) as exc:
        verify_capsule(jws, trust, now=REFERENCE_NOW)
    assert exc.value.code == "capsule_entity_not_authorized"


def test_authorized_jwks_accepts_matching():
    key = _build_test_key()
    jws = sign_capsule(_fixed_capsule(), key)
    trust = AuthorizedJwks(
        keys=[public_jwk_from_private(key)],
        authorizations=[
            AuthorizedJwksEntry(
                kid=key["kid"],
                issuer="https://gateway.veto.so",
                entity_ids=["ent_abc"],
            )
        ],
    )
    result = verify_capsule(jws, trust, now=REFERENCE_NOW)
    assert result.payload["entity_id"] == "ent_abc"


def test_trust_anchor_require_binding_rejects_legacy_jwks():
    key = _build_test_key()
    jws = sign_capsule(_fixed_capsule(), key)
    trust = TrustAnchor(
        jwks={"keys": [public_jwk_from_private(key)]},
        require_issuer_binding=True,
    )
    with pytest.raises(CapsuleVerificationError) as exc:
        verify_capsule(jws, trust, now=REFERENCE_NOW)
    assert exc.value.code == "signature_kid_unknown"


# ---- P1: kid bound to JWK material -----------------------------------------


def test_sign_refuses_when_kid_diverges_from_jwk_kid():
    key = _build_test_key()
    bad = {**key, "kid": "fake", "jwk": {**key["jwk"], "kid": "real"}}
    with pytest.raises(ValueError, match="kid.*must equal"):
        sign_capsule(_fixed_capsule(), bad)


def test_jwk_thumbprint_is_stable():
    key = _build_test_key()
    t1 = jwk_thumbprint(public_jwk_from_private(key))
    t2 = jwk_thumbprint(public_jwk_from_private(key))
    assert t1 == t2


# ---- P1: strict RFC 3339 parsing -------------------------------------------


def test_rfc3339_rejects_impossible_dates():
    with pytest.raises(Rfc3339ParseError):
        parse_rfc3339_strict("2026-02-31T00:00:00Z")


def test_rfc3339_rejects_non_leap_feb29():
    with pytest.raises(Rfc3339ParseError):
        parse_rfc3339_strict("2025-02-29T00:00:00Z")


def test_rfc3339_accepts_leap_feb29():
    r = parse_rfc3339_strict("2024-02-29T00:00:00Z")
    assert r.epoch_ms > 0


def test_rfc3339_rejects_hour24():
    with pytest.raises(Rfc3339ParseError):
        parse_rfc3339_strict("2026-01-01T24:00:00Z")


def test_rfc3339_rejects_minute60():
    with pytest.raises(Rfc3339ParseError):
        parse_rfc3339_strict("2026-01-01T12:60:00Z")


def test_rfc3339_rejects_offset_plus_24_00():
    with pytest.raises(Rfc3339ParseError):
        parse_rfc3339_strict("2026-01-01T12:00:00+24:00")


def test_rfc3339_rejects_offset_plus_00_60():
    with pytest.raises(Rfc3339ParseError):
        parse_rfc3339_strict("2026-01-01T12:00:00+00:60")


def test_rfc3339_rejects_7_digit_fractional():
    with pytest.raises(Rfc3339ParseError):
        parse_rfc3339_strict("2026-01-01T12:00:00.1234567Z")


def test_rfc3339_accepts_6_digit_fractional():
    r = parse_rfc3339_strict("2026-01-01T12:00:00.123456Z")
    assert r.epoch_ms > 0


# ---- P1: merkle leaf-count binding -----------------------------------------


def test_merkle_leaf_count_is_bound():
    a = "sha256:" + "1" * 64
    b = "sha256:" + "2" * 64
    c = "sha256:" + "3" * 64
    assert compute_merkle_root([a, b, c]) != compute_merkle_root([a, b, c, c])


def test_merkle_doubled_pair_differs_from_single_pair():
    a = "sha256:" + "a" * 64
    b = "sha256:" + "b" * 64
    assert compute_merkle_root([a, b]) != compute_merkle_root([a, b, a, b])


# ---- P2: issuer URL tightening ---------------------------------------------


def test_issuer_rejects_http():
    with pytest.raises(Exception, match="https"):
        validate_capsule_payload(_fixed_capsule(issuer="http://gateway.veto.so"))


def test_issuer_rejects_userinfo():
    with pytest.raises(Exception, match="userinfo"):
        validate_capsule_payload(
            _fixed_capsule(issuer="https://user:pw@gateway.veto.so")
        )


def test_issuer_rejects_query():
    with pytest.raises(Exception, match="query"):
        validate_capsule_payload(_fixed_capsule(issuer="https://gateway.veto.so?x=1"))


def test_issuer_rejects_fragment():
    with pytest.raises(Exception, match="fragment"):
        validate_capsule_payload(_fixed_capsule(issuer="https://gateway.veto.so#f"))


# ---- P2: amount_ceiling additionalProperties:false --------------------------


def test_amount_ceiling_rejects_unknown_field():
    with pytest.raises(Exception, match="additional properties"):
        validate_capsule_payload(
            _fixed_capsule(amount_ceiling={"currency": "USD", "amount": "100.00", "foo": "bar"})
        )


# ---- P2: rail_allowlist uniqueItems ----------------------------------------


def test_rail_allowlist_rejects_duplicate():
    with pytest.raises(Exception, match="duplicate"):
        validate_capsule_payload(_fixed_capsule(rail_allowlist=["ach", "ach"]))


# ---- P1: payload_invalid_json is typed -------------------------------------


def test_verify_non_json_payload_raises_typed():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    key = _build_test_key()
    priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(TEST_PRIVATE_SEED_HEX))
    header_b64 = _b64url(
        json.dumps(
            {"alg": "EdDSA", "typ": "veto.capsule+jws", "kid": key["kid"]},
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
    )
    body_b64 = _b64url(b"this is not json")
    sig = priv.sign(f"{header_b64}.{body_b64}".encode("ascii"))
    jws = f"{header_b64}.{body_b64}.{_b64url(sig)}"
    trust = AuthorizedJwks(
        keys=[public_jwk_from_private(key)],
        authorizations=[AuthorizedJwksEntry(kid=key["kid"], issuer="https://gateway.veto.so")],
    )
    with pytest.raises(CapsuleVerificationError):
        verify_capsule(jws, trust, now=REFERENCE_NOW)


# ---- P1: canonicality test MUST be unconditional ---------------------------


def test_canonicality_rejection_is_unconditional():
    """Handcraft guaranteed non-canonical bytes — extra space after '{'."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    key = _build_test_key()
    priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(TEST_PRIVATE_SEED_HEX))
    canonical = canonicalize(_fixed_capsule())
    # Insert a space character after the opening brace — JCS never emits one.
    non_canonical = "{ " + canonical[1:]
    body_b64 = _b64url(non_canonical.encode("utf-8"))
    header_b64 = _b64url(
        json.dumps(
            {"alg": "EdDSA", "typ": "veto.capsule+jws", "kid": key["kid"]},
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
    )
    sig = priv.sign(f"{header_b64}.{body_b64}".encode("ascii"))
    jws = f"{header_b64}.{body_b64}.{_b64url(sig)}"
    trust = AuthorizedJwks(
        keys=[public_jwk_from_private(key)],
        authorizations=[AuthorizedJwksEntry(kid=key["kid"], issuer="https://gateway.veto.so")],
    )
    with pytest.raises(CapsuleVerificationError) as exc:
        verify_capsule(jws, trust, now=REFERENCE_NOW)
    assert exc.value.code == "payload_not_canonical"
