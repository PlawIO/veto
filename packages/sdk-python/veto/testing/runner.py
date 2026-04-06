"""
Policy unit testing framework.

Reads YAML fixture files and evaluates each test case against rules
loaded from policy YAML files (no LLM, no network).
"""

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from veto.testing.types import (
    TestExpect,
    VetoTestCase,
    VetoTestResult,
    VetoTestRunResult,
    VetoTestSuite,
)


def normalize_expected_decision(expected: str) -> str:
    """Normalize fixture expectations to match engine output.

    block/deny -> deny, warn/log -> allow (non-blocking).
    """
    if expected in ("block", "deny"):
        return "deny"
    if expected in ("warn", "log"):
        return "allow"
    return expected


def load_suites(fixtures_path: str) -> tuple[list[VetoTestSuite], list[str]]:
    """Load test suites from YAML files."""
    suites: list[VetoTestSuite] = []
    errors: list[str] = []
    path = Path(fixtures_path).resolve()

    if not path.exists():
        errors.append(f"Fixture path not found: {path}")
        return suites, errors

    files: list[Path] = []
    if path.is_file():
        files = [path]
    else:
        files = sorted(path.rglob("*.yaml")) + sorted(path.rglob("*.yml"))
        if not files:
            errors.append(f"No YAML fixture files found in: {path}")

    for f in files:
        try:
            content = f.read_text()
            parsed = yaml.safe_load(content)
        except Exception as e:
            errors.append(f"Error loading {f}: {e}")
            continue

        if not isinstance(parsed, dict) or "suite" not in parsed or "tests" not in parsed:
            errors.append(f"Invalid fixture format in {f}")
            continue

        test_cases: list[VetoTestCase] = []
        for tc in parsed["tests"]:
            expect_data = tc.get("expect", {})
            test_cases.append(
                VetoTestCase(
                    id=tc["id"],
                    tool=tc["tool"],
                    arguments=tc.get("arguments", {}),
                    expect=TestExpect(
                        decision=expect_data.get("decision", "allow"),
                        rule_id=expect_data.get("rule_id"),
                    ),
                    description=tc.get("description"),
                    context=tc.get("context"),
                )
            )
        suites.append(VetoTestSuite(suite=parsed["suite"], tests=test_cases))

    return suites, errors


def load_rules(policy_path: str) -> List[Dict[str, Any]]:
    """Load rules from policy YAML files."""
    rules: List[Dict[str, Any]] = []
    path = Path(policy_path).resolve()

    if path.is_file():
        files = [path]
    elif path.is_dir():
        rules_dir = path / "rules"
        if rules_dir.is_dir():
            files = sorted(rules_dir.rglob("*.yaml")) + sorted(rules_dir.rglob("*.yml"))
        else:
            files = sorted(path.rglob("*.yaml")) + sorted(path.rglob("*.yml"))
    else:
        return rules

    for f in files:
        try:
            parsed = yaml.safe_load(f.read_text())
            if isinstance(parsed, dict) and "rules" in parsed:
                rules.extend(parsed["rules"])
        except Exception:
            continue

    return rules


def evaluate_test_case(
    rules: List[Dict[str, Any]], test_case: VetoTestCase
) -> Tuple[str, Optional[str]]:
    """Evaluate a test case against rules. Returns (decision, rule_id)."""
    for rule in rules:
        if not rule.get("enabled", True):
            continue

        rule_tools = rule.get("tools", [])
        if rule_tools and test_case.tool not in rule_tools:
            continue

        conditions = rule.get("conditions", [])
        if conditions and not _evaluate_conditions(conditions, test_case):
            continue

        action = rule.get("action", "allow")
        rule_id = rule.get("id")

        if action in ("block", "deny"):
            return "deny", rule_id
        elif action == "allow":
            return "allow", rule_id
        elif action in ("warn", "log"):
            return "allow", rule_id
        elif action == "require_approval":
            return "require_approval", rule_id

    return "allow", None


