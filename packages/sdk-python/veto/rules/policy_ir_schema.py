"""
Policy IR v1 JSON Schema.

Embedded copy of policy-ir-v1.schema.json for use without filesystem access.
"""

from typing import Any, Dict

POLICY_IR_V1_SCHEMA: Dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://veto.dev/schemas/policy-ir-v1.json",
    "title": "Veto Policy IR v1",
    "description": "Canonical intermediate representation for Veto policies. Consumed by TypeScript and Python SDK loaders.",
    "type": "object",
    "required": ["version"],
    "anyOf": [
        {"required": ["rules"]},
        {"required": ["output_rules"]},
        {"required": ["extends"]},
        {"required": ["economic"]},
        {"required": ["sessionConstraints"]},
    ],
    "properties": {
        "version": {
            "const": "1.0",
            "description": 'Schema version. Must be "1.0" for this version of the IR.',
        },
        "name": {
            "type": "string",
            "minLength": 1,
            "description": "Human-readable name for this policy set.",
        },
        "description": {
            "type": "string",
            "description": "Detailed description of this policy set.",
        },
        "extends": {
            "type": "string",
            "minLength": 1,
            "description": 'Optional built-in policy pack name to inherit from (e.g., "@veto/coding-agent").',
        },
        "rules": {
            "type": "array",
            "items": {"$ref": "#/$defs/Rule"},
            "description": "Ordered list of rules in this policy.",
        },
        "output_rules": {
            "type": "array",
            "items": {"$ref": "#/$defs/OutputRule"},
            "description": "Ordered list of output rules in this policy.",
        },
        "settings": {
            "$ref": "#/$defs/Settings",
        },
        "economic": {
            "$ref": "#/$defs/EconomicPolicy",
        },
        "sessionConstraints": {
            "$ref": "#/$defs/SessionConstraints",
        },
    },
    "additionalProperties": False,
    "$defs": {
        "Rule": {
            "type": "object",
            "required": ["id", "name", "action"],
            "properties": {
                "id": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Unique identifier for this rule.",
                },
                "name": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Human-readable name for this rule.",
                },
                "description": {
                    "type": "string",
                    "description": "Detailed description of what this rule does.",
                },
                "message": {
                    "type": "string",
                    "description": "Optional user-facing message for approvals, warnings, or denials.",
                },
                "enabled": {
                    "type": "boolean",
                    "default": True,
                    "description": "Whether this rule is active.",
                },
                "severity": {
                    "$ref": "#/$defs/Severity",
                },
                "action": {
                    "$ref": "#/$defs/Action",
                },
                "tools": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1},
                    "description": "Tools this rule applies to. Empty or absent means all tools.",
                },
                "agents": {
                    "$ref": "#/$defs/AgentScope",
                },
                "conditions": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/Condition"},
                    "description": "Conditions that must ALL be met for the rule to trigger (AND logic).",
                },
                "condition_groups": {
                    "type": "array",
                    "items": {
                        "type": "array",
                        "items": {"$ref": "#/$defs/Condition"},
                    },
                    "description": "Alternative condition groups (OR between groups, AND within each group).",
                },
                "blocked_by": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/SequenceConstraint"},
                    "description": "Block if any matching historical call is present.",
                },
                "requires": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/SequenceConstraint"},
                    "description": "Block unless each required historical call is present.",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Tags for categorization.",
                },
                "metadata": {
                    "type": "object",
                    "additionalProperties": True,
                    "description": "Arbitrary key-value metadata attached to this rule.",
                },
                "rate_limits": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["scope", "max_calls", "window_seconds"],
                        "properties": {
                            "scope": {
                                "type": "string",
                                "enum": ["agent", "user", "session", "global"],
                            },
                            "max_calls": {"type": "number"},
                            "window_seconds": {"type": "number"},
                        },
                        "additionalProperties": False,
                    },
                    "description": "Sliding-window rate limits evaluated after conditions pass.",
                },
                "payment": {
                    "type": "object",
                    "required": ["protocol", "amount", "currency"],
                    "properties": {
                        "protocol": {"type": "string", "enum": ["x402", "mpp", "ap2"]},
                        "amount": {"type": "number"},
                        "currency": {"type": "string"},
                        "chain_id": {"type": "number"},
                    },
                    "additionalProperties": False,
                    "description": "Payment gate configuration for require_payment action.",
                },
            },
            "additionalProperties": False,
        },
        "OutputRule": {
            "type": "object",
            "required": ["id", "name", "action"],
            "properties": {
                "id": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Unique identifier for this output rule.",
                },
                "name": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Human-readable name for this output rule.",
                },
                "description": {
                    "type": "string",
                    "description": "Detailed description of what this output rule does.",
                },
                "enabled": {
                    "type": "boolean",
                    "default": True,
                    "description": "Whether this output rule is active.",
                },
                "severity": {
                    "$ref": "#/$defs/Severity",
                },
                "action": {
                    "$ref": "#/$defs/OutputAction",
                },
                "tools": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1},
                    "description": "Tools this output rule applies to. Empty or absent means all tools.",
                },
                "output_conditions": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/Condition"},
                    "description": "Conditions that must ALL be met for the output rule to trigger (AND logic).",
                },
                "output_condition_groups": {
                    "type": "array",
                    "items": {
                        "type": "array",
                        "items": {"$ref": "#/$defs/Condition"},
                    },
                    "description": "Alternative output condition groups (OR between groups, AND within each group).",
                },
                "redact_with": {
                    "type": "string",
                    "description": "Replacement string used for redact action.",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Tags for categorization.",
                },
                "metadata": {
                    "type": "object",
                    "additionalProperties": True,
                    "description": "Arbitrary key-value metadata attached to this output rule.",
                },
            },
            "additionalProperties": False,
        },
        "Condition": {
            "type": "object",
            "required": ["field", "operator"],
            "properties": {
                "field": {
                    "type": "string",
                    "minLength": 1,
                    "description": 'Dot-notation path to the field to evaluate (e.g. "arguments.amount").',
                },
                "operator": {
                    "$ref": "#/$defs/Operator",
                },
                "value": {
                    "description": "The value to compare the field against.",
                },
                "reference": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Optional dot-notation reference path used by dynamic operators.",
                },
            },
            "allOf": [
                {
                    "if": {
                        "properties": {
                            "operator": {
                                "const": "not_exists",
                            }
                        }
                    },
                    "else": {"required": ["value"]},
                },
                {
                    "if": {
                        "properties": {
                            "operator": {
                                "enum": ["within_hours", "outside_hours"],
                            }
                        }
                    },
                    "then": {
                        "properties": {
                            "value": {
                                "anyOf": [
                                    {"$ref": "#/$defs/TimeWindowValue"},
                                    {"$ref": "#/$defs/TimeWindowString"},
                                ]
                            },
                        }
                    },
                },
                {
                    "if": {
                        "properties": {
                            "operator": {
                                "const": "percent_of",
                            }
                        }
                    },
                    "then": {
                        "required": ["reference"],
                        "properties": {
                            "value": {
                                "type": "number",
                                "exclusiveMinimum": 0,
                            }
                        },
                    },
                },
            ],
            "additionalProperties": False,
        },
        "FeedRef": {
            "type": "object",
            "required": ["kind", "feed_id", "version", "max_staleness_sec", "fallback"],
            "properties": {
                "kind": {"const": "feed"},
                "feed_id": {"type": "string", "minLength": 1},
                "version": {"type": "string", "minLength": 1},
                "max_staleness_sec": {"type": "integer", "minimum": 0},
                "fallback": {
                    "type": "string",
                    "enum": ["fail_open", "fail_closed", "last_known_good"],
                },
            },
            "additionalProperties": False,
            "description": "Typed reference to a dynamic pipeline feed.",
        },
        "PipelineRef": {
            "type": "object",
            "required": [
                "kind",
                "pipeline_id",
                "version",
                "max_staleness_sec",
                "fallback",
            ],
            "properties": {
                "kind": {"const": "pipeline"},
                "pipeline_id": {"type": "string", "minLength": 1},
                "version": {"type": "string", "minLength": 1},
                "max_staleness_sec": {"type": "integer", "minimum": 0},
                "fallback": {
                    "type": "string",
                    "enum": ["fail_open", "fail_closed", "last_known_good"],
                },
            },
            "additionalProperties": False,
            "description": "Typed reference to a pipeline by id.",
        },
        "TimeWindowValue": {
            "type": "object",
            "required": ["start", "end", "timezone"],
            "properties": {
                "start": {
                    "type": "string",
                    "pattern": "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
                    "description": "Start time in HH:MM 24-hour format.",
                },
                "end": {
                    "type": "string",
                    "pattern": "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
                    "description": "End time in HH:MM 24-hour format.",
                },
                "timezone": {
                    "type": "string",
                    "minLength": 1,
                    "description": 'IANA timezone identifier (e.g., "America/New_York").',
                },
                "days": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
                    },
                    "description": "Optional day filter. If omitted, applies every day.",
                },
            },
            "additionalProperties": False,
        },
        "TimeWindowString": {
            "type": "string",
            "pattern": "^(?:[01]\\d|2[0-3]):[0-5]\\d-(?:[01]\\d|2[0-3]):[0-5]\\d$",
            "description": "Simple time window in HH:MM-HH:MM format.",
        },
        "AgentScope": {
            "oneOf": [
                {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1},
                    "description": "Rule applies only to these agents.",
                },
                {
                    "type": "object",
                    "required": ["not"],
                    "properties": {
                        "not": {
                            "type": "array",
                            "items": {"type": "string", "minLength": 1},
                            "description": "Rule applies to all agents except those listed here.",
                        }
                    },
                    "additionalProperties": False,
                },
            ],
            "description": "Optional agent scope filter for this rule.",
        },
        "SequenceConstraint": {
            "type": "object",
            "required": ["tool"],
            "properties": {
                "tool": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Historical tool name to match.",
                },
                "conditions": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/Condition"},
                    "description": "Conditions that must ALL match on the historical call context.",
                },
                "condition_groups": {
                    "type": "array",
                    "items": {
                        "type": "array",
                        "items": {"$ref": "#/$defs/Condition"},
                    },
                    "description": "Alternative condition groups (OR between groups, AND within each group).",
                },
                "within": {
                    "type": "number",
                    "minimum": 0,
                    "description": "Optional time window in seconds relative to the current call.",
                },
            },
            "additionalProperties": False,
        },
        "Operator": {
            "type": "string",
            "enum": [
                "equals",
                "not_equals",
                "contains",
                "not_contains",
                "starts_with",
                "ends_with",
                "matches",
                "greater_than",
                "greater_than_or_equal",
                "less_than",
                "less_than_or_equal",
                "percent_of",
                "length_greater_than",
                "in",
                "not_in",
                "not_exists",
                "outside_hours",
                "within_hours",
            ],
            "description": "Comparison operator.",
        },
        "SessionCounterConfig": {
            "type": "object",
            "required": ["increment"],
            "properties": {
                "increment": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1},
                },
                "decrement": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1},
                },
                "max": {"type": "number"},
                "maxAction": {
                    "type": "string",
                    "enum": ["deny", "require_approval"],
                },
            },
            "additionalProperties": False,
        },
        "CumulativeLimit": {
            "type": "object",
            "required": ["argumentName", "maxValue"],
            "properties": {
                "argumentName": {"type": "string", "minLength": 1},
                "maxValue": {"type": "number"},
            },
            "additionalProperties": False,
        },
        "SessionConstraints": {
            "type": "object",
            "properties": {
                "maxCalls": {"type": "number"},
                "budget": {"type": "number"},
                "spendArgument": {"type": "string", "minLength": 1},
                "cumulativeLimits": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/CumulativeLimit"},
                },
                "counters": {
                    "type": "object",
                    "additionalProperties": {
                        "$ref": "#/$defs/SessionCounterConfig"
                    },
                },
            },
            "additionalProperties": False,
        },
        "Severity": {
            "type": "string",
            "enum": ["critical", "high", "medium", "low", "info"],
            "default": "medium",
            "description": "Severity level of the rule.",
        },
        "Action": {
            "type": "string",
            "enum": [
                "block",
                "warn",
                "log",
                "allow",
                "require_approval",
                "require_payment",
            ],
            "description": "Action to take when the rule matches.",
        },
        "OutputAction": {
            "type": "string",
            "enum": ["block", "redact", "log"],
            "description": "Action to take when the output rule matches.",
        },
        "Settings": {
            "type": "object",
            "properties": {
                "default_action": {
                    "$ref": "#/$defs/Action",
                },
                "fail_mode": {
                    "type": "string",
                    "enum": ["open", "closed"],
                    "description": 'Behavior on validation errors: "open" allows, "closed" blocks.',
                },
                "global_tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Tags applied to all rules in this set.",
                },
            },
            "additionalProperties": False,
        },
        "EconomicPolicy": {
            "type": "object",
            "description": "Economic authorization policy for x402, MPP, and AP2 protocols.",
            "properties": {
                "budgets": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/EconomicBudget"},
                    "description": "Budget configurations per scope.",
                },
                "cost_extraction": {
                    "type": "object",
                    "properties": {
                        "default": {
                            "type": "string",
                            "description": "Default dot-notation path to extract cost from tool arguments.",
                        },
                        "overrides": {
                            "type": "object",
                            "additionalProperties": {"type": "string"},
                            "description": "Per-tool cost extraction path overrides.",
                        },
                    },
                    "additionalProperties": False,
                },
                "payer": {
                    "type": "object",
                    "properties": {
                        "required": {"type": "boolean"},
                        "approved": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "additionalProperties": False,
                },
                "denial_reasons": {
                    "type": "object",
                    "properties": {
                        "budget_exceeded": {"type": "string"},
                        "approval_required": {"type": "string"},
                        "payer_missing": {"type": "string"},
                        "payer_unauthorized": {"type": "string"},
                        "currency_mismatch": {"type": "string"},
                        "connector_error": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
            },
            "additionalProperties": False,
        },
        "EconomicBudget": {
            "type": "object",
            "required": ["scope", "limit", "currency", "window"],
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["session", "agent", "user", "global"],
                },
                "limit": {"type": "number", "minimum": 0},
                "currency": {"type": "string", "minLength": 1},
                "approval_threshold": {"type": "number", "minimum": 0},
                "window": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
}
