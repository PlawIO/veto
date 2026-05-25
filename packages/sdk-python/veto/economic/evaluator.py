"""Economic policy evaluator."""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any, Optional, cast

from veto.economic.types import (
    BudgetEngine,
    BudgetScope,
    EconomicBudgetConfig,
    EconomicContext,
    EconomicDenialDetails,
    EconomicEvaluationResult,
)
from veto.rules.condition_evaluator import resolve_field_path
from veto.utils.logger import Logger


def _format_template_value(value: float | int) -> str:
    numeric = float(value)
    if math.isfinite(numeric) and numeric.is_integer():
        return str(int(numeric))
    return str(value)


def parse_economic_budget_configs(raw: Any) -> list[EconomicBudgetConfig]:
    """Normalize policy YAML budget maps into typed budget configs."""
    if not isinstance(raw, list):
        return []

    budgets: list[EconomicBudgetConfig] = []
    for item in raw:
        if not isinstance(item, Mapping):
            continue

        scope_raw = item.get("scope")
        scope: BudgetScope = (
            scope_raw
            if scope_raw in ("session", "agent", "user", "global")
            else "session"
        )
        window_raw = item.get("window")
        window = (
            window_raw
            if window_raw in ("session", "1h", "24h", "30d")
            else "session"
        )
        limit_raw = item.get("limit")
        currency_raw = item.get("currency")
        threshold_raw = item.get("approval_threshold")
        if not isinstance(limit_raw, (int, float)) or isinstance(limit_raw, bool):
            continue
        if not isinstance(currency_raw, str) or not currency_raw:
            continue

        budgets.append(
            EconomicBudgetConfig(
                scope=scope,
                limit=float(limit_raw),
                currency=currency_raw,
                window=cast(Any, window),
                approval_threshold=float(threshold_raw)
                if isinstance(threshold_raw, (int, float))
                and not isinstance(threshold_raw, bool)
                else None,
            )
        )

    return budgets


