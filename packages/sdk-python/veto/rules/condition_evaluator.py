from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Optional
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
