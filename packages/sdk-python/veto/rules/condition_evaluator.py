from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Optional
from datetime import datetime
import re

from veto.deterministic.regex_safety import is_safe_pattern


def resolve_field_path(field: str, context: Mapping[str, Any]) -> Any:
    """Resolve a dot-notation field path from an evaluation context."""
    current: Any = context
    for segment in field.split("."):
        if current is None:
            return None
        if not isinstance(current, Mapping):
            return None
        current = current.get(segment)
    return current


def create_safe_regex(pattern: str, flags: int = 0) -> Optional[re.Pattern[str]]:
    """Compile a regex only if it passes safety checks."""
    if len(pattern) > 256:
        return None
    if not is_safe_pattern(pattern):
        return None
    try:
        return re.compile(pattern, flags)
    except re.error:
        return None


def evaluate_legacy_condition(field_value: Any, operator: str, expected: Any) -> bool:
    """Evaluate a single legacy field/operator/value condition."""
    if operator == "equals":
        return bool(field_value == expected)
    if operator == "not_equals":
        return bool(field_value != expected)
    if operator == "contains":
        if isinstance(field_value, str) and isinstance(expected, str):
            return expected in field_value
        if isinstance(field_value, list):
            return expected in field_value
        return False
    if operator == "not_contains":
        if isinstance(field_value, str) and isinstance(expected, str):
            return expected not in field_value
        if isinstance(field_value, list):
            return expected not in field_value
        return True
    if operator == "starts_with":
        return (
            isinstance(field_value, str)
            and isinstance(expected, str)
            and field_value.startswith(expected)
        )
    if operator == "ends_with":
        return (
            isinstance(field_value, str)
            and isinstance(expected, str)
            and field_value.endswith(expected)
        )
    if operator == "matches":
        if not isinstance(field_value, str) or not isinstance(expected, str):
            return False
        regex = create_safe_regex(expected)
        if regex is None:
            return False
        return regex.search(field_value) is not None
    if operator == "greater_than":
        try:
            return float(field_value) > float(expected)
        except (TypeError, ValueError):
            return False
    if operator == "less_than":
        try:
            return float(field_value) < float(expected)
        except (TypeError, ValueError):
            return False
    if operator == "in":
        return isinstance(expected, list) and field_value in expected
    if operator == "not_in":
        return isinstance(expected, list) and field_value not in expected
    return False


def evaluate_condition(
    condition: Mapping[str, Any],
    context: Mapping[str, Any],
    evaluate_expression: Optional[Callable[[str, Mapping[str, Any]], bool]] = None,
) -> bool:
    """Evaluate a condition supporting expression-based and legacy forms."""
    expression = condition.get("expression")
    if isinstance(expression, str):
        if evaluate_expression is None:
            return False
        return evaluate_expression(expression, context)

    field = condition.get("field")
    operator = condition.get("operator")

    if isinstance(field, str) and isinstance(operator, str):
        field_value = resolve_field_path(field, context)
        expected = condition.get("value")
        return evaluate_legacy_condition(field_value, operator, expected)

    return True


def evaluate_condition_collections(
    conditions: Optional[list[Mapping[str, Any]]],
    condition_groups: Optional[list[list[Mapping[str, Any]]]],
    context: Mapping[str, Any],
    evaluate_expression: Optional[Callable[[str, Mapping[str, Any]], bool]] = None,
) -> bool:
    """
    Evaluate a rule-like condition collection.

    - conditions: AND semantics
    - condition_groups: OR semantics, each group is AND
    """
    if conditions:
        return all(
            evaluate_condition(
                condition=condition,
                context=context,
                evaluate_expression=evaluate_expression,
            )
            for condition in conditions
        )

    if condition_groups:
        return any(
            all(
                evaluate_condition(
                    condition=condition,
                    context=context,
                    evaluate_expression=evaluate_expression,
                )
                for condition in group
            )
            for group in condition_groups
        )

    return True


