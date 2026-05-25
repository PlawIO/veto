"""Local in-memory budget engine for economic authorization."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from veto.economic.types import (
    BudgetCheckResult,
    BudgetScope,
    EconomicBudgetConfig,
    EconomicBudgetStatus,
    EconomicDenialDetails,
    EconomicDenialReason,
)
from veto.utils.logger import Logger


@dataclass
class _BudgetState:
    spent: float
    limit: float
    currency: str
    approval_threshold: Optional[float] = None


class LocalBudgetEngine:
    """Session-only in-memory budget engine.

    TypeScript intentionally keeps local SDK budgets scoped to ``session``.
    Agent/user/global windows need the platform because they need shared state.
    """

    def __init__(
        self,
        *,
        budgets: list[EconomicBudgetConfig],
        logger: Logger,
    ) -> None:
        self._logger = logger
        self._state: dict[BudgetScope, _BudgetState] = {}

        for budget in budgets:
            if budget.scope != "session":
                self._logger.warn(
                    "LocalBudgetEngine only supports session scope — "
                    f"ignoring {budget.scope} budget. Use Veto Cloud for "
                    "agent/user/global scopes.",
                    {"scope": budget.scope, "window": budget.window},
                )
                continue

            self._state[budget.scope] = _BudgetState(
                spent=0,
                limit=budget.limit,
                currency=budget.currency,
                approval_threshold=budget.approval_threshold,
            )

    def check(
        self,
        cost: float,
        currency: str,
        scope: BudgetScope,
    ) -> BudgetCheckResult:
        safe_cost = self._sanitize_cost(cost)
        budget = self._state.get(scope)
        if budget is None:
            return BudgetCheckResult(allowed=True, decision="allow")

        if currency.upper() != budget.currency.upper():
            return BudgetCheckResult(
                allowed=False,
                decision="deny",
                denial=self._build_denial(
                    "currency_mismatch", safe_cost, currency, budget, scope
                ),
            )

        remaining = budget.limit - budget.spent
        if safe_cost > remaining:
            self._logger.warn(
                "Budget would be exceeded",
                {
                    "scope": scope,
                    "cost": safe_cost,
                    "spent": budget.spent,
                    "limit": budget.limit,
                },
            )
            return BudgetCheckResult(
                allowed=False,
                decision="deny",
                denial=self._build_denial(
                    "budget_exceeded", safe_cost, currency, budget, scope
                ),
            )

        if (
            budget.approval_threshold is not None
            and safe_cost > budget.approval_threshold
        ):
            self._logger.info(
                "Cost exceeds approval threshold",
                {
                    "scope": scope,
                    "cost": safe_cost,
                    "threshold": budget.approval_threshold,
                },
            )
            return BudgetCheckResult(
                allowed=False,
                decision="require_approval",
                denial=self._build_denial(
                    "approval_required", safe_cost, currency, budget, scope
                ),
            )

        return BudgetCheckResult(allowed=True, decision="allow")

    def reserve(
        self,
        cost: float,
        currency: str,
        scope: BudgetScope,
    ) -> BudgetCheckResult:
        result = self.check(cost, currency, scope)
        if not result.allowed:
            return result

        safe_cost = self._sanitize_cost(cost)
        budget = self._state.get(scope)
        if budget is not None and safe_cost > 0:
            budget.spent += safe_cost
            self._logger.debug(
                "Budget reserved",
                {
                    "scope": scope,
                    "cost": safe_cost,
                    "totalSpent": budget.spent,
                    "remaining": budget.limit - budget.spent,
                },
            )

        return result

    def record(self, cost: float, _currency: str, scope: BudgetScope) -> None:
        safe_cost = self._sanitize_cost(cost)
        budget = self._state.get(scope)
        if budget is not None and safe_cost > 0:
            budget.spent += safe_cost
            self._logger.debug(
                "Budget charge recorded",
                {
                    "scope": scope,
                    "cost": safe_cost,
                    "totalSpent": budget.spent,
                    "remaining": budget.limit - budget.spent,
                },
            )

    def refund(self, amount: float, scope: BudgetScope) -> None:
        if amount <= 0:
            return

        budget = self._state.get(scope)
        if budget is None:
            return

        budget.spent = max(0, budget.spent - amount)
        self._logger.debug(
            "Budget refunded",
            {
                "scope": scope,
                "amount": amount,
                "totalSpent": budget.spent,
                "remaining": budget.limit - budget.spent,
            },
        )

    def get_status(self, scope: BudgetScope) -> Optional[EconomicBudgetStatus]:
        budget = self._state.get(scope)
        if budget is None:
            return None
        return EconomicBudgetStatus(
            scope=scope,
            spent=budget.spent,
            limit=budget.limit,
            remaining=max(0, budget.limit - budget.spent),
            currency=budget.currency,
        )

    # TypeScript-style alias for callers translating examples directly.
    def getStatus(self, scope: BudgetScope) -> Optional[EconomicBudgetStatus]:
        return self.get_status(scope)

    def reset(self, scope: BudgetScope) -> None:
        budget = self._state.get(scope)
        if budget is None:
            return

        previous = budget.spent
        budget.spent = 0
        self._logger.debug("Budget reset", {"scope": scope, "previousSpent": previous})

    @staticmethod
    def _sanitize_cost(cost: float) -> float:
        if not isinstance(cost, (int, float)) or isinstance(cost, bool):
            return 0
        if not math.isfinite(float(cost)) or cost < 0:
            return 0
        return float(cost)

    @staticmethod
    def _build_denial(
        reason: EconomicDenialReason,
        cost: float,
        currency: str,
        budget: _BudgetState,
        scope: BudgetScope,
    ) -> EconomicDenialDetails:
        return EconomicDenialDetails(
            reason=reason,
            cost=cost,
            currency=currency,
            budget_scope=scope,
            budget_limit=budget.limit,
            budget_spent=budget.spent,
            budget_remaining=max(0, budget.limit - budget.spent),
            approval_threshold=budget.approval_threshold,
        )

