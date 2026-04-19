"""Hand-rolled validators for the two protocol payloads.

Mirrors veto/packages/spend-capsule-protocol/src/validate.ts byte-for-byte on
the wire checks. Must stay in sync — the wire format is the contract.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

from .rfc3339 import Rfc3339ParseError, parse_rfc3339_strict
from .types import CapsulePayload, ReceiptPayload

_RE_CAPSULE_ID = re.compile(r"^cap_[0-9a-z]{24}$")
_RE_WORKFLOW_ID = re.compile(r"^wf_[0-9a-z]{24}$")
_RE_RECEIPT_ID = re.compile(r"^rcp_[0-9a-z]{24}$")
_RE_SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
_RE_SHA256_PREFIXED = re.compile(r"^sha256:[0-9a-f]{64}$")
_RE_CURRENCY = re.compile(r"^[A-Z]{3,10}$")
_RE_AMOUNT = re.compile(r"^\d+(\.\d{1,18})?$")
_RE_REASON_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_RE_TOOL = re.compile(r"^[a-z][a-z0-9_.:\-]{0,127}$")
_RE_POLICY_PACK_ID = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

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

_AMOUNT_CEILING_ALLOWED = frozenset(("currency", "amount"))
_RECEIPT_AMOUNT_ALLOWED = frozenset(("currency", "amount"))

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


def _require_str(
    value: Any,
    path: str,
    pattern: re.Pattern[str] | None = None,
    max_len: int | None = None,
    min_len: int | None = None,
) -> str:
    if not isinstance(value, str):
        raise ValidationError(path, f"must be a string, got {type(value).__name__}")
    if min_len is not None and len(value) < min_len:
        raise ValidationError(path, f"must be at least {min_len} characters")
    if pattern is not None and not pattern.match(value):
        raise ValidationError(path, f"does not match required format {pattern.pattern}")
    if max_len is not None and len(value) > max_len:
        raise ValidationError(path, f"exceeds max length {max_len}")
    return value


def _require_str_or_null(value: Any, path: str, min_len: int | None = None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValidationError(path, "must be a string or null")
    if min_len is not None and len(value) < min_len:
        raise ValidationError(path, f"must be at least {min_len} characters")
    return value


def _require_rfc3339(value: Any, path: str) -> str:
    if not isinstance(value, str):
        raise ValidationError(path, f"must be a string, got {type(value).__name__}")
    try:
        parse_rfc3339_strict(value)
    except Rfc3339ParseError as err:
        raise ValidationError(path, str(err)) from err
    return value


def _require_issuer(value: Any, path: str) -> str:
    s = _require_str(value, path, max_len=2048, min_len=1)
    parsed = urlparse(s)
    if parsed.scheme != "https":
        raise ValidationError(path, f"must use https:// scheme; got {parsed.scheme!r}")
    if not parsed.netloc:
        raise ValidationError(path, "must be a valid URL")
    if parsed.username or parsed.password:
        raise ValidationError(path, "must not contain userinfo (user:pass@)")
    if parsed.query:
        raise ValidationError(path, "must not contain a query string")
    if parsed.fragment:
        raise ValidationError(path, "must not contain a fragment")
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
    _require_issuer(input["issuer"], "$.issuer")
    _require_str(input["entity_id"], "$.entity_id", max_len=128, min_len=1)
    _require_str(input["agent_id"], "$.agent_id", max_len=128, min_len=1)
    if "session_id" in input:
        _require_str(input["session_id"], "$.session_id", max_len=128, min_len=1)

    rails = input["rail_allowlist"]
    if not isinstance(rails, list) or not rails:
        raise ValidationError("$.rail_allowlist", "must be a non-empty array")
    seen_rails: set[str] = set()
    for i, rail in enumerate(rails):
        if not isinstance(rail, str) or rail not in _ALLOWED_RAILS:
            raise ValidationError(f"$.rail_allowlist[{i}]", f"invalid rail: {rail!r}")
        if rail in seen_rails:
            raise ValidationError(f"$.rail_allowlist[{i}]", f"duplicate rail: {rail}")
        seen_rails.add(rail)

    _require_str(input["counterparty_hash"], "$.counterparty_hash", _RE_SHA256_PREFIXED)

    amount_ceiling = input["amount_ceiling"]
    if not isinstance(amount_ceiling, dict):
        raise ValidationError("$.amount_ceiling", "must be an object")
    for key in amount_ceiling.keys():
        if key not in _AMOUNT_CEILING_ALLOWED:
            raise ValidationError(
                f"$.amount_ceiling.{key}", "additional properties are not allowed"
            )
    if "currency" not in amount_ceiling:
        raise ValidationError("$.amount_ceiling.currency", "required field is missing")
    if "amount" not in amount_ceiling:
        raise ValidationError("$.amount_ceiling.amount", "required field is missing")
    _require_str(amount_ceiling["currency"], "$.amount_ceiling.currency", _RE_CURRENCY)
    _require_str(amount_ceiling["amount"], "$.amount_ceiling.amount", _RE_AMOUNT)

    if "memo_template" in input:
        _require_str(input["memo_template"], "$.memo_template", max_len=140)
    _require_str(input["invoice_hash"], "$.invoice_hash", _RE_SHA256_PREFIXED)
    _require_str(input["workflow_id"], "$.workflow_id", _RE_WORKFLOW_ID)
    _require_str(input["policy_sha256"], "$.policy_sha256", _RE_SHA256_HEX)
    if "approval_ref" in input:
        _require_str_or_null(input["approval_ref"], "$.approval_ref", min_len=1)
    if "dual_control_ref" in input:
        _require_str_or_null(input["dual_control_ref"], "$.dual_control_ref", min_len=1)

    _require_rfc3339(input["issued_at"], "$.issued_at")
    _require_rfc3339(input["expires_at"], "$.expires_at")

    issued_ms = parse_rfc3339_strict(input["issued_at"]).epoch_ms
    expires_ms = parse_rfc3339_strict(input["expires_at"]).epoch_ms
    if expires_ms <= issued_ms:
        raise ValidationError("$.expires_at", "must be strictly after issued_at")

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
    _require_str(input["entity_id"], "$.entity_id", max_len=128, min_len=1)
    _require_str(input["agent_id"], "$.agent_id", max_len=128, min_len=1)
    _require_str(input["tool"], "$.tool", _RE_TOOL)

    if not isinstance(input["decision"], str) or input["decision"] not in _ALLOWED_DECISIONS:
        raise ValidationError("$.decision", f"invalid decision: {input['decision']!r}")
    _require_rfc3339(input["issued_at"], "$.issued_at")
    _require_str(input["args_hash"], "$.args_hash", _RE_SHA256_PREFIXED)
    if input["result_hash"] is not None:
        _require_str(input["result_hash"], "$.result_hash", _RE_SHA256_PREFIXED)
    _require_str(input["policy_hash"], "$.policy_hash", _RE_SHA256_HEX)
    _require_str(input["prev_receipt_hash"], "$.prev_receipt_hash", _RE_SHA256_PREFIXED)
    _require_str(input["merkle_root"], "$.merkle_root", _RE_SHA256_PREFIXED)

    # Optional fields — fully validate when present.
    if "session_id" in input and input["session_id"] is not None:
        _require_str(input["session_id"], "$.session_id", max_len=128, min_len=1)
    if "workflow_id" in input and input["workflow_id"] is not None:
        _require_str(input["workflow_id"], "$.workflow_id", _RE_WORKFLOW_ID)
    if "capsule_id" in input and input["capsule_id"] is not None:
        _require_str(input["capsule_id"], "$.capsule_id", _RE_CAPSULE_ID)
    if "reason_code" in input and input["reason_code"] is not None:
        _require_str(input["reason_code"], "$.reason_code", _RE_REASON_CODE)
    if "reason_detail" in input and input["reason_detail"] is not None:
        _require_str(input["reason_detail"], "$.reason_detail", max_len=1024)
    if "approval_hash" in input and input["approval_hash"] is not None:
        _require_str(input["approval_hash"], "$.approval_hash", _RE_SHA256_PREFIXED)
    if "policy_pack_id" in input and input["policy_pack_id"] is not None:
        _require_str(input["policy_pack_id"], "$.policy_pack_id", _RE_POLICY_PACK_ID)
    if "counterparty_hash" in input and input["counterparty_hash"] is not None:
        _require_str(input["counterparty_hash"], "$.counterparty_hash", _RE_SHA256_PREFIXED)
    if "rail" in input and input["rail"] is not None:
        rail = input["rail"]
        if not isinstance(rail, str) or rail not in _ALLOWED_RAILS:
            raise ValidationError("$.rail", f"invalid rail: {rail!r}")
    if "amount" in input and input["amount"] is not None:
        amount = input["amount"]
        if not isinstance(amount, dict):
            raise ValidationError("$.amount", "must be an object")
        for key in amount.keys():
            if key not in _RECEIPT_AMOUNT_ALLOWED:
                raise ValidationError(
                    f"$.amount.{key}", "additional properties are not allowed"
                )
        if "currency" not in amount:
            raise ValidationError("$.amount.currency", "required field is missing")
        if "amount" not in amount:
            raise ValidationError("$.amount.amount", "required field is missing")
        _require_str(amount["currency"], "$.amount.currency", _RE_CURRENCY)
        _require_str(amount["amount"], "$.amount.amount", _RE_AMOUNT)

    return input  # type: ignore[return-value]
