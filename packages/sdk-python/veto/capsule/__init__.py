"""Veto Spend Capsule protocol — Python mirror of @veto/spend-capsule-protocol.

Provides sign/verify of capsule JWS, beneficiary hashing, and receipt chain
verification. Designed for byte-for-byte interoperability with the TypeScript
reference implementation.

Requires the `capsule` extra: `pip install veto[capsule]`.
"""

from .types import (
    CAPSULE_VERSION,
    GENESIS_PREV_RECEIPT_HASH,
    JWS_TYP,
    RECEIPT_VERSION,
    BankInternationalBeneficiary,
    BankUsBeneficiary,
    CapsulePayload,
    ChainVerifyResult,
    CryptoBeneficiary,
    Jwks,
    JwksKey,
    PrivateSigningKey,
    ReceiptPayload,
)
from .hash import (
    canonicalize,
    hash_beneficiary,
    hash_canonical,
    normalize_beneficiary,
    sha256_hex,
    sha256_prefixed,
)
from .sign import (
    AuthorizedJwks,
    AuthorizedJwksEntry,
    CapsuleVerificationError,
    TrustAnchor,
    jwk_thumbprint,
    public_jwk_from_private,
    sign_capsule,
    verify_capsule,
)
from .rfc3339 import Rfc3339ParseError, is_valid_rfc3339, parse_rfc3339_strict
from .merkle import (
    GENESIS_MERKLE_ROOT,
    MERKLE_BLOCK_SIZE,
    anchor_block,
    build_receipt,
    combine_anchors,
    compute_merkle_root,
    hash_receipt,
    verify_receipt_chain,
)
from .validate import (
    ValidationError,
    validate_capsule_payload,
    validate_receipt_payload,
)

__all__ = [
    "AuthorizedJwks",
    "AuthorizedJwksEntry",
    "CAPSULE_VERSION",
    "CapsulePayload",
    "CapsuleVerificationError",
    "ChainVerifyResult",
    "GENESIS_MERKLE_ROOT",
    "GENESIS_PREV_RECEIPT_HASH",
    "JWS_TYP",
    "Jwks",
    "JwksKey",
    "MERKLE_BLOCK_SIZE",
    "PrivateSigningKey",
    "RECEIPT_VERSION",
    "ReceiptPayload",
    "Rfc3339ParseError",
    "TrustAnchor",
    "BankInternationalBeneficiary",
    "BankUsBeneficiary",
    "CryptoBeneficiary",
    "anchor_block",
    "build_receipt",
    "canonicalize",
    "combine_anchors",
    "compute_merkle_root",
    "hash_beneficiary",
    "hash_canonical",
    "hash_receipt",
    "is_valid_rfc3339",
    "jwk_thumbprint",
    "normalize_beneficiary",
    "parse_rfc3339_strict",
    "public_jwk_from_private",
    "sha256_hex",
    "sha256_prefixed",
    "sign_capsule",
    "verify_capsule",
    "verify_receipt_chain",
    "ValidationError",
    "validate_capsule_payload",
    "validate_receipt_payload",
]
