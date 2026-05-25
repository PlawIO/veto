"""
Conformance tests for Policy IR v1 schema validation.

Uses the shared fixtures in conformance/fixtures/policy-ir/ to prove parity
between the TypeScript and Python schema validators.
"""

from pathlib import Path

import pytest
import yaml

from veto.rules import validate_policy_ir, PolicySchemaError


FIXTURES_DIR = (
    Path(__file__).resolve().parent.parent.parent.parent
    / "conformance"
    / "fixtures"
    / "policy-ir"
)


def _load_fixture(name: str) -> dict:
    with open(FIXTURES_DIR / name) as f:
        return yaml.safe_load(f)


class TestValidDocuments:
    def test_valid_minimal(self) -> None:
        data = _load_fixture("valid-minimal.yaml")
        validate_policy_ir(data)

    def test_valid_full(self) -> None:
        data = _load_fixture("valid-full.yaml")
        validate_policy_ir(data)

    def test_accepts_require_approval_action(self) -> None:
        validate_policy_ir(
            {
                "version": "1.0",
                "rules": [
                    {
                        "id": "require-human",
                        "name": "Require human approval",
                        "action": "require_approval",
                    }
                ],
            }
        )

    def test_accepts_output_rules(self) -> None:
        validate_policy_ir(
            {
                "version": "1.0",
                "output_rules": [
                    {
                        "id": "redact-output",
                        "name": "Redact output",
                        "action": "redact",
                        "output_conditions": [
                            {
                                "field": "output.email",
                                "operator": "matches",
                                "value": "[^@]+@[^@]+",
                            }
                        ],
                        "redact_with": "[REDACTED]",
                    }
                ],
            }
        )

    def test_accepts_sequence_constraints(self) -> None:
        validate_policy_ir(
            {
                "version": "1.0",
                "rules": [
                    {
                        "id": "sequence",
                        "name": "Sequence rule",
                        "action": "block",
                        "tools": ["send_email"],
                        "blocked_by": [
                            {
                                "tool": "read_file",
                                "conditions": [
                                    {
                                        "field": "arguments.path",
                                        "operator": "starts_with",
                                        "value": "/etc/secrets",
                                    }
                                ],
                            }
                        ],
                        "requires": [
                            {
                                "tool": "verify_identity",
                                "within": 300,
                            }
                        ],
                    }
                ],
            }
        )

    def test_accepts_extends_field(self) -> None:
        validate_policy_ir(
            {
                "version": "1.0",
                "extends": "@veto/coding-agent",
            }
        )

    def test_accepts_agents_scope(self) -> None:
        validate_policy_ir(
            {
                "version": "1.0",
                "rules": [
                    {
                        "id": "include-agents",
                        "name": "Include agents",
                        "action": "block",
                        "agents": ["agent-a", "agent-b"],
                    },
                    {
                        "id": "exclude-agents",
                        "name": "Exclude agents",
                        "action": "block",
                        "agents": {"not": ["agent-c"]},
                    },
                ],
            }
        )

    def test_accepts_time_operators(self) -> None:
        validate_policy_ir(
            {
                "version": "1.0",
                "rules": [
                    {
                        "id": "block-off-hours",
                        "name": "Block outside business hours",
                        "action": "block",
                        "conditions": [
                            {
                                "field": "context.time",
                                "operator": "outside_hours",
                                "value": {
                                    "start": "09:00",
                                    "end": "17:00",
                                    "timezone": "America/New_York",
                                    "days": ["mon", "tue", "wed", "thu", "fri"],
                                },
                            }
                        ],
                    },
                    {
                        "id": "allow-work-hours",
                        "name": "Allow in work hours",
                        "action": "allow",
                        "conditions": [
                            {
                                "field": "context.time",
                                "operator": "within_hours",
                                "value": {
                                    "start": "09:00",
                                    "end": "17:00",
                                    "timezone": "America/New_York",
                                },
                            }
                        ],
                    },
                ],
            }
        )

    def test_accepts_ts_parity_operators_and_not_exists(self) -> None:
        validate_policy_ir(
            {
                "version": "1.0",
                "rules": [
                    {
                        "id": "advanced-operators",
                        "name": "Advanced operators",
                        "action": "block",
                        "conditions": [
                            {
                                "field": "arguments.amount",
                                "operator": "greater_than_or_equal",
                                "value": 100,
                            },
                            {
                                "field": "arguments.amount",
                                "operator": "less_than_or_equal",
                                "value": 1000,
                            },
                            {
                                "field": "arguments.slippage",
                                "operator": "percent_of",
                                "value": 5,
                                "reference": "arguments.total",
                            },
                            {
                                "field": "arguments.approval_id",
                                "operator": "not_exists",
                            },
                        ],
                    }
                ],
            }
        )

    def test_accepts_economic_and_session_constraint_documents(self) -> None:
        validate_policy_ir(
            {
                "version": "1.0",
                "economic": {
                    "budgets": [
                        {
                            "scope": "session",
                            "limit": 100,
                            "currency": "USD",
                            "window": "session",
                            "approval_threshold": 50,
                        }
                    ],
                    "cost_extraction": {"default": "arguments.cost"},
                    "payer": {"required": True, "approved": ["cus_123"]},
                },
                "sessionConstraints": {
                    "maxCalls": 10,
                    "budget": 1000,
                    "spendArgument": "amount",
                    "cumulativeLimits": [
                        {"argumentName": "amount", "maxValue": 5000}
                    ],
                    "counters": {
                        "open_positions": {
                            "increment": ["buy"],
                            "decrement": ["sell"],
                            "max": 3,
                            "maxAction": "deny",
                        }
                    },
                },
            }
        )


