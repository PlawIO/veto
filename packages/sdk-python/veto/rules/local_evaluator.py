"""Local rule evaluator.

Pure-Python counterpart to the TypeScript SDK's ``evaluateRulesLocally``.
Useful for tests, CLIs, and SDK consumers that want rule decisions without
constructing a full ``Veto`` instance.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Mapping

from veto.rules.condition_evaluator import (
    evaluate_condition,
    resolve_field_path,
)
from veto.rules.feed_provider import FeedProvider


@dataclass
class LocalEvalResult:
    decision: Literal["allow", "deny", "require_approval"] | None
    reason: str | None = None
    rule_id: str | None = None


@dataclass
class LocalEvalOptions:
    feed_provider: FeedProvider | None = None
    now: datetime | None = None


def _conditions_match(
    conditions: list[Mapping[str, Any]],
    context: Mapping[str, Any],
    options: LocalEvalOptions,
) -> bool:
    return all(
        evaluate_condition(
            condition=condition,
            context=context,
            now=options.now,
            feed_provider=options.feed_provider,
        )
        for condition in conditions
    )


def evaluate_rules_locally(
    rules: list[Mapping[str, Any]],
    tool_name: str,
    args: Mapping[str, Any],
    options: LocalEvalOptions | None = None,
) -> LocalEvalResult:
    """Evaluate rules against a single tool call.

    First matching enforcing rule wins. ``warn`` and ``log`` are non-blocking
    and evaluation continues, matching the TypeScript SDK.
    """
    opts = options or LocalEvalOptions()
    for rule in rules:
        if rule.get("enabled", True) is False:
            continue

        tools = rule.get("tools")
        if isinstance(tools, list) and tools and tool_name not in tools:
            continue

        conditions = [
            condition
            for condition in rule.get("conditions", [])
            if isinstance(condition, Mapping)
        ]
        condition_groups = [
            [condition for condition in group if isinstance(condition, Mapping)]
            for group in rule.get("condition_groups", [])
            if isinstance(group, list)
        ]

        if conditions and not _conditions_match(conditions, args, opts):
            continue
        if not conditions and condition_groups:
            if not any(_conditions_match(group, args, opts) for group in condition_groups):
                continue

        action = rule.get("action")
        reason = (
            rule.get("description")
            if isinstance(rule.get("description"), str)
            else rule.get("name")
            if isinstance(rule.get("name"), str)
            else None
        )
        rule_id = rule.get("id") if isinstance(rule.get("id"), str) else None

        if action == "block":
            return LocalEvalResult(decision="deny", reason=reason, rule_id=rule_id)
        if action == "require_approval":
            return LocalEvalResult(
                decision="require_approval",
                reason=reason,
                rule_id=rule_id,
            )
        if action == "allow":
            return LocalEvalResult(decision="allow", reason=reason, rule_id=rule_id)

    return LocalEvalResult(decision=None)


__all__ = [
    "LocalEvalOptions",
    "LocalEvalResult",
    "evaluate_condition",
    "evaluate_rules_locally",
    "resolve_field_path",
]

