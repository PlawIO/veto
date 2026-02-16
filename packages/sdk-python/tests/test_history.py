"""
Tests for HistoryTracker.
"""

import pytest
from datetime import datetime

from veto.core.history import HistoryTracker, HistoryTrackerOptions, HistoryStats
from veto.types.config import ValidationResult, ToolCallHistoryEntry
from veto.utils.logger import create_logger


@pytest.fixture
def history_tracker():
    """Create a history tracker for testing."""
    logger = create_logger("silent")
    return HistoryTracker(HistoryTrackerOptions(max_size=10, logger=logger))


class TestHistoryTracker:
    """Tests for HistoryTracker class."""

    def test_add_entry(self, history_tracker):
        """Should add entries to history."""
        entry = ToolCallHistoryEntry(
            tool_name="test_tool",
            arguments={"key": "value"},
            validation_result=ValidationResult(decision="allow"),
            timestamp=datetime.now(),
        )
        history_tracker.add(entry)

        entries = history_tracker.get_all()
        assert len(entries) == 1
        assert entries[0].tool_name == "test_tool"

    def test_max_size_limit(self, history_tracker):
        """Should respect max size limit."""
        for i in range(15):
            entry = ToolCallHistoryEntry(
                tool_name=f"tool_{i}",
                arguments={},
                validation_result=ValidationResult(decision="allow"),
                timestamp=datetime.now(),
            )
            history_tracker.add(entry)

        entries = history_tracker.get_all()
        assert len(entries) == 10  # max_size
        # Oldest entries should be removed
        assert entries[0].tool_name == "tool_5"

    def test_get_stats(self, history_tracker):
        """Should calculate stats correctly."""
        # Add allowed entry
        history_tracker.add(
            ToolCallHistoryEntry(
                tool_name="allowed_tool",
                arguments={},
                validation_result=ValidationResult(decision="allow"),
                timestamp=datetime.now(),
            )
        )

        # Add denied entry
        history_tracker.add(
            ToolCallHistoryEntry(
                tool_name="denied_tool",
                arguments={},
                validation_result=ValidationResult(decision="deny", reason="blocked"),
                timestamp=datetime.now(),
            )
        )

        stats = history_tracker.get_stats()
        assert stats.total_calls == 2
        assert stats.allowed_calls == 1
        assert stats.denied_calls == 1

    def test_clear(self, history_tracker):
        """Should clear all entries."""
        history_tracker.add(
            ToolCallHistoryEntry(
                tool_name="tool",
                arguments={},
                validation_result=ValidationResult(decision="allow"),
                timestamp=datetime.now(),
            )
        )
        assert len(history_tracker.get_all()) == 1

        history_tracker.clear()
        assert len(history_tracker.get_all()) == 0

    def test_get_for_tool(self, history_tracker):
        """Should filter entries by tool name."""
        history_tracker.add(
            ToolCallHistoryEntry(
                tool_name="tool_a",
                arguments={},
                validation_result=ValidationResult(decision="allow"),
                timestamp=datetime.now(),
            )
        )
        history_tracker.add(
            ToolCallHistoryEntry(
                tool_name="tool_b",
                arguments={},
                validation_result=ValidationResult(decision="allow"),
                timestamp=datetime.now(),
            )
        )
        history_tracker.add(
            ToolCallHistoryEntry(
                tool_name="tool_a",
                arguments={},
                validation_result=ValidationResult(decision="deny"),
                timestamp=datetime.now(),
            )
        )

        tool_a_entries = history_tracker.get_by_tool("tool_a")
        assert len(tool_a_entries) == 2
        assert all(e.tool_name == "tool_a" for e in tool_a_entries)

    def test_export_decisions_json(self, history_tracker):
        """Should export decision history as JSON with required fields."""
        history_tracker.record(
            tool_name="wire_transfer",
            args={"amount": 12500, "recipient": "ops-vendor"},
            result=ValidationResult(
                decision="deny",
                reason="Approval denied",
                metadata={
                    "ruleId": "require-wire-approval",
                    "policyVersion": "1.0",
                },
            ),
        )

        exported = history_tracker.export_decisions("json")
        import json

        parsed = json.loads(exported)
        assert len(parsed) == 1
        assert parsed[0]["tool_name"] == "wire_transfer"
        assert parsed[0]["arguments"] == {"amount": 12500, "recipient": "ops-vendor"}
        assert parsed[0]["policy_version"] == "1.0"
        assert parsed[0]["rule_id"] == "require-wire-approval"
        assert parsed[0]["decision"] == "deny"
        assert parsed[0]["reason"] == "Approval denied"
        assert isinstance(parsed[0]["timestamp"], str)

    def test_export_decisions_csv(self, history_tracker):
        """Should export decision history as CSV."""
        history_tracker.record(
            tool_name="wire_transfer",
            args={"note": "requires, review"},
            result=ValidationResult(
                decision="allow",
                metadata={
                    "rule_id": "require-wire-approval",
                    "policy_version": "1.0",
                },
            ),
        )

        exported = history_tracker.export_decisions("csv")
        lines = exported.split("\n")

        assert (
            lines[0]
            == "timestamp,tool_name,arguments,policy_version,rule_id,decision,reason"
        )
        assert len(lines) == 2
        assert "wire_transfer" in lines[1]
        assert "require-wire-approval" in lines[1]
        assert "allow" in lines[1]

    def test_export_decisions_invalid_format(self, history_tracker):
        """Should reject unsupported export formats."""
        with pytest.raises(ValueError):
            history_tracker.export_decisions("xml")  # type: ignore[arg-type]


class TestHistoryStats:
    """Tests for HistoryStats dataclass."""

    def test_stats_creation(self):
        """Should create stats with correct values."""
        stats = HistoryStats(
            total_calls=10,
            allowed_calls=7,
            denied_calls=3,
            modified_calls=0,
            calls_by_tool={"tool_a": 5, "tool_b": 5},
        )
        assert stats.total_calls == 10
        assert stats.allowed_calls == 7
        assert stats.denied_calls == 3
