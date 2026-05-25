"""Economic authorization types.

These mirror the TypeScript SDK's protocol-agnostic economic layer: protocol
connectors normalize payment signals into ``EconomicContext`` and the budget
engine/evaluator make one allow / deny / require_approval decision shape.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal, Mapping, Optional, Protocol

EconomicProtocol = Literal["x402", "mpp", "ap2", "custom"]
EconomicDenialReason = Literal[
    "budget_exceeded",
    "approval_required",
    "payer_missing",
    "payer_unauthorized",
    "currency_mismatch",
    "invalid_cost",
    "connector_error",
]
BudgetScope = Literal["session", "agent", "user", "global"]


@dataclass
class EconomicContext:
    """Normalized economic context for one tool/action."""

    cost: float
    currency: str
    protocol: EconomicProtocol
    payer: Optional[str] = None
    protocol_metadata: Optional[dict[str, Any]] = None

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> "EconomicContext":
        raw_protocol = data.get("protocol", "custom")
        protocol: EconomicProtocol = (
            raw_protocol
            if raw_protocol in ("x402", "mpp", "ap2", "custom")
            else "custom"
        )
        raw_cost = data.get("cost")
        cost = float(raw_cost) if isinstance(raw_cost, (int, float)) else float("nan")
        raw_currency = data.get("currency")
        currency = raw_currency if isinstance(raw_currency, str) else "USD"
        raw_payer = data.get("payer")
        raw_metadata = data.get("protocol_metadata")
        return cls(
            cost=cost,
            currency=currency,
            protocol=protocol,
            payer=raw_payer if isinstance(raw_payer, str) else None,
            protocol_metadata=dict(raw_metadata)
            if isinstance(raw_metadata, Mapping)
            else None,
        )

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "cost": self.cost,
            "currency": self.currency,
            "protocol": self.protocol,
        }
        if self.payer is not None:
            payload["payer"] = self.payer
        if self.protocol_metadata is not None:
            payload["protocol_metadata"] = dict(self.protocol_metadata)
        return payload


@dataclass
class EconomicDenialDetails:
    """Machine-readable details for an economic denial."""

    reason: EconomicDenialReason
    cost: float
    currency: str
    budget_scope: str
    budget_limit: float
    budget_spent: float
    budget_remaining: float
    approval_threshold: Optional[float] = None
    payer: Optional[str] = None
    protocol: Optional[str] = None
    message: Optional[str] = None
    connector_name: Optional[str] = None
    raw_error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "reason": self.reason,
            "cost": self.cost,
            "currency": self.currency,
            "budget_scope": self.budget_scope,
            "budget_limit": self.budget_limit,
            "budget_spent": self.budget_spent,
            "budget_remaining": self.budget_remaining,
        }
        optional = {
            "approval_threshold": self.approval_threshold,
            "payer": self.payer,
            "protocol": self.protocol,
            "message": self.message,
            "connector_name": self.connector_name,
            "raw_error": self.raw_error,
        }
        payload.update({key: value for key, value in optional.items() if value is not None})
        return payload


@dataclass
class EconomicBudgetConfig:
    scope: BudgetScope
    limit: float
    currency: str
    window: Literal["session", "1h", "24h", "30d"]
    approval_threshold: Optional[float] = None


@dataclass
class EconomicBudgetStatus:
    scope: BudgetScope
    spent: float
    limit: float
    remaining: float
    currency: str


@dataclass
class BudgetCheckResult:
    allowed: bool
    decision: Literal["allow", "deny", "require_approval"]
    denial: Optional[EconomicDenialDetails] = None


class BudgetEngine(Protocol):
    def check(
        self, cost: float, currency: str, scope: BudgetScope
    ) -> BudgetCheckResult: ...

    def reserve(
        self, cost: float, currency: str, scope: BudgetScope
    ) -> BudgetCheckResult: ...

    def record(self, cost: float, currency: str, scope: BudgetScope) -> None: ...

    def refund(self, amount: float, scope: BudgetScope) -> None: ...

    def get_status(self, scope: BudgetScope) -> Optional[EconomicBudgetStatus]: ...

    def reset(self, scope: BudgetScope) -> None: ...


@dataclass
class EconomicEvaluationResult:
    decision: Literal["allow", "deny", "require_approval"]
    denial: Optional[EconomicDenialDetails] = None


class ProtocolConnector(Protocol):
    protocol: EconomicProtocol
    protocol_version: str

    def extract(self, response: Any) -> Optional[EconomicContext]: ...

    def wrap_fetch(self, fetch_fn: Callable[..., Any]) -> Callable[..., Any]: ...

