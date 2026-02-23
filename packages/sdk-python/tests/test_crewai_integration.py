"""
Tests for CrewAI integration wrappers.
"""

from __future__ import annotations

import builtins
import importlib
import sys
import types
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from veto.core.interceptor import ToolCallDeniedError

MODULE_PATH = "veto.integrations.crewai.integration"
PACKAGE_PATH = "veto.integrations.crewai"


def _reset_crewai_integration_modules() -> None:
    sys.modules.pop(MODULE_PATH, None)
    sys.modules.pop(PACKAGE_PATH, None)


def _load_crewai_integration() -> types.ModuleType:
    _reset_crewai_integration_modules()
    return importlib.import_module(MODULE_PATH)


def _install_fake_crewai(monkeypatch: pytest.MonkeyPatch) -> type:
    crewai_module = types.ModuleType("crewai")
    tools_module = types.ModuleType("crewai.tools")

    class BaseTool:
        name = "base_tool"
        args_schema = SimpleNamespace(model_fields={})

    tools_module.BaseTool = BaseTool
    crewai_module.tools = tools_module

    monkeypatch.setitem(sys.modules, "crewai", crewai_module)
    monkeypatch.setitem(sys.modules, "crewai.tools", tools_module)

    return BaseTool


def _make_guard_result(decision: str, reason: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        decision=decision,
        reason=reason,
        rule_id=None,
        severity=None,
        approval_id=None,
    )


class TestCrewAIIntegration:
    async def test_wrap_crewai_tools_validates_before_run(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        BaseTool = _install_fake_crewai(monkeypatch)
        integration = _load_crewai_integration()
        events: list[str] = []

        class TransferArgs:
            model_fields = {"amount": object(), "to_account": object()}

        class TransferTool(BaseTool):
            name = "transfer_funds"
            args_schema = TransferArgs

            def _run(self, amount: float, to_account: str) -> str:
                events.append("run")
                return f"Transferred ${amount} to {to_account}"

        async def guard(tool_name: str, args_dict: dict[str, object]) -> SimpleNamespace:
            events.append("guard")
            assert tool_name == "transfer_funds"
            assert args_dict == {"amount": 250.0, "to_account": "ACC-001"}
            return _make_guard_result("allow")

        veto = SimpleNamespace(guard=AsyncMock(side_effect=guard))
        wrapped_tool = integration.wrap_crewai_tools(veto, [TransferTool()])[0]

        result = wrapped_tool._run(250.0, "ACC-001")

        assert result == "Transferred $250.0 to ACC-001"
        assert events == ["guard", "run"]
        veto.guard.assert_awaited_once_with(
            "transfer_funds",
            {"amount": 250.0, "to_account": "ACC-001"},
        )

    async def test_denied_crewai_tool_call_raises_tool_call_denied_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        BaseTool = _install_fake_crewai(monkeypatch)
        integration = _load_crewai_integration()

        class TransferArgs:
            model_fields = {"amount": object(), "to_account": object()}

        class TransferTool(BaseTool):
            name = "transfer_funds"
            args_schema = TransferArgs

            def _run(self, amount: float, to_account: str) -> str:
                return f"Transferred ${amount} to {to_account}"

        veto = SimpleNamespace(
            guard=AsyncMock(
                return_value=_make_guard_result(
                    "deny",
                    "Amount exceeds policy threshold",
                )
            )
        )
        wrapped_tool = integration.wrap_crewai_tools(veto, [TransferTool()])[0]

        with pytest.raises(ToolCallDeniedError) as exc_info:
            wrapped_tool._run(5000.0, "ACC-001")

        assert exc_info.value.tool_name == "transfer_funds"
        assert exc_info.value.reason == "Amount exceeds policy threshold"
        assert exc_info.value.validation_result.reason == "Amount exceeds policy threshold"
        veto.guard.assert_awaited_once_with(
            "transfer_funds",
            {"amount": 5000.0, "to_account": "ACC-001"},
        )

    async def test_allowed_crewai_tool_call_executes_run_and_returns_result(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        BaseTool = _install_fake_crewai(monkeypatch)
        integration = _load_crewai_integration()

        class BalanceArgs:
            model_fields = {"account_id": object()}

        class GetBalanceTool(BaseTool):
            name = "get_balance"
            args_schema = BalanceArgs

            def _run(self, account_id: str) -> str:
                return f"Balance for {account_id}: $5,000"

        veto = SimpleNamespace(guard=AsyncMock(return_value=_make_guard_result("allow")))
        wrapped_tool = integration.wrap_crewai_tools(veto, [GetBalanceTool()])[0]

        result = wrapped_tool._run("ACC-001")

        assert result == "Balance for ACC-001: $5,000"
        veto.guard.assert_awaited_once_with(
            "get_balance",
            {"account_id": "ACC-001"},
        )

    async def test_async_arun_is_wrapped_when_present(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        BaseTool = _install_fake_crewai(monkeypatch)
        integration = _load_crewai_integration()

        class TransferArgs:
            model_fields = {"amount": object(), "to_account": object()}

        class AsyncTransferTool(BaseTool):
            name = "transfer_funds"
            args_schema = TransferArgs

            def _run(self, amount: float, to_account: str) -> str:
                return f"Transferred ${amount} to {to_account}"

            async def _arun(self, amount: float, to_account: str) -> str:
                return f"ASYNC transfer ${amount} to {to_account}"

        veto = SimpleNamespace(guard=AsyncMock(return_value=_make_guard_result("allow")))
        wrapped_tool = integration.wrap_crewai_tools(veto, [AsyncTransferTool()])[0]

        result = await wrapped_tool._arun(300.0, "ACC-999")

        assert result == "ASYNC transfer $300.0 to ACC-999"
        veto.guard.assert_awaited_once_with(
            "transfer_funds",
            {"amount": 300.0, "to_account": "ACC-999"},
        )

    def test_graceful_import_error_when_crewai_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        for module_name in list(sys.modules.keys()):
            if module_name == "crewai" or module_name.startswith("crewai."):
                sys.modules.pop(module_name, None)

        original_import = builtins.__import__

        def guarded_import(
            name: str,
            globals_obj: object = None,
            locals_obj: object = None,
            fromlist: tuple[str, ...] = (),
            level: int = 0,
        ) -> object:
            if name == "crewai" or name.startswith("crewai."):
                raise ImportError("No module named 'crewai'")
            return original_import(name, globals_obj, locals_obj, fromlist, level)

        monkeypatch.setattr(builtins, "__import__", guarded_import)

        integration = _load_crewai_integration()
        veto = SimpleNamespace(guard=AsyncMock(return_value=_make_guard_result("allow")))

        with pytest.raises(ImportError, match="crewai is required for this integration"):
            integration.wrap_crewai_tools(veto, [])
