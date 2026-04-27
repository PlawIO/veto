"""
Logging infrastructure for Veto.

Provides a flexible logging system with configurable log levels
and support for custom logger implementations.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Literal, Optional, Protocol

from veto.types.config import LogLevel, StreamLogMode

DecisionStreamDecision = Literal["allow", "deny", "await"]


@dataclass
class LogEntry:
    """Log entry structure for structured logging."""

    level: LogLevel
    message: str
    timestamp: datetime
    context: Optional[dict[str, Any]] = None
    error: Optional[Exception] = None


@dataclass
class DecisionStreamEvent:
    """Structured payload for decision stream logging."""

    decision: DecisionStreamDecision
    tool_name: str
    arguments: Optional[dict[str, Any]] = None
    reason: Optional[str] = None
    rule_id: Optional[str] = None
    latency_ms: Optional[float] = None
    approval_id: Optional[str] = None
    # Email or identifier of the approver that resolved an awaited decision.
    approver: Optional[str] = None
    # Override for the timestamp shown in compact mode (defaults to "now").
    timestamp: Optional[datetime] = None


class Logger(Protocol):
    """
    Logger interface that can be implemented for custom logging.

    Example:
        >>> class MyLogger:
        ...     def debug(self, msg, ctx=None): my_service.log('debug', msg, ctx)
        ...     def info(self, msg, ctx=None): my_service.log('info', msg, ctx)
        ...     def warn(self, msg, ctx=None): my_service.log('warn', msg, ctx)
        ...     def error(self, msg, ctx=None, err=None): my_service.log('error', msg, ctx)
    """

    def debug(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None: ...

    def info(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None: ...

    def warn(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None: ...

    def error(
        self,
        message: str,
        context: Optional[dict[str, Any]] = None,
        error: Optional[Exception] = None,
    ) -> None: ...


class DecisionStreamLogger(Logger, Protocol):
    """Marker protocol for stream-mode decision loggers.

    Detection should use ``isinstance(logger, BaseStreamLogger)`` rather than
    duck-typing on the ``stream_decision`` attribute — a custom logger may
    coincidentally expose the same name with unrelated semantics.
    """

    def stream_decision(self, event: DecisionStreamEvent) -> None: ...


class BaseStreamLogger:
    """Base class for stream-mode loggers.

    External code (the validation engine, integrations, etc.) uses
    ``isinstance(logger, BaseStreamLogger)`` to detect stream mode. Inheriting
    from this class is the explicit opt-in — duck-typing on
    ``stream_decision`` is intentionally avoided.
    """

    def stream_decision(self, event: "DecisionStreamEvent") -> None:  # pragma: no cover
        raise NotImplementedError


# Numeric priority for log levels (lower = more verbose)
LOG_LEVEL_PRIORITY: dict[LogLevel, int] = {
    "debug": 0,
    "info": 1,
    "stream": 1,
    "warn": 2,
    "error": 3,
    "silent": 4,
}

ANSI_RESET = "\u001b[0m"
ANSI_GREEN = "\u001b[32m"
ANSI_RED = "\u001b[31m"
ANSI_YELLOW = "\u001b[33m"
ANSI_DIM = "\u001b[2m"
ANSI_BOLD = "\u001b[1m"


def should_log(
    message_level: Literal["debug", "info", "warn", "error"],
    configured_level: LogLevel,
) -> bool:
    """Check if a log level should be emitted given the configured level."""
    return LOG_LEVEL_PRIORITY[message_level] >= LOG_LEVEL_PRIORITY[configured_level]


# Strip C0/C1 control characters and ANSI escape sequences from user-supplied
# strings before they hit the terminal. Keeps the one-line-per-decision
# invariant intact and prevents user data from spoofing terminal state.
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def _sanitize_str(value: str) -> str:
    # Visualise newlines/tabs explicitly so they don't break alignment.
    sanitized = value.replace("\r\n", "\\n").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return _CONTROL_CHARS.sub("", sanitized)


def _escape_string(value: str) -> str:
    # Escape backslashes and quotes on the *original* string first; otherwise
    # the visualisation backslashes that ``_sanitize_str`` introduces (e.g.
    # turning a real newline into the two-char sequence ``\`` + ``n``) get
    # doubled by the backslash-escape pass and the row prints
    # ``'line1\\nline2'`` instead of ``'line1\nline2'``.
    return _sanitize_str(value.replace("\\", "\\\\").replace("'", "\\'"))


def _format_scalar(value: Any) -> str:
    if isinstance(value, str):
        return f"'{_escape_string(value)}'"
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")
        return str(value)
    if value is None:
        return "None"
    if isinstance(value, datetime):
        return f"'{value.isoformat()}'"
    return _sanitize_str(str(value))


def _format_value(value: Any, depth: int = 0) -> str:
    if isinstance(value, (str, bool, int, float)) or value is None:
        return _format_scalar(value)

    if isinstance(value, datetime):
        return _format_scalar(value)

    if isinstance(value, (list, tuple)):
        if depth >= 2:
            return "[…]"
        return f"[{', '.join(_format_value(item, depth + 1) for item in value)}]"

    if isinstance(value, dict):
        if depth >= 2:
            return "{…}"
        return "{" + ", ".join(
            f"{key}: {_format_value(item, depth + 1)}"
            for key, item in value.items()
        ) + "}"

    return _format_scalar(value)


def _truncate(value: str, max_length: int) -> str:
    if len(value) <= max_length:
        return value
    return value[: max(0, max_length - 1)] + "…"


def _format_args_inline(
    arguments: Optional[dict[str, Any]],
    *,
    max_length: int,
    empty: str = "",
) -> str:
    """JS-object-literal arg rendering: ``{key: 'value', n: 1}``.

    Single canonical formatter shared by compact + verbose modes. ``empty``
    chooses what's rendered when there are no args: compact uses ``"{}"``,
    verbose uses ``""``.
    """
    if not arguments:
        return empty
    return _truncate(_format_value(arguments), max_length)


def _is_finite_number(value: Optional[float]) -> bool:
    return value is not None and isinstance(value, (int, float)) and math.isfinite(float(value))


def _format_duration(latency_ms: Optional[float]) -> Optional[str]:
    if not _is_finite_number(latency_ms) or latency_ms < 0:  # type: ignore[operator]
        return None
    return f"{round(latency_ms)}ms"  # type: ignore[arg-type]


def _format_latency_cell(latency_ms: Optional[float]) -> str:
    """
    Compact latency cell. Auto-scales: ms → s → m → h. Returns ``-`` when there
    is no measured latency, the value is non-finite (NaN / Inf), or it's
    negative — these all mean "we don't have a usable timing".
    """
    if not _is_finite_number(latency_ms) or latency_ms < 0:  # type: ignore[operator]
        return "-"
    ms = float(latency_ms)  # type: ignore[arg-type]
    if ms < 1_000:
        return f"{round(ms)}ms"
    if ms < 60_000:
        return f"{round(ms / 1_000)}s"
    if ms < 3_600_000:
        return f"{round(ms / 60_000)}m"
    return f"{round(ms / 3_600_000)}h"


def _format_time_of_day(date: Optional[datetime] = None) -> str:
    """HH:MM:SS in UTC by default; set ``VETO_LOG_LOCALTIME=1`` for host time.

    UTC is the default so the same code prints the same row on a developer's
    laptop, in CI, and inside a container — important for diffing logs.
    """
    if date is None:
        date = datetime.now(tz=timezone.utc)
    elif date.tzinfo is None:
        # Assume naive timestamps are UTC. Better than silently treating them
        # as local time depending on host configuration.
        date = date.replace(tzinfo=timezone.utc)

    if os.environ.get("VETO_LOG_LOCALTIME"):
        date = date.astimezone()
    return date.strftime("%H:%M:%S")


def _format_trailing_tag(event: DecisionStreamEvent) -> Optional[str]:
    """
    Trailing context tag for the compact stream:
      * deny  → ``policy:<rule_id>`` when known
      * await → ``approval-required[:<approval_id>]``
      * allow → ``approved[:<approver>]`` when the result came from an approval
    """
    if event.decision == "deny" and event.rule_id:
        return f"policy:{event.rule_id}"
    if event.decision == "await":
        return (
            f"approval-required:{event.approval_id}"
            if event.approval_id
            else "approval-required"
        )
    if event.decision == "allow" and event.approver:
        return f"approved:{event.approver}"
    return None


def _supports_color() -> bool:
    """Honor https://no-color.org and https://force-color.org conventions.

    * ``NO_COLOR`` set to any non-empty value → never emit ANSI.
    * ``FORCE_COLOR`` set to any non-empty value → always emit ANSI.
    * Otherwise → only emit ANSI when stderr is a TTY.
    """
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("FORCE_COLOR"):
        return True
    return bool(hasattr(sys.stderr, "isatty") and sys.stderr.isatty())


def _colorize(value: str, color: str) -> str:
    if not _supports_color():
        return value
    return f"{color}{value}{ANSI_RESET}"


def _dim(value: str) -> str:
    if not _supports_color():
        return value
    return f"{ANSI_DIM}{value}{ANSI_RESET}"


def _bold(value: str) -> str:
    if not _supports_color():
        return value
    return f"{ANSI_BOLD}{value}{ANSI_RESET}"


def _decision_label(decision: DecisionStreamDecision) -> str:
    """Lowercase decision keyword, padded right to 5 chars, then colorized."""
    padded = decision.ljust(5)
    if decision == "allow":
        return _colorize(padded, ANSI_GREEN)
    if decision == "deny":
        return _colorize(padded, ANSI_RED)
    return _colorize(padded, ANSI_YELLOW)


def _format_reason(reason: Optional[str], max_length: int) -> Optional[str]:
    if not reason or not reason.strip():
        return None
    return _truncate(reason.strip(), max_length)


COMPACT_CALL_MIN_WIDTH = 40
COMPACT_CALL_MAX_WIDTH = 80
COMPACT_LATENCY_WIDTH = 5
COMPACT_ARGS_BUDGET = 60  # how much of the call width the args portion can use
VERBOSE_ARGS_MAX = 320


def format_compact_decision(event: DecisionStreamEvent) -> str:
    """
    One-line decision row, formatted as:
      ``HH:MM:SS <decision>  <tool>(<args>)              <latency>  <tag?>``

    Tool name and args are sanitized (no newlines / control chars) and the
    full call portion is hard-truncated to ``COMPACT_CALL_MAX_WIDTH`` so the
    latency column stays roughly aligned across rows.
    """
    time_str = _dim(_format_time_of_day(event.timestamp))
    label = _decision_label(event.decision)
    safe_tool = _sanitize_str(event.tool_name)
    call = f"{safe_tool}({_format_args_inline(event.arguments, max_length=COMPACT_ARGS_BUDGET, empty='{}')})"
    call = _truncate(call, COMPACT_CALL_MAX_WIDTH)
    call_padded = call.ljust(COMPACT_CALL_MIN_WIDTH)
    latency = _format_latency_cell(event.latency_ms).rjust(COMPACT_LATENCY_WIDTH)
    tag = _format_trailing_tag(event)
    tag_suffix = f"  {_dim(tag)}" if tag else ""
    return f"{time_str} {label}  {call_padded}  {latency}{tag_suffix}"


def format_verbose_decision(event: DecisionStreamEvent) -> str:
    args = _format_args_inline(event.arguments, max_length=VERBOSE_ARGS_MAX)
    duration = _format_duration(event.latency_ms)
    reason = _format_reason(event.reason, VERBOSE_ARGS_MAX) or "n/a"
    lines = [
        f"{_bold('VETO DECISION')} {_decision_label(event.decision).rstrip()}",
        f"time: {_format_time_of_day(event.timestamp)}",
        f"tool: {_sanitize_str(event.tool_name)}",
        f"args: {args or '(none)'}",
        f"reason: {reason}",
    ]

    if event.rule_id:
        lines.append(f"rule: {event.rule_id}")

    if event.approval_id:
        lines.append(f"approval: {event.approval_id}")

    if event.approver:
        lines.append(f"approver: {event.approver}")

    if duration:
        lines.append(f"latency: {duration}")

    return "\n".join(lines)


def _write_to_stderr(message: str) -> None:
    sys.stderr.write(message + "\n")


def format_message(
    level: Literal["debug", "info", "warn", "error"],
    message: str,
    context: Optional[dict[str, Any]] = None,
) -> str:
    """Format a log message with optional context."""
    timestamp = datetime.now().isoformat()
    level_str = level.upper().ljust(5)
    prefix = f"[{timestamp}] [VETO] {level_str}"

    if context and len(context) > 0:
        try:
            context_str = json.dumps(context, default=str)
        except Exception:
            context_str = repr(context)
        return f"{prefix} {message} {context_str}"

    return f"{prefix} {message}"


class ConsoleLogger:
    """Console-based logger implementation."""

    def __init__(self, level: Literal["debug", "info", "warn", "error", "silent"]):
        self.level = level

    def debug(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        if should_log("debug", self.level):
            print(format_message("debug", message, context))

    def info(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        if should_log("info", self.level):
            print(format_message("info", message, context))

    def warn(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        if should_log("warn", self.level):
            print(format_message("warn", message, context))

    def error(
        self,
        message: str,
        context: Optional[dict[str, Any]] = None,
        error: Optional[Exception] = None,
    ) -> None:
        if should_log("error", self.level):
            print(format_message("error", message, context))
            if error:
                print(error)


# Warn-level messages whose body the stream row already conveys. The
# StreamLogger drops these locally so the validation engine no longer needs
# to know about logger types — it just emits as before.
_STREAM_NOISY_WARNS = frozenset({
    "Tool call blocked by local rule",
    "Tool call blocked by local approval rule (no approval flow configured)",
})


class StreamLogger(BaseStreamLogger):
    """Decision stream logger.

    Inherits :class:`BaseStreamLogger` so external callers can detect stream
    mode safely via ``isinstance(logger, BaseStreamLogger)``.
    """

    def __init__(self, mode: StreamLogMode = "compact"):
        self.mode = mode

    def debug(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        _ = (message, context)

    def info(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        _ = (message, context)

    def warn(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        # Suppress warnings that just duplicate the deny / await stream row —
        # filtering here keeps the noise off the user's terminal without the
        # validation engine having to know it's running in stream mode.
        if message in _STREAM_NOISY_WARNS:
            return
        _write_to_stderr(format_message("warn", message, context))

    def error(
        self,
        message: str,
        context: Optional[dict[str, Any]] = None,
        error: Optional[Exception] = None,
    ) -> None:
        _write_to_stderr(format_message("error", message, context))
        if error is not None:
            _write_to_stderr(str(error))

    def stream_decision(self, event: DecisionStreamEvent) -> None:
        _write_to_stderr(
            format_verbose_decision(event)
            if self.mode == "verbose"
            else format_compact_decision(event)
        )


def is_decision_stream_logger(logger: Logger) -> bool:
    """Detect stream-mode loggers safely.

    Strict ``isinstance`` check against :class:`BaseStreamLogger`. Older code
    duck-typed on the ``stream_decision`` attribute, which silently
    misidentified user loggers that happened to expose the same name.
    """
    return isinstance(logger, BaseStreamLogger)


@dataclass
class EnvLogSetting:
    level: LogLevel
    stream_mode: Optional[StreamLogMode] = None


def parse_env_log_setting(value: Optional[str]) -> Optional[EnvLogSetting]:
    """
    Parse the ``VETO_LOG`` environment variable. Recognized forms:

      * ``stream`` → compact stream mode
      * ``stream:compact`` / ``stream:verbose`` → explicit stream mode
      * ``debug`` / ``info`` / ``warn`` / ``error`` / ``silent`` → standard level

    Returns ``None`` for unrecognized or absent values so callers can fall back
    to other configuration sources.
    """
    if not value:
        return None

    raw = value.strip().lower()
    if not raw:
        return None

    if raw == "stream":
        return EnvLogSetting(level="stream", stream_mode="compact")
    if raw.startswith("stream:"):
        suffix = raw.split(":", 1)[1]
        if suffix == "verbose":
            return EnvLogSetting(level="stream", stream_mode="verbose")
        if suffix == "compact":
            return EnvLogSetting(level="stream", stream_mode="compact")
        return None

    if raw in ("debug", "info", "warn", "error", "silent"):
        return EnvLogSetting(level=raw)  # type: ignore[arg-type]
    return None


def create_logger(level: LogLevel, stream_mode: StreamLogMode = "compact") -> Logger:
    """
    Create a console-based logger with the specified log level.

    Args:
        level: Minimum log level to emit

    Returns:
        Logger instance

    Example:
        >>> logger = create_logger('info')
        >>> logger.debug('This will not be logged')
        >>> logger.info('This will be logged')
    """
    if level == "stream":
        return StreamLogger(stream_mode)
    return ConsoleLogger(level)


class SilentLogger:
    """A no-op logger that discards all messages."""

    def debug(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        pass

    def info(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        pass

    def warn(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        pass

    def error(
        self,
        message: str,
        context: Optional[dict[str, Any]] = None,
        error: Optional[Exception] = None,
    ) -> None:
        pass


# Silent logger singleton
silent_logger: Logger = SilentLogger()


class MemoryLogger:
    """Logger that stores entries in memory."""

    def __init__(self, level: LogLevel = "debug"):
        self.level = level
        self.entries: list[LogEntry] = []

    def _add_entry(
        self,
        message_level: Literal["debug", "info", "warn", "error"],
        message: str,
        context: Optional[dict[str, Any]] = None,
        error: Optional[Exception] = None,
    ) -> None:
        if should_log(message_level, self.level):
            self.entries.append(
                LogEntry(
                    level=message_level,
                    message=message,
                    timestamp=datetime.now(),
                    context=context,
                    error=error,
                )
            )

    def debug(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        self._add_entry("debug", message, context)

    def info(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        self._add_entry("info", message, context)

    def warn(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        self._add_entry("warn", message, context)

    def error(
        self,
        message: str,
        context: Optional[dict[str, Any]] = None,
        error: Optional[Exception] = None,
    ) -> None:
        self._add_entry("error", message, context, error)

    def clear(self) -> None:
        self.entries.clear()


def create_memory_logger(
    level: LogLevel = "debug",
) -> tuple[Logger, list[LogEntry], Callable[[], None]]:
    """
    Create a logger that stores entries in memory.

    Useful for testing or capturing logs for later analysis.

    Args:
        level: Minimum log level to capture

    Returns:
        Tuple of (logger, entries list, clear function)

    Example:
        >>> logger, entries, clear = create_memory_logger('debug')
        >>> logger.info('test message', {'key': 'value'})
        >>> print(entries)  # [LogEntry(level='info', message='test message', ...)]
    """
    memory_logger = MemoryLogger(level)
    return memory_logger, memory_logger.entries, memory_logger.clear


class ChildLogger:
    """Logger with additional default context."""

    def __init__(self, parent: Logger, default_context: dict[str, Any]):
        self.parent = parent
        self.default_context = default_context

    def _merge_context(
        self, context: Optional[dict[str, Any]]
    ) -> dict[str, Any]:
        return {**self.default_context, **(context or {})}

    def debug(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        self.parent.debug(message, self._merge_context(context))

    def info(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        self.parent.info(message, self._merge_context(context))

    def warn(
        self, message: str, context: Optional[dict[str, Any]] = None
    ) -> None:
        self.parent.warn(message, self._merge_context(context))

    def error(
        self,
        message: str,
        context: Optional[dict[str, Any]] = None,
        error: Optional[Exception] = None,
    ) -> None:
        self.parent.error(message, self._merge_context(context), error)


def create_child_logger(
    parent: Logger, default_context: dict[str, Any]
) -> Logger:
    """
    Create a child logger with additional default context.

    Args:
        parent: Parent logger to wrap
        default_context: Context to include in all log entries

    Returns:
        Logger with merged context

    Example:
        >>> parent_logger = create_logger('info')
        >>> child_logger = create_child_logger(parent_logger, {'component': 'validator'})
        >>> child_logger.info('Validation complete')  # Includes {'component': 'validator'}
    """
    return ChildLogger(parent, default_context)
