"""Tests for the policy test runner."""


import yaml

from veto.testing.runner import (
    load_suites,
    evaluate_test_case,
    normalize_expected_decision,
    run_tests,
)
from veto.testing.types import TestExpect, VetoTestCase


class TestNormalizeExpectedDecision:
    def test_block_to_deny(self):
        assert normalize_expected_decision("block") == "deny"

    def test_deny_stays_deny(self):
        assert normalize_expected_decision("deny") == "deny"

    def test_warn_to_allow(self):
        assert normalize_expected_decision("warn") == "allow"

    def test_log_to_allow(self):
        assert normalize_expected_decision("log") == "allow"

    def test_allow_stays_allow(self):
        assert normalize_expected_decision("allow") == "allow"

    def test_require_approval_passthrough(self):
        assert normalize_expected_decision("require_approval") == "require_approval"


class TestLoadSuites:
    def test_valid_fixture(self, tmp_path):
        fixture = {
            "suite": "Test Suite",
            "tests": [
                {
                    "id": "test-1",
                    "tool": "read_file",
                    "arguments": {"path": "/etc/passwd"},
                    "expect": {"decision": "deny"},
                }
            ],
        }
        f = tmp_path / "test.yaml"
        f.write_text(yaml.dump(fixture))

        suites, errors = load_suites(str(tmp_path))
        assert len(errors) == 0
        assert len(suites) == 1
        assert suites[0].suite == "Test Suite"
        assert len(suites[0].tests) == 1
        assert suites[0].tests[0].id == "test-1"

    def test_missing_path(self, tmp_path):
        suites, errors = load_suites(str(tmp_path / "nonexistent"))
        assert len(suites) == 0
        assert len(errors) == 1
        assert "not found" in errors[0]

    def test_invalid_format(self, tmp_path):
        f = tmp_path / "bad.yaml"
        f.write_text("just a string")

        suites, errors = load_suites(str(tmp_path))
        assert len(suites) == 0
        assert len(errors) == 1
        assert "Invalid fixture format" in errors[0]

    def test_single_file(self, tmp_path):
        fixture = {
            "suite": "Single",
            "tests": [
                {
                    "id": "t1",
                    "tool": "tool_a",
                    "arguments": {},
                    "expect": {"decision": "allow"},
                }
            ],
        }
        f = tmp_path / "single.yaml"
        f.write_text(yaml.dump(fixture))

        suites, errors = load_suites(str(f))
        assert len(errors) == 0
        assert len(suites) == 1


class TestEvaluateTestCase:
    def test_matching_rule_denies(self):
        rules = [
            {
                "id": "block-passwd",
                "tools": ["read_file"],
                "action": "block",
                "conditions": [
                    {"field": "path", "operator": "contains", "value": "/etc/passwd"}
                ],
            }
        ]
        tc = VetoTestCase(
            id="t1",
            tool="read_file",
            arguments={"path": "/etc/passwd"},
            expect=TestExpect(decision="deny"),
        )
        decision, rule_id = evaluate_test_case(rules, tc)
        assert decision == "deny"
        assert rule_id == "block-passwd"

    def test_no_matching_rule_allows(self):
        rules = [
            {
                "id": "block-passwd",
                "tools": ["read_file"],
                "action": "block",
                "conditions": [
                    {"field": "path", "operator": "contains", "value": "/etc/passwd"}
                ],
            }
        ]
        tc = VetoTestCase(
            id="t2",
            tool="read_file",
            arguments={"path": "/tmp/safe.txt"},
            expect=TestExpect(decision="allow"),
        )
        decision, rule_id = evaluate_test_case(rules, tc)
        assert decision == "allow"
        assert rule_id is None

    def test_disabled_rule_skipped(self):
        rules = [
            {
                "id": "disabled-rule",
                "tools": ["read_file"],
                "action": "block",
                "enabled": False,
            }
        ]
        tc = VetoTestCase(
            id="t3",
            tool="read_file",
            arguments={},
            expect=TestExpect(decision="allow"),
        )
        decision, _ = evaluate_test_case(rules, tc)
        assert decision == "allow"

    def test_tool_mismatch_skipped(self):
        rules = [
            {
                "id": "r1",
                "tools": ["write_file"],
                "action": "block",
            }
        ]
        tc = VetoTestCase(
            id="t4",
            tool="read_file",
            arguments={},
            expect=TestExpect(decision="allow"),
        )
        decision, _ = evaluate_test_case(rules, tc)
        assert decision == "allow"

    def test_equals_condition(self):
        rules = [
            {
                "id": "r1",
                "tools": ["exec"],
                "action": "deny",
                "conditions": [
                    {"field": "cmd", "operator": "equals", "value": "rm"}
                ],
            }
        ]
        tc = VetoTestCase(
            id="t5",
            tool="exec",
            arguments={"cmd": "rm"},
            expect=TestExpect(decision="deny"),
        )
        decision, _ = evaluate_test_case(rules, tc)
        assert decision == "deny"

    def test_context_field_lookup(self):
        rules = [
            {
                "id": "r1",
                "tools": ["exec"],
                "action": "deny",
                "conditions": [
                    {"field": "env", "operator": "equals", "value": "production"}
                ],
            }
        ]
        tc = VetoTestCase(
            id="t6",
            tool="exec",
            arguments={},
            expect=TestExpect(decision="deny"),
            context={"env": "production"},
        )
        decision, _ = evaluate_test_case(rules, tc)
        assert decision == "deny"


class TestRunTests:
    def test_end_to_end(self, tmp_path):
        # Create policy
        policy_dir = tmp_path / "policy" / "rules"
        policy_dir.mkdir(parents=True)
        rules_file = policy_dir / "rules.yaml"
        rules_file.write_text(
            yaml.dump(
                {
                    "rules": [
                        {
                            "id": "block-dangerous",
                            "tools": ["delete_file"],
                            "action": "block",
                        }
                    ]
                }
            )
        )

        # Create fixtures
        fixtures_dir = tmp_path / "tests"
        fixtures_dir.mkdir()
        fixture_file = fixtures_dir / "suite.yaml"
        fixture_file.write_text(
            yaml.dump(
                {
                    "suite": "Basic",
                    "tests": [
                        {
                            "id": "t1",
                            "tool": "delete_file",
                            "arguments": {},
                            "description": "should deny delete",
                            "expect": {
                                "decision": "deny",
                                "rule_id": "block-dangerous",
                            },
                        },
                        {
                            "id": "t2",
                            "tool": "read_file",
                            "arguments": {},
                            "description": "should allow read",
                            "expect": {"decision": "allow"},
                        },
                    ],
                }
            )
        )

        result = run_tests(
            fixtures_path=str(fixtures_dir),
            policy_path=str(tmp_path / "policy"),
            quiet=True,
        )
        assert result.total == 2
        assert result.passed == 2
        assert result.failed == 0
