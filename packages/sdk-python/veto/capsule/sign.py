"""Ed25519 JWS compact sign/verify for Spend Capsules.

Wire-compatible with @veto/spend-capsule-protocol (TypeScript) — same payload
canonicalization and header key order produce byte-identical JWS.
"""

from __future__ import annotations

import base64
import datetime as _dt
import json
from dataclasses import dataclass
from typing import Any, Literal

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from .hash import canonicalize
from .types import JWS_TYP, CapsulePayload, Jwks, JwksKey, PrivateSigningKey
from .validate import ValidationError, validate_capsule_payload

DEFAULT_SKEW_SECONDS = 30

CapsuleErrorCode = Literal[
    "jws_malformed",
    "signature_alg_not_supported",
    "signature_typ_invalid",
    "signature_kid_missing",
    "signature_kid_unknown",
    "signature_invalid",
    "jwks_key_invalid",
    "payload_invalid_json",
    "payload_not_canonical",
    "capsule_payload_invalid",
    "capsule_version_unsupported",
    "capsule_expires_at_invalid",
    "capsule_issued_at_invalid",
    "capsule_expired",
    "capsule_issued_in_future",
]


@dataclass
class VerifyCapsuleResult:
    payload: CapsulePayload
    protected_header: dict[str, Any]


