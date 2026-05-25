"""
Rules module for Veto SDK.

Provides Policy IR v1 schema validation and rule loading.
"""

from veto.rules.schema_validator import (
    validate_policy_ir,
    PolicySchemaError,
    PolicyValidationError,
)
from veto.rules.condition_evaluator import (
    resolve_field_path,
    create_safe_regex,
    evaluate_legacy_condition,
    evaluate_condition,
    evaluate_condition_collections,
    evaluate_agent_scope,
    rule_applies_to_agent,
    has_matching_history_entry,
    evaluate_sequence_constraints,
)
from veto.rules.feed_provider import (
    FeedFallback,
    FeedProvider,
    FeedSnapshot,
    InMemoryFeedProvider,
    is_condition_value_ref,
    resolve_feed_ref,
)
from veto.rules.local_evaluator import (
    LocalEvalOptions,
    LocalEvalResult,
    evaluate_rules_locally,
)
from veto.rules.pipeline_dsl import (
    PipelineBudget,
    PipelineOutput,
    PipelineSchedule,
    PipelineSpec,
    PipelineStep,
    canonicalize_json,
    compute_pipeline_id,
    parse_pipeline_spec,
    stamp_pipeline_id,
    verify_pipeline_id,
)
from veto.rules.patterns import (
    OUTPUT_PATTERNS,
    OUTPUT_PATTERN_SSN,
    OUTPUT_PATTERN_CREDIT_CARD,
    OUTPUT_PATTERN_OPENAI_API_KEY,
    OUTPUT_PATTERN_GITHUB_API_KEY,
    OUTPUT_PATTERN_AWS_API_KEY,
    OUTPUT_PATTERN_EMAIL,
    OUTPUT_PATTERN_US_PHONE,
)

__all__ = [
    "validate_policy_ir",
    "PolicySchemaError",
    "PolicyValidationError",
    "resolve_field_path",
    "create_safe_regex",
    "evaluate_legacy_condition",
    "evaluate_condition",
    "evaluate_condition_collections",
    "evaluate_agent_scope",
    "rule_applies_to_agent",
    "has_matching_history_entry",
    "evaluate_sequence_constraints",
    "FeedFallback",
    "FeedProvider",
    "FeedSnapshot",
    "InMemoryFeedProvider",
    "is_condition_value_ref",
    "resolve_feed_ref",
    "LocalEvalOptions",
    "LocalEvalResult",
    "evaluate_rules_locally",
    "PipelineBudget",
    "PipelineOutput",
    "PipelineSchedule",
    "PipelineSpec",
    "PipelineStep",
    "canonicalize_json",
    "compute_pipeline_id",
    "parse_pipeline_spec",
    "stamp_pipeline_id",
    "verify_pipeline_id",
    "OUTPUT_PATTERNS",
    "OUTPUT_PATTERN_SSN",
    "OUTPUT_PATTERN_CREDIT_CARD",
    "OUTPUT_PATTERN_OPENAI_API_KEY",
    "OUTPUT_PATTERN_GITHUB_API_KEY",
    "OUTPUT_PATTERN_AWS_API_KEY",
    "OUTPUT_PATTERN_EMAIL",
    "OUTPUT_PATTERN_US_PHONE",
]