class TestInvalidDocuments:
    def test_missing_version(self) -> None:
        data = _load_fixture("invalid-missing-version.yaml")
        with pytest.raises(PolicySchemaError) as exc_info:
            validate_policy_ir(data)
        assert any("version" in e.message for e in exc_info.value.errors)

    def test_wrong_version(self) -> None:
        data = _load_fixture("invalid-wrong-version.yaml")
        with pytest.raises(PolicySchemaError):
            validate_policy_ir(data)

    def test_missing_rules(self) -> None:
        data = _load_fixture("invalid-missing-rules.yaml")
        with pytest.raises(PolicySchemaError) as exc_info:
            validate_policy_ir(data)
        assert any("rules" in e.message for e in exc_info.value.errors)

    def test_bad_action(self) -> None:
        data = _load_fixture("invalid-bad-action.yaml")
        with pytest.raises(PolicySchemaError):
            validate_policy_ir(data)

    def test_bad_output_action(self) -> None:
        with pytest.raises(PolicySchemaError):
            validate_policy_ir(
                {
                    "version": "1.0",
                    "rules": [],
                    "output_rules": [
                        {
                            "id": "bad-output-action",
                            "name": "Bad output action",
                            "action": "allow",
                        }
                    ],
                }
            )

    def test_bad_operator(self) -> None:
        data = _load_fixture("invalid-bad-operator.yaml")
        with pytest.raises(PolicySchemaError):
            validate_policy_ir(data)

    def test_extra_field(self) -> None:
        data = _load_fixture("invalid-extra-field.yaml")
        with pytest.raises(PolicySchemaError):
            validate_policy_ir(data)

    def test_rule_missing_id(self) -> None:
        data = _load_fixture("invalid-rule-missing-id.yaml")
        with pytest.raises(PolicySchemaError):
            validate_policy_ir(data)

    def test_negative_within_rejected(self) -> None:
        with pytest.raises(PolicySchemaError):
            validate_policy_ir(
                {
                    "version": "1.0",
                    "rules": [
                        {
                            "id": "bad-within",
                            "name": "Bad within",
                            "action": "block",
                            "requires": [
                                {
                                    "tool": "verify_identity",
                                    "within": -5,
                                }
                            ],
                        }
                    ],
                }
            )

    def test_invalid_agents_scope_rejected(self) -> None:
        with pytest.raises(PolicySchemaError):
            validate_policy_ir(
                {
                    "version": "1.0",
                    "rules": [
                        {
                            "id": "bad-agents",
                            "name": "Bad agents scope",
                            "action": "block",
                            "agents": {"not": "agent-a"},
                        }
                    ],
                }
            )

    def test_simple_time_window_string_is_accepted_for_ts_parity(self) -> None:
        validate_policy_ir(
            {
                "version": "1.0",
                "rules": [
                    {
                        "id": "simple-time",
                        "name": "Simple time operator value",
                        "action": "block",
                        "conditions": [
                            {
                                "field": "context.time",
                                "operator": "within_hours",
                                "value": "09:00-17:00",
                            }
                        ],
                    }
                ],
            }
        )

    def test_invalid_time_window_string_rejected(self) -> None:
        with pytest.raises(PolicySchemaError):
            validate_policy_ir(
                {
                    "version": "1.0",
                    "rules": [
                        {
                            "id": "bad-time",
                            "name": "Bad time operator value",
                            "action": "block",
                            "conditions": [
                                {
                                    "field": "context.time",
                                    "operator": "within_hours",
                                    "value": "9-5",
                                }
                            ],
                        }
                    ],
                }
            )

    def test_invalid_time_day_rejected(self) -> None:
        with pytest.raises(PolicySchemaError):
            validate_policy_ir(
                {
                    "version": "1.0",
                    "rules": [
                        {
                            "id": "bad-time-day",
                            "name": "Bad time day",
                            "action": "block",
                            "conditions": [
                                {
                                    "field": "context.time",
                                    "operator": "outside_hours",
                                    "value": {
                                        "start": "09:00",
                                        "end": "17:00",
                                        "timezone": "UTC",
                                        "days": ["monday"],
                                    },
                                }
                            ],
                        }
                    ],
                }
            )