class CapsuleVerificationError(Exception):
    def __init__(self, code: CapsuleErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    try:
        return base64.urlsafe_b64decode((data + pad).encode("ascii"))
    except Exception as err:
        raise CapsuleVerificationError("jws_malformed", "invalid base64url segment") from err


def _private_key_from_jwk(jwk: JwksKey) -> Ed25519PrivateKey:
    if "d" not in jwk:
        raise ValueError("JWK is missing private scalar `d`")
    raw = _b64url_decode(jwk["d"])
    return Ed25519PrivateKey.from_private_bytes(raw)


def _public_key_from_jwk(jwk: JwksKey) -> Ed25519PublicKey:
    if "x" not in jwk:
        raise CapsuleVerificationError("jwks_key_invalid", "JWK is missing public `x`")
    try:
        raw = _b64url_decode(jwk["x"])
        return Ed25519PublicKey.from_public_bytes(raw)
    except CapsuleVerificationError:
        raise
    except Exception as err:
        raise CapsuleVerificationError(
            "jwks_key_invalid", f"invalid public key material: {err}"
        ) from err


def sign_capsule(payload: CapsulePayload, key: PrivateSigningKey) -> str:
    """Return the compact-serialized JWS for `payload`.

    Validates against the schema first so bad capsules never reach the wire.
    """
    validate_capsule_payload(payload)
    private = _private_key_from_jwk(key["jwk"])
    header = {"alg": "EdDSA", "typ": JWS_TYP, "kid": key["kid"]}
    # Header uses insertion-ordered json.dumps(ensure_ascii=False) to match
    # jose (TS) byte-for-byte (including any non-ASCII kid).
    header_b64 = _b64url_encode(
        json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
    )
    payload_b64 = _b64url_encode(canonicalize(payload).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    signature = private.sign(signing_input)
    sig_b64 = _b64url_encode(signature)
    return f"{header_b64}.{payload_b64}.{sig_b64}"


def _parse_header(jws: str) -> dict[str, Any]:
    try:
        header_b64 = jws.split(".", 1)[0]
        if not header_b64:
            raise CapsuleVerificationError("jws_malformed", "empty JWS header")
        return json.loads(_b64url_decode(header_b64))
    except CapsuleVerificationError:
        raise
    except Exception as err:
        raise CapsuleVerificationError("jws_malformed", "invalid JWS header") from err


def _parse_rfc3339(value: str, code: CapsuleErrorCode) -> _dt.datetime:
    # Reject naive datetimes — require explicit Z or ±HH:MM offset.
    import re

    if not re.match(
        r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$",
        value,
    ):
        raise CapsuleVerificationError(
            code,
            f"timestamp must be RFC 3339 with explicit offset; got {value!r}",
        )
    try:
        return _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception as err:
        raise CapsuleVerificationError(code, f"invalid datetime: {value!r}") from err


def verify_capsule(
    jws: str,
    jwks: Jwks,
    *,
    clock_skew_seconds: int = DEFAULT_SKEW_SECONDS,
    now: _dt.datetime | None = None,
) -> VerifyCapsuleResult:
    parts = jws.split(".")
    if len(parts) != 3:
        raise CapsuleVerificationError(
            "jws_malformed", f"JWS must have exactly 3 segments, got {len(parts)}"
        )

    header_b64, payload_b64, sig_b64 = parts
    if not header_b64 or not payload_b64 or not sig_b64:
        raise CapsuleVerificationError("jws_malformed", "JWS has empty segments")

    header = _parse_header(jws)

    if header.get("alg") != "EdDSA":
        raise CapsuleVerificationError(
            "signature_alg_not_supported", f"unsupported alg: {header.get('alg')}"
        )
    if header.get("typ") != JWS_TYP:
        raise CapsuleVerificationError(
            "signature_typ_invalid", f"unexpected typ: {header.get('typ')}"
        )
    kid = header.get("kid")
    if not isinstance(kid, str):
        raise CapsuleVerificationError("signature_kid_missing", "missing kid in JWS header")

    jwk = next((k for k in jwks["keys"] if k.get("kid") == kid), None)
    if jwk is None:
        raise CapsuleVerificationError("signature_kid_unknown", f"no JWKS key with kid={kid}")
    if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519":
        raise CapsuleVerificationError(
            "jwks_key_invalid", f"JWKS key for kid={kid} must be OKP/Ed25519"
        )

    public_key = _public_key_from_jwk(jwk)
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    signature = _b64url_decode(sig_b64)
    try:
        public_key.verify(signature, signing_input)
    except InvalidSignature as err:
        raise CapsuleVerificationError(
            "signature_invalid", "JWS signature verification failed"
        ) from err

    payload_bytes = _b64url_decode(payload_b64)
    try:
        raw_payload = json.loads(payload_bytes)
    except Exception as err:
        raise CapsuleVerificationError(
            "payload_invalid_json", "payload is not JSON"
        ) from err

    # Canonical-form enforcement: the signer commits to JCS-canonicalized
    # bytes; a valid-signature-over-non-canonical payload is rejected so there
    # is exactly one wire encoding per semantic capsule.
    expected = canonicalize(raw_payload)
    signed = payload_bytes.decode("utf-8")
    if expected != signed:
        raise CapsuleVerificationError(
            "payload_not_canonical",
            "capsule payload is valid JSON but not JCS-canonical",
        )

    try:
        payload = validate_capsule_payload(raw_payload)
    except ValidationError as err:
        raise CapsuleVerificationError(
            "capsule_payload_invalid",
            f"capsule failed schema validation: {err}",
        ) from err

    if payload.get("version") != "veto.capsule/1":
        raise CapsuleVerificationError(
            "capsule_version_unsupported",
            f"unsupported capsule version: {payload.get('version')}",
        )

    now = now or _dt.datetime.now(_dt.timezone.utc)
    expires_at = _parse_rfc3339(payload["expires_at"], "capsule_expires_at_invalid")
    issued_at = _parse_rfc3339(payload["issued_at"], "capsule_issued_at_invalid")

    if (now - expires_at).total_seconds() > clock_skew_seconds:
        raise CapsuleVerificationError(
            "capsule_expired", f"capsule expired at {payload['expires_at']}"
        )
    if (issued_at - now).total_seconds() > clock_skew_seconds:
        raise CapsuleVerificationError(
            "capsule_issued_in_future",
            f"capsule issued_at {payload['issued_at']} is beyond tolerated skew",
        )

    return VerifyCapsuleResult(payload=payload, protected_header=header)


def public_jwk_from_private(key: PrivateSigningKey) -> JwksKey:
    jwk = key["jwk"]
    return JwksKey(  # type: ignore[typeddict-item]
        kty=jwk["kty"],
        crv=jwk["crv"],
        kid=key["kid"],
        x=jwk["x"],
        alg="EdDSA",
        use="sig",
    )
