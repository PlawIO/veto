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
    "OUTPUT_PATTERNS",
    "OUTPUT_PATTERN_SSN",
    "OUTPUT_PATTERN_CREDIT_CARD",
    "OUTPUT_PATTERN_OPENAI_API_KEY",
    "OUTPUT_PATTERN_GITHUB_API_KEY",
    "OUTPUT_PATTERN_AWS_API_KEY",
    "OUTPUT_PATTERN_EMAIL",
    "OUTPUT_PATTERN_US_PHONE",
]
