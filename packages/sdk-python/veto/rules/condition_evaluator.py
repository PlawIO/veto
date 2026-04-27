from __future__ import annotations

import logging
import re
import sys
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from veto.deterministic.regex_safety import is_safe_pattern

# One-time log per pattern so a misconfigured rule emits a single
# error line instead of spamming stderr on every evaluation.
_LOGGED_BAD_PATTERNS: set[str] = set()
_BAD_PATTERN_LOGGER = logging.getLogger("veto.rules.condition_evaluator")


def _report_unsafe_pattern(pattern: str) -> None:
    """Surface a rejected `matches` regex once per process.

    The condition itself returns ``False`` to the caller (the safer of the
    two silent options) but a fail-open block rule should not be invisible.
    PR #201 catches most cases via a load-time scan; this catches rules
    that are added or mutated at runtime.
    """
    if pattern in _LOGGED_BAD_PATTERNS:
        return
    _LOGGED_BAD_PATTERNS.add(pattern)
    truncated = pattern if len(pattern) <= 128 else pattern[:128] + "…"
    message = (
        f"[veto] ERROR: rule `matches` regex rejected by safety heuristic — "
        f"the rule will never fire. Pattern: {truncated!r}"
    )
    # Belt and braces: write to stderr (always visible) and to the
    # standard `logging` module (so structured-logging consumers see it).
    print(message, file=sys.stderr)
    _BAD_PATTERN_LOGGER.error(message)

DAY_ORDER: tuple[str, ...] = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")
DAY_SET = set(DAY_ORDER)
TIME_24H_PATTERN = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

def _build_builtin_context(now: Optional[datetime] = None) -> dict[str, Any]:
    current = now or datetime.now()
    day_of_week = DAY_ORDER[(current.weekday() + 1) % len(DAY_ORDER)]
    return {
        "time": current.isoformat(),
        "day_of_week": day_of_week,
    }


def _resolve_dot_path(field: str, context: Mapping[str, Any]) -> Any:
    """Resolve a dot-notation field path from an evaluation context."""
    if not field:
        return context

    current: Any = context
    for segment in field.split("."):
        if current is None:
            return None
        if not isinstance(current, Mapping):
            return None
        current = current.get(segment)
    return current


def resolve_field_path(
    field: str,
    context: Mapping[str, Any],
    built_in_context: Optional[Mapping[str, Any]] = None,
) -> Any:
    active_context = (
        built_in_context if built_in_context is not None else _build_builtin_context()
    )

    if field == "context":
        return active_context

    if field.startswith("context."):
        return _resolve_dot_path(field[len("context.") :], active_context)

    return _resolve_dot_path(field, context)


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


def _normalize_day(raw: str) -> Optional[str]:
    day = raw.strip().lower()[:3]
    return day if day in DAY_SET else None


def _parse_clock_to_minutes(raw: str) -> Optional[int]:
    if TIME_24H_PATTERN.fullmatch(raw) is None:
        return None
    hour_raw, minute_raw = raw.split(":")
    return int(hour_raw) * 60 + int(minute_raw)


def _normalize_time_window(
    expected: Any,
) -> Optional[tuple[int, int, str, Optional[set[str]]]]:
    if not isinstance(expected, Mapping):
        return None

    start_raw = expected.get("start")
    end_raw = expected.get("end")
    timezone_raw = expected.get("timezone")

    if not isinstance(start_raw, str):
        return None
    if not isinstance(end_raw, str):
        return None
    if not isinstance(timezone_raw, str):
        return None

    start_minutes = _parse_clock_to_minutes(start_raw)
    end_minutes = _parse_clock_to_minutes(end_raw)
    if start_minutes is None or end_minutes is None:
        return None

    days_raw = expected.get("days")
    days: Optional[set[str]] = None
    if days_raw is not None:
        if not isinstance(days_raw, list):
            return None
        days = set()
        for day in days_raw:
            if not isinstance(day, str):
                return None
            normalized_day = _normalize_day(day)
            if normalized_day is None:
                return None
            days.add(normalized_day)

    return start_minutes, end_minutes, timezone_raw, days


def _parse_timestamp(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None

    if isinstance(value, str):
        candidate = value.strip()
        if candidate.endswith("Z"):
            candidate = f"{candidate[:-1]}+00:00"
        try:
            return datetime.fromisoformat(candidate)
        except ValueError:
            return None

    return None


def _get_zoned_day_and_minute(
    timestamp: datetime, timezone_name: str
) -> Optional[tuple[str, int]]:
    try:
        zone = ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError):
        return None

    try:
        localized = timestamp.astimezone(zone)
    except ValueError:
        try:
            localized = timestamp.replace(tzinfo=timezone.utc).astimezone(zone)
        except ValueError:
            return None

    day = DAY_ORDER[(localized.weekday() + 1) % len(DAY_ORDER)]
    minute_of_day = localized.hour * 60 + localized.minute
    return day, minute_of_day


def _previous_day(day: str) -> str:
    index = DAY_ORDER.index(day)
    return DAY_ORDER[(index + len(DAY_ORDER) - 1) % len(DAY_ORDER)]


def _evaluate_time_window(
    field_value: Any, expected: Any
) -> Optional[tuple[bool, bool]]:
    normalized = _normalize_time_window(expected)
    if normalized is None:
        return None

    start_minutes, end_minutes, timezone_name, days = normalized

    timestamp = _parse_timestamp(field_value)
    if timestamp is None:
        return None

    zoned = _get_zoned_day_and_minute(timestamp, timezone_name)
    if zoned is None:
        return None

    day, minute_of_day = zoned

    relevant_day = (
        _previous_day(day)
        if start_minutes > end_minutes and minute_of_day < end_minutes
        else day
    )

    in_scope = days is None or relevant_day in days
    if not in_scope:
        return False, False

    if start_minutes == end_minutes:
        return True, True

    if start_minutes < end_minutes:
        return True, start_minutes <= minute_of_day < end_minutes

    return True, minute_of_day >= start_minutes or minute_of_day < end_minutes