class TestErrorQuality:
    def test_actionable_error_messages(self) -> None:
        with pytest.raises(PolicySchemaError) as exc_info:
            validate_policy_ir(
                {
                    "version": "1.0",
                    "rules": [
                        {"name": "no-id-no-action"},
                    ],
                }
            )
        errors = exc_info.value.errors
        assert len(errors) >= 2
        assert any("rules/0" in e.path for e in errors)
        assert "Invalid policy document" in str(exc_info.value)

    def test_reports_all_errors(self) -> None:
        with pytest.raises(PolicySchemaError) as exc_info:
            validate_policy_ir({})
        assert len(exc_info.value.errors) >= 2


class TestPathFormatting:
    """Verify path formatting preserves parent property names for parity with TS SDK."""

    def test_includes_parent_property_names(self) -> None:
        """Paths should be /rules/0 not /0."""
        with pytest.raises(PolicySchemaError) as exc_info:
            validate_policy_ir(
                {
                    "version": "1.0",
                    "rules": [{"name": "missing-required-fields"}],
                }
            )
        errors = exc_info.value.errors
        paths = [e.path for e in errors]
        # Paths must include 'rules' parent property
        assert any(p.startswith("/rules/0") for p in paths)
        # Should not have paths like '/0' without parent
        import re

        assert all(not re.match(r"^/\d+$", p) for p in paths)

    def test_nested_condition_paths(self) -> None:
        """Nested paths should include full hierarchy."""
        with pytest.raises(PolicySchemaError) as exc_info:
            validate_policy_ir(
                {
                    "version": "1.0",
                    "rules": [
                        {
                            "id": "test",
                            "name": "test",
                            "action": "block",
                            "conditions": [
                                {
                                    "field": "tool_name",
                                    "operator": "BAD_OPERATOR",
                                    "value": "x",
                                }
                            ],
                        }
                    ],
                }
            )
        errors = exc_info.value.errors
        paths = [e.path for e in errors]
        # Path should include full hierarchy: /rules/0/conditions/0/operator
        assert any("/rules/0/conditions/0" in p for p in paths)

    def test_root_level_errors_use_slash(self) -> None:
        """Root-level errors should have path '/'."""
        with pytest.raises(PolicySchemaError) as exc_info:
            validate_policy_ir({})
        errors = exc_info.value.errors
        # Missing version and rules errors are at root
        assert any(e.path == "/" for e in errors)


class TestFailSafeBehavior:
    """Verify validator never silently passes invalid data."""

    def test_never_silently_pass_invalid_data(self) -> None:
        """Various malformed inputs should always raise PolicySchemaError."""
        malformed_inputs = [
            None,
            "string",
            123,
            [],
            {"version": "1.0"},  # missing rules
            {"rules": []},  # missing version
            {"version": "2.0", "rules": []},  # wrong version
        ]

        for input_data in malformed_inputs:
            with pytest.raises(PolicySchemaError):
                validate_policy_ir(input_data)

    def test_error_structure_complete(self) -> None:
        """Each error should have path, message, and keyword."""
        with pytest.raises(PolicySchemaError) as exc_info:
            validate_policy_ir({"invalid": "data"})
        errors = exc_info.value.errors
        assert len(errors) > 0
        for err in errors:
            assert err.path is not None
            assert err.message is not None
            assert err.keyword is not None
