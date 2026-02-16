"""
Tool call history tracking.

This module manages the history of tool calls for a Veto instance,
providing context to validators about previous calls.
"""

from typing import Any, Optional
from dataclasses import dataclass
from datetime import datetime
import csv
import io
import json

from veto.types.config import (
    DecisionExportFormat,
    DecisionExportRecord,
    ToolCallHistoryEntry,
    ValidationResult,
)
from veto.utils.logger import Logger


@dataclass
class HistoryTrackerOptions:
    """Options for the history tracker."""

    max_size: int
    logger: Logger


@dataclass
class HistoryStats:
    """Statistics about tool call history."""

    total_calls: int
    allowed_calls: int
    denied_calls: int
    modified_calls: int
    calls_by_tool: dict[str, int]


class HistoryTracker:
    """Tracks the history of tool calls for context."""

    def __init__(self, options: HistoryTrackerOptions):
        self._entries: list[ToolCallHistoryEntry] = []
        self._max_size = options.max_size
        self._logger = options.logger

    def add(self, entry: ToolCallHistoryEntry) -> None:
        """
        Add an entry to the history.

        If the history exceeds max_size, the oldest entry is removed.

        Args:
            entry: The history entry to add
        """
        self._entries.append(entry)

        # Remove oldest entries if we exceed max size
        while len(self._entries) > self._max_size:
            removed = self._entries.pop(0)
            self._logger.debug(
                "History entry evicted due to size limit",
                {
                    "evicted_tool": removed.tool_name,
                    "history_size": len(self._entries),
                },
            )

        self._logger.debug(
            "History entry added",
            {
                "tool_name": entry.tool_name,
                "decision": entry.validation_result.decision,
                "history_size": len(self._entries),
            },
        )

    def record(
        self,
        tool_name: str,
        args: dict[str, Any],
        result: ValidationResult,
        duration_ms: Optional[float] = None,
    ) -> None:
        """
        Record a tool call in the history.

        Convenience method that creates a history entry.

        Args:
            tool_name: Name of the tool called
            args: Arguments passed to the tool
            result: Validation result
            duration_ms: Optional execution duration
        """
        self.add(
            ToolCallHistoryEntry(
                tool_name=tool_name,
                arguments=args,
                validation_result=result,
                timestamp=datetime.now(),
                duration_ms=duration_ms,
            )
        )

    def get_all(self) -> list[ToolCallHistoryEntry]:
        """
        Get all history entries.

        Returns a copy to prevent external modification.
        """
        return list(self._entries)

    def get_last(self, count: int) -> list[ToolCallHistoryEntry]:
        """
        Get the last N entries.

        Args:
            count: Number of entries to retrieve
        """
        return list(self._entries[-count:])

    def get_by_tool(self, tool_name: str) -> list[ToolCallHistoryEntry]:
        """
        Get entries for a specific tool.

        Args:
            tool_name: Name of the tool to filter by
        """
        return [entry for entry in self._entries if entry.tool_name == tool_name]

    def get_by_time_range(
        self,
        since: datetime,
        until: Optional[datetime] = None,
    ) -> list[ToolCallHistoryEntry]:
        """
        Get entries within a time range.

        Args:
            since: Start of the time range
            until: End of the time range (defaults to now)
        """
        until = until or datetime.now()
        return [entry for entry in self._entries if since <= entry.timestamp <= until]

    def get_denied(self) -> list[ToolCallHistoryEntry]:
        """Get entries that were denied."""
        return [
            entry
            for entry in self._entries
            if entry.validation_result.decision == "deny"
        ]

    def size(self) -> int:
        """Get the count of entries."""
        return len(self._entries)

    def clear(self) -> None:
        """Clear all history entries."""
        previous_size = len(self._entries)
        self._entries.clear()
        self._logger.debug("History cleared", {"previous_size": previous_size})

    def get_stats(self) -> HistoryStats:
        """Get statistics about the history."""
        tool_counts: dict[str, int] = {}
        allowed_count = 0
        denied_count = 0
        modified_count = 0

        for entry in self._entries:
            tool_counts[entry.tool_name] = tool_counts.get(entry.tool_name, 0) + 1

            decision = entry.validation_result.decision
            if decision == "allow":
                allowed_count += 1
            elif decision == "deny":
                denied_count += 1
            elif decision == "modify":
                modified_count += 1

        return HistoryStats(
            total_calls=len(self._entries),
            allowed_calls=allowed_count,
            denied_calls=denied_count,
            modified_calls=modified_count,
            calls_by_tool=tool_counts,
        )

    def export_decisions(self, format: DecisionExportFormat = "json") -> str:
        """Export decision history as JSON or CSV."""
        records = self._to_export_records()

        if format == "json":
            return json.dumps(
                [
                    {
                        "timestamp": record.timestamp,
                        "tool_name": record.tool_name,
                        "arguments": record.arguments,
                        "policy_version": record.policy_version,
                        "rule_id": record.rule_id,
                        "decision": record.decision,
                        "reason": record.reason,
                    }
                    for record in records
                ],
                indent=2,
            )

        if format == "csv":
            return self._to_csv(records)

        raise ValueError(f"Unsupported decision export format: {format}")

    def _to_export_records(self) -> list[DecisionExportRecord]:
        records: list[DecisionExportRecord] = []

        for entry in self._entries:
            metadata = entry.validation_result.metadata or {}
            records.append(
                DecisionExportRecord(
                    timestamp=entry.timestamp.isoformat(),
                    tool_name=entry.tool_name,
                    arguments=entry.arguments,
                    policy_version=self._extract_metadata_string(
                        metadata, ["policyVersion", "policy_version"]
                    ),
                    rule_id=self._extract_metadata_string(
                        metadata, ["ruleId", "rule_id"]
                    ),
                    decision=entry.validation_result.decision,
                    reason=entry.validation_result.reason,
                )
            )

        return records

    def _extract_metadata_string(
        self,
        metadata: dict[str, Any],
        keys: list[str],
    ) -> Optional[str]:
        for key in keys:
            value = metadata.get(key)
            if isinstance(value, str) and value.strip():
                return value
            if isinstance(value, (int, float, bool)):
                return str(value)

        return None

    def _to_csv(self, records: list[DecisionExportRecord]) -> str:
        output = io.StringIO()
        writer = csv.writer(output, lineterminator="\n")

        writer.writerow(
            [
                "timestamp",
                "tool_name",
                "arguments",
                "policy_version",
                "rule_id",
                "decision",
                "reason",
            ]
        )

        for record in records:
            writer.writerow(
                [
                    record.timestamp,
                    record.tool_name,
                    json.dumps(record.arguments),
                    record.policy_version or "",
                    record.rule_id or "",
                    record.decision,
                    record.reason or "",
                ]
            )

        return output.getvalue().rstrip("\n")
