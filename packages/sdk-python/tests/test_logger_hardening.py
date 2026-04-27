"""Regression tests for stream logger hardening (audit follow-up)."""
from __future__ import annotations

import math
from datetime import datetime, timezone

import pytest

from veto.utils.logger import (
    BaseStreamLogger,
    DecisionStreamEvent,
    StreamLogger,
    _format_latency_cell,
    _format_time_of_day,
    _sanitize_str,
    _supports_color,
    format_compact_decision,
    is_decision_stream_logger,
)


# ── Newlines / control chars in args break the one-line invariant ───────
class TestSanitization:
    def test_newline_in_args_does_not_break_row(self):
        e = DecisionStreamEvent(
            decision="allow",
            tool_name="x",
            arguments={"q": "line1\nline2"},
            latency_ms=1,
            timestamp=datetime(2026, 4, 27, 12, 0, 0, tzinfo=timezone.utc),
        )
        out = format_compact_decision(e)
        assert "\n" not in out, f"row contains literal newline: {out!r}"
        # Earlier versions double-escaped `\n` to `\\n` because the backslash-
        # escape pass ran *after* sanitize introduced the visualisation
        # backslash. Pin the exact rendering and explicitly forbid the
        # double-escape so the bug can't regress silently.
        assert "'line1\\nline2'" in out, f"unexpected arg rendering: {out!r}"
        assert "'line1\\\\nline2'" not in out, (
            f"newline got double-escaped — backslash-escape order regressed: {out!r}"
        )

    def test_newline_in_tool_name_does_not_break_row(self):
        e = DecisionStreamEvent(
            decision="allow",
            tool_name="bad\ntool",
            arguments={"a": 1},
            latency_ms=1,
            timestamp=datetime(2026, 4, 27, 12, 0, 0, tzinfo=timezone.utc),
        )
        out = format_compact_decision(e)
        assert "\n" not in out

    def test_ansi_in_args_is_stripped(self):
        e = DecisionStreamEvent(
            decision="allow",
            tool_name="t",
            arguments={"x": "\x1b[31mred\x1b[0m"},
            latency_ms=1,
            timestamp=datetime(2026, 4, 27, 12, 0, 0, tzinfo=timezone.utc),
        )
        out = format_compact_decision(e)
        # Strip the dim+label ANSI we add ourselves; user-supplied ANSI inside
        # the args string must not appear at all.
        # User data: \x1b[31m and \x1b[0m. Compact format wraps args in '...'.
        # Look for 'red' WITHOUT the surrounding ANSI from user input.
        assert "\x1b[31m" not in out
        assert "red" in out

    def test_sanitize_str_visualises_tabs_and_returns_no_raw_controls(self):
        s = _sanitize_str("a\tb\nc\rd\x07e")
        assert "\t" not in s
        assert "\n" not in s
        assert "\r" not in s
        assert "\x07" not in s
        assert "\\t" in s and "\\n" in s and "\\r" in s


# ── NaN / Inf latency must not crash ─────────────────────────────────────
class TestLatencyEdgeCases:
    @pytest.mark.parametrize("latency,expected", [
        (None, "-"),
        (0, "0ms"),
        (-1, "-"),
        (math.nan, "-"),
        (math.inf, "-"),
        (-math.inf, "-"),
        (0.4, "0ms"),
        (1500, "2s"),
        (86_400_000, "24h"),
    ])
    def test_no_crash_and_correct_label(self, latency, expected):
        assert _format_latency_cell(latency) == expected


# ── NO_COLOR / FORCE_COLOR conventions ───────────────────────────────────
class TestColorEnv:
    def test_no_color_disables(self, monkeypatch):
        monkeypatch.setenv("NO_COLOR", "1")
        monkeypatch.delenv("FORCE_COLOR", raising=False)
        assert _supports_color() is False

    def test_force_color_enables(self, monkeypatch):
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setenv("FORCE_COLOR", "1")
        assert _supports_color() is True

    def test_no_color_wins_over_force_color(self, monkeypatch):
        monkeypatch.setenv("NO_COLOR", "1")
        monkeypatch.setenv("FORCE_COLOR", "1")
        assert _supports_color() is False


# ── UTC default + opt-in localtime ───────────────────────────────────────
class TestTimezone:
    def test_utc_by_default(self, monkeypatch):
        monkeypatch.delenv("VETO_LOG_LOCALTIME", raising=False)
        ts = datetime(2026, 4, 27, 17, 30, 5, tzinfo=timezone.utc)
        assert _format_time_of_day(ts) == "17:30:05"

    def test_naive_timestamp_treated_as_utc(self, monkeypatch):
        monkeypatch.delenv("VETO_LOG_LOCALTIME", raising=False)
        ts = datetime(2026, 4, 27, 17, 30, 5)  # naive
        assert _format_time_of_day(ts) == "17:30:05"


# ── Stream logger detection: strict isinstance, not duck-typing ──────────
class TestStreamLoggerDetection:
    def test_user_logger_with_unrelated_stream_decision_not_misidentified(self):
        class UserLogger:
            def debug(self, *a, **k): pass
            def info(self, *a, **k): pass
            def warn(self, *a, **k): pass
            def error(self, *a, **k): pass

            def stream_decision(self, x):
                """Unrelated user method that happens to share the name."""

        assert is_decision_stream_logger(UserLogger()) is False

    def test_actual_stream_logger_detected(self):
        assert is_decision_stream_logger(StreamLogger()) is True

    def test_explicit_subclass_detected(self):
        class CustomStream(BaseStreamLogger):
            def debug(self, *a, **k): pass
            def info(self, *a, **k): pass
            def warn(self, *a, **k): pass
            def error(self, *a, **k): pass

            def stream_decision(self, ev): pass

        assert is_decision_stream_logger(CustomStream()) is True


# ── Filter-at-source: noisy warns suppressed on StreamLogger only ────────
class TestStreamWarnFiltering:
    def test_known_noisy_warn_suppressed(self, capsys):
        sl = StreamLogger()
        sl.warn("Tool call blocked by local rule", {"x": 1})
        captured = capsys.readouterr()
        assert captured.err == ""

    def test_other_warns_still_emit(self, capsys):
        sl = StreamLogger()
        sl.warn("Veto config not found", {"path": "/x"})
        captured = capsys.readouterr()
        assert "Veto config not found" in captured.err
