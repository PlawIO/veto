"""
Core module exports for Veto.
"""

from veto.core.veto import (
    Veto,
    ToolCallDeniedError,
    GuardResult,
    VetoOptions,
    VetoMode,
    WrappedTools,
    WrappedHandler,
)

from veto.core.validator import (
    ValidationEngine,
    ValidationEngineOptions,
    AggregatedValidationResult,
    create_passthrough_validator,
    create_blocklist_validator,
    create_allowlist_validator,
)

from veto.core.history import (
    HistoryTracker,
    HistoryTrackerOptions,
    HistoryStats,
)

from veto.core.interceptor import (
    Interceptor,
    InterceptorOptions,
    InterceptionResult,
)

__all__ = [
    # Veto
    "Veto",
    "ToolCallDeniedError",
    "GuardResult",
    "VetoOptions",
    "VetoMode",
    "WrappedTools",
    "WrappedHandler",
    # Validator
    "ValidationEngine",
    "ValidationEngineOptions",
    "AggregatedValidationResult",
    "create_passthrough_validator",
    "create_blocklist_validator",
    "create_allowlist_validator",
    # History
    "HistoryTracker",
    "HistoryTrackerOptions",
    "HistoryStats",
    # Interceptor
    "Interceptor",
    "InterceptorOptions",
    "InterceptionResult",
]
