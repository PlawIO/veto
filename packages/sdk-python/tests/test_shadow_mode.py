"""Tests for true shadow mode behavior."""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from veto import Veto, VetoOptions
from veto.deterministic.types import ArgumentConstraint, DeterministicPolicy
from veto.types.tool import ToolCall


def _block_rule() -> dict[str, object]:
    return {
        "id": "shadow-block",
        "name": "Shadow Block",
        "enabled": True,
        "severity": "high",
        "action": "block",
        "tools": ["transfer_funds"],
        "conditions": [
            {
                "field": "arguments.amount",
                "operator": "greater_than",
                "value": 1000,
            }
        ],
    }


def _approval_rule() -> dict[str, object]:
    return {
        "id": "shadow-approval",
        "name": "Shadow Approval",
        "enabled": True,
        "severity": "critical",
        "action": "require_approval",
        "tools": ["deploy"],
        "conditions": [
            {
                "field": "arguments.env",
                "operator": "equals",
                "value": "prod",
            }
        ],
    }


@dataclass
class MockTool:
    name: str
    response: str
    calls: int = 0

    async def handler(self, args: dict[str, object]) -> str:
        _ = args
        self.calls += 1
        return self.response


class TestShadowMode:
    async def test_shadow_wrap_allows_blocked_call_and_preserves_real_deny(self) -> None:
        tool = MockTool("transfer_funds", "executed")
        veto = Veto.from_rules(
            rules=[_block_rule()],
            mode="shadow",
            log_level="silent",
        )

        validation = await veto.validate_tool_call(
            ToolCall(
                id="call-shadow-1",
                name="transfer_funds",
                arguments={"amount": 5000},
            )
        )
        assert validation.allowed is True
        assert validation.validation_result.decision == "deny"
        assert validation.validation_result.metadata is not None
        assert validation.validation_result.metadata.get("shadow") is True
        assert validation.validation_result.metadata.get("shadow_decision") == "deny"
        assert validation.validation_result.metadata.get("shadow_rule_id") == "shadow-block"

        wrapped = veto.wrap([tool])
        result = await wrapped[0].handler({"amount": 5000})
        assert result == "executed"
        assert tool.calls == 1

    async def test_shadow_wrap_allows_require_approval_without_blocking(self) -> None:
        tool = MockTool("deploy", "deployed")
        veto = Veto.from_rules(
            rules=[_approval_rule()],
            mode="shadow",
            log_level="silent",
        )

        validation = await veto.validate_tool_call(
            ToolCall(
                id="call-shadow-2",
                name="deploy",
                arguments={"env": "prod"},
            )
        )
        assert validation.allowed is True
        assert validation.validation_result.decision == "require_approval"
        assert validation.validation_result.metadata is not None
        assert (
            validation.validation_result.metadata.get("shadow_decision")
            == "require_approval"
        )
        assert (
            validation.validation_result.metadata.get("shadow_rule_id")
            == "shadow-approval"
        )

        wrapped = veto.wrap([tool])
        result = await wrapped[0].handler({"env": "prod"})
        assert result == "deployed"
        assert tool.calls == 1

    async def test_guard_in_shadow_returns_real_decision_and_shadow_flags(self) -> None:
        veto = Veto.from_rules(
            rules=[_block_rule()],
            mode="shadow",
            log_level="silent",
        )

        result = await veto.guard("transfer_funds", {"amount": 5000})
        assert result.decision == "deny"
        assert result.shadow is True
        assert result.shadow_decision == "deny"

    async def test_shadow_stderr_output_is_formatted(self, capsys: pytest.CaptureFixture[str]) -> None:
        veto = Veto.from_rules(
            rules=[_block_rule()],
            mode="shadow",
            log_level="warn",
        )

        await veto.validate_tool_call(
            ToolCall(
                id="call-shadow-3",
                name="transfer_funds",
                arguments={"amount": 5000},
            )
        )

        captured = capsys.readouterr()
        assert "[shadow]" in captured.err
        assert "WOULD BE DENIED" in captured.err
        assert "transfer_funds(" in captured.err

    async def test_shadow_stderr_is_suppressed_when_log_level_is_silent(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        veto = Veto.from_rules(
            rules=[_block_rule()],
            mode="shadow",
            log_level="silent",
        )

        await veto.validate_tool_call(
            ToolCall(
                id="call-shadow-4",
                name="transfer_funds",
                arguments={"amount": 5000},
            )
        )

        captured = capsys.readouterr()
        assert captured.err == ""

    async def test_webhook_event_includes_shadow_true(self, tmp_path: Path) -> None:
        veto_dir = tmp_path / "veto"
        rules_dir = veto_dir / "rules"
        rules_dir.mkdir(parents=True, exist_ok=True)

        (veto_dir / "veto.config.yaml").write_text(
            (
                'version: "1.0"\n'
                'mode: "shadow"\n'
                "validation:\n"
                '  mode: "local"\n'
                "logging:\n"
                '  level: "silent"\n'
                "rules:\n"
                '  directory: "./rules"\n'
                "events:\n"
                "  webhook:\n"
                '    url: "https://hooks.example.com/veto"\n'
                '    on: ["deny"]\n'
                '    min_severity: "info"\n'
                '    format: "generic"\n'
            ),
            encoding="utf-8",
        )
        (rules_dir / "rules.yaml").write_text(
            (
                'version: "1.0"\n'
                "name: shadow-rules\n"
                "rules:\n"
                "  - id: shadow-block\n"
                "    name: Shadow Block\n"
                "    enabled: true\n"
                "    severity: high\n"
                "    action: block\n"
                "    tools: [transfer_funds]\n"
                "    conditions:\n"
                "      - field: arguments.amount\n"
                "        operator: greater_than\n"
                "        value: 1000\n"
            ),
            encoding="utf-8",
        )

        veto = await Veto.init(VetoOptions(config_dir=str(veto_dir), log_level="silent"))
        sent: list[tuple[str, bytes, str]] = []

        async def fake_send_async(url: str, body: bytes, content_type: str) -> int:
            sent.append((url, body, content_type))
            return 202

        setattr(veto._event_webhook_emitter, "_send_async", fake_send_async)

        result = await veto.guard("transfer_funds", {"amount": 5000})
        assert result.decision == "deny"

        await asyncio.sleep(0)
        assert len(sent) == 1
        payload = json.loads(sent[0][1].decode("utf-8"))
        assert payload["event_type"] == "deny"
        assert payload["shadow"] is True

    async def test_from_rules_uses_veto_mode_env_when_mode_omitted(self) -> None:
        previous_mode = os.environ.get("VETO_MODE")
        os.environ["VETO_MODE"] = "shadow"

        try:
            veto = Veto.from_rules(
                rules=[_block_rule()],
                log_level="silent",
            )
            result = await veto.guard("transfer_funds", {"amount": 5000})
            assert result.shadow is True
            assert result.shadow_decision == "deny"
        finally:
            if previous_mode is None:
                os.environ.pop("VETO_MODE", None)
            else:
                os.environ["VETO_MODE"] = previous_mode

    async def test_shadow_decision_logs_include_shadow_context_for_dashboard(self) -> None:
        veto = await Veto.init(
            VetoOptions(
                api_key="test-key",
                mode="shadow",
                log_level="silent",
            )
        )

        policy = DeterministicPolicy(
            tool_name="transfer_funds",
            mode="deterministic",
            constraints=[
                ArgumentConstraint(
                    argument_name="amount",
                    less_than_or_equal=1000,
                )
            ],
            has_session_constraints=False,
            has_rate_limits=False,
            version=1,
            fetched_at=0.0,
        )

        veto._policy_cache.get = MagicMock(return_value=policy)
        veto._cloud_client.log_decision = MagicMock()
        veto._cloud_client.validate = AsyncMock()

        await veto.guard("transfer_funds", {"amount": 5000})

        assert veto._cloud_client.log_decision.call_count == 1
        payload = veto._cloud_client.log_decision.call_args.args[0]
        assert payload["context"]["shadow"] is True
        assert payload["context"]["shadow_decision"] == "deny"
