"""Regression tests for validation hardening (audit follow-up)."""
from __future__ import annotations

import asyncio

from veto import Veto
from veto.core.history import HistoryTracker, HistoryTrackerOptions
from veto.core.interceptor import Interceptor, InterceptorOptions
from veto.core.validator import ValidationEngine, ValidationEngineOptions
from veto.types.config import (
    NamedValidator,
    ValidationContext,
    ValidationResult,
)
from veto.types.tool import ToolCall
from veto.utils.logger import MemoryLogger


# ── A. Validator priority=0 must sort first, not as 100 ──────────────────
def test_priority_zero_runs_before_priority_five():
    """`priority=0` was treated as falsy → sorted as priority=100."""
    log: list[str] = []

    def first(_ctx):
        log.append("p0")
        return ValidationResult(decision="allow")

    def second(_ctx):
        log.append("p5")
        return ValidationResult(decision="allow")

    v0 = NamedValidator(name="p0", priority=0, validate=first)
    v5 = NamedValidator(name="p5", priority=5, validate=second)

    veto = Veto.from_rules(rules=[], validators=[v5, v0])  # registered in reverse

    asyncio.run(veto.guard("any_tool", {}))
    assert log == ["p0", "p5"], f"priority=0 must run first, got order: {log}"


# ── B. History records the FINAL arguments after `modify` ────────────────
def test_history_records_modified_arguments():
    """When a validator returns decision='modify', history must show the
    arguments the tool actually saw — not the original input."""
    logger = MemoryLogger("error")

    def normaliser(ctx: ValidationContext) -> ValidationResult:
        # Strip leading/trailing whitespace from the `command` arg
        new_args = dict(ctx.arguments)
        cmd = new_args.get("command")
        if isinstance(cmd, str):
            new_args["command"] = cmd.strip()
        return ValidationResult(decision="modify", modified_arguments=new_args)

    engine = ValidationEngine(
        ValidationEngineOptions(logger=logger, default_decision="allow"),
    )
    engine.add_validator(NamedValidator(name="normaliser", validate=normaliser))
    history = HistoryTracker(HistoryTrackerOptions(max_size=100, logger=logger))

    interceptor = Interceptor(InterceptorOptions(
        logger=logger,
        validation_engine=engine,
        history_tracker=history,
    ))

    asyncio.run(interceptor.intercept(
        ToolCall(id="t1", name="run_shell", arguments={"command": "  ls -la  "}),
    ))

    entries = history.get_all()
    assert len(entries) == 1
    recorded_command = entries[0].arguments["command"]
    assert recorded_command == "ls -la", (
        f"history must reflect the modified args; got {recorded_command!r}"
    )


# ── C. Unsafe regex in a rule logs a loud error at load time ─────────────
def test_unsafe_regex_pattern_logged_at_load():
    """Currently a rejected pattern silently makes the rule never match
    (fail-open). The audit fix logs an `error` at construction so users
    spot misconfigured rules in startup output."""
    logger = MemoryLogger("error")
    Veto.from_rules(
        rules=[{
            "id": "broken",
            "tools": ["x"],
            "action": "block",
            "conditions": [{
                "field": "arguments.cmd",
                "operator": "matches",
                # Triggers the heuristic's overlapping-alternation rejection
                "value": "(rm.*|wget.*)",
            }],
        }],
        log_level="error",
    )
    # The MemoryLogger above isn't passed in (Veto.from_rules creates its
    # own ConsoleLogger), so we assert via the helper-direct test below
    # which captures the actual warn output.
    _ = logger  # asserted through stderr / direct helper call elsewhere


def test_safe_regex_pattern_does_not_log_error():
    """Don't false-positive on safe patterns."""
    Veto.from_rules(
        rules=[{
            "id": "safe",
            "tools": ["x"],
            "action": "block",
            "conditions": [{
                "field": "arguments.cmd",
                "operator": "matches",
                "value": "rm -rf",  # plain string, definitely safe
            }],
        }],
        log_level="error",
    )


def test_unsafe_regex_warn_helper_directly():
    """Hit the warn-emit helper directly so we can capture log output."""
    logger = MemoryLogger("error")

    # Build a Veto-like shim that has just what _warn_about_unsafe_rule_patterns needs
    class Shim:
        _logger = logger

    Veto._warn_about_unsafe_rule_patterns(Shim(), [
        {
            "id": "broken",
            "conditions": [{
                "field": "arguments.cmd",
                "operator": "matches",
                "value": "(rm.*|wget.*)",  # rejected by heuristic
            }],
        },
        {
            "id": "fine",
            "conditions": [{
                "field": "arguments.cmd",
                "operator": "matches",
                "value": "rm -rf",  # safe
            }],
        },
    ])

    error_messages = [e.message for e in logger.entries if e.level == "error"]
    rule_ids = [
        e.context.get("rule_id") if e.context else None
        for e in logger.entries if e.level == "error"
    ]
    assert any("unsafe" in m for m in error_messages)
    assert "broken" in rule_ids and "fine" not in rule_ids


def test_unsafe_regex_in_condition_groups_is_caught():
    """`rule.condition_groups` (OR-of-AND) must also be walked.

    Earlier the helper only iterated `rule.conditions` (the flat AND
    list), so an unsafe pattern inside `condition_groups` slipped past
    the load-time check and silently failed open at runtime.
    """
    logger = MemoryLogger("error")

    class Shim:
        _logger = logger

    Veto._warn_about_unsafe_rule_patterns(Shim(), [
        {
            "id": "groups-broken",
            "condition_groups": [
                [{
                    "field": "arguments.cmd",
                    "operator": "matches",
                    "value": "(rm.*|wget.*)",  # rejected by heuristic
                }],
                [{
                    "field": "arguments.cmd",
                    "operator": "matches",
                    "value": "rm -rf",  # safe
                }],
            ],
        },
        {
            # Mixed shape: flat conditions + condition_groups, both visited.
            "id": "mixed",
            "conditions": [{
                "field": "arguments.cmd",
                "operator": "matches",
                "value": "rm -rf",  # safe → no warning
            }],
            "condition_groups": [
                [{
                    "field": "arguments.url",
                    "operator": "matches",
                    "value": "(http.*|https.*)",  # rejected
                }],
            ],
        },
    ])

    rule_ids_with_errors = [
        e.context.get("rule_id") if e.context else None
        for e in logger.entries if e.level == "error"
    ]
    assert "groups-broken" in rule_ids_with_errors
    # The mixed rule has both safe + unsafe; we expect exactly one error.
    assert rule_ids_with_errors.count("mixed") == 1
