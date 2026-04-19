"""Type aliases and constants for the Spend Capsule protocol.

Kept minimal: we use TypedDict rather than dataclasses so JSON round-trips
are byte-identical with the TypeScript reference implementation.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

CAPSULE_VERSION: Literal["veto.capsule/1"] = "veto.capsule/1"
RECEIPT_VERSION: Literal["veto.receipt/1"] = "veto.receipt/1"
JWS_TYP: Literal["veto.capsule+jws"] = "veto.capsule+jws"

# SHA-256 of the empty byte string. Used as prev_receipt_hash of the genesis
# receipt. Must match the TS constant byte-for-byte.
GENESIS_PREV_RECEIPT_HASH: str = (
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
)

Rail = Literal[
    "ach",
    "wire",
    "international_wire",
    "book",
    "usdc.eth",
    "usdc.sol",
    "usdc.base",
    "usdc.arb",
]

Decision = Literal["allow", "deny", "require_approval"]


class AmountCeiling(TypedDict):
    currency: str
    amount: str


class CapsulePayload(TypedDict, total=False):
    version: Literal["veto.capsule/1"]
    capsule_id: str
    issuer: str
    entity_id: str
    agent_id: str
    session_id: str
    rail_allowlist: list[Rail]
    counterparty_hash: str
    amount_ceiling: AmountCeiling
    memo_template: str
    invoice_hash: str
    workflow_id: str
    policy_sha256: str
    approval_ref: str | None
    dual_control_ref: str | None
    issued_at: str
    expires_at: str
    max_uses: int
    nonce: str


class ReceiptPayload(TypedDict, total=False):
    version: Literal["veto.receipt/1"]
    receipt_id: str
    entity_id: str
    agent_id: str
    session_id: str
    workflow_id: str
    capsule_id: str | None
    tool: str
    decision: Decision
    reason_code: str
    reason_detail: str
    args_hash: str
    result_hash: str | None
    approval_hash: str | None
    policy_hash: str
    policy_pack_id: str
    counterparty_hash: str | None
    rail: str | None
    amount: AmountCeiling | None
    issued_at: str
    prev_receipt_hash: str
    merkle_root: str


class BankUsBeneficiary(TypedDict):
    type: Literal["bank_us"]
    name: str
    routing: str
    account_last4: str


class BankInternationalBeneficiary(TypedDict, total=False):
    type: Literal["bank_intl"]
    name: str
    iban: str
    swift_bic: str
    country_iso: str


class CryptoBeneficiary(TypedDict):
    type: Literal["crypto"]
    chain: str
    address: str


Beneficiary = BankUsBeneficiary | BankInternationalBeneficiary | CryptoBeneficiary


class JwksKey(TypedDict, total=False):
    kty: Literal["OKP"]
    crv: Literal["Ed25519"]
    kid: str
    x: str
    d: str
    alg: Literal["EdDSA"]
    use: Literal["sig"]


class Jwks(TypedDict):
    keys: list[JwksKey]


class PrivateSigningKey(TypedDict):
    kid: str
    jwk: JwksKey  # must include `d`


class ChainVerifyResult(TypedDict, total=False):
    ok: bool
    breakAt: int
    reason: str


class VerifyCapsuleResult(TypedDict):
    payload: CapsulePayload
    protected_header: dict[str, Any]
