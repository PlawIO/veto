"""Lazy core module exports for Veto."""

from __future__ import annotations

from importlib import import_module
from typing import Any


_EXPORTS: dict[str, tuple[str, str]] = {
    "Veto": ("veto.core.veto", "Veto"),
    "ToolCallDeniedError": ("veto.core.veto", "ToolCallDeniedError"),
    "GuardResult": ("veto.core.veto", "GuardResult"),
    "VetoOptions": ("veto.core.veto", "VetoOptions"),
    "VetoMode": ("veto.core.veto", "VetoMode"),
    "ValidationMode": ("veto.core.veto", "ValidationMode"),
    "WrappedTools": ("veto.core.veto", "WrappedTools"),
    "WrappedMCPTools": ("veto.core.veto", "WrappedMCPTools"),
    "WrappedHandler": ("veto.core.veto", "WrappedHandler"),
    "protect": ("veto.core.protect", "protect"),
    "ValidationEngine": ("veto.core.validator", "ValidationEngine"),
    "ValidationEngineOptions": ("veto.core.validator", "ValidationEngineOptions"),
    "AggregatedValidationResult": ("veto.core.validator", "AggregatedValidationResult"),
    "create_passthrough_validator": ("veto.core.validator", "create_passthrough_validator"),
    "create_blocklist_validator": ("veto.core.validator", "create_blocklist_validator"),
    "create_allowlist_validator": ("veto.core.validator", "create_allowlist_validator"),
    "HistoryTracker": ("veto.core.history", "HistoryTracker"),
    "HistoryTrackerOptions": ("veto.core.history", "HistoryTrackerOptions"),
    "HistoryStats": ("veto.core.history", "HistoryStats"),
    "Interceptor": ("veto.core.interceptor", "Interceptor"),
    "InterceptorOptions": ("veto.core.interceptor", "InterceptorOptions"),
    "InterceptionResult": ("veto.core.interceptor", "InterceptionResult"),
    "DenialDetails": ("veto.core.interceptor", "DenialDetails"),
    "OutputValidator": ("veto.core.output_validator", "OutputValidator"),
    "OutputValidatorOptions": ("veto.core.output_validator", "OutputValidatorOptions"),
    "OutputValidationResult": ("veto.core.output_validator", "OutputValidationResult"),
    "EventWebhookConfig": ("veto.core.events", "EventWebhookConfig"),
    "WebhookEvent": ("veto.core.events", "WebhookEvent"),
    "WebhookEventType": ("veto.core.events", "WebhookEventType"),
    "WebhookFormat": ("veto.core.events", "WebhookFormat"),
    "EventWebhookEmitter": ("veto.core.events", "EventWebhookEmitter"),
    "format_slack_payload": ("veto.core.events", "format_slack_payload"),
    "format_pagerduty_payload": ("veto.core.events", "format_pagerduty_payload"),
    "format_generic_payload": ("veto.core.events", "format_generic_payload"),
    "format_cef_payload": ("veto.core.events", "format_cef_payload"),
}

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    try:
        module_name, export_name = _EXPORTS[name]
    except KeyError as exc:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from exc

    module = import_module(module_name)
    value = getattr(module, export_name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted({*globals(), *__all__})
