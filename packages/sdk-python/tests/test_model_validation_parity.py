from __future__ import annotations

from pathlib import Path

import pytest

from veto import (
    KernelResponse,
    Veto,
    VetoOptions,
    buildPrompt,
    buildProviderMessages,
    parse_kernel_response,
)


RULE = {
    "id": "model-rule",
    "name": "Model Rule",
    "enabled": True,
    "action": "block",
    "tools": ["model_tool"],
}


class MockModelClient:
    def __init__(self, response: dict) -> None:
        self.response = response
        self.calls: list[tuple[dict, list[dict]]] = []

    async def evaluate(self, tool_call: dict, rules: list[dict]) -> dict:
        self.calls.append((tool_call, rules))
        return self.response


def test_kernel_prompt_and_response_parser_match_ts_shape() -> None:
    prompt = buildPrompt({"tool": "model_tool", "arguments": {"path": "/tmp"}}, [RULE])

    assert "TOOL CALL:" in prompt
    assert "RULES:" in prompt
    assert "tool: model_tool" in prompt

    parsed = parse_kernel_response(
        'extra {"pass_weight": 0.1, "block_weight": 0.9, '
        '"decision": "block", "reasoning": "bad", "matched_rules": ["r1"]}'
    )
    assert parsed == KernelResponse(
        pass_weight=0.1,
        block_weight=0.9,
        decision="block",
        reasoning="bad",
        matched_rules=["r1"],
    )


def test_custom_provider_messages_match_provider_shapes() -> None:
    openai = buildProviderMessages("openai", "hello")
    anthropic = buildProviderMessages("anthropic", "hello")
    gemini = buildProviderMessages("gemini", "hello")

    assert openai["messages"][0]["role"] == "system"
    assert anthropic["system"]
    assert gemini["contents"][0]["parts"][0]["text"].endswith("hello")


@pytest.mark.asyncio
async def test_kernel_mode_uses_injected_client() -> None:
    client = MockModelClient(
        {
            "decision": "block",
            "reasoning": "Kernel blocked",
            "block_weight": 1.0,
            "pass_weight": 0.0,
            "matched_rules": ["model-rule"],
        }
    )
    veto = Veto.from_rules(
        rules=[RULE],
        log_level="silent",
        validation_mode="kernel",
        kernel_client=client,
    )

    result = await veto.guard("model_tool", {})

    assert result.decision == "deny"
    assert result.reason == "Kernel blocked"
    assert client.calls[0][0] == {"tool": "model_tool", "arguments": {}}


@pytest.mark.asyncio
async def test_custom_mode_uses_injected_client_and_log_mode_allows() -> None:
    client = MockModelClient(
        {
            "decision": "block",
            "reasoning": "Custom blocked",
            "block_weight": 1.0,
            "pass_weight": 0.0,
        }
    )
    veto = Veto.from_rules(
        rules=[RULE],
        log_level="silent",
        mode="log",
        validation_mode="custom",
        custom_client=client,
    )

    result = await veto.guard("model_tool", {})

    assert result.decision == "allow"
    assert result.reason == "[LOG MODE] Would block: Custom blocked"
    assert client.calls


@pytest.mark.asyncio
async def test_custom_config_errors_fail_closed_in_strict_mode(tmp_path: Path) -> None:
    veto_dir = tmp_path / "veto"
    rules_dir = veto_dir / "rules"
    rules_dir.mkdir(parents=True)
    (veto_dir / "veto.config.yaml").write_text(
        """version: "1.0"
mode: "strict"
validation:
  mode: "custom"
logging:
  level: "silent"
rules:
  directory: "./rules"
custom:
  model: "gpt-test"
""",
        encoding="utf-8",
    )
    (rules_dir / "rules.yaml").write_text(
        """version: "1.0"
rules:
  - id: model-rule
    name: Model Rule
    action: block
    tools: [model_tool]
""",
        encoding="utf-8",
    )

    veto = await Veto.init(VetoOptions(config_dir=str(veto_dir)))
    result = await veto.guard("model_tool", {})

    assert result.decision == "deny"
    assert "custom.provider" in (result.reason or "")

