"""Tests for top-level protect() API."""

from __future__ import annotations

import importlib
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from veto import ToolCallDeniedError, protect

protect_module = importlib.import_module("veto.core.protect")


class MockTool:
    def __init__(self, name: str, response: str = "ok"):
        self.name = name
        self.response = response
        self.calls = 0

    async def handler(self, args: dict[str, object]) -> str:
        _ = args
        self.calls += 1
        return self.response


class FakeVeto:
    def wrap(self, tools: list[MockTool]) -> list[MockTool]:
        return tools

    def wrap_tool(self, tool: MockTool) -> MockTool:
        return tool


@pytest.fixture(autouse=True)
def _reset_protect_cache() -> None:
    protect_module._reset_protect_cache_for_tests()
    yield
    protect_module._reset_protect_cache_for_tests()


@pytest.fixture
def isolated_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _amount_block_rule(tool_name: str) -> dict[str, object]:
    return {
        "id": f"block-{tool_name}",
        "name": f"Block {tool_name}",
        "enabled": True,
        "severity": "high",
        "action": "block",
        "tools": [tool_name],
        "conditions": [
            {
                "field": "arguments.amount",
                "operator": "greater_than",
                "value": 1000,
            }
        ],
    }


async def test_protect_wraps_arrays(isolated_cwd):
    _ = isolated_cwd
    tools = [MockTool("tool_a", "a"), MockTool("tool_b", "b")]

    wrapped = await protect(tools, rules=[], log_level="silent")

    assert isinstance(wrapped, list)
    assert len(wrapped) == 2
    assert await wrapped[0].handler({}) == "a"
    assert await wrapped[1].handler({}) == "b"


async def test_protect_wraps_single_tool(isolated_cwd):
    _ = isolated_cwd
    tool = MockTool("single_tool", "single")

    wrapped = await protect(tool, rules=[], log_level="silent")

    assert isinstance(wrapped, MockTool)
    assert await wrapped.handler({}) == "single"


async def test_protect_pack_uses_financial_rules(isolated_cwd):
    _ = isolated_cwd
    tool = MockTool("transfer_funds")

    wrapped = await protect([tool], pack="financial", mode="strict", log_level="silent")

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler({"amount": 15000, "currency": "USD"})


async def test_protect_api_key_uses_init_path(isolated_cwd, monkeypatch: pytest.MonkeyPatch):
    _ = isolated_cwd
    tool = MockTool("cloud_tool")
    init_mock = AsyncMock(return_value=FakeVeto())
    monkeypatch.setattr(protect_module.Veto, "init", init_mock)

    await protect([tool], api_key="veto_xxx", log_level="silent")

    init_mock.assert_awaited_once()


async def test_protect_rules_uses_from_rules(isolated_cwd, monkeypatch: pytest.MonkeyPatch):
    _ = isolated_cwd
    tool = MockTool("transfer_funds")
    from_rules_mock = MagicMock(return_value=FakeVeto())
    monkeypatch.setattr(protect_module.Veto, "from_rules", from_rules_mock)

    await protect([tool], rules=[_amount_block_rule("transfer_funds")], log_level="silent")

    assert from_rules_mock.call_count == 1


async def test_protect_stream_options_map_to_decision_stream_logger(
    isolated_cwd, monkeypatch: pytest.MonkeyPatch
):
    _ = isolated_cwd
    tool = MockTool("stream_tool")
    from_rules_mock = MagicMock(return_value=FakeVeto())
    monkeypatch.setattr(protect_module.Veto, "from_rules", from_rules_mock)

    await protect(
        [tool],
        rules=[],
        stream=True,
        stream_mode="verbose",
        log_level="silent",
    )

    assert from_rules_mock.call_count == 1
    assert from_rules_mock.call_args.kwargs["log_level"] == "stream"
    assert from_rules_mock.call_args.kwargs["stream_mode"] == "verbose"


