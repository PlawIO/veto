"""
Tests for output validation and redaction.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from veto import Veto, VetoOptions
from veto.cloud.client import VetoCloudClient
from veto.cloud.policy_cache import PolicyCache
from veto.cloud.types import ValidationResponse


def _write_config(veto_dir: Path) -> None:
    (veto_dir / "rules").mkdir(parents=True, exist_ok=True)
    (veto_dir / "veto.config.yaml").write_text(
        """
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
logging:
  level: "silent"
rules:
  directory: "./rules"
  recursive: true
""",
        encoding="utf-8",
    )


def _mock_cloud_client() -> MagicMock:
    client = MagicMock(spec=VetoCloudClient)
    client._base_url = "https://api.runveto.com"
    client._api_key = "test-key"
    client.register_tools = AsyncMock(return_value=MagicMock(success=True, registered_tools=[]))
    client.validate = AsyncMock(
        return_value=ValidationResponse(decision="allow", reason="allowed")
    )
    client.fetch_policy = AsyncMock(return_value=None)
    return client


async def _init_veto(veto_dir: Path, policy: str) -> Veto:
    _write_config(veto_dir)
    (veto_dir / "rules" / "policy.yaml").write_text(policy, encoding="utf-8")

    veto = await Veto.init(
        VetoOptions(
            api_key="test-key",
            log_level="silent",
            config_dir=str(veto_dir),
        )
    )

    mock_client = _mock_cloud_client()
    veto._cloud_client = mock_client
    veto._policy_cache = PolicyCache(mock_client)
    return veto


class TestOutputValidation:
    async def test_standalone_redaction(self, tmp_path: Path) -> None:
        veto = await _init_veto(
            tmp_path / "veto",
            """
version: "1.0"
rules: []
output_rules:
  - id: redact-email
    name: Redact email
    enabled: true
    action: redact
    tools: [profile_tool]
    output_conditions:
      - field: output.user.contact.email
        operator: matches
        value: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\\\.[A-Za-z]{2,}"
    redact_with: "[EMAIL]"
""",
        )

        result = veto.validate_output(
            "profile_tool",
            {
                "user": {
                    "contact": {
                        "email": "alice@example.com",
                    }
                }
            },
        )

        assert result.decision == "allow"
        assert result.redactions == 1
        assert result.output["user"]["contact"]["email"] == "[EMAIL]"

    async def test_standalone_block(self, tmp_path: Path) -> None:
        veto = await _init_veto(
            tmp_path / "veto",
            """
version: "1.0"
rules: []
output_rules:
  - id: block-secret
    name: Block secret output
    enabled: true
    action: block
    tools: [report_tool]
    description: Secret output blocked
    output_conditions:
      - field: output.message
        operator: contains
        value: SECRET
""",
        )

        result = veto.validate_output(
            "report_tool",
            {"message": "contains SECRET data"},
        )

        assert result.decision == "block"
        assert result.reason == "Secret output blocked"

    async def test_block_precedence_over_redact(self, tmp_path: Path) -> None:
        veto = await _init_veto(
            tmp_path / "veto",
            """
version: "1.0"
rules: []
output_rules:
  - id: redact-card
    name: Redact card
    enabled: true
    action: redact
    tools: [billing_tool]
    output_conditions:
      - field: output.card
        operator: matches
        value: "\\\\d{16}"
    redact_with: "[CARD]"
  - id: block-card
    name: Block card
    enabled: true
    action: block
    tools: [billing_tool]
    output_conditions:
      - field: output.card
        operator: matches
        value: "\\\\d{16}"
""",
        )

        result = veto.validate_output(
            "billing_tool",
            {"card": "4242424242424242"},
        )

        assert result.decision == "block"
        assert result.redactions == 0

    async def test_unsafe_regex_rejected(self, tmp_path: Path) -> None:
        veto = await _init_veto(
            tmp_path / "veto",
            """
version: "1.0"
rules: []
output_rules:
  - id: unsafe-block
    name: Unsafe block
    enabled: true
    action: block
    tools: [unsafe_tool]
    output_conditions:
      - field: output.value
        operator: matches
        value: "(a+)+"
""",
        )

        result = veto.validate_output(
            "unsafe_tool",
            {"value": "aaaaaaaa"},
        )

        assert result.decision == "allow"
        assert result.matched_rule_ids == []

    async def test_tool_filtering(self, tmp_path: Path) -> None:
        veto = await _init_veto(
            tmp_path / "veto",
            """
version: "1.0"
rules: []
output_rules:
  - id: tool-specific-redact
    name: Tool specific redact
    enabled: true
    action: redact
    tools: [tool_a]
    output_conditions:
      - field: output.email
        operator: matches
        value: "[^@]+@[^@]+"
    redact_with: "[MASKED]"
""",
        )

        result = veto.validate_output(
            "tool_b",
            {"email": "alice@example.com"},
        )

        assert result.decision == "allow"
        assert result.output["email"] == "alice@example.com"
        assert result.matched_rule_ids == []

    async def test_wrap_redacts_output(self, tmp_path: Path) -> None:
        veto = await _init_veto(
            tmp_path / "veto",
            """
version: "1.0"
rules: []
output_rules:
  - id: wrap-redact
    name: Wrap redaction
    enabled: true
    action: redact
    tools: [get_profile]
    output_conditions:
      - field: output.email
        operator: matches
        value: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\\\.[A-Za-z]{2,}"
    redact_with: "[EMAIL]"
""",
        )

        class MockTool:
            name = "get_profile"
            description = "profile tool"

            async def handler(self, args):  # type: ignore[no-untyped-def]
                _ = args
                return {"email": "alice@example.com"}

        wrapped = veto.wrap([MockTool()])
        result = await wrapped[0].handler({})
        assert result["email"] == "[EMAIL]"

    async def test_wrap_blocks_output(self, tmp_path: Path) -> None:
        veto = await _init_veto(
            tmp_path / "veto",
            """
version: "1.0"
rules: []
output_rules:
  - id: wrap-block
    name: Wrap block
    enabled: true
    action: block
    tools: [get_secret]
    description: Output blocked by policy
    output_conditions:
      - field: output.secret
        operator: contains
        value: token
""",
        )

        class MockTool:
            name = "get_secret"
            description = "secret tool"

            async def handler(self, args):  # type: ignore[no-untyped-def]
                _ = args
                return {"secret": "api-token-123"}

        wrapped = veto.wrap([MockTool()])
        with pytest.raises(RuntimeError, match="Output blocked by policy"):
            await wrapped[0].handler({})
