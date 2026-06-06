"""Lazy rules module exports for Veto."""

from __future__ import annotations

from importlib import import_module
from typing import Any


_EXPORTS: dict[str, tuple[str, str]] = {
    "validate_policy_ir": ("veto.rules.schema_validator", "validate_policy_ir"),
    "PolicySchemaError": ("veto.rules.schema_validator", "PolicySchemaError"),
    "PolicyValidationError": ("veto.rules.schema_validator", "PolicyValidationError"),
    "resolve_field_path": ("veto.rules.condition_evaluator", "resolve_field_path"),
    "create_safe_regex": ("veto.rules.condition_evaluator", "create_safe_regex"),
    "evaluate_legacy_condition": ("veto.rules.condition_evaluator", "evaluate_legacy_condition"),
    "evaluate_condition": ("veto.rules.condition_evaluator", "evaluate_condition"),
    "evaluate_condition_collections": ("veto.rules.condition_evaluator", "evaluate_condition_collections"),
    "evaluate_agent_scope": ("veto.rules.condition_evaluator", "evaluate_agent_scope"),
    "rule_applies_to_agent": ("veto.rules.condition_evaluator", "rule_applies_to_agent"),
    "has_matching_history_entry": ("veto.rules.condition_evaluator", "has_matching_history_entry"),
    "evaluate_sequence_constraints": ("veto.rules.condition_evaluator", "evaluate_sequence_constraints"),
    "FeedFallback": ("veto.rules.feed_provider", "FeedFallback"),
    "FeedProvider": ("veto.rules.feed_provider", "FeedProvider"),
    "FeedSnapshot": ("veto.rules.feed_provider", "FeedSnapshot"),
    "InMemoryFeedProvider": ("veto.rules.feed_provider", "InMemoryFeedProvider"),
    "is_condition_value_ref": ("veto.rules.feed_provider", "is_condition_value_ref"),
    "resolve_feed_ref": ("veto.rules.feed_provider", "resolve_feed_ref"),
    "LocalEvalOptions": ("veto.rules.local_evaluator", "LocalEvalOptions"),
    "LocalEvalResult": ("veto.rules.local_evaluator", "LocalEvalResult"),
    "evaluate_rules_locally": ("veto.rules.local_evaluator", "evaluate_rules_locally"),
    "PipelineBudget": ("veto.rules.pipeline_dsl", "PipelineBudget"),
    "PipelineOutput": ("veto.rules.pipeline_dsl", "PipelineOutput"),
    "PipelineSchedule": ("veto.rules.pipeline_dsl", "PipelineSchedule"),
    "PipelineSpec": ("veto.rules.pipeline_dsl", "PipelineSpec"),
    "PipelineStep": ("veto.rules.pipeline_dsl", "PipelineStep"),
    "canonicalize_json": ("veto.rules.pipeline_dsl", "canonicalize_json"),
    "compute_pipeline_id": ("veto.rules.pipeline_dsl", "compute_pipeline_id"),
    "parse_pipeline_spec": ("veto.rules.pipeline_dsl", "parse_pipeline_spec"),
    "stamp_pipeline_id": ("veto.rules.pipeline_dsl", "stamp_pipeline_id"),
    "verify_pipeline_id": ("veto.rules.pipeline_dsl", "verify_pipeline_id"),
    "OUTPUT_PATTERNS": ("veto.rules.patterns", "OUTPUT_PATTERNS"),
    "OUTPUT_PATTERN_SSN": ("veto.rules.patterns", "OUTPUT_PATTERN_SSN"),
    "OUTPUT_PATTERN_CREDIT_CARD": ("veto.rules.patterns", "OUTPUT_PATTERN_CREDIT_CARD"),
    "OUTPUT_PATTERN_OPENAI_API_KEY": ("veto.rules.patterns", "OUTPUT_PATTERN_OPENAI_API_KEY"),
    "OUTPUT_PATTERN_GITHUB_API_KEY": ("veto.rules.patterns", "OUTPUT_PATTERN_GITHUB_API_KEY"),
    "OUTPUT_PATTERN_AWS_API_KEY": ("veto.rules.patterns", "OUTPUT_PATTERN_AWS_API_KEY"),
    "OUTPUT_PATTERN_EMAIL": ("veto.rules.patterns", "OUTPUT_PATTERN_EMAIL"),
    "OUTPUT_PATTERN_US_PHONE": ("veto.rules.patterns", "OUTPUT_PATTERN_US_PHONE"),
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
