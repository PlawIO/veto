"""
Tests for Logger utilities.
"""

import pytest

from veto.utils.logger import (
    create_logger,
    create_memory_logger,
    create_child_logger,
    should_log,
    format_message,
    ConsoleLogger,
    SilentLogger,
    MemoryLogger,
    StreamLogger,
    parse_env_log_setting,
)


class TestLogLevelPriority:
    """Tests for log level priority."""

    def test_debug_logs_all(self):
        """Debug should log all levels."""
        assert should_log("debug", "debug") is True
        assert should_log("info", "debug") is True
        assert should_log("warn", "debug") is True
        assert should_log("error", "debug") is True

    def test_info_skips_debug(self):
        """Info should skip debug."""
        assert should_log("debug", "info") is False
        assert should_log("info", "info") is True
        assert should_log("warn", "info") is True
        assert should_log("error", "info") is True

    def test_error_only_logs_error(self):
        """Error should only log errors."""
        assert should_log("debug", "error") is False
        assert should_log("info", "error") is False
        assert should_log("warn", "error") is False
        assert should_log("error", "error") is True

    def test_silent_logs_nothing(self):
        """Silent should log nothing."""
        assert should_log("debug", "silent") is False
        assert should_log("info", "silent") is False
        assert should_log("warn", "silent") is False
        assert should_log("error", "silent") is False


class TestFormatMessage:
    """Tests for message formatting."""

    def test_format_simple_message(self):
        """Should format a simple message."""
        result = format_message("info", "Test message")
        assert "[VETO]" in result
        assert "INFO" in result
        assert "Test message" in result

    def test_format_with_context(self):
        """Should include context in formatted message."""
        result = format_message("debug", "With context", {"key": "value"})
        assert "key" in result
        assert "value" in result


class TestConsoleLogger:
    """Tests for ConsoleLogger."""

    def test_creates_with_level(self):
        """Should create logger with level."""
        logger = ConsoleLogger("info")
        assert logger.level == "info"

    def test_create_logger_function(self):
        """create_logger should return ConsoleLogger."""
        logger = create_logger("debug")
        assert isinstance(logger, ConsoleLogger)


class TestStreamLogger:
    """Tests for StreamLogger."""

    def test_warn_and_error_still_reach_stderr(self, capsys: pytest.CaptureFixture[str]):
        """Stream mode should still surface operational warnings and errors."""
        logger = StreamLogger("compact")

        logger.warn("Warn message", {"component": "sdk"})
        logger.error("Error message", {"component": "sdk"}, RuntimeError("boom"))

        captured = capsys.readouterr()
        assert "WARN" in captured.err
        assert "Warn message" in captured.err
        assert "ERROR" in captured.err
        assert "Error message" in captured.err
        assert "boom" in captured.err


class TestEnvLogSetting:
    """Tests for VETO_LOG parsing."""

    def test_parse_stream_modes(self):
        """Should parse supported stream mode suffixes."""
        verbose = parse_env_log_setting("stream:verbose")
        compact = parse_env_log_setting("stream:compact")

        assert verbose is not None
        assert verbose.level == "stream"
        assert verbose.stream_mode == "verbose"
        assert compact is not None
        assert compact.level == "stream"
        assert compact.stream_mode == "compact"

    def test_parse_unknown_stream_suffix_returns_none(self):
        """Should reject unsupported stream mode suffixes."""
        assert parse_env_log_setting("stream:nope") is None


class TestSilentLogger:
    """Tests for SilentLogger."""

    def test_silent_methods_exist(self):
        """Silent logger should have all methods."""
        logger = SilentLogger()
        # Should not raise
        logger.debug("msg")
        logger.info("msg")
        logger.warn("msg")
        logger.error("msg")


class TestMemoryLogger:
    """Tests for MemoryLogger."""

    def test_stores_entries(self):
        """Should store log entries in memory."""
        logger = MemoryLogger("debug")
        logger.info("Test message", {"key": "value"})

        assert len(logger.entries) == 1
        assert logger.entries[0].message == "Test message"
        assert logger.entries[0].level == "info"

    def test_respects_level(self):
        """Should only store entries at or above level."""
        logger = MemoryLogger("warn")
        logger.debug("Debug message")
        logger.info("Info message")
        logger.warn("Warn message")
        logger.error("Error message")

        assert len(logger.entries) == 2
        assert logger.entries[0].level == "warn"
        assert logger.entries[1].level == "error"

    def test_clear(self):
        """Should clear all entries."""
        logger = MemoryLogger("debug")
        logger.info("Test")
        assert len(logger.entries) == 1

        logger.clear()
        assert len(logger.entries) == 0


class TestCreateMemoryLogger:
    """Tests for create_memory_logger function."""

    def test_returns_tuple(self):
        """Should return logger, entries, and clear function."""
        logger, entries, clear = create_memory_logger("debug")

        logger.info("Test")
        assert len(entries) == 1

        clear()
        assert len(entries) == 0


class TestChildLogger:
    """Tests for ChildLogger."""

    def test_merges_context(self):
        """Should merge default context with provided context."""
        logger, entries, _ = create_memory_logger("debug")
        child = create_child_logger(logger, {"component": "test"})

        child.info("Message", {"extra": "value"})

        assert len(entries) == 1
        assert entries[0].context["component"] == "test"
        assert entries[0].context["extra"] == "value"

    def test_preserves_default_context(self):
        """Should include default context even without extra."""
        logger, entries, _ = create_memory_logger("debug")
        child = create_child_logger(logger, {"component": "validator"})

        child.warn("Warning message")

        assert entries[0].context["component"] == "validator"
