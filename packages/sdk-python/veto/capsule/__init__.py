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
    CapsuleVerificationError,
    public_jwk_from_private,
    sign_capsule,
    verify_capsule,
)
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

__all__ = [
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
    "normalize_beneficiary",
    "public_jwk_from_private",
    "sha256_hex",
    "sha256_prefixed",
    "sign_capsule",
    "verify_capsule",
    "verify_receipt_chain",
]
