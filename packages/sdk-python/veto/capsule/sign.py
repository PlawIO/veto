"""Ed25519 JWS compact sign/verify for Spend Capsules.

Wire-compatible with @veto/spend-capsule-protocol (TypeScript) — the JWS bytes
produced by either side verify on the other because Ed25519 signatures over
identical bytes are deterministic and byte-identical.
"""

from __future__ import annotations

import base64
import datetime as _dt
import json
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from .hash import canonicalize
from .types import JWS_TYP, CapsulePayload, Jwks, JwksKey, PrivateSigningKey

DEFAULT_SKEW_SECONDS = 30


@dataclass
class VerifyCapsuleResult:
    payload: CapsulePayload
    protected_header: dict[str, Any]


class CapsuleVerificationError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode((data + pad).encode("ascii"))


def _private_key_from_jwk(jwk: JwksKey) -> Ed25519PrivateKey:
    if "d" not in jwk:
        raise ValueError("JWK is missing private scalar `d`")
    raw = _b64url_decode(jwk["d"])
    return Ed25519PrivateKey.from_private_bytes(raw)


def _public_key_from_jwk(jwk: JwksKey) -> Ed25519PublicKey:
    if "x" not in jwk:
        raise ValueError("JWK is missing public `x`")
    raw = _b64url_decode(jwk["x"])
    return Ed25519PublicKey.from_public_bytes(raw)


def sign_capsule(payload: CapsulePayload, key: PrivateSigningKey) -> str:
    """Return the compact-serialized JWS for `payload`."""
    private = _private_key_from_jwk(key["jwk"])
    header = {"alg": "EdDSA", "typ": JWS_TYP, "kid": key["kid"]}
    # The JWS protected header is serialized in insertion order (alg, typ, kid)
    # to match jose's CompactSign output in the TypeScript reference. The payload
    # is JCS-canonicalized so cross-language JWS bytes match byte-for-byte.
    header_b64 = _b64url_encode(
        json.dumps(header, separators=(",", ":")).encode("utf-8"),
    )
    payload_b64 = _b64url_encode(canonicalize(payload).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    signature = private.sign(signing_input)
    sig_b64 = _b64url_encode(signature)
    return f"{header_b64}.{payload_b64}.{sig_b64}"


def _parse_header(jws: str) -> dict[str, Any]:
    try:
        header_b64 = jws.split(".", 1)[0]
        return json.loads(_b64url_decode(header_b64))
    except Exception as err:
        raise CapsuleVerificationError("jws_malformed", "invalid JWS header") from err


def verify_capsule(
    jws: str,
    jwks: Jwks,
    *,
    clock_skew_seconds: int = DEFAULT_SKEW_SECONDS,
    now: _dt.datetime | None = None,
) -> VerifyCapsuleResult:
    parts = jws.split(".")
    if len(parts) != 3:
        raise CapsuleVerificationError("jws_malformed", "JWS must have three segments")

    header_b64, payload_b64, sig_b64 = parts
    header = _parse_header(jws)

    if header.get("alg") != "EdDSA":
        raise CapsuleVerificationError(
            "signature_alg_not_supported",
            f"unsupported alg: {header.get('alg')}",
        )
    if header.get("typ") != JWS_TYP:
        raise CapsuleVerificationError(
            "signature_typ_invalid",
            f"unexpected typ: {header.get('typ')}",
        )
    kid = header.get("kid")
    if not isinstance(kid, str):
        raise CapsuleVerificationError("signature_kid_missing", "missing kid in JWS header")

    jwk = next((k for k in jwks["keys"] if k.get("kid") == kid), None)
    if jwk is None:
        raise CapsuleVerificationError(
            "signature_kid_unknown", f"no JWKS key with kid={kid}",
        )

    try:
        public_key = _public_key_from_jwk(jwk)
        signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
        signature = _b64url_decode(sig_b64)
        public_key.verify(signature, signing_input)
    except InvalidSignature as err:
        raise CapsuleVerificationError(
            "signature_invalid", "JWS signature verification failed",
        ) from err

    try:
        payload: CapsulePayload = json.loads(_b64url_decode(payload_b64))
    except Exception as err:
        raise CapsuleVerificationError("payload_invalid_json", "payload is not JSON") from err

    if payload.get("version") != "veto.capsule/1":
        raise CapsuleVerificationError(
            "capsule_version_unsupported",
            f"unsupported capsule version: {payload.get('version')}",
        )

    now = now or _dt.datetime.now(_dt.timezone.utc)
    try:
        expires_at = _dt.datetime.fromisoformat(payload["expires_at"].replace("Z", "+00:00"))
    except Exception as err:
        raise CapsuleVerificationError(
            "capsule_expires_at_invalid", "expires_at is not a valid date-time",
        ) from err
    try:
        issued_at = _dt.datetime.fromisoformat(payload["issued_at"].replace("Z", "+00:00"))
    except Exception as err:
        raise CapsuleVerificationError(
            "capsule_issued_at_invalid", "issued_at is not a valid date-time",
        ) from err

    if (now - expires_at).total_seconds() > clock_skew_seconds:
        raise CapsuleVerificationError(
            "capsule_expired", f"capsule expired at {payload['expires_at']}",
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