def _get_history_field(entry: Any, key: str) -> Any:
    if isinstance(entry, Mapping):
        return entry.get(key)
    return getattr(entry, key, None)


def _get_history_decision(entry: Any) -> Optional[str]:
    validation_result = _get_history_field(entry, "validation_result")
    if isinstance(validation_result, Mapping):
        decision = validation_result.get("decision")
        return decision if isinstance(decision, str) else None
    decision = getattr(validation_result, "decision", None)
    return decision if isinstance(decision, str) else None


def _coerce_timestamp(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None


def _build_history_context(entry: Any) -> Mapping[str, Any]:
    raw_args = _get_history_field(entry, "arguments")
    args = raw_args if isinstance(raw_args, Mapping) else {}

    tool_name = _get_history_field(entry, "tool_name")
    if not isinstance(tool_name, str):
        tool_name = ""

    decision = _get_history_decision(entry)
    timestamp = _coerce_timestamp(_get_history_field(entry, "timestamp"))

    context: dict[str, Any] = dict(args)
    context["tool_name"] = tool_name
    context["arguments"] = dict(args)
    context["decision"] = decision
    context["timestamp"] = timestamp.isoformat() if timestamp else None
    return context


def has_matching_history_entry(
    constraint: Mapping[str, Any],
    call_history: list[Any],
    now: datetime,
    evaluate_expression: Optional[Callable[[str, Mapping[str, Any]], bool]] = None,
) -> bool:
    required_tool = constraint.get("tool")
    if not isinstance(required_tool, str) or not required_tool:
        return False

    within_raw = constraint.get("within")
    within_seconds: Optional[float] = None
    if isinstance(within_raw, (int, float)):
        within_seconds = max(0.0, float(within_raw))

    for entry in call_history:
        tool_name = _get_history_field(entry, "tool_name")
        if tool_name != required_tool:
            continue

        decision = _get_history_decision(entry)
        if decision == "deny":
            continue

        timestamp = _coerce_timestamp(_get_history_field(entry, "timestamp"))
        if timestamp is None:
            continue

        if within_seconds is not None:
            age_seconds = (now - timestamp).total_seconds()
            if age_seconds < 0 or age_seconds > within_seconds:
                continue

        if not evaluate_condition_collections(
            conditions=constraint.get("conditions")
            if isinstance(constraint.get("conditions"), list)
            else None,
            condition_groups=constraint.get("condition_groups")
            if isinstance(constraint.get("condition_groups"), list)
            else None,
            context=_build_history_context(entry),
            evaluate_expression=evaluate_expression,
        ):
            continue

        return True

    return False


def evaluate_sequence_constraints(
    rule: Mapping[str, Any],
    call_history: list[Any],
    now: Optional[datetime] = None,
    evaluate_expression: Optional[Callable[[str, Mapping[str, Any]], bool]] = None,
) -> bool:
    blocked_by_raw = rule.get("blocked_by")
    requires_raw = rule.get("requires")

    blocked_by = (
        [item for item in blocked_by_raw if isinstance(item, Mapping)]
        if isinstance(blocked_by_raw, list)
        else []
    )
    requires = (
        [item for item in requires_raw if isinstance(item, Mapping)]
        if isinstance(requires_raw, list)
        else []
    )

    if not blocked_by and not requires:
        return True

    evaluation_time = now or datetime.now()
    blocked_by_matched = any(
        has_matching_history_entry(
            constraint=constraint,
            call_history=call_history,
            now=evaluation_time,
            evaluate_expression=evaluate_expression,
        )
        for constraint in blocked_by
    )
    missing_requirement = any(
        not has_matching_history_entry(
            constraint=constraint,
            call_history=call_history,
            now=evaluation_time,
            evaluate_expression=evaluate_expression,
        )
        for constraint in requires
    )

    return blocked_by_matched or missing_requirement
