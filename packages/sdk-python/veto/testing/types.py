from dataclasses import dataclass, field
from typing import Literal, Optional


@dataclass
class TestExpect:
    decision: Literal["allow", "deny", "block", "warn", "log", "require_approval"]
    rule_id: Optional[str] = None


@dataclass
class VetoTestCase:
    id: str
    tool: str
    arguments: dict
    expect: TestExpect
    description: Optional[str] = None
    context: Optional[dict] = None


@dataclass
class VetoTestSuite:
    suite: str
    tests: list[VetoTestCase]


@dataclass
class VetoTestResult:
    test_id: str
    suite: str
    passed: bool
    expected: TestExpect
    actual_decision: str
    actual_rule_id: Optional[str] = None
    error: Optional[str] = None


@dataclass
class VetoTestRunResult:
    total: int
    passed: int
    failed: int
    results: list[VetoTestResult] = field(default_factory=list)
