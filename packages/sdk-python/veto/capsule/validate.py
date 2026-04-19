"""Hand-rolled validators for the two protocol payloads.

Mirrors veto/packages/spend-capsule-protocol/src/validate.ts byte-for-byte on
the wire checks. Must stay in sync — the wire format is the contract.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

from .types import CapsulePayload, ReceiptPayload

_RE_CAPSULE_ID = re.compile(r"^cap_[0-9a-z]{24}$")
_RE_WORKFLOW_ID = re.compile(r"^wf_[0-9a-z]{24}$")
_RE_RECEIPT_ID = re.compile(r"^rcp_[0-9a-z]{24}$")
_RE_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
_RE_SHA256_PREFIXED = re.compile(r"^sha256:[0-9a-f]{64}$")
_RE_CURRENCY = re.compile(r"^[A-Z]{3,10}$")
_RE_AMOUNT = re.compile(r"^\d+(\.\d{1,18})?$")
# RFC 3339 date-time with explicit offset (Z or ±HH:MM). Naive local strings
# like "2026-04-17T14:00:00" are rejected because they introduce timezone
# drift between hosts.
_RE_RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"
)

_CAPSULE_REQUIRED = (
    "version",
    "capsule_id",
    "issuer",
    "entity_id",
    "agent_id",
    "rail_allowlist",
    "counterparty_hash",
    "amount_ceiling",
    "invoice_hash",
    "workflow_id",
    "policy_sha256",
    "issued_at",
    "expires_at",
    "nonce",
)

_CAPSULE_ALLOWED = frozenset(
    _CAPSULE_REQUIRED
    + (
        "session_id",
        "memo_template",
        "approval_ref",
        "dual_control_ref",
        "max_uses",
    )
)

_ALLOWED_RAILS = frozenset(
    (
        "ach",
        "wire",
        "international_wire",
        "book",
        "usdc.eth",
        "usdc.sol",
        "usdc.base",
        "usdc.arb",
    )
)


class ValidationError(ValueError):
    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path}: {message}")
        self.path = path


def _require_str(value: Any, path: str, pattern: re.Pattern[str] | None = None, max_len: int | None = None) -> str:
    if not isinstance(value, str):
        raise ValidationError(path, f"must be a string, got {type(value).__name__}")
    if pattern is not None and not pattern.match(value):
        raise ValidationError(path, f"does not match required format {pattern.pattern}")
    if max_len is not None and len(value) > max_len:
        raise ValidationError(path, f"exceeds max length {max_len}")
    return value


def _require_str_or_null(value: Any, path: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValidationError(path, "must be a string or null")
    return value


def _require_rfc3339(value: Any, path: str) -> str:
    s = _require_str(value, path)
    if not _RE_RFC3339.match(s):
        raise ValidationError(
            path,
            'must be RFC 3339 with explicit offset (e.g., "...Z" or "...+00:00"); naive local strings rejected',
        )
    return s


def validate_capsule_payload(input: Any) -> CapsulePayload:
    if not isinstance(input, dict):
        raise ValidationError("$", "must be a JSON object")

    for key in input.keys():
        if key not in _CAPSULE_ALLOWED:
            raise ValidationError(f"$.{key}", "additional properties are not allowed")
    for field in _CAPSULE_REQUIRED:
        if field not in input:
            raise ValidationError(f"$.{field}", "required field is missing")

    if input["version"] != "veto.capsule/1":
        raise ValidationError("$.version", 'must be the literal "veto.capsule/1"')
    _require_str(input["capsule_id"], "$.capsule_id", _RE_CAPSULE_ID)
    issuer = _require_str(input["issuer"], "$.issuer")
    parsed = urlparse(issuer)
    if not parsed.scheme or not parsed.netloc:
        raise ValidationError("$.issuer", "must be a valid URI")
    _require_str(input["entity_id"], "$.entity_id")
    _require_str(input["agent_id"], "$.agent_id")
    if "session_id" in input:
        _require_str(input["session_id"], "$.session_id")

    rails = input["rail_allowlist"]
    if not isinstance(rails, list) or not rails:
        raise ValidationError("$.rail_allowlist", "must be a non-empty array")
    for i, rail in enumerate(rails):
        if not isinstance(rail, str) or rail not in _ALLOWED_RAILS:
            raise ValidationError(f"$.rail_allowlist[{i}]", f"invalid rail: {rail!r}")

    _require_str(input["counterparty_hash"], "$.counterparty_hash", _RE_SHA256_PREFIXED)

    amount_ceiling = input["amount_ceiling"]
    if not isinstance(amount_ceiling, dict):
        raise ValidationError("$.amount_ceiling", "must be an object")
    _require_str(amount_ceiling.get("currency"), "$.amount_ceiling.currency", _RE_CURRENCY)
    _require_str(amount_ceiling.get("amount"), "$.amount_ceiling.amount", _RE_AMOUNT)

    if "memo_template" in input:
        _require_str(input["memo_template"], "$.memo_template", max_len=140)
    _require_str(input["invoice_hash"], "$.invoice_hash", _RE_SHA256_PREFIXED)
    _require_str(input["workflow_id"], "$.workflow_id", _RE_WORKFLOW_ID)
    _require_str(input["policy_sha256"], "$.policy_sha256", _RE_SHA256_HEX)
    if "approval_ref" in input:
        _require_str_or_null(input["approval_ref"], "$.approval_ref")
    if "dual_control_ref" in input:
        _require_str_or_null(input["dual_control_ref"], "$.dual_control_ref")

    _require_rfc3339(input["issued_at"], "$.issued_at")
    _require_rfc3339(input["expires_at"], "$.expires_at")

    if "max_uses" in input:
        mu = input["max_uses"]
        if not isinstance(mu, int) or isinstance(mu, bool) or mu < 1:
            raise ValidationError(
                "$.max_uses", "must be a positive integer (>= 1); null/0 are not allowed"
            )

    nonce = _require_str(input["nonce"], "$.nonce")
    if len(nonce) < 16:
        raise ValidationError("$.nonce", "must be at least 16 characters")

    return input  # type: ignore[return-value]


_RECEIPT_REQUIRED = (
    "version",
    "receipt_id",
    "entity_id",
    "agent_id",
    "tool",
    "decision",
    "issued_at",
    "args_hash",
    "result_hash",
    "policy_hash",
    "prev_receipt_hash",
    "merkle_root",
)

_RECEIPT_ALLOWED = frozenset(
    _RECEIPT_REQUIRED
    + (
        "session_id",
        "workflow_id",
        "capsule_id",
        "reason_code",
        "reason_detail",
        "approval_hash",
        "policy_pack_id",
        "counterparty_hash",
        "rail",
        "amount",
    )
)

_ALLOWED_DECISIONS = frozenset(("allow", "deny", "require_approval"))


def validate_receipt_payload(input: Any) -> ReceiptPayload:
    if not isinstance(input, dict):
        raise ValidationError("$", "must be a JSON object")
    for key in input.keys():
        if key not in _RECEIPT_ALLOWED:
            raise ValidationError(f"$.{key}", "additional properties are not allowed")
    for field in _RECEIPT_REQUIRED:
        if field not in input:
            raise ValidationError(f"$.{field}", "required field is missing")
    if input["version"] != "veto.receipt/1":
        raise ValidationError("$.version", 'must be the literal "veto.receipt/1"')
    _require_str(input["receipt_id"], "$.receipt_id", _RE_RECEIPT_ID)
    _require_str(input["entity_id"], "$.entity_id")
    _require_str(input["agent_id"], "$.agent_id")
    _require_str(input["tool"], "$.tool")
    if not isinstance(input["decision"], str) or input["decision"] not in _ALLOWED_DECISIONS:
        raise ValidationError("$.decision", f"invalid decision: {input['decision']!r}")
    _require_rfc3339(input["issued_at"], "$.issued_at")
    _require_str(input["args_hash"], "$.args_hash", _RE_SHA256_PREFIXED)
    if input["result_hash"] is not None:
        _require_str(input["result_hash"], "$.result_hash", _RE_SHA256_PREFIXED)
    _require_str(input["policy_hash"], "$.policy_hash", _RE_SHA256_HEX)
    _require_str(input["prev_receipt_hash"], "$.prev_receipt_hash", _RE_SHA256_PREFIXED)
    _require_str(input["merkle_root"], "$.merkle_root", _RE_SHA256_PREFIXED)

    return input  # type: ignore[return-value]