def _evaluate_conditions(conditions: List[Dict[str, Any]], test_case: VetoTestCase) -> bool:
    """Simplified condition evaluator for test fixtures."""
    for cond in conditions:
        field = cond.get("field", "")
        operator = cond.get("operator", "")
        value = cond.get("value")

        if field.startswith("arguments."):
            actual = test_case.arguments.get(field[len("arguments."):])
        elif field.startswith("context."):
            actual = (test_case.context or {}).get(field[len("context."):])
        else:
            actual = test_case.arguments.get(field)
            if actual is None and test_case.context:
                actual = test_case.context.get(field)

        if operator == "equals" and actual != value:
            return False
        elif operator == "not_equals" and actual == value:
            return False
        elif operator == "contains" and (actual is None or str(value) not in str(actual)):
            return False
        elif operator == "greater_than" and (actual is None or value is None or float(actual) <= float(value)):
            return False
        elif operator == "less_than" and (actual is None or value is None or float(actual) >= float(value)):
            return False
        elif operator == "in" and actual not in (value if isinstance(value, list) else [value]):
            return False
        elif operator == "not_in" and actual in (value if isinstance(value, list) else [value]):
            return False
        elif operator == "exists" and actual is None:
            return False
        elif operator == "not_exists" and actual is not None:
            return False

    return True


def run_tests(
    fixtures_path: str = "./veto/tests",
    policy_path: str = "./veto",
    coverage: bool = False,
    quiet: bool = False,
) -> VetoTestRunResult:
    """Run policy unit tests from YAML fixtures."""
    suites, load_errors = load_suites(fixtures_path)

    if load_errors and not quiet:
        for err in load_errors:
            print(f"  Error: {err}")

    rules = load_rules(policy_path)
    results: list[VetoTestResult] = []

    for suite in suites:
        if not quiet:
            print(f"\n{suite.suite}")

        for tc in suite.tests:
            actual_decision, actual_rule_id = evaluate_test_case(rules, tc)
            normalized = normalize_expected_decision(tc.expect.decision)

            decision_match = actual_decision == normalized
            rule_id_match = tc.expect.rule_id is None or actual_rule_id == tc.expect.rule_id
            passed = decision_match and rule_id_match

            error = None
            if not decision_match:
                error = f"expected decision '{tc.expect.decision}' but got '{actual_decision}'"
            elif not rule_id_match:
                error = f"expected rule_id '{tc.expect.rule_id}' but got '{actual_rule_id}'"

            result = VetoTestResult(
                test_id=tc.id,
                suite=suite.suite,
                passed=passed,
                expected=tc.expect,
                actual_decision=actual_decision,
                actual_rule_id=actual_rule_id,
                error=error,
            )
            results.append(result)

            if not quiet:
                badge = "  PASS" if passed else "  FAIL"
                desc = f" -- {tc.description}" if tc.description else ""
                print(f"{badge} {tc.id}{desc}")
                if error:
                    print(f"       {error}")

    total_passed: int = sum(1 for r in results if r.passed)
    failed = len(results) - total_passed

    if not quiet:
        print(f"\nTests: {total_passed} passed" + (f", {failed} failed" if failed else ""))

    if coverage and not quiet:
        _print_coverage(rules, results)

    return VetoTestRunResult(total=len(results), passed=total_passed, failed=failed, results=results)


def _print_coverage(rules: List[Dict[str, Any]], results: List[VetoTestResult]) -> None:
    tested_ids = {r.expected.rule_id for r in results if r.expected.rule_id}
    all_ids = [r.get("id") for r in rules if r.get("id")]
    untested = [rid for rid in all_ids if rid not in tested_ids]

    print("\nCoverage:")
    print(f"  Rules with tests:    {len(tested_ids)}")
    print(f"  Rules without tests: {len(untested)}")

    if untested:
        print("\n  Untested rule IDs:")
        for rid in untested:
            print(f"    {rid}")
