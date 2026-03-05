"""
Core module exports for Veto.
"""

from veto.core.veto import (
    Veto,
    ToolCallDeniedError,
    GuardResult,
    VetoOptions,
    VetoMode,
    ValidationMode,
    WrappedTools,
    WrappedHandler,
)
from veto.core.protect import protect

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
    DenialDetails,
)
from veto.core.output_validator import (
    OutputValidator,
    OutputValidatorOptions,
    OutputValidationResult,
)
from veto.core.events import (
    EventWebhookConfig,
    WebhookEvent,
    WebhookEventType,
    WebhookFormat,
    EventWebhookEmitter,
    format_slack_payload,
    format_pagerduty_payload,
    format_generic_payload,
    format_cef_payload,
)

__all__ = [
    # Veto
    "Veto",
    "ToolCallDeniedError",
    "GuardResult",
    "VetoOptions",
    "VetoMode",
    "ValidationMode",
    "WrappedTools",
    "WrappedHandler",
    "protect",
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
    "DenialDetails",
    # Output validator
    "OutputValidator",
    "OutputValidatorOptions",
    "OutputValidationResult",
    # Events
    "EventWebhookConfig",
    "WebhookEvent",
    "WebhookEventType",
    "WebhookFormat",
    "EventWebhookEmitter",
    "format_slack_payload",
    "format_pagerduty_payload",
    "format_generic_payload",
    "format_cef_payload",
]
