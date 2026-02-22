from datetime import datetime, timedelta, timezone
from typing import Literal

from veto.rules import evaluate_condition_collections, evaluate_sequence_constraints
from veto.types.config import ToolCallHistoryEntry, ValidationResult


def _entry(
    tool_name: str,
    arguments: dict,
    timestamp: datetime,
    decision: Literal["allow", "deny", "modify", "require_approval"] = "allow",
) -> ToolCallHistoryEntry:
    return ToolCallHistoryEntry(
        tool_name=tool_name,
        arguments=arguments,
        validation_result=ValidationResult(decision=decision),
        timestamp=timestamp,
    )


def test_blocked_by_without_conditions() -> None:
    now = datetime.now(timezone.utc)
    rule = {
        "blocked_by": [
            {"tool": "read_file"},
        ],
    }

    assert evaluate_sequence_constraints(rule, [_entry("read_file", {}, now)], now=now)
    assert not evaluate_sequence_constraints(rule, [], now=now)


def test_blocked_by_with_conditions() -> None:
    now = datetime.now(timezone.utc)
    rule = {
        "blocked_by": [
            {
                "tool": "read_file",
                "conditions": [
                    {
                        "field": "arguments.path",
                        "operator": "starts_with",
                        "value": "/etc/secrets",
                    }
                ],
            }
        ],
    }

    public_read = _entry("read_file", {"path": "/tmp/public.txt"}, now)
    secret_read = _entry("read_file", {"path": "/etc/secrets/token"}, now)

    assert not evaluate_sequence_constraints(rule, [public_read], now=now)
    assert evaluate_sequence_constraints(rule, [secret_read], now=now)


def test_requires_without_time_window() -> None:
    now = datetime.now(timezone.utc)
    rule = {
        "requires": [
            {"tool": "verify_identity"},
        ],
    }

    assert evaluate_sequence_constraints(rule, [], now=now)
    assert not evaluate_sequence_constraints(
        rule,
        [_entry("verify_identity", {"user_id": "u-1"}, now)],
        now=now,
    )


def test_requires_within_window() -> None:
    now = datetime.now(timezone.utc)
    rule = {
        "requires": [
            {"tool": "verify_identity", "within": 300},
        ],
    }

    recent = _entry(
        "verify_identity",
        {"user_id": "u-2"},
        now - timedelta(seconds=299),
    )
    expired = _entry(
        "verify_identity",
        {"user_id": "u-2"},
        now - timedelta(seconds=301),
    )

    assert not evaluate_sequence_constraints(rule, [recent], now=now)
    assert evaluate_sequence_constraints(rule, [expired], now=now)


def test_multiple_sequence_constraints_on_one_rule() -> None:
    now = datetime.now(timezone.utc)
    rule = {
        "blocked_by": [{"tool": "read_file"}],
        "requires": [{"tool": "verify_identity"}],
    }

    history_with_verify_only = [_entry("verify_identity", {"user_id": "u-3"}, now)]
    history_with_verify_and_read = [
        _entry("verify_identity", {"user_id": "u-3"}, now),
        _entry("read_file", {"path": "/tmp/a.txt"}, now),
    ]

    assert not evaluate_sequence_constraints(rule, history_with_verify_only, now=now)
    assert evaluate_sequence_constraints(rule, history_with_verify_and_read, now=now)
    assert evaluate_sequence_constraints(rule, [], now=now)


def test_interaction_with_condition_based_rules() -> None:
    now = datetime.now(timezone.utc)
    rule = {
        "conditions": [
            {
                "field": "arguments.amount",
                "operator": "greater_than",
                "value": 1000,
            }
        ],
        "requires": [{"tool": "verify_identity"}],
    }

    high_value_context = {"arguments": {"amount": 5000}}
    low_value_context = {"arguments": {"amount": 100}}
    history = []

    high_value_match = evaluate_condition_collections(
        rule.get("conditions"),
        rule.get("condition_groups"),
        high_value_context,
    ) and evaluate_sequence_constraints(rule, history, now=now)
    low_value_match = evaluate_condition_collections(
        rule.get("conditions"),
        rule.get("condition_groups"),
        low_value_context,
    ) and evaluate_sequence_constraints(rule, history, now=now)

    assert high_value_match
    assert not low_value_match


def test_history_size_limit_effect() -> None:
    now = datetime.now(timezone.utc)
    rule = {"requires": [{"tool": "bootstrap"}]}

    full_history = [_entry("bootstrap", {"ok": True}, now - timedelta(seconds=1))]
    for i in range(100):
        full_history.append(_entry("noop", {"i": i}, now))

    retained_history = full_history[-100:]

    assert not evaluate_sequence_constraints(rule, full_history, now=now)
    assert evaluate_sequence_constraints(rule, retained_history, now=now)
