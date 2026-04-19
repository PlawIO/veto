"""Ed25519 JWS compact sign/verify for Spend Capsules.

Wire-compatible with @veto/spend-capsule-protocol (TypeScript) — same payload
canonicalization and header key order produce byte-identical JWS.
"""

from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Literal

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from .hash import canonicalize
from .rfc3339 import Rfc3339ParseError, parse_rfc3339_strict
from .types import JWS_TYP, CapsulePayload, Jwks, JwksKey, PrivateSigningKey
from .validate import ValidationError, validate_capsule_payload

DEFAULT_SKEW_SECONDS = 30

CapsuleErrorCode = Literal[
    "jws_malformed",
    "signature_alg_not_supported",
    "signature_typ_invalid",
    "signature_kid_missing",
    "signature_kid_unknown",
    "signature_kid_mismatch",
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
    "capsule_issuer_not_authorized",
    "capsule_entity_not_authorized",
]


@dataclass
class VerifyCapsuleResult:
    payload: CapsulePayload
    protected_header: dict[str, Any]


class CapsuleVerificationError(Exception):
    def __init__(self, code: CapsuleErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class AuthorizedJwksEntry:
    kid: str
    issuer: str
    entity_ids: list[str] | None = None


@dataclass
class AuthorizedJwks:
    keys: list[JwksKey]
    authorizations: list[AuthorizedJwksEntry] = field(default_factory=list)


@dataclass
class TrustAnchor:
    """Verifier trust anchor. A JWKS alone says "some trusted key signed this";
    a TrustAnchor binds each kid to the (issuer, entity_ids) it is authorized
    to sign for."""
    jwks: Jwks | AuthorizedJwks
    require_issuer_binding: bool | None = None


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    try:
        return base64.urlsafe_b64decode((data + pad).encode("ascii"))
    except Exception as err:
        raise CapsuleVerificationError("jws_malformed", "invalid base64url segment") from err


def jwk_thumbprint(jwk: JwksKey) -> str:
    """RFC 7638 JWK thumbprint for Ed25519 (crv, kty, x only)."""
    minimal = {"crv": jwk["crv"], "kty": jwk["kty"], "x": jwk["x"]}
    digest = hashlib.sha256(canonicalize(minimal).encode("utf-8")).digest()
    return _b64url_encode(digest)


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

    # Bind kid to JWK material. Silent relabel has caused real
    # rotation/audit drift across implementations.
    jwk_kid = key["jwk"].get("kid")
    if jwk_kid is not None and jwk_kid != key["kid"]:
        raise ValueError(
            f"PrivateSigningKey.kid ({key['kid']!r}) must equal "
            f"PrivateSigningKey.jwk.kid ({jwk_kid!r})"
        )

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
        header_bytes = _b64url_decode(header_b64)
        try:
            header_json = header_bytes.decode("utf-8")
        except UnicodeDecodeError as err:
            raise CapsuleVerificationError(
                "jws_malformed", "JWS segment is not valid UTF-8"
            ) from err
        return json.loads(header_json)
    except CapsuleVerificationError:
        raise
    except Exception as err:
        raise CapsuleVerificationError("jws_malformed", "invalid JWS header") from err


def _resolve_trust(
    trust: Jwks | AuthorizedJwks | TrustAnchor | dict,
) -> tuple[list[JwksKey], list[AuthorizedJwksEntry] | None, bool]:
    """Return (keys, authorizations_or_None, require_binding).

    Accepts four shapes:
      - TrustAnchor dataclass
      - AuthorizedJwks dataclass
      - Plain dict JWKS (may carry `authorizations` from JSON fixtures)
      - Dict-shaped TrustAnchor with `jwks` + optional `require_issuer_binding`
    """
    if isinstance(trust, TrustAnchor):
        inner = trust.jwks
        req_override = trust.require_issuer_binding
    elif isinstance(trust, dict) and "jwks" in trust and "keys" not in trust:
        # Dict-shaped TrustAnchor. Distinguishable from a plain JWKS because
        # a JWKS MUST have a top-level `keys` array.
        inner = trust["jwks"]
        req_override = trust.get("require_issuer_binding")
    else:
        inner = trust
        req_override = None

    if isinstance(inner, AuthorizedJwks):
        keys = inner.keys
        auths = inner.authorizations
    elif isinstance(inner, dict):
        keys = inner["keys"]
        # A dict can carry `authorizations` — JSON-loaded fixtures and cross-
        # language contract tests use this shape. Promote it to typed entries
        # so the binding check fires correctly instead of silently fail-open.
        auths_raw = inner.get("authorizations")
        auths = (
            [AuthorizedJwksEntry(**a) for a in auths_raw] if auths_raw else None
        )
    else:
        keys = inner["keys"]  # type: ignore[index]
        auths_raw = inner.get("authorizations") if hasattr(inner, "get") else None  # type: ignore[attr-defined]
        auths = (
            [AuthorizedJwksEntry(**a) for a in auths_raw] if auths_raw else None
        )

    # Default posture: require issuer binding. Callers that really want the
    # legacy "any trusted key for any issuer" behavior must pass an explicit
    # TrustAnchor with require_issuer_binding=False. Matches the TS mirror's
    # production-safety default (codex second-pass P0).
    require_binding = req_override if req_override is not None else True
    return keys, auths, require_binding


def verify_capsule(
    jws: str,
    trust: Jwks | AuthorizedJwks | TrustAnchor,
    *,
    clock_skew_seconds: int = DEFAULT_SKEW_SECONDS,
    now: _dt.datetime | None = None,
) -> VerifyCapsuleResult:
    keys, authorizations, require_binding = _resolve_trust(trust)

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
    if not isinstance(kid, str) or not kid:
        raise CapsuleVerificationError("signature_kid_missing", "missing kid in JWS header")

    jwk = next((k for k in keys if k.get("kid") == kid), None)
    if jwk is None:
        raise CapsuleVerificationError("signature_kid_unknown", f"no JWKS key with kid={kid}")
    if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519":
        raise CapsuleVerificationError(
            "jwks_key_invalid", f"JWKS key for kid={kid} must be OKP/Ed25519"
        )
    if jwk.get("kid") != kid:
        raise CapsuleVerificationError(
            "signature_kid_mismatch",
            f"JWKS entry kid {jwk.get('kid')!r} disagrees with header kid {kid!r}",
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
        signed_str = payload_bytes.decode("utf-8")
    except UnicodeDecodeError as err:
        raise CapsuleVerificationError(
            "jws_malformed", "JWS segment is not valid UTF-8"
        ) from err
    try:
        raw_payload = json.loads(signed_str)
    except Exception as err:
        raise CapsuleVerificationError(
            "payload_invalid_json", "payload is not JSON"
        ) from err

    # Canonical-form enforcement.
    expected = canonicalize(raw_payload)
    if expected != signed_str:
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

    # ---- Trust-anchor binding ----
    if authorizations is not None:
        auth = next((a for a in authorizations if a.kid == kid), None)
        if auth is None:
            if require_binding:
                raise CapsuleVerificationError(
                    "signature_kid_unknown",
                    f"kid {kid!r} has no authorization entry in trust anchor",
                )
        else:
            if auth.issuer != payload["issuer"]:
                raise CapsuleVerificationError(
                    "capsule_issuer_not_authorized",
                    f"kid {kid!r} is not authorized to sign for issuer {payload['issuer']!r} "
                    f"(expected {auth.issuer!r})",
                )
            if auth.entity_ids is not None and payload["entity_id"] not in auth.entity_ids:
                raise CapsuleVerificationError(
                    "capsule_entity_not_authorized",
                    f"kid {kid!r} is not authorized for entity_id {payload['entity_id']!r}",
                )
    elif require_binding:
        raise CapsuleVerificationError(
            "signature_kid_unknown",
            "trust anchor has no authorizations; pass AuthorizedJwks or set "
            "require_issuer_binding=False explicitly",
        )

    # ---- Temporal validation ----
    now = now or _dt.datetime.now(_dt.timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    try:
        expires_ms = parse_rfc3339_strict(payload["expires_at"]).epoch_ms
    except Rfc3339ParseError as err:
        raise CapsuleVerificationError("capsule_expires_at_invalid", str(err)) from err
    try:
        issued_ms = parse_rfc3339_strict(payload["issued_at"]).epoch_ms
    except Rfc3339ParseError as err:
        raise CapsuleVerificationError("capsule_issued_at_invalid", str(err)) from err

    if (now_ms - expires_ms) / 1000 > clock_skew_seconds:
        raise CapsuleVerificationError(
            "capsule_expired", f"capsule expired at {payload['expires_at']}"
        )
    if (issued_ms - now_ms) / 1000 > clock_skew_seconds:
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