class EconomicEvaluator:
    """Evaluate payer, currency, and budget checks for an economic context."""

    def __init__(
        self,
        *,
        policy: Mapping[str, Any],
        budget_engine: BudgetEngine,
        logger: Logger,
    ) -> None:
        self._policy = dict(policy)
        self._budget_engine = budget_engine
        self._logger = logger

    def evaluate(
        self,
        economic_context: EconomicContext | Mapping[str, Any],
    ) -> EconomicEvaluationResult:
        context = self._normalize_context(economic_context)

        if (
            not isinstance(context.cost, (int, float))
            or isinstance(context.cost, bool)
            or not math.isfinite(float(context.cost))
            or context.cost < 0
        ):
            self._logger.warn(
                "Economic context has invalid cost",
                {"cost": context.cost, "protocol": context.protocol},
            )
            first_budget = self._first_budget()
            status = (
                self._budget_engine.get_status(first_budget.scope)
                if first_budget is not None
                else None
            )
            return EconomicEvaluationResult(
                decision="deny",
                denial=EconomicDenialDetails(
                    reason="invalid_cost",
                    cost=context.cost,
                    currency=context.currency,
                    budget_scope=first_budget.scope if first_budget else "session",
                    budget_limit=status.limit if status else 0,
                    budget_spent=status.spent if status else 0,
                    budget_remaining=status.remaining if status else 0,
                    protocol=context.protocol,
                    message="Invalid cost: must be a finite non-negative number",
                ),
            )

        payer_result = self._check_payer(context)
        if payer_result is not None:
            return payer_result

        for budget in self._budgets():
            result = self._budget_engine.check(
                context.cost,
                context.currency,
                budget.scope,
            )
            if result.allowed:
                continue

            self._logger.warn(
                "Economic budget check failed",
                {
                    "scope": budget.scope,
                    "decision": result.decision,
                    "cost": context.cost,
                    "reason": result.denial.reason if result.denial else None,
                },
            )
            if result.denial is not None:
                message = self.render_denial_message(result.denial)
                if message:
                    result.denial.message = message
            return EconomicEvaluationResult(
                decision=result.decision,
                denial=result.denial,
            )

        return EconomicEvaluationResult(decision="allow")

    def resolve_cost(self, tool_name: str, args: Mapping[str, Any]) -> Optional[float]:
        extraction = self._policy.get("cost_extraction")
        if not isinstance(extraction, Mapping):
            return None

        path = None
        overrides = extraction.get("overrides")
        if isinstance(overrides, Mapping):
            override = overrides.get(tool_name)
            if isinstance(override, str) and override:
                path = override

        if path is None:
            default = extraction.get("default")
            if isinstance(default, str) and default:
                path = default

        if path is None:
            return None

        value = resolve_field_path(path, {"arguments": dict(args)})
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            numeric = float(value)
            if math.isfinite(numeric) and numeric >= 0:
                return numeric

        return None

    # TypeScript-style alias for callers translating examples directly.
    def resolveCost(self, tool_name: str, args: Mapping[str, Any]) -> Optional[float]:
        return self.resolve_cost(tool_name, args)

    def reserve_budget(self, cost: float, currency: str) -> EconomicEvaluationResult:
        reserved_scopes: list[BudgetScope] = []
        for budget in self._budgets():
            result = self._budget_engine.reserve(cost, currency, budget.scope)
            if not result.allowed:
                for scope in reserved_scopes:
                    self._budget_engine.refund(cost, scope)
                return EconomicEvaluationResult(
                    decision=result.decision,
                    denial=result.denial,
                )
            reserved_scopes.append(budget.scope)

        return EconomicEvaluationResult(decision="allow")

    def reserveBudget(self, cost: float, currency: str) -> EconomicEvaluationResult:
        return self.reserve_budget(cost, currency)

    def refund_budget(self, amount: float) -> None:
        for budget in self._budgets():
            self._budget_engine.refund(amount, budget.scope)

    def refundBudget(self, amount: float) -> None:
        self.refund_budget(amount)

    def render_denial_message(
        self,
        denial: EconomicDenialDetails,
    ) -> Optional[str]:
        templates = self._policy.get("denial_reasons")
        if not isinstance(templates, Mapping):
            return None

        template = templates.get(denial.reason)
        if not isinstance(template, str):
            return None

        return (
            template.replace("{cost}", _format_template_value(denial.cost))
            .replace("{currency}", denial.currency)
            .replace("{scope}", denial.budget_scope)
            .replace("{limit}", _format_template_value(denial.budget_limit))
            .replace("{spent}", _format_template_value(denial.budget_spent))
            .replace("{remaining}", _format_template_value(denial.budget_remaining))
            .replace("{payer}", denial.payer or "unknown")
            .replace(
                "{threshold}",
                _format_template_value(
                    denial.approval_threshold
                    if denial.approval_threshold is not None
                    else denial.budget_limit
                ),
            )
        )

    def renderDenialMessage(
        self,
        denial: EconomicDenialDetails,
    ) -> Optional[str]:
        return self.render_denial_message(denial)

    @staticmethod
    def _normalize_context(
        economic_context: EconomicContext | Mapping[str, Any],
    ) -> EconomicContext:
        if isinstance(economic_context, EconomicContext):
            return economic_context
        return EconomicContext.from_mapping(economic_context)

    def _budgets(self) -> list[EconomicBudgetConfig]:
        return parse_economic_budget_configs(self._policy.get("budgets"))

    def _first_budget(self) -> Optional[EconomicBudgetConfig]:
        budgets = self._budgets()
        return budgets[0] if budgets else None

    def _budget_status_for_denial(self) -> tuple[str, float, float, float]:
        first_budget = self._first_budget()
        if first_budget is None:
            return "session", 0, 0, 0

        status = self._budget_engine.get_status(first_budget.scope)
        if status is None:
            return first_budget.scope, 0, 0, 0
        return status.scope, status.limit, status.spent, status.remaining

    def _check_payer(
        self,
        context: EconomicContext,
    ) -> Optional[EconomicEvaluationResult]:
        payer_config = self._policy.get("payer")
        if not isinstance(payer_config, Mapping):
            return None

        required = payer_config.get("required") is True
        approved_raw = payer_config.get("approved")
        approved = [item for item in approved_raw if isinstance(item, str)] if isinstance(approved_raw, list) else []

        if required and not context.payer:
            self._logger.warn(
                "Payer required but missing",
                {"protocol": context.protocol},
            )
            scope, limit, spent, remaining = self._budget_status_for_denial()
            denial = EconomicDenialDetails(
                reason="payer_missing",
                cost=context.cost,
                currency=context.currency,
                budget_scope=scope,
                budget_limit=limit,
                budget_spent=spent,
                budget_remaining=remaining,
                protocol=context.protocol,
            )
            message = self.render_denial_message(denial)
            if message:
                denial.message = message
            return EconomicEvaluationResult(decision="deny", denial=denial)

        if approved and context.payer and context.payer not in approved:
            self._logger.warn(
                "Payer not in approved list",
                {"payer": context.payer, "protocol": context.protocol},
            )
            scope, limit, spent, remaining = self._budget_status_for_denial()
            denial = EconomicDenialDetails(
                reason="payer_unauthorized",
                cost=context.cost,
                currency=context.currency,
                budget_scope=scope,
                budget_limit=limit,
                budget_spent=spent,
                budget_remaining=remaining,
                payer=context.payer,
                protocol=context.protocol,
            )
            message = self.render_denial_message(denial)
            if message:
                denial.message = message
            return EconomicEvaluationResult(decision="deny", denial=denial)

        return None
