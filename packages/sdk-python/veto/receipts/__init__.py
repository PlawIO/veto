"""Universal decision receipt helpers for the Python SDK."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Literal, Mapping, TypeAlias

RECEIPT_VERSION = "veto.receipt/1"
GENESIS_PREVIOUS_RECEIPT_HASH = (
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
)

_DOMAIN_LEAF = 0x00
_DOMAIN_NODE = 0x01
_DOMAIN_ANCHOR = 0x02
_DOMAIN_ROOT = 0x03
MERKLE_BLOCK_SIZE = 1024

ReceiptDecision: TypeAlias = Literal[
    "allow",
    "deny",
    "require_approval",
    "approval_approved",
    "approval_denied",
]
Sha256Digest: TypeAlias = str

_RE_RECEIPT_ID = re.compile(r"^rcp_[0-9a-z]{24}$")
_RE_SHA256_PREFIXED = re.compile(r"^sha256:[0-9a-f]{64}$")
_RE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
_RE_TOOL_NAME = re.compile(r"^[A-Za-z0-9_.:/-]{1,200}$")
_RE_REASON_CODE = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$")
_RE_RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$"
)

_REQUIRED = (
    "version",
    "receipt_id",
    "organization_id",
    "project_id",
    "decision_id",
    "tool_name",
    "policy_version",
    "policy_hash",
    "decision",
    "redacted_arguments",
    "argument_hash",
    "result_hash",
    "approval_hash",
    "previous_receipt_hash",
    "merkle_root",
    "timestamp",
)

_ALLOWED = frozenset(
    _REQUIRED
    + (
        "approval_id",
        "session_id",
        "agent_id",
        "client_id",
        "connection_id",
        "upstream_id",
        "tool_schema_hash",
        "policy_id",
        "reason_code",
        "reason_detail",
        "trace_id",
    )
)

_ALLOWED_DECISIONS = {
    "allow",
    "deny",
    "require_approval",
    "approval_approved",
    "approval_denied",
}


class ValidationError(ValueError):
    """Raised when a receipt payload does not match ``veto.receipt/1``."""

    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path}: {message}")
        self.path = path


@dataclass(frozen=True)
class ReceiptSummary:
    receipt_id: str
    receipt_hash: Sha256Digest
    previous_receipt_hash: Sha256Digest
    merkle_root: Sha256Digest

    def as_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass(frozen=True)
class DecisionOutcome:
    decision: Literal["allow", "deny", "require_approval"]
    mode: str | None = None
    reason: str | None = None
    approval_id: str | None = None
    receipt: ReceiptSummary | None = None
    latency_ms: int | None = None
    validations: list[dict[str, Any]] | None = None
    denial: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        data = asdict(self)
        return {key: value for key, value in data.items() if value is not None}


DecisionReceiptPayload: TypeAlias = dict[str, Any]


def canonicalize(value: Any) -> str:
    try:
        import jcs  # type: ignore[import-not-found]

        result = jcs.canonicalize(value)
        return result.decode("utf-8") if isinstance(result, bytes) else str(result)
    except ModuleNotFoundError:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_prefixed(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def hash_canonical(value: Any) -> str:
    return sha256_prefixed(canonicalize(value))


GENESIS_MERKLE_ROOT = sha256_prefixed(bytes([_DOMAIN_ANCHOR]) + b"veto.merkle.genesis/1")


def _require_str(
    value: Any,
    path: str,
    pattern: re.Pattern[str] | None = None,
    *,
    max_len: int | None = None,
    min_len: int | None = None,
) -> str:
    if not isinstance(value, str):
        raise ValidationError(path, f"must be a string, got {type(value).__name__}")
    if min_len is not None and len(value) < min_len:
        raise ValidationError(path, f"must be at least {min_len} characters")
    if max_len is not None and len(value) > max_len:
        raise ValidationError(path, f"exceeds max length {max_len}")
    if pattern is not None and not pattern.match(value):
        raise ValidationError(path, "does not match required format")
    return value


def _require_str_or_none(
    value: Any,
    path: str,
    pattern: re.Pattern[str] | None = None,
    *,
    max_len: int | None = None,
    min_len: int | None = None,
) -> str | None:
    if value is None:
        return None
    return _require_str(value, path, pattern, max_len=max_len, min_len=min_len)


def _require_sha256(value: Any, path: str) -> str:
    return _require_str(value, path, _RE_SHA256_PREFIXED)


def _parse_rfc3339(value: Any, path: str) -> datetime:
    if not isinstance(value, str):
        raise ValidationError(path, f"must be a string, got {type(value).__name__}")
    if not _RE_RFC3339.match(value):
        raise ValidationError(path, "must be RFC 3339")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError(path, f"must be RFC 3339: {exc}") from exc


def now_rfc3339() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00",
        "Z",
    )


def create_receipt_id() -> str:
    return f"rcp_{uuid.uuid4().hex[:24]}"


def create_decision_id() -> str:
    return f"dec_{uuid.uuid4().hex[:24]}"


def _strip_sha256(value: str) -> bytes:
    if not _RE_SHA256_PREFIXED.match(value):
        raise ValueError("digest must be sha256:<64 lowercase hex chars>")
    return bytes.fromhex(value[7:])


def _tagged_hash(domain: int, *parts: bytes) -> bytes:
    return hashlib.sha256(bytes([domain]) + b"".join(parts)).digest()


def compute_merkle_root(leaves: Iterable[str]) -> str:
    level = [_tagged_hash(_DOMAIN_LEAF, _strip_sha256(leaf)) for leaf in leaves]
    leaf_count = len(level)
    if not level:
        return GENESIS_MERKLE_ROOT
    while len(level) > 1:
        next_level: list[bytes] = []
        for index in range(0, len(level), 2):
            left = level[index]
            right = level[index + 1] if index + 1 < len(level) else left
            next_level.append(_tagged_hash(_DOMAIN_NODE, left, right))
        level = next_level
    root = _tagged_hash(_DOMAIN_ROOT, leaf_count.to_bytes(8, "big"), level[0])
    return f"sha256:{root.hex()}"


def validate_receipt_payload(input: Any) -> DecisionReceiptPayload:
    if not isinstance(input, dict):
        raise ValidationError("$", "must be a JSON object")
    for key in input.keys():
        if key not in _ALLOWED:
            raise ValidationError(f"$.{key}", "additional properties are not allowed")
    for field in _REQUIRED:
        if field not in input:
            raise ValidationError(f"$.{field}", "required field is missing")

    if input["version"] != RECEIPT_VERSION:
        raise ValidationError("$.version", 'must be the literal "veto.receipt/1"')
    _require_str(input["receipt_id"], "$.receipt_id", _RE_RECEIPT_ID)
    _require_str(input["organization_id"], "$.organization_id", _RE_ID)
    _require_str_or_none(input["project_id"], "$.project_id", _RE_ID)
    _require_str(input["decision_id"], "$.decision_id", _RE_ID)
    if "approval_id" in input:
        _require_str_or_none(input["approval_id"], "$.approval_id", _RE_ID)
    if "session_id" in input:
        _require_str_or_none(input["session_id"], "$.session_id", _RE_ID)
    if "agent_id" in input:
        _require_str_or_none(input["agent_id"], "$.agent_id", _RE_ID)
    if "client_id" in input:
        _require_str_or_none(input["client_id"], "$.client_id", _RE_ID)
    if "connection_id" in input:
        _require_str_or_none(input["connection_id"], "$.connection_id", max_len=256, min_len=1)
    if "upstream_id" in input:
        _require_str_or_none(input["upstream_id"], "$.upstream_id", _RE_ID)
    _require_str(input["tool_name"], "$.tool_name", _RE_TOOL_NAME)
    if "tool_schema_hash" in input:
        _require_str_or_none(input["tool_schema_hash"], "$.tool_schema_hash", _RE_SHA256_PREFIXED)
    if "policy_id" in input:
        _require_str_or_none(input["policy_id"], "$.policy_id", _RE_ID)
    _require_str(input["policy_version"], "$.policy_version", max_len=128, min_len=1)
    _require_sha256(input["policy_hash"], "$.policy_hash")
    if not isinstance(input["decision"], str) or input["decision"] not in _ALLOWED_DECISIONS:
        raise ValidationError("$.decision", f"invalid decision: {input['decision']!r}")
    if "reason_code" in input:
        _require_str_or_none(input["reason_code"], "$.reason_code", _RE_REASON_CODE)
    if "reason_detail" in input:
        _require_str_or_none(input["reason_detail"], "$.reason_detail", max_len=2048)
    _require_sha256(input["argument_hash"], "$.argument_hash")
    _require_str_or_none(input["result_hash"], "$.result_hash", _RE_SHA256_PREFIXED)
    _require_str_or_none(input["approval_hash"], "$.approval_hash", _RE_SHA256_PREFIXED)
    _require_sha256(input["previous_receipt_hash"], "$.previous_receipt_hash")
    _require_sha256(input["merkle_root"], "$.merkle_root")
    _parse_rfc3339(input["timestamp"], "$.timestamp")
    if "trace_id" in input:
        _require_str_or_none(input["trace_id"], "$.trace_id", max_len=256, min_len=1)
    return dict(input)


def hash_receipt(receipt: Mapping[str, Any]) -> str:
    return hash_canonical(dict(receipt))


def receipt_summary(receipt: Mapping[str, Any]) -> ReceiptSummary:
    payload = validate_receipt_payload(dict(receipt))
    return ReceiptSummary(
        receipt_id=payload["receipt_id"],
        receipt_hash=hash_receipt(payload),
        previous_receipt_hash=payload["previous_receipt_hash"],
        merkle_root=payload["merkle_root"],
    )


def build_decision_receipt(
    *,
    tool_name: str,
    arguments: Mapping[str, Any],
    decision: ReceiptDecision,
    reason: str | None = None,
    approval_id: str | None = None,
    session_id: str | None = None,
    agent_id: str | None = None,
    organization_id: str = "local",
    project_id: str | None = None,
    decision_id: str | None = None,
    policy_version: str = "1.0",
    policy_hash: str | None = None,
    previous_receipt: Mapping[str, Any] | None = None,
    timestamp: str | None = None,
) -> DecisionReceiptPayload:
    previous_payload = validate_receipt_payload(dict(previous_receipt)) if previous_receipt else None
    previous_hash = (
        hash_receipt(previous_payload)
        if previous_payload is not None
        else GENESIS_PREVIOUS_RECEIPT_HASH
    )
    payload: DecisionReceiptPayload = {
        "version": RECEIPT_VERSION,
        "receipt_id": create_receipt_id(),
        "organization_id": organization_id,
        "project_id": project_id,
        "decision_id": decision_id or create_decision_id(),
        "approval_id": approval_id,
        "session_id": session_id,
        "agent_id": agent_id,
        "tool_name": tool_name,
        "policy_version": policy_version,
        "policy_hash": policy_hash or hash_canonical({"policy_version": policy_version}),
        "decision": decision,
        "reason_detail": reason,
        "redacted_arguments": dict(arguments),
        "argument_hash": hash_canonical(dict(arguments)),
        "result_hash": None,
        "approval_hash": None,
        "previous_receipt_hash": previous_hash,
        "merkle_root": (
            previous_payload["merkle_root"]
            if previous_payload is not None
            else GENESIS_MERKLE_ROOT
        ),
        "timestamp": timestamp or now_rfc3339(),
    }
    return validate_receipt_payload(payload)


def iter_ndjson_lines(lines: Iterable[str]) -> Iterator[DecisionReceiptPayload]:
    for line_no, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"line {line_no}: invalid JSON: {exc}") from exc
        try:
            yield validate_receipt_payload(parsed)
        except ValidationError as exc:
            raise ValueError(f"line {line_no}: invalid receipt: {exc}") from exc


def parse_ndjson(text: str) -> list[DecisionReceiptPayload]:
    return list(iter_ndjson_lines(text.splitlines()))


def format_ndjson(receipts: Iterable[Mapping[str, Any]]) -> str:
    rows = [canonicalize(validate_receipt_payload(dict(receipt))) for receipt in receipts]
    return "\n".join(rows) + ("\n" if rows else "")


def verify_receipt_chain(
    receipts: Iterable[Mapping[str, Any]],
    *,
    timestamp_skew_seconds: int = 5,
) -> dict[str, Any]:
    payloads = [validate_receipt_payload(dict(receipt)) for receipt in receipts]
    prev_timestamp: datetime | None = None
    prev_root: str | None = None
    skew_seconds = max(0, timestamp_skew_seconds)

    for index, receipt in enumerate(payloads):
        expected_previous = (
            GENESIS_PREVIOUS_RECEIPT_HASH
            if index == 0
            else hash_receipt(payloads[index - 1])
        )
        if receipt["previous_receipt_hash"] != expected_previous:
            return {
                "ok": False,
                "breakAt": index,
                "reason": (
                    "receipt[0] previous_receipt_hash must be the genesis hash"
                    if index == 0
                    else f"receipt[{index}] previous_receipt_hash does not match sha256 of receipt[{index - 1}]"
                ),
            }

        timestamp = _parse_rfc3339(receipt["timestamp"], f"receipt[{index}].timestamp")
        if prev_timestamp is not None:
            if timestamp.timestamp() + skew_seconds < prev_timestamp.timestamp():
                return {
                    "ok": False,
                    "breakAt": index,
                    "reason": (
                        f"receipt[{index}] timestamp {receipt['timestamp']} precedes "
                        f"receipt[{index - 1}].timestamp beyond tolerated skew"
                    ),
                }
            if timestamp > prev_timestamp:
                prev_timestamp = timestamp
        else:
            prev_timestamp = timestamp

        if prev_root is not None and receipt["merkle_root"] != prev_root:
            at_boundary = index % MERKLE_BLOCK_SIZE == 0
            if not at_boundary:
                return {
                    "ok": False,
                    "breakAt": index,
                    "reason": (
                        f"receipt[{index}] merkle_root changed mid-block "
                        f"(position {index % MERKLE_BLOCK_SIZE})"
                    ),
                }
        prev_root = receipt["merkle_root"]

    return {"ok": True}


def verify_file(path: str | Path) -> dict[str, Any]:
    receipt_path = Path(path)
    if not receipt_path.exists():
        return {"ok": False, "reason": f"Receipt file not found: {receipt_path}"}
    try:
        receipts = parse_ndjson(receipt_path.read_text(encoding="utf-8"))
        result = verify_receipt_chain(receipts)
    except Exception as exc:
        return {"ok": False, "reason": str(exc)}
    result["count"] = len(receipts)
    result["finalReceiptHash"] = hash_receipt(receipts[-1]) if receipts else None
    return result


def load_last_receipt(path: str | Path) -> DecisionReceiptPayload | None:
    receipt_path = Path(path)
    if not receipt_path.exists():
        return None
    last_line: str | None = None
    with receipt_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            if raw_line.strip():
                last_line = raw_line
    if last_line is None:
        return None
    return parse_ndjson(last_line)[0]


def append_receipt(path: str | Path, receipt: Mapping[str, Any]) -> None:
    receipt_path = Path(path)
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    with receipt_path.open("a", encoding="utf-8") as handle:
        handle.write(format_ndjson([receipt]))


__all__ = [
    "DecisionOutcome",
    "DecisionReceiptPayload",
    "GENESIS_MERKLE_ROOT",
    "GENESIS_PREVIOUS_RECEIPT_HASH",
    "MERKLE_BLOCK_SIZE",
    "RECEIPT_VERSION",
    "ReceiptSummary",
    "ValidationError",
    "append_receipt",
    "build_decision_receipt",
    "compute_merkle_root",
    "format_ndjson",
    "hash_receipt",
    "iter_ndjson_lines",
    "load_last_receipt",
    "parse_ndjson",
    "receipt_summary",
    "validate_receipt_payload",
    "verify_file",
    "verify_receipt_chain",
]