async def test_protect_init_path_receives_decision_stream_settings(
    isolated_cwd, monkeypatch: pytest.MonkeyPatch
):
    _ = isolated_cwd
    tool = MockTool("cloud_tool")
    init_mock = AsyncMock(return_value=FakeVeto())
    monkeypatch.setattr(protect_module.Veto, "init", init_mock)

    await protect(
        [tool],
        api_key="veto_xxx",
        stream=True,
        stream_mode="verbose",
        log_level="silent",
    )

    init_mock.assert_awaited_once()
    veto_options = init_mock.await_args.args[0]
    assert veto_options.api_key == "veto_xxx"
    assert veto_options.log_level == "stream"
    assert veto_options.stream_mode == "verbose"


async def test_protect_log_mode_allows(isolated_cwd):
    _ = isolated_cwd
    tool = MockTool("transfer_funds", "executed")

    wrapped = await protect(
        [tool],
        rules=[_amount_block_rule("transfer_funds")],
        mode="log",
        log_level="silent",
    )

    assert await wrapped[0].handler({"amount": 2000}) == "executed"


async def test_protect_passes_shadow_mode_through_without_aliasing(
    isolated_cwd, monkeypatch: pytest.MonkeyPatch
):
    _ = isolated_cwd
    tool = MockTool("transfer_funds")
    from_rules_mock = MagicMock(return_value=FakeVeto())
    monkeypatch.setattr(protect_module.Veto, "from_rules", from_rules_mock)

    await protect(
        [tool],
        rules=[],
        mode="shadow",
        log_level="silent",
    )

    assert from_rules_mock.call_count == 1
    assert from_rules_mock.call_args.kwargs["mode"] == "shadow"


async def test_protect_heuristics_detect_financial_pack(isolated_cwd):
    _ = isolated_cwd
    tool = MockTool("transfer_funds")

    wrapped = await protect([tool], log_level="silent")

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler({"amount": 15000, "currency": "USD"})


async def test_protect_heuristics_detect_browser_pack(isolated_cwd):
    _ = isolated_cwd
    tool = MockTool("navigate")

    wrapped = await protect([tool], log_level="silent")

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler({"url": "javascript:alert(1)"})


async def test_protect_no_pattern_falls_back_to_allow_all(isolated_cwd):
    _ = isolated_cwd
    tool = MockTool("unknown_tool", "allowed")

    wrapped = await protect([tool], log_level="silent")

    assert await wrapped[0].handler({"anything": True}) == "allowed"


async def test_protect_reuses_cache_for_identical_options(
    isolated_cwd, monkeypatch: pytest.MonkeyPatch
):
    _ = isolated_cwd
    tool = MockTool("cached_tool")
    from_rules_mock = MagicMock(return_value=FakeVeto())
    monkeypatch.setattr(protect_module.Veto, "from_rules", from_rules_mock)

    await protect([tool], rules=[], log_level="silent")
    await protect([tool], rules=[], log_level="silent")

    assert from_rules_mock.call_count == 1


async def test_protect_creates_new_instance_when_decision_stream_settings_change(
    isolated_cwd, monkeypatch: pytest.MonkeyPatch
):
    _ = isolated_cwd
    tool = MockTool("cached_tool")
    from_rules_mock = MagicMock(return_value=FakeVeto())
    monkeypatch.setattr(protect_module.Veto, "from_rules", from_rules_mock)

    await protect([tool], rules=[], log_level="silent")
    await protect([tool], rules=[], stream=True, stream_mode="verbose", log_level="silent")

    assert from_rules_mock.call_count == 2


async def test_wrapped_tool_validates_before_execution_and_throws_on_deny(isolated_cwd):
    _ = isolated_cwd
    tool = MockTool("transfer_funds", "should-not-run")

    wrapped = await protect(
        [tool],
        rules=[_amount_block_rule("transfer_funds")],
        mode="strict",
        log_level="silent",
    )

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler({"amount": 5000})

    assert tool.calls == 0


async def test_protect_accepts_budget_and_costs_kwargs(isolated_cwd):
    _ = isolated_cwd
    tool = MockTool("budget_tool", "ok")

    wrapped = await protect(
        [tool],
        rules=[],
        budget={"max": 25, "currency": "USD"},
        costs={"budget_tool": 2},
        log_level="silent",
    )

    assert await wrapped[0].handler({}) == "ok"