def _length_comparable_size(value: Any) -> Optional[int]:
    if isinstance(value, (list, tuple, set, frozenset)):
        return len(value)

    if isinstance(value, Mapping):
        return len(value)

    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed == "":
            return 0

        if "," in value or ";" in value:
            return len([item.strip() for item in re.split(r"[;,]", value) if item.strip() != ""])

        return 1

    return None


def evaluate_legacy_condition(field_value: Any, operator: str, expected: Any) -> bool:
    """Evaluate a single legacy field/operator/value condition."""
    if operator == "equals":
        if isinstance(field_value, str) and isinstance(expected, str):
            return field_value.lower() == expected.lower()
        return bool(field_value == expected)
    if operator == "not_equals":
        if isinstance(field_value, str) and isinstance(expected, str):
            return field_value.lower() != expected.lower()
        return bool(field_value != expected)
    if operator == "contains":
        if isinstance(field_value, str) and isinstance(expected, str):
            return expected.lower() in field_value.lower()
        if isinstance(field_value, list):
            return expected in field_value
        return False
    if operator == "not_contains":
        if isinstance(field_value, str) and isinstance(expected, str):
            return expected.lower() not in field_value.lower()
        if isinstance(field_value, list):
            return expected not in field_value
        return False
    if operator == "starts_with":
        return (
            isinstance(field_value, str)
            and isinstance(expected, str)
            and field_value.lower().startswith(expected.lower())
        )
    if operator == "ends_with":
        return (
            isinstance(field_value, str)
            and isinstance(expected, str)
            and field_value.lower().endswith(expected.lower())
        )
    if operator == "matches":
        if not isinstance(field_value, str) or not isinstance(expected, str):
            return False
        regex = create_safe_regex(expected, flags=re.IGNORECASE)
        if regex is None:
            # The pattern was rejected by the safety heuristic. Returning
            # ``False`` here means a `block` rule with a broken regex never
            # fires — the silent fail-open class. PR #201's load-time scan
            # catches static rules; this catches rules that are added or
            # mutated at runtime.
            _report_unsafe_pattern(expected)
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
    if operator == "length_greater_than":
        size = _length_comparable_size(field_value)
        if size is None:
            return False

        try:
            expected_size = float(expected)
        except (TypeError, ValueError):
            return False

        return float(size) > expected_size
    if operator == "in":
        if not isinstance(expected, list):
            return False
        if isinstance(field_value, str):
            lower = field_value.lower()
            return any(e.lower() == lower if isinstance(e, str) else e == field_value for e in expected)
        return field_value in expected
    if operator == "not_in":
        if not isinstance(expected, list):
            return False
        if isinstance(field_value, str):
            lower = field_value.lower()
            return not any(e.lower() == lower if isinstance(e, str) else e == field_value for e in expected)
        return field_value not in expected
    if operator == "within_hours":
        result = _evaluate_time_window(field_value, expected)
        return bool(result and result[0] and result[1])
    if operator == "outside_hours":
        result = _evaluate_time_window(field_value, expected)
        return bool(result and result[0] and not result[1])
    return False


def evaluate_condition(
    condition: Mapping[str, Any],
    context: Mapping[str, Any],
    evaluate_expression: Optional[Callable[[str, Mapping[str, Any]], bool]] = None,
    now: Optional[datetime] = None,
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
        built_in_context = _build_builtin_context(now)
        field_value = resolve_field_path(field, context, built_in_context)
        expected = condition.get("value")
        return evaluate_legacy_condition(field_value, operator, expected)

    return False


def evaluate_condition_collections(
    conditions: Optional[list[Mapping[str, Any]]],
    condition_groups: Optional[list[list[Mapping[str, Any]]]],
    context: Mapping[str, Any],
    evaluate_expression: Optional[Callable[[str, Mapping[str, Any]], bool]] = None,
    now: Optional[datetime] = None,
) -> bool:
    """
    Evaluate a rule-like condition collection.

    - conditions: AND semantics
    - condition_groups: OR semantics, each group is AND
    """
    evaluation_time = now or datetime.now()

    if conditions:
        return all(
            evaluate_condition(
                condition=condition,
                context=context,
                evaluate_expression=evaluate_expression,
                now=evaluation_time,
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
                    now=evaluation_time,
                )
                for condition in group
            )
            for group in condition_groups
        )

    return True


def _normalize_agent_ids(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [value for value in raw if isinstance(value, str)]


def evaluate_agent_scope(agents: Any, agent_id: Optional[str]) -> bool:
    """Evaluate a rule ``agents`` scope against an agent identifier."""
    if agents is None:
        return True

    if isinstance(agents, list):
        allowed_agents = _normalize_agent_ids(agents)
        return agent_id is not None and agent_id in allowed_agents

    if isinstance(agents, Mapping):
        excluded_agents = _normalize_agent_ids(agents.get("not"))
        return agent_id is None or agent_id not in excluded_agents

    return True


def rule_applies_to_agent(rule: Mapping[str, Any], agent_id: Optional[str]) -> bool:
    """Return True when a rule applies to the provided agent ID."""
    return evaluate_agent_scope(rule.get("agents"), agent_id)


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
            now=timestamp,
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
