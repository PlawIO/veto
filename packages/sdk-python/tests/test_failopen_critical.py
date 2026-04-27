"""
Regression tests for the critical fail-open fixes (audit Round 2, PR A).

Two specific behaviour changes pinned here:

1. ``protect()`` no longer silently degrades to an allow-all instance when
   Veto initialisation throws — by default it re-raises. The legacy degrade
   behaviour is reachable via ``protect(safe_fallback=True)`` and prints a
   loud banner to stderr.

2. The ``matches`` operator on a regex that the safety heuristic rejects
   still returns ``False`` (preserves rule semantics) but now also writes
   a one-time ERROR line to stderr so a fail-open block rule can't go
   unnoticed at runtime.
"""
from __future__ import annotations

import asyncio

import pytest

from unittest.mock import patch

from veto.core.protect import protect, _reset_protect_cache_for_tests
from veto.rules.condition_evaluator import (
    _LOGGED_BAD_PATTERNS,
    evaluate_legacy_condition,
)


class _SimulatedInitError(RuntimeError):
    """Stand-in for any Veto-side init failure (bad YAML, malformed rule
    schema, unreachable cloud, etc.) so tests don't need to find a real
    config-shape that the loader rejects."""


@pytest.fixture(autouse=True)
def _reset_caches():
    _reset_protect_cache_for_tests()
    _LOGGED_BAD_PATTERNS.clear()
    yield
    _reset_protect_cache_for_tests()
    _LOGGED_BAD_PATTERNS.clear()


# ──────────────────────────────────────────────────────────────────
# 1. protect() — fail-loud by default, opt-in safe_fallback.
# ──────────────────────────────────────────────────────────────────
class TestProtectFailLoud:
    def test_init_failure_raises_by_default(self):
        """An init exception must propagate out of ``protect()`` — the
        previous behaviour silently returned an allow-all wrapper, which
        is the worst class of fail-open."""

        class FakeTool:
            name = "send_email"

        async def run() -> None:
            await protect(
                FakeTool(),
                rules=[{"id": "x", "tools": ["send_email"], "action": "block"}],
            )

        with patch(
            "veto.core.protect.Veto.from_rules",
            side_effect=_SimulatedInitError("bang"),
        ):
            with pytest.raises(_SimulatedInitError):
                asyncio.run(run())

    def test_safe_fallback_true_degrades_with_loud_banner(self, capsys):
        """Opt-in ``safe_fallback=True`` keeps the legacy degrade behaviour
        but prints a loud stderr banner so it can't be missed."""
        from veto.core.veto import Veto as _RealVeto
        real_from_rules = _RealVeto.from_rules

        def fail_only_user_rules(*args, **kwargs):
            # The user-rules call passes a non-empty `rules`. The allow-all
            # fallback path calls back into Veto.from_rules with `rules=[]`
            # — let that one through so the fallback succeeds.
            if kwargs.get("rules"):
                raise _SimulatedInitError("bang")
            return real_from_rules(*args, **kwargs)

        class FakeTool:
            name = "send_email"

            def __call__(self, **kwargs):  # something to wrap
                return None

        async def run():
            return await protect(
                FakeTool(),
                rules=[{"id": "x", "tools": ["send_email"], "action": "block"}],
                safe_fallback=True,
            )

        with patch(
            "veto.core.protect.Veto.from_rules",
            side_effect=fail_only_user_rules,
        ):
            wrapped = asyncio.run(run())
        captured = capsys.readouterr()
        assert wrapped is not None, "safe_fallback should still produce a wrapped tool"
        assert "WARNING: Veto initialization failed" in captured.err
        assert "ALLOW-ALL" in captured.err
        assert "safe_fallback=True" in captured.err

    def test_successful_init_does_not_print_banner(self, capsys):
        """A working rule set must not trigger the banner."""

        class FakeTool:
            name = "send_email"

        async def run():
            return await protect(
                FakeTool(),
                rules=[{
                    "id": "ok",
                    "tools": ["send_email"],
                    "action": "block",
                    "conditions": [
                        {"field": "arguments.body", "operator": "contains", "value": "secret"}
                    ],
                }],
            )

        asyncio.run(run())
        captured = capsys.readouterr()
        assert "WARNING: Veto initialization failed" not in captured.err


# ──────────────────────────────────────────────────────────────────
# 2. matches operator — rejected pattern surfaces a one-time error.
# ──────────────────────────────────────────────────────────────────
class TestMatchesPatternRejection:
    def test_rejected_pattern_returns_false_and_logs_once(self, capsys):
        # The heuristic rejects `.*…|…*.*` shapes — picked because the
        # earlier audit hit this exact shape on a real demo rule.
        bad = "(rm.*|wget.*)"
        # First evaluation: returns False AND emits the one-time error.
        result_1 = evaluate_legacy_condition("anything", "matches", bad)
        captured_1 = capsys.readouterr()
        assert result_1 is False
        assert "ERROR" in captured_1.err
        assert "rejected by safety heuristic" in captured_1.err
        # Second evaluation with the SAME pattern: still False, no second log.
        result_2 = evaluate_legacy_condition("anything else", "matches", bad)
        captured_2 = capsys.readouterr()
        assert result_2 is False
        assert captured_2.err == "", "duplicate log on the same pattern"

    def test_safe_pattern_does_not_log(self, capsys):
        result = evaluate_legacy_condition("rm -rf /tmp", "matches", "rm -rf")
        captured = capsys.readouterr()
        assert result is True
        assert captured.err == ""

    def test_each_distinct_bad_pattern_logs_once(self, capsys):
        bad_a = "(rm.*|wget.*)"
        bad_b = "(curl.*|fetch.*)"
        evaluate_legacy_condition("x", "matches", bad_a)
        evaluate_legacy_condition("x", "matches", bad_b)
        # Each pattern logs once, never re-logs:
        evaluate_legacy_condition("y", "matches", bad_a)
        evaluate_legacy_condition("y", "matches", bad_b)
        captured = capsys.readouterr()
        # Exactly two ERROR lines expected (one per distinct pattern).
        assert captured.err.count("ERROR") == 2
