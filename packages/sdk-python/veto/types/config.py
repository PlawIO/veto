"""
Configuration types for Veto guardrail system.
"""

from typing import (
    Any,
    Callable,
    Literal,
    Optional,
    Union,
    Awaitable,
    TYPE_CHECKING,
)
from dataclasses import dataclass, field
from datetime import datetime

if TYPE_CHECKING:
    from veto.utils.logger import Logger


# Log level for Veto operations
LogLevel = Literal["debug", "info", "warn", "error", "silent"]

# Validation decision for a tool call
ValidationDecision = Literal["allow", "deny", "modify"]

# Export format for decision history
DecisionExportFormat = Literal["json", "csv"]


@dataclass
class ValidationResult:
    """Result of validating a tool call."""

    decision: ValidationDecision
    reason: Optional[str] = None
    modified_arguments: Optional[dict[str, Any]] = None
    metadata: Optional[dict[str, Any]] = None


@dataclass
class ToolCallHistoryEntry:
    """Entry in the tool call history."""

    tool_name: str
    arguments: dict[str, Any]
    validation_result: ValidationResult
    timestamp: datetime
    duration_ms: Optional[float] = None


@dataclass
class DecisionExportRecord:
    """Serializable decision record returned by export_decisions()."""

    timestamp: str
    tool_name: str
    arguments: dict[str, Any]
    policy_version: Optional[str]
    rule_id: Optional[str]
    decision: ValidationDecision
    reason: Optional[str]


@dataclass
class ValidationContext:
    """Context provided to validators for making decisions."""

    tool_name: str
    arguments: dict[str, Any]
    call_id: str
    timestamp: datetime
    call_history: list[ToolCallHistoryEntry] = field(default_factory=list)
    custom: Optional[dict[str, Any]] = None


# Validator function type
Validator = Callable[
    [ValidationContext], Union[ValidationResult, Awaitable[ValidationResult]]
]


@dataclass
class NamedValidator:
    """Named validator with optional configuration."""

    name: str
    validate: Validator
    description: Optional[str] = None
    priority: int = 100
    tool_filter: Optional[list[str]] = None


@dataclass
class VetoConfig:
    """Configuration options for the Veto instance."""

    validators: Optional[list[Union[Validator, NamedValidator]]] = None
    default_decision: ValidationDecision = "allow"
    log_level: LogLevel = "info"
    logger: Optional["Logger"] = None
    track_history: bool = True
    max_history_size: int = 100
    custom_context: Optional[dict[str, Any]] = None
    on_before_validation: Optional[
        Callable[[ValidationContext], Union[None, Awaitable[None]]]
    ] = None
    on_after_validation: Optional[
        Callable[[ValidationContext, ValidationResult], Union[None, Awaitable[None]]]
    ] = None
    on_denied: Optional[
        Callable[[ValidationContext, ValidationResult], Union[None, Awaitable[None]]]
    ] = None


@dataclass
class ResolvedVetoConfig:
    """Resolved configuration with all defaults applied."""

    validators: list[Union[Validator, NamedValidator]]
    default_decision: ValidationDecision
    log_level: LogLevel
    logger: "Logger"
    track_history: bool
    max_history_size: int
    custom_context: Optional[dict[str, Any]] = None
    on_before_validation: Optional[
        Callable[[ValidationContext], Union[None, Awaitable[None]]]
    ] = None
    on_after_validation: Optional[
        Callable[[ValidationContext, ValidationResult], Union[None, Awaitable[None]]]
    ] = None
    on_denied: Optional[
        Callable[[ValidationContext, ValidationResult], Union[None, Awaitable[None]]]
    ] = None


def is_named_validator(validator: Union[Validator, NamedValidator]) -> bool:
    """Helper to check if a validator is a named validator."""
    return isinstance(validator, NamedValidator)


def normalize_validator(
    validator: Union[Validator, NamedValidator], index: int
) -> NamedValidator:
    """Normalize a validator to NamedValidator format."""
    if isinstance(validator, NamedValidator):
        return NamedValidator(
            name=validator.name,
            validate=validator.validate,
            description=validator.description,
            priority=validator.priority if validator.priority else 100,
            tool_filter=validator.tool_filter,
        )
    return NamedValidator(
        name=f"validator-{index}",
        validate=validator,
        priority=100,
    )
